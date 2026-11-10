// End-to-end test of the SWITCH edu-ID login (OIDC) against the mock provider, driven like a browser:
// follows redirects, keeps cookies per host, submits the mock's login/consent forms.
// Started by db/tests/e2e/run-edu-id.mjs inside a container that shares the app container's network
// (app on localhost:3000, mock on localhost:9999), with the app's production image and tut_test.
//   node db/tests/e2e/edu-id.mjs main          the login scenarios
//   node db/tests/e2e/edu-id.mjs unavailable   identity provider down
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const pg = createRequire(import.meta.url)("pg");
const APP = "http://localhost:3000";
const db = new pg.Client({ connectionString: process.env.E2E_DB_URL });

// --- minimal browser: cookie jar per host, manual redirects, form submission ---
class Browser {
  jar = new Map(); // host -> Map(name -> value)
  cookieHeader(url) {
    const c = this.jar.get(new URL(url).host);
    return c ? [...c].map(([k, v]) => `${k}=${v}`).join("; ") : "";
  }
  store(url, res) {
    const host = new URL(url).host;
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!this.jar.has(host)) this.jar.set(host, new Map());
      const expired = attrs.some((a) => /max-age=0/i.test(a)) || value === "";
      if (expired) this.jar.get(host).delete(name);
      else this.jar.get(host).set(name, value);
    }
  }
  async request(url, { method = "GET", body, headers = {} } = {}) {
    const res = await fetch(url, {
      method, body, redirect: "manual",
      headers: { ...headers, ...(this.cookieHeader(url) ? { Cookie: this.cookieHeader(url) } : {}) },
    });
    this.store(url, res);
    return res;
  }
  /** Follows redirects and submits the HTML forms on the way; returns the final app URL. */
  async run(startUrl, subject) {
    let url = startUrl;
    let res = await this.request(url);
    for (let step = 0; step < 25; step++) {
      if (res.status >= 300 && res.status < 400) {
        url = new URL(res.headers.get("location"), url).href;
        // landed back in the app on a page (not the callback): done
        if (url.startsWith(APP) && !url.includes("/api/auth/switch/")) return url;
        res = await this.request(url);
        continue;
      }
      const html = await res.text();
      const form = html.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
      if (res.status !== 200 || !form) throw new Error(`unexpected page ${res.status} at ${url}: ${html.slice(0, 200)}`);
      const fields = new URLSearchParams();
      for (const input of form[2].matchAll(/<input[^>]*>/gi)) {
        const name = input[0].match(/name="([^"]+)"/)?.[1];
        if (!name) continue;
        const value = input[0].match(/value="([^"]*)"/)?.[1] ?? "";
        fields.set(name, name === "login" ? subject : name === "password" ? "any" : value);
      }
      url = new URL(form[1].replace(/&amp;/g, "&"), url).href;
      res = await this.request(url, {
        method: "POST", body: fields.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    }
    throw new Error("too many steps");
  }
}

async function eduIdLogin(subject) {
  const browser = new Browser();
  const finalUrl = await browser.run(`${APP}/api/auth/switch/initiate`, subject);
  const session = await browser.request(`${APP}/api/auth/session`);
  const body = session.ok ? await session.json() : null;
  return { finalUrl: new URL(finalUrl), userId: body?.user?.id ?? null };
}

const accountsWith = async (email) =>
  (await db.query("SELECT a.id, p.auth_provider, p.switch_edu_id_sub, p.must_change_password FROM public.app_user a JOIN public.profiles p ON p.id = a.id WHERE lower(a.email) = lower($1)", [email])).rows;

async function adminCookie() {
  const res = await fetch(`${APP}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: APP },
    body: JSON.stringify({ email: "seed-a1@example.invalid", password: "Seed-Passwort-1" }),
  });
  assert.ok(res.ok, `admin login ${res.status}`);
  return res.headers.getSetCookie()[0].split(";")[0];
}

const ok = (msg) => console.log(`ok   ${msg}`);

async function main() {
  // 1. brand-new edu-ID user: account is created, session works, lands on the app
  const n = await eduIdLogin("new-user-1");
  assert.equal(n.finalUrl.searchParams.get("error"), null, `new user: ${n.finalUrl}`);
  assert.equal(n.finalUrl.pathname, "/erfasste-zeit");
  const [created] = await accountsWith("new.user@example.org");
  assert.ok(created && n.userId === created.id, "session belongs to the new account");
  assert.equal(created.auth_provider, "switch_edu_id");
  assert.equal(created.switch_edu_id_sub, "new-user-1");
  ok("new edu-ID user: account created, logged in, auth_provider switch_edu_id");

  // 2. returning user: second login lands in the same account, no duplicate
  const r1 = await eduIdLogin("returning-user-1");
  const r2 = await eduIdLogin("returning-user-1");
  assert.ok(r1.userId && r1.userId === r2.userId);
  assert.equal((await accountsWith("returning.user@example.org")).length, 1);
  ok("returning edu-ID user: same account on the second login");

  // 3. linking: admin creates a password account (must change password), then the person logs in
  //    with edu-ID and the same e-mail -> same account, linked, password change no longer required
  const cookie = await adminCookie();
  const createRes = await fetch(`${APP}/api/admin/users/create`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: APP, Cookie: cookie },
    body: JSON.stringify({ email: "collision@test.ch", firstName: "Kollision", lastName: "Test", temporaryPassword: "Temp-Passwort-123" }),
  });
  assert.ok(createRes.ok, `admin create ${createRes.status}`);
  const [before] = await accountsWith("collision@test.ch");
  assert.equal(before.auth_provider, "password");
  assert.equal(before.must_change_password, true);
  const c = await eduIdLogin("collision-user-1");
  assert.equal(c.finalUrl.searchParams.get("error"), null, `linking: ${c.finalUrl}`);
  const after = await accountsWith("collision@test.ch");
  assert.equal(after.length, 1, "no duplicate account");
  assert.equal(after[0].id, before.id, "same account (history preserved)");
  assert.equal(c.userId, before.id);
  assert.equal(after[0].auth_provider, "switch_edu_id");
  assert.equal(after[0].must_change_password, false);
  ok("linking to an admin-created password account (same id, must_change_password cleared)");

  // 4. same e-mail but email_verified=false: refused, no new account
  const u = await eduIdLogin("unverified-1");
  assert.equal(u.finalUrl.searchParams.get("error"), "oidc_account_conflict", `${u.finalUrl}`);
  assert.equal(u.userId, null);
  assert.equal((await accountsWith("collision@test.ch")).length, 1);
  ok("email_verified=false: linking refused (oidc_account_conflict), not logged in");

  // 5. no e-mail released: refused
  const e = await eduIdLogin("no-email-1");
  assert.equal(e.finalUrl.searchParams.get("error"), "oidc_incomplete_identity", `${e.finalUrl}`);
  assert.equal(e.userId, null);
  ok("no e-mail released: refused (oidc_incomplete_identity)");
}

async function unavailable() {
  const browser = new Browser();
  const res = await browser.request(`${APP}/api/auth/switch/initiate`);
  assert.equal(res.status, 307);
  const target = new URL(res.headers.get("location"));
  assert.equal(`${target.origin}${target.pathname}`, `${APP}/`);
  assert.equal(target.searchParams.get("error"), "oidc_unavailable");
  ok("identity provider unreachable: back to the login page with oidc_unavailable");
}

await db.connect();
try {
  if (process.argv[2] === "unavailable") await unavailable();
  else await main();
} finally {
  await db.end();
}
