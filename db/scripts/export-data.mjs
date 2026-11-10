// Exports all user data of a Time Use Tool database into an import file for import-data.mjs, plus a
// manifest (row counts per table, sha256 of the file). Typical use: copying all data into a freshly
// migrated database of another environment.
//
//   npm run db:export                 local dev database -> db/.work/data_export.sql (+ .manifest.json)
//   DATABASE_OWNER_URL=... ALLOW_REMOTE_DB=1 npm run db:export     another database (read-only)
//
// - Runs in one read-only transaction (consistent snapshot), as the owner login.
// - The file contains personal data and password hashes: db/.work/ is gitignored; transfer it
//   encrypted and delete it after the import.
// - Rows are written 1:1 (same ids, same values) via jsonb_populate_recordset, so PostgreSQL itself
//   converts the column types on import.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DATA_TABLES } from "./data-tables.mjs";
import { assertLocal, CONNECT_TIMEOUT_MS, pgSsl, urls } from "./env.mjs";

const pg = createRequire(import.meta.url)("pg");
const WORK = join(resolve(import.meta.dirname, "..", ".."), "db", ".work");
assertLocal(urls.owner, "data export");

// keep every value exactly as PostgreSQL prints it (no conversion to JS dates or numbers)
const raw = (v) => v;
const client = new pg.Client({
  connectionString: urls.owner, ssl: pgSsl(), connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  application_name: "tut-export", options: "-c default_transaction_read_only=on",
});
await client.connect();

const manifest = { exported_at: new Date().toISOString(), tables: {} };
const out = [
  `-- Time Use Tool data export, ${manifest.exported_at}.`,
  "-- Contains personal data and password hashes. Load with db/scripts/import-data.mjs as the owner login.",
  "SET LOCAL search_path = '';",
];
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  for (const t of DATA_TABLES) {
    const res = await client.query({
      text: `SELECT to_jsonb(x) AS r FROM public.${t.name} x ORDER BY 1`,
      types: { getTypeParser: () => raw },
    });
    const rows = res.rows.map((r) => JSON.parse(r.r));
    manifest.tables[t.name] = rows.length;
    // chunks of 500 rows keep the single statements small
    for (let i = 0; i < rows.length; i += 500) {
      const literal = "'" + JSON.stringify(rows.slice(i, i + 500)).replace(/'/g, "''") + "'";
      out.push(`INSERT INTO public.${t.name} ${t.identity ? "OVERRIDING SYSTEM VALUE " : ""}` +
        `SELECT * FROM jsonb_populate_recordset(NULL::public.${t.name}, ${literal}::jsonb);`);
    }
  }
  await client.query("ROLLBACK");
} finally {
  await client.end();
}

mkdirSync(WORK, { recursive: true });
const file = join(WORK, "data_export.sql");
const text = out.join("\n") + "\n";
writeFileSync(file, text);
manifest.sha256 = createHash("sha256").update(text).digest("hex");
writeFileSync(file.replace(/\.sql$/, ".manifest.json"), JSON.stringify(manifest, null, 1));
console.log(JSON.stringify(manifest.tables));
console.log(`written ${file} (sha256 ${manifest.sha256})`);
