// Applies db/migrations/*.sql in file-name order, each file in its own transaction.
//
//   node db/scripts/migrate.mjs            (uses DATABASE_OWNER_URL, default: local dev container)
//
// - Must run as the database OWNER login (tut_<env>_owner), never as a superuser: SECURITY DEFINER
//   functions run as their owner, and a superuser owner would bypass every check.
// - Applied files are recorded with their sha256 in migrations.applied. A file that was changed after
//   it was applied stops the run (write a new migration instead of editing an old one).
// - Files are sent as one simple query, so multi-statement files and $$ function bodies work as-is.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { CONNECT_TIMEOUT_MS, pgSsl, urls } from "./env.mjs";

const DIR = resolve(import.meta.dirname, "..", "migrations");

if (process.env.NODE_ENV === "production" && !process.env.DATABASE_OWNER_URL) {
  throw new Error("DATABASE_OWNER_URL is not set");
}
const client = new pg.Client({ connectionString: urls.owner, ssl: pgSsl(), connectionTimeoutMillis: CONNECT_TIMEOUT_MS, application_name: "tut-migrate" });
await client.connect();
try {
  // identity check: not a superuser, and exactly the login that owns the database
  const me = await client.query(
    "SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su, " +
      "pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = current_database())) AS dbowner",
  );
  const { u, su, dbowner } = me.rows[0];
  if (su) throw new Error(`refusing to migrate as superuser ${u}; use the owner login`);
  if (u !== dbowner) throw new Error(`refusing to migrate as ${u}; the database is owned by ${dbowner}`);

  await client.query("CREATE SCHEMA IF NOT EXISTS migrations");
  await client.query(
    "CREATE TABLE IF NOT EXISTS migrations.applied (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const done = new Map((await client.query("SELECT name, sha256 FROM migrations.applied")).rows.map((r) => [r.name, r.sha256]));

  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  let applied = 0;
  for (const name of files) {
    const sql = readFileSync(join(DIR, name), "utf8");
    const sha = createHash("sha256").update(sql).digest("hex");
    if (done.has(name)) {
      if (done.get(name) !== sha) throw new Error(`${name} was changed after it was applied (write a new migration)`);
      continue;
    }
    process.stdout.write(`apply ${name} ... `);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO migrations.applied (name, sha256) VALUES ($1, $2)", [name, sha]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.log("FAILED");
      throw new Error(`${name}: ${e.message}${e.position ? ` (at character ${e.position})` : ""}`);
    }
    console.log("ok");
    applied++;
  }
  console.log(applied ? `${applied} migration(s) applied` : "database is up to date");
} finally {
  await client.end();
}
