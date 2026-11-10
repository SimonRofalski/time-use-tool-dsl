// Runs every db/tests/app/*.test.ts (integration tests of lib/data against the synthetic seed).
// The tests CHANGE data, so they only run in the separate test database:  npm run db:test-all
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

if (!/\/tut_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("The app tests change data and only run in the test database: npm run db:test-all");
  process.exit(1);
}

const DIR = resolve(import.meta.dirname);
const files = readdirSync(DIR).filter((f) => f.endsWith(".test.ts")).sort();
let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f}`);
  const r = spawnSync(`npx tsx "${join(DIR, f)}"`, { stdio: "inherit", shell: true });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} of ${files.length} app test files failed` : `\nall ${files.length} app test files passed`);
process.exit(failed ? 1 : 0);
