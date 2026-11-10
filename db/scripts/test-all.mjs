// Runs every database test in a SEPARATE local test database (tut_test), so your working database
// tut_local (with your logins, enrollments and the imported data) is never touched.
//   npm run db:test-all
//   node db/scripts/test-all.mjs --setup-only     fresh tut_test with seed, no tests (used by db/tests/e2e)
//
// Steps: drop + re-create tut_test with the same bootstrap the DSL runs (env=test, same container),
// apply the migrations, load the synthetic seed, run the RLS tests (db/tests/*.sql) and the app
// tests (db/tests/app/*.test.ts). Needs the dev container (npm run db:up).
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PW = { owner: "tut_test_owner_pw", app: "tut_test_app_pw", service: "tut_test_service_pw" };
const url = (login, pw) => `postgresql://${login}:${pw}@127.0.0.1:15432/tut_test`;

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env }, shell: false });
  if (r.status !== 0) {
    console.error(`\nfailed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
};
const psql = (args, env = {}) =>
  run("docker", [
    "compose", "-f", "compose.dev.yml", "exec", "-T",
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "db", "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", ...args,
  ]);

run("docker", ["compose", "-f", "compose.dev.yml", "up", "-d", "--wait"]);
// fresh test database (only tut_test and its three logins; tut_local stays as it is)
psql(["-c", "DROP DATABASE IF EXISTS tut_test WITH (FORCE)"]);
psql(["-c", "DROP ROLE IF EXISTS tut_test_app, tut_test_service, tut_test_owner"]);
psql(["-q", "-v", "env=test", "-f", "/bootstrap/bootstrap.sql"], {
  TUT_OWNER_PASSWORD: PW.owner, TUT_APP_PASSWORD: PW.app, TUT_SERVICE_PASSWORD: PW.service,
});

const testEnv = {
  DATABASE_OWNER_URL: url("tut_test_owner", PW.owner),
  DATABASE_URL: url("tut_test_app", PW.app),
  DATABASE_SERVICE_URL: url("tut_test_service", PW.service),
};
run("node", ["db/scripts/migrate.mjs"], testEnv);
run("node", ["db/scripts/seed.mjs"], testEnv);
if (process.argv.includes("--setup-only")) {
  console.log("tut_test ready (seed loaded)");
  process.exit(0);
}
run("node", ["db/tests/run.mjs"], testEnv);          // RLS tests first: the app tests change data
run("node", ["db/tests/app/run.mjs"], testEnv);
console.log("\nall database tests passed (in tut_test; tut_local untouched)");
