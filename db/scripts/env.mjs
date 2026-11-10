// Connection settings shared by the db scripts (migrate, seed, import/export, set-admin, tests).
// URLs come from the environment; the defaults point at the local compose.dev.yml container.
import { readFileSync } from "node:fs";

// Default URLs of the local dev container (database tut_local, never production).
export const LOCAL = {
  super: "postgresql://postgres:postgres@127.0.0.1:15432/tut_local",
  owner: "postgresql://tut_local_owner:tut_local_owner_pw@127.0.0.1:15432/tut_local",
  app: "postgresql://tut_local_app:tut_local_app_pw@127.0.0.1:15432/tut_local",
  service: "postgresql://tut_local_service:tut_local_service_pw@127.0.0.1:15432/tut_local",
};

export const urls = {
  owner: process.env.DATABASE_OWNER_URL ?? LOCAL.owner,
  app: process.env.DATABASE_URL ?? LOCAL.app,
  service: process.env.DATABASE_SERVICE_URL ?? LOCAL.service,
  super: process.env.LOCAL_SUPERUSER_URL ?? LOCAL.super,
};

/**
 * Refuse to run destructive helpers (seed, tests, import, export, set-admin) against anything but the
 * local container. ALLOW_REMOTE_DB=1 lifts the check deliberately (e.g. import or set-admin in the DSL).
 */
export function assertLocal(url, what) {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host) && process.env.ALLOW_REMOTE_DB !== "1") {
    throw new Error(`${what} only runs against the local dev database (host was ${host})`);
  }
}

/**
 * TLS for the scripts, same rules as lib/db: only for a database on another host (DATABASE_SSLMODE=
 * verify-full + DATABASE_CA_FILE); the DSL stack and the local container use none. Don't put sslmode
 * into the URLs themselves.
 */
export function pgSsl() {
  for (const url of [process.env.DATABASE_OWNER_URL, process.env.DATABASE_URL, process.env.DATABASE_SERVICE_URL]) {
    if (url && /[?&](sslmode|ssl|sslrootcert|sslcert|sslkey|uselibpqcompat)=/i.test(url)) {
      throw new Error("TLS settings belong in DATABASE_SSLMODE / DATABASE_CA_FILE, not in the database URL");
    }
  }
  const mode = process.env.DATABASE_SSLMODE;
  if (!mode) return undefined;
  if (!["disable", "require", "verify-ca", "verify-full"].includes(mode)) {
    throw new Error(`DATABASE_SSLMODE=${mode} is not supported (disable | require | verify-full)`);
  }
  if (mode === "disable") return undefined;
  const caFile = process.env.DATABASE_CA_FILE;
  return {
    ca: caFile ? readFileSync(caFile, "utf8") : undefined,
    rejectUnauthorized: mode !== "require", // verify-ca behaves like verify-full (host name checked too)
  };
}

/** Connect timeout for the scripts (same default as the app). */
export const CONNECT_TIMEOUT_MS = Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 10000);
