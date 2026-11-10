// RLS / access tests (db/tests/*.sql). They pin the permission rules of the schema; started by
// npm run db:test-all against the separate test database tut_test.
//   node db/tests/run.mjs            all files      node db/tests/run.mjs 02   files starting with 02
//
// Each *.sql file runs in one transaction that is always rolled back, connected as:
//   *.owner.sql   -> owner login      *.service.sql -> service login      otherwise -> app login
// Inside a file the app login switches identity like the app does (lib/db withUser):
//   SELECT set_config('role', 'tut_authenticated', true), set_config('app.user_id', '<uuid>', true);
// A failed assertion is a RAISE EXCEPTION whose message starts with the test id.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { assertLocal, urls } from "../scripts/env.mjs";

const pg = createRequire(import.meta.url)("pg");
const DIR = resolve(import.meta.dirname);
const filter = process.argv[2] ?? "";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql") && f.startsWith(filter)).sort();

let failed = 0;
for (const file of files) {
  const url = file.endsWith(".owner.sql") ? urls.owner : file.endsWith(".service.sql") ? urls.service : urls.app;
  assertLocal(url, "db tests");
  const client = new pg.Client({ connectionString: url, application_name: "tut-tests" });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(readFileSync(join(DIR, file), "utf8"));
    console.log(`PASS ${file}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${file}\n     ${e.message}`);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}
console.log(failed ? `\n${failed} of ${files.length} test files failed` : `\nall ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
