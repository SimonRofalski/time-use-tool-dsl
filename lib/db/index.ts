// Server-side database access (PostgreSQL via node-postgres; Drizzle for typed queries).
//
//   withUser(userId, async (db) => db.query(...))   as the logged-in user: the RLS policies apply
//                                                   (auth.uid() = userId, role tut_authenticated)
//   withService(async (db) => db.query(...))        server-side jobs (login, exports, admin accounts)
//                                                   with service rights (backend_all policies)
//
// Every call is one transaction. The user id and the role are set transaction-locally
// (set_config(..., true)), so a pooled connection never keeps another user's identity, and the code
// also works behind PgBouncer in transaction mode. Never import this file into client components.
import { readFileSync } from "node:fs";
import { Pool, types, type PoolClient, type QueryResultRow } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import * as relations from "./relations";

export * from "./schema";

// ---- result types: keep the former PostgREST shapes, so the page logic is unchanged ---------------
types.setTypeParser(1082, (v) => v); // date        -> "YYYY-MM-DD" (no JS Date, no timezone shift)
types.setTypeParser(1083, (v) => v); // time        -> "HH:MM:SS"
types.setTypeParser(1114, (v) => v); // timestamp   -> raw string
// timestamptz -> "2026-11-02T20:00:00+00:00" like PostgREST (session TimeZone is UTC, see bootstrap)
types.setTypeParser(1184, (v) => v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
types.setTypeParser(20, (v) => Number(v)); // bigint (count(*)) -> number, like PostgREST
types.setTypeParser(1700, (v) => Number(v)); // numeric -> number, like PostgREST

// ---- connection pools ------------------------------------------------------------------------------
// Two logins: "app" (switches to tut_authenticated per transaction) and "service".
// Without env vars, development uses the local database container (port 15432).
const DEV_DEFAULTS = {
  app: "postgresql://tut_local_app:tut_local_app_pw@127.0.0.1:15432/tut_local",
  service: "postgresql://tut_local_service:tut_local_service_pw@127.0.0.1:15432/tut_local",
};

function connectionString(kind: "app" | "service"): string {
  const url = kind === "app" ? process.env.DATABASE_URL : process.env.DATABASE_SERVICE_URL;
  if (url) {
    assertAllowedHost(url);
    assertNoTlsParams(url);
    return url;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${kind === "app" ? "DATABASE_URL" : "DATABASE_SERVICE_URL"} is not set`);
  }
  return DEV_DEFAULTS[kind];
}

/** In development, only the local container may be used (protects production data from dev runs). */
function assertAllowedHost(url: string) {
  if (process.env.NODE_ENV === "production" || process.env.ALLOW_REMOTE_DB === "1") return;
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error(`refusing to connect to ${host} in development (set ALLOW_REMOTE_DB=1 to override)`);
  }
}

/**
 * TLS settings only via DATABASE_SSLMODE: node-postgres lets sslmode/ssl parameters in the URL replace
 * the ssl object entirely (e.g. ?sslmode=require drops the CA), so such URLs are refused.
 */
function assertNoTlsParams(url: string) {
  if (/[?&](sslmode|ssl|sslrootcert|sslcert|sslkey|uselibpqcompat)=/i.test(url)) {
    throw new Error("TLS settings belong in DATABASE_SSLMODE / DATABASE_CA_FILE, not in the database URL");
  }
}

const SSL_MODES = ["disable", "require", "verify-ca", "verify-full"];

function ssl() {
  // Docker stack: disable (the database runs next to the app in the stack's own network); local: unset =
  // no TLS. A database on another host: verify-full + DATABASE_CA_FILE.
  // verify-ca behaves like verify-full (Node also checks the host name). Unknown values (typos) stop
  // the app instead of silently connecting without certificate check.
  const mode = process.env.DATABASE_SSLMODE;
  if (!mode) return undefined;
  if (!SSL_MODES.includes(mode)) {
    throw new Error(`DATABASE_SSLMODE=${mode} is not supported (disable | require | verify-full)`);
  }
  if (mode === "disable") return undefined;
  const caFile = process.env.DATABASE_CA_FILE;
  const ca = caFile ? readFileSync(caFile, "utf8") : undefined;
  return { ca, rejectUnauthorized: mode !== "require" };
}

// Fail after 10 s (-> health 503) instead of waiting for the OS TCP timeout when the server drops
// packets; also the longest wait for a free pool connection under load
const CONNECT_TIMEOUT_MS = Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 10000);

type Pools = { app: Pool; service: Pool };
// Kept on globalThis so hot reloads in development don't open new pools
const globalPools = globalThis as unknown as { __tutPools?: Pools };

function pools(): Pools {
  if (!globalPools.__tutPools) {
    globalPools.__tutPools = {
      app: new Pool({
        connectionString: connectionString("app"),
        ssl: ssl(),
        max: Number(process.env.DATABASE_POOL_MAX ?? 10),
        application_name: "tut-app",
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      }),
      service: new Pool({
        connectionString: connectionString("service"),
        ssl: ssl(),
        max: Number(process.env.DATABASE_SERVICE_POOL_MAX ?? 4),
        application_name: "tut-service",
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      }),
    };
  }
  return globalPools.__tutPools;
}

// ---- transactions ------------------------------------------------------------------------------------
export type Db = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<R[]>;
  /** the raw pg client of this transaction (e.g. for Drizzle) */
  client: PoolClient;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** BEGIN, optional setup (role/user id), fn, COMMIT; ROLLBACK on any error. */
async function inTransaction<T>(
  pool: Pool,
  setup: ((c: PoolClient) => Promise<unknown>) | null,
  fn: (db: Db) => Promise<T>,
  readOnly: boolean,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    if (setup) await setup(client);
    const db: Db = {
      client,
      async query(text, values) {
        return (await client.query(text, values as unknown[])).rows;
      },
    };
    const result = await fn(db);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true; // never hand a connection in an unknown state back to the pool
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

/** Runs fn as the logged-in user. RLS policies see auth.uid() = userId. */
export function withUser<T>(userId: string, fn: (db: Db) => Promise<T>, opts: { readOnly?: boolean } = {}) {
  if (!UUID_RE.test(userId)) throw new Error("withUser: invalid user id");
  return inTransaction(
    pools().app,
    (c) =>
      c.query("SELECT set_config('role', 'tut_authenticated', true), set_config('app.user_id', $1, true)", [userId]),
    fn,
    opts.readOnly ?? false,
  );
}

/** Runs fn with the server-side service rights (backend_all policies). Use only after an explicit check. */
export function withService<T>(fn: (db: Db) => Promise<T>, opts: { readOnly?: boolean } = {}) {
  return inTransaction(pools().service, null, fn, opts.readOnly ?? false);
}

/**
 * Typed Drizzle query builder on the connection of the current withUser/withService transaction.
 *   await withUser(user.id, (db) => orm(db).select().from(profiles).where(eq(profiles.id, user.id)))
 */
export function orm(db: Db) {
  return drizzle({ client: db.client, schema: { ...schema, ...relations } });
}

/** PostgreSQL error code of a failed query (e.g. "23505" unique violation, "23503" FK, "42501" RLS). */
export function pgErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}
