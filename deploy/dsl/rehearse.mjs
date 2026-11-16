// Local rehearsal of the DSL hand-over files: starts deploy/dsl/<test|prod>/compose.yml exactly as
// written, with locally built images and random dummy secrets, and checks the whole stack.
//   npm run test:dsl-stack              (test environment)
//   npm run test:dsl-stack -- prod      (production file)
//   ... -- --no-build                   (reuse the images from the last run)
//   ... -- --keep                       (afterwards restart it with an empty database and leave it
//                                        running, e.g. to try the data import; remove it with
//                                        docker compose -p tut-rehearse-<env> -f <file> down -v and
//                                        docker network rm tut-rehearse-web)
//
// What changes against the real deployment: the two image names (local builds instead of the GitLab
// registry), the secrets (random values instead of the vault) and the name of the external network
// "web" (tut-rehearse-web, created and removed here). Nothing is published on the host; the dev
// database (compose.dev.yml) is not touched. Needs Docker.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const ENV = process.argv.includes("prod") ? "prod" : "test";
const DB_ENV = ENV === "prod" ? "prod" : "stage";
const PROJECT = `tut-rehearse-${ENV}`;
const NET = "tut-rehearse-web";
const IMAGES = { app: "tut-rehearse-app", db: "tut-rehearse-db" };
const NODE_IMAGE = "node:24.22.3-slim";
const env = { ...process.env, MSYS_NO_PATHCONV: "1" };

const sh = (cmd, args, { allowFail = false, quiet = false } = {}) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: quiet ? "pipe" : "inherit", env, encoding: "utf8" });
  if (r.status !== 0 && !allowFail) {
    console.error(`\nfailed: ${cmd} ${args.join(" ")}\n${r.stdout ?? ""}${r.stderr ?? ""}`);
    cleanup();
    process.exit(r.status ?? 1);
  }
  return r;
};

// --- render the hand-over file ---
const source = readFileSync(join(ROOT, "deploy", "dsl", ENV, "compose.yml"), "utf8").replace(/\r\n/g, "\n");
const secrets = new Map();
let rendered = source
  .replace(/\{\{\s*secrets\.([\w.]+)\s*\}\}/g, (_, key) => {
    // edu-ID stays unregistered (empty client id/secret), like before the SWITCH registration
    if (/switch_oidc_client_(id|secret)$/.test(key)) return "";
    if (!secrets.has(key)) secrets.set(key, randomBytes(24).toString("hex"));
    return secrets.get(key);
  })
  .replace(/registry\.gitlab\.ti\.bfh\.ch\/\S+\/time-use-tool-(app|db):[\w.-]+/g, (_, kind) => IMAGES[kind])
  .replace(/^ {2}web:\n {4}external: true$/m, `  web:\n    external: true\n    name: ${NET}`);
