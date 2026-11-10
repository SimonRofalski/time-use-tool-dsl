// Recreates the LOCAL dev database from scratch: wipe volume -> bootstrap -> migrations -> data.
//   node db/scripts/reset.mjs              synthetic seed (npm run db:reset)
//   node db/scripts/reset.mjs --real       the data export db/.work/data_export.sql instead
//                                          (create it first with npm run db:export)
// Wipes tut_local (your logins, enrollments, imported data). Not needed for tests: npm run db:test-all
// uses its own database tut_test.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const real = process.argv.includes("--real");
const realFile = join("db", ".work", "data_export.sql");
if (real && !existsSync(join(ROOT, realFile))) {
  console.error(`${realFile} not found: run npm run db:export first`);
  process.exit(1);
}

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run("docker", ["compose", "-f", "compose.dev.yml", "down", "-v"]);
run("docker", ["compose", "-f", "compose.dev.yml", "up", "-d", "--wait"]);
run("node", ["db/scripts/migrate.mjs"]);
if (real) run("node", ["db/scripts/import-data.mjs", realFile]);
else run("node", ["db/scripts/seed.mjs"]);
