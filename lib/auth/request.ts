// Helpers for route handlers (app/api/**): CSRF check, rate limits, client address.
// With cookie sessions the browser sends the cookie automatically, so every state-changing route must
// verify that the request comes from our own pages (Server Actions get this check from Next.js itself).
import { NextResponse } from "next/server";
import { withService } from "@/lib/db";
import { attemptKey } from "./core";

function expectedHosts(request: Request): string[] {
  const hosts = new Set<string>();
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host) hosts.add(host.split(",")[0].trim().toLowerCase());
  if (process.env.APP_ORIGIN) hosts.add(new URL(process.env.APP_ORIGIN).host.toLowerCase());
  return [...hosts];
}

/** null if the request is same-origin, otherwise a 403 response. Use for every non-GET route. */
export function rejectCrossSite(request: Request): NextResponse | null {
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin") return null;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (expectedHosts(request).includes(new URL(origin).host.toLowerCase())) return null;
    } catch {
      /* invalid Origin header -> reject */
    }
  } else if (!site) {
    // Neither header: not a browser request from another site (curl, server-to-server); cookies
    // are only sent by browsers, which always send at least one of the two headers on POST
    return null;
  }
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

/**
 * Sliding-window rate limit (table auth_attempt). Records the attempt and returns true when the
 * limit is exceeded. Used for sign-in, sign-up and password change.
 */
export async function isRateLimited(kind: string, key: string, max: number, windowMinutes: number): Promise<boolean> {
  const keyHash = attemptKey(kind, key);
  return withService(async (db) => {
    const rows = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.auth_attempt WHERE kind = $1 AND key_hash = $2 AND attempted_at > now() - make_interval(mins => $3)",
      [kind, keyHash, windowMinutes],
    );
    if (rows[0].n >= max) return true;
    await db.query("INSERT INTO public.auth_attempt (kind, key_hash) VALUES ($1, $2)", [kind, keyHash]);
    return false;
  });
}

/**
 * Client address for the rate limits. Takes the LAST X-Forwarded-For entry: that is the one the
 * reverse proxy wrote. The first entries can be anything the client sent itself, and a client
 * could otherwise get a fresh rate-limit key on every request. See DEPLOY.md, reverse proxy
 * requirements.
 */
export function clientIp(request: Request): string {
  const parts = (request.headers.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] || "unknown";
}