if (/^[^#\n]*(\{\{|registry\.gitlab)/m.test(rendered) || !rendered.includes(`name: ${NET}`)) {
  throw new Error("rendering failed (unexpected format of the compose file)");
}
const dir = join(tmpdir(), PROJECT);
mkdirSync(dir, { recursive: true });
const file = join(dir, "compose.yml");
writeFileSync(file, rendered);
const compose = (...args) => sh("docker", ["compose", "-p", PROJECT, "-f", file, ...args]);
const cleanup = () => {
  spawnSync("docker", ["compose", "-p", PROJECT, "-f", file, "down", "-v", "--remove-orphans"], { stdio: "ignore", env });
  spawnSync("docker", ["network", "rm", NET], { stdio: "ignore", env });
};

const ok = (msg) => console.log(`ok   ${msg}`);
const origin = rendered.match(/APP_ORIGIN=(\S+)/)[1];
const containerState = (service) => {
  const id = sh("docker", ["compose", "-p", PROJECT, "-f", file, "ps", "-a", "-q", service], { quiet: true }).stdout.trim();
  return JSON.parse(sh("docker", ["inspect", id], { quiet: true }).stdout)[0].State;
};
const waitHealthy = (service, seconds = 180) => {
  for (let i = 0; i < seconds; i++) {
    const s = containerState(service);
    if (s.Health?.Status === "healthy") return;
    if (s.Status === "exited") break;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
  }
  compose("logs", "--no-color", "--tail", "80");
  console.error(`${service} did not become healthy`);
  cleanup();
  process.exit(1);
};
const probe = (code) => sh("docker", ["run", "--rm", "--network", NET, "-e", `ORIGIN=${origin}`, NODE_IMAGE, "node", "-e", code], { quiet: true });
const sql = (query) =>
  sh("docker", ["compose", "-p", PROJECT, "-f", file, "exec", "-T", "tut_db", "psql", "-qtAX", "-U", "postgres", "-d", `tut_${DB_ENV}`, "-c", query], { quiet: true }).stdout.trim();

// --- build ---
cleanup();
if (!process.argv.includes("--no-build")) {
  sh("docker", ["build", "-q", "-t", IMAGES.app, "."]);
  sh("docker", ["build", "-q", "-t", IMAGES.db, "db/bootstrap"]);
}

// --- guards of the database image ---
const badInit = (extra) => sh("docker", ["run", "--rm", "-e", "POSTGRES_PASSWORD=x", ...extra, IMAGES.db], { allowFail: true, quiet: true });
const good = ["-e", "TUT_OWNER_PASSWORD=" + "a".repeat(20), "-e", "TUT_APP_PASSWORD=" + "b".repeat(20), "-e", "TUT_SERVICE_PASSWORD=" + "c".repeat(20)];
let r = badInit(["-e", "TUT_ENV=test", ...good]);
if (r.status === 0 || !/TUT_ENV must be prod or stage/.test(r.stderr + r.stdout)) throw new Error("TUT_ENV=test was not refused");
r = badInit(["-e", "TUT_ENV=stage", ...good.slice(0, 4), "-e", "TUT_SERVICE_PASSWORD=short"]);
if (r.status === 0 || !/TUT_SERVICE_PASSWORD must be/.test(r.stderr + r.stdout)) throw new Error("short password was not refused");
ok("database image refuses a reserved environment name and a weak password");

// --- first start ---
sh("docker", ["network", "create", NET], { quiet: true });
compose("up", "-d");
waitHealthy("tut_app");
const migrate = containerState("tut_migrate");
const migrateLog = sh("docker", ["compose", "-p", PROJECT, "-f", file, "logs", "--no-color", "tut_migrate"], { quiet: true }).stdout;
if (migrate.ExitCode !== 0 || !/migration\(s\) applied/.test(migrateLog)) throw new Error(`migrate: exit ${migrate.ExitCode}\n${migrateLog}`);
ok(`first start: tut_db healthy (database tut_${DB_ENV}), migrations applied, tut_app healthy`);

const roles = sql("SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'tut_%'");
const expected = ["tut_authenticated", "tut_backend", `tut_${DB_ENV}_app`, `tut_${DB_ENV}_owner`, `tut_${DB_ENV}_service`].sort().join(",");
if (roles !== expected) throw new Error(`roles: ${roles}`);
const superusers = sql("SELECT string_agg(rolname, ',') FROM pg_roles WHERE rolsuper");
if (superusers !== "postgres") throw new Error(`superusers: ${superusers}`);
ok("bootstrap: the three logins + two groups, no extra superuser");

// --- through the network "web" (where Traefik sits) ---
probe(`(async () => {
  const h = await fetch("http://tut_app:3000/api/health"); const b = await h.json();
  if (h.status !== 200 || b.status !== "ok") throw new Error("health " + h.status + " " + JSON.stringify(b));
  const page = await fetch("http://tut_app:3000/"); if (page.status !== 200) throw new Error("login page " + page.status);
  let dbVisible = true; try { await require("node:dns").promises.lookup("tut_db"); } catch { dbVisible = false; }
  if (dbVisible) throw new Error("tut_db is reachable from the network web");
})().catch((e) => { console.error(e.message); process.exit(1); })`);
ok("via the network web: /api/health ok, login page 200, tut_db not visible");

// --- first admin of an empty environment ---
const email = "rehearsal-admin@example.invalid";
probe(`(async () => {
  const res = await fetch("http://tut_app:3000/api/auth/signup", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: process.env.ORIGIN },
    body: JSON.stringify({ email: ${JSON.stringify(email)}, password: "Rehearsal-Passwort-1" }) });
  if (!res.ok) throw new Error("signup " + res.status + " " + await res.text());
})().catch((e) => { console.error(e.message); process.exit(1); })`);
r = sh("docker", ["compose", "-p", PROJECT, "-f", file, "run", "--rm", "-T", "-e", "ALLOW_REMOTE_DB=1", "tut_migrate", "node", "db/scripts/set-admin.mjs", "nobody@example.invalid"], { allowFail: true, quiet: true });
if (r.status === 0) throw new Error("set-admin accepted an unknown e-mail");
compose("run", "--rm", "-T", "-e", "ALLOW_REMOTE_DB=1", "tut_migrate", "node", "db/scripts/set-admin.mjs", email.toUpperCase());
if (sql(`SELECT p.role FROM public.profiles p JOIN public.app_user a ON a.id = p.id WHERE a.email = '${email}'`) !== "admin") {
  throw new Error("set-admin did not make the account an admin");
}
ok("sign-up through the app, set-admin makes the account an admin (unknown e-mail refused)");

// --- restart: data stays, bootstrap does not run again, migrations up to date ---
compose("down");
compose("up", "-d");
waitHealthy("tut_app");
const again = sh("docker", ["compose", "-p", PROJECT, "-f", file, "logs", "--no-color", "tut_migrate"], { quiet: true }).stdout;
if (!/database is up to date/.test(again)) throw new Error(`second start, migrate:\n${again}`);
if (sql(`SELECT count(*) FROM public.app_user WHERE email = '${email}'`) !== "1") throw new Error("data lost after restart");
ok("down + up: data kept (volume), migrate reports up to date, app healthy again");

if (process.argv.includes("--keep")) {
  // fresh, empty database (as before the data import), left running
  compose("down", "-v");
  compose("up", "-d");
  waitHealthy("tut_app");
  console.log(`\nstack left running with an empty database: docker compose -p ${PROJECT} -f ${file} ...`);
} else {
  cleanup();
}
console.log(`\nDSL stack rehearsal (${ENV}) passed`);
