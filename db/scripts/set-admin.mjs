// Makes an existing, active account an admin, as the OWNER login. For an environment that starts
// without admins (the DSL test environment: empty database, no data import) and as an emergency
// path; afterwards admins manage admin rights in the Nutzerübersicht.
//
//   node db/scripts/set-admin.mjs person@example.org          (local dev database)
//   DSL: docker compose run --rm -e ALLOW_REMOTE_DB=1 tut_migrate node db/scripts/set-admin.mjs person@example.org
//
// The person registers first (login page or edu-ID). Exact e-mail match, case-insensitive.
import pg from "pg";
import { assertLocal, CONNECT_TIMEOUT_MS, pgSsl, urls } from "./env.mjs";

const email = process.argv[2];
if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("usage: node db/scripts/set-admin.mjs <e-mail>");
if (process.env.NODE_ENV === "production" && !process.env.DATABASE_OWNER_URL) {
  throw new Error("DATABASE_OWNER_URL is not set");
}
assertLocal(urls.owner, "set-admin");

const client = new pg.Client({ connectionString: urls.owner, ssl: pgSsl(), connectionTimeoutMillis: CONNECT_TIMEOUT_MS, application_name: "tut-set-admin" });
await client.connect();
try {
  const { rows } = await client.query(
    `UPDATE public.profiles p SET role = 'admin'
       FROM public.app_user a
      WHERE a.id = p.id AND lower(a.email) = lower($1) AND p.is_active
     RETURNING p.role`,
    [email],
  );
  if (!rows.length) {
    console.error("no active account with this e-mail (the person has to register first)");
    process.exitCode = 1;
  } else {
    console.log("ok: the account is now an admin (takes effect on the next page load)");
  }
} finally {
  await client.end();
}
