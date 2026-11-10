// Loads an import file from db/scripts/export-data.mjs into the new database, as the OWNER login,
// in ONE transaction, and checks the row counts against the manifest. Needs no superuser.
//
//   node db/scripts/import-data.mjs db/.work/data_export.sql
//
// - The target must be freshly migrated (no data except the lookup tables from 0002).
// - User triggers are disabled during the load (the rows already contain what the triggers would
//   produce, e.g. the profile of an account), then enabled again; sequences are moved past the max ids.
// - Default target: the local dev database. For the DSL: DATABASE_OWNER_URL=... ALLOW_REMOTE_DB=1.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DATA_TABLES } from "./data-tables.mjs";
import { assertLocal, CONNECT_TIMEOUT_MS, pgSsl, urls } from "./env.mjs";

const pg = createRequire(import.meta.url)("pg");
const file = process.argv[2];
if (!file || !existsSync(file)) throw new Error("usage: node db/scripts/import-data.mjs <import file>");
const manifestFile = file.replace(/\.sql$/, ".manifest.json");
// The manifest (written by export-data.mjs next to the file) is required: without it neither the
// checksum nor the row counts could be checked. --no-manifest only for hand-made local test files.
const allowNoManifest = process.argv.includes("--no-manifest");
if (!existsSync(manifestFile) && !allowNoManifest) {
  throw new Error(`manifest ${manifestFile} not found (it belongs next to the import file); --no-manifest skips the checks`);
}
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : null;
const sql = readFileSync(file, "utf8");
const sha256 = createHash("sha256").update(sql).digest("hex");
if (manifest && sha256 !== manifest.sha256) {
  throw new Error("import file does not match its manifest (sha256)");
}
if (manifest) console.log(`manifest ok: sha256 ${sha256}`);
else console.warn("WARNING: no manifest, checksum and row counts are NOT checked");
assertLocal(urls.owner, "data import");

if (process.env.NODE_ENV === "production" && !process.env.DATABASE_OWNER_URL) {
  throw new Error("DATABASE_OWNER_URL is not set");
}
const TABLES = DATA_TABLES.map((t) => t.name);

const client = new pg.Client({ connectionString: urls.owner, ssl: pgSsl(), connectionTimeoutMillis: CONNECT_TIMEOUT_MS, application_name: "tut-import" });
await client.connect();
try {
  // refuse a target that already holds data (ids would collide)
  const busy = await client.query(
    "SELECT (SELECT count(*) FROM public.app_user) + (SELECT count(*) FROM public.day) + (SELECT count(*) FROM public.course) AS n",
  );
  if (Number(busy.rows[0].n) > 0) throw new Error("target database already contains data: import only into a freshly migrated database");

  await client.query("BEGIN");
  for (const t of TABLES) await client.query(`ALTER TABLE public.${t} DISABLE TRIGGER USER`);
  await client.query(sql);
  for (const t of TABLES) await client.query(`ALTER TABLE public.${t} ENABLE TRIGGER USER`);

  // move every sequence past the highest id (identity and serial columns)
  await client.query(`
    DO $$
    DECLARE r record; m bigint;
    BEGIN
      FOR r IN
        SELECT c.relname AS tbl, a.attname AS col, pg_get_serial_sequence(format('public.%I', c.relname), a.attname) AS seq
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND pg_get_serial_sequence(format('public.%I', c.relname), a.attname) IS NOT NULL
      LOOP
        EXECUTE format('SELECT max(%I) FROM public.%I', r.col, r.tbl) INTO m;
        IF m IS NOT NULL THEN PERFORM setval(r.seq, m, true); END IF;
      END LOOP;
    END $$;`);

  const counts = {};
  for (const t of TABLES) counts[t] = Number((await client.query(`SELECT count(*) AS n FROM public.${t}`)).rows[0].n);
  if (manifest) {
    const diff = TABLES.filter((t) => (manifest.tables[t] ?? 0) !== counts[t]);
    if (diff.length) throw new Error(`row counts differ from the manifest: ${diff.map((t) => `${t} ${counts[t]}/${manifest.tables[t]}`).join(", ")}`);
  }
  await client.query("COMMIT");
  await client.query("ANALYZE");
  console.log("imported:", JSON.stringify(counts));
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
