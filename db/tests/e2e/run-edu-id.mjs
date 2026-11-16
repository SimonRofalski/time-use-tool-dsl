// SWITCH edu-ID end-to-end test with the PRODUCTION image against the local mock provider.
//   npm run test:edu-id          (needs the dev container and a built image: docker build -t time-use-tool:dev .)
//
// Setup: fresh tut_test (seed), app container "tut-e2e-app" (production image, NODE_ENV=production),
// the mock provider and the test driver in the SAME network namespace as the app container, so all
// three reach each other on localhost (the app only allows an http identity provider on localhost;
// the real SWITCH is https). Nothing is published on the host; tut_local is not touched.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const IMAGE = process.env.TUT_IMAGE ?? "time-use-tool:dev";
const NODE_IMAGE = "node:24.22.3-slim";
const DB = (login, pw) => `postgresql://${login}:${pw}@host.docker.internal:15432/tut_test`;
const env = { ...process.env, MSYS_NO_PATHCONV: "1" };

const sh = (cmd, args, { allowFail = false, quiet = false } = {}) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: quiet ? "pipe" : "inherit", env });
  if (r.status !== 0 && !allowFail) {
    console.error(`\nfailed: ${cmd} ${args.join(" ")}`);
    cleanup();
    process.exit(r.status ?? 1);
  }
  return r;
};
const docker = (...args) => sh("docker", args);
const cleanup = () => {
  for (const name of ["tut-e2e-mock", "tut-e2e-app"]) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", env });
};

const repoMount = `${ROOT}:/repo:ro`;
const appEnv = [
  "-e", `DATABASE_URL=${DB("tut_test_app", "tut_test_app_pw")}`,
  "-e", `DATABASE_SERVICE_URL=${DB("tut_test_service", "tut_test_service_pw")}`,
  "-e", "APP_ORIGIN=http://localhost:3000",
  "-e", "RESET_DECOY_SECRET=e2e-only",
  "-e", "SWITCH_OIDC_ISSUER_URL=http://localhost:9999",
  "-e", "SWITCH_OIDC_CLIENT_ID=time-use-tool-dev",
  "-e", "SWITCH_OIDC_CLIENT_SECRET=dev-secret",
  "-e", "SWITCH_OIDC_REDIRECT_URI=http://localhost:3000/api/auth/switch/callback",
];
const waitFor = (url, what) => {
  const r = sh("docker", ["run", "--rm", "--network", "container:tut-e2e-app", NODE_IMAGE, "node", "-e",
    `const u=${JSON.stringify(url)};(async()=>{for(let i=0;i<60;i++){try{const r=await fetch(u);if(r.status<500)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,1000))}process.exit(1)})()`],
    { allowFail: true });
  if (r.status !== 0) { console.error(`${what} did not come up`); cleanup(); process.exit(1); }
};
const driver = (phase) => docker("run", "--rm", "--network", "container:tut-e2e-app", "-v", repoMount, "-w", "/repo",
  "-e", `E2E_DB_URL=${DB("tut_test_service", "tut_test_service_pw")}`, NODE_IMAGE, "node", "db/tests/e2e/edu-id.mjs", phase);

cleanup();
sh("node", ["db/scripts/test-all.mjs", "--setup-only"]);
docker("run", "-d", "--name", "tut-e2e-app", "--read-only", "--tmpfs", "/tmp", "--tmpfs", "/app/.next/cache:uid=1000,gid=1000", ...appEnv, IMAGE);
docker("run", "-d", "--name", "tut-e2e-mock", "--network", "container:tut-e2e-app", "-v", repoMount, "-w", "/repo", NODE_IMAGE,
  "node", "dev/mock-oidc-provider.mjs");
waitFor("http://localhost:3000/api/health", "app");
waitFor("http://localhost:9999/.well-known/openid-configuration", "mock provider");

console.log("\n=== edu-ID login scenarios (production image, mock provider) ===");
driver("main");

// identity provider down: stop the mock, restart the app (forgets the cached discovery document)
docker("rm", "-f", "tut-e2e-mock");
docker("restart", "tut-e2e-app");
waitFor("http://localhost:3000/api/health", "app");
driver("unavailable");

cleanup();
console.log("\nall edu-ID end-to-end checks passed");
