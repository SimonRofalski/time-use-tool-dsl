// Database sessions: a random token in an HttpOnly cookie, its hash in public.user_session.
// Server-only: used by route handlers, Server Actions and Server Components.
import { cache } from "react";
import { cookies } from "next/headers";
import { withService } from "@/lib/db";
import { newSessionToken, sessionExpiry, sessionIdFromToken, SESSION_TOUCH_INTERVAL_MS } from "./core";

/** Secure cookies (and the __Host- prefix) whenever the app is served over https. */
function isSecureOrigin(): boolean {
  const origin = process.env.APP_ORIGIN;
  if (origin) return origin.startsWith("https://");
  return process.env.NODE_ENV === "production";
}

/** __Host- prefix in production (OWASP): only sent to this exact host, Path=/, Secure. */
export function sessionCookieName(): string {
  return isSecureOrigin() ? "__Host-tut_session" : "tut_session";
}

// The browser keeps the cookie long; the server enforces the inactivity timeout (expires_at).
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

export type SessionUser = {
  id: string;
  email: string;
  lastSignInAt: string | null;
  createdAt: string;
  role: string | null;
  mustChangePassword: boolean;
  authProvider: string | null;
  locale: string | null;
  sessionId: string;
};

/**
 * Creates a session for the user and sets the cookie. Call only after a successful login.
 * markSignIn (default true) also updates app_user.last_sign_in_at.
 */
export async function createSession(userId: string, opts: { markSignIn?: boolean } = { markSignIn: true }) {
  const token = newSessionToken();
  const id = sessionIdFromToken(token);
  await withService(async (db) => {
    await db.query("INSERT INTO public.user_session (id, user_id, expires_at) VALUES ($1, $2, $3)", [id, userId, sessionExpiry()]);
    if (opts.markSignIn !== false) {
      await db.query("UPDATE public.app_user SET last_sign_in_at = now() WHERE id = $1", [userId]);
    }
  });
  const store = await cookies();
  store.set(sessionCookieName(), token, {
    httpOnly: true,
    secure: isSecureOrigin(),
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
  });
  return id;
}

/** The logged-in user of this request, or null. Memoized per render pass (Next.js DAL pattern). */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!token) return null;
  const id = sessionIdFromToken(token);
  return withService(async (db) => {
    const rows = await db.query<{
      user_id: string; expires_at: string; last_seen_at: string; email: string; last_sign_in_at: string | null;
      created_at: string; role: string | null; must_change_password: boolean | null; auth_provider: string | null; locale: string | null;
    }>(
      `SELECT s.user_id, s.expires_at, s.last_seen_at, u.email, u.last_sign_in_at, u.created_at,
              p.role, p.must_change_password, p.auth_provider, p.locale
         FROM public.user_session s
         JOIN public.app_user u ON u.id = s.user_id
         LEFT JOIN public.profiles p ON p.id = s.user_id
        WHERE s.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    const now = Date.now();
    if (new Date(row.expires_at).getTime() <= now) {
      await db.query("DELETE FROM public.user_session WHERE id = $1", [id]);
      return null;
    }
    if (now - new Date(row.last_seen_at).getTime() > SESSION_TOUCH_INTERVAL_MS) {
      await db.query("UPDATE public.user_session SET last_seen_at = now(), expires_at = $2 WHERE id = $1", [id, sessionExpiry()]);
      // Opportunistic cleanup (there is no cron job): expired sessions and old attempt rows
      await db.query("DELETE FROM public.user_session WHERE expires_at < now()");
      await db.query("DELETE FROM public.auth_attempt WHERE attempted_at < now() - interval '1 day'");
    }
    return {
      id: row.user_id,
      email: row.email,
      lastSignInAt: row.last_sign_in_at,
      createdAt: row.created_at,
      role: row.role,
      mustChangePassword: row.must_change_password ?? false,
      authProvider: row.auth_provider,
      locale: row.locale,
      sessionId: id,
    };
  });
});

/** Logout: deletes the session in the DB and clears the cookie. */
export async function deleteCurrentSession() {
  const store = await cookies();
  const token = store.get(sessionCookieName())?.value;
  if (token) {
    await withService((db) => db.query("DELETE FROM public.user_session WHERE id = $1", [sessionIdFromToken(token)]));
  }
  store.set(sessionCookieName(), "", { httpOnly: true, secure: isSecureOrigin(), sameSite: "lax", path: "/", maxAge: 0 });
}

/** Ends all sessions of a user, optionally except one (e.g. the current one after a password change). */
export async function deleteSessionsOfUser(userId: string, exceptSessionId?: string) {
  await withService((db) =>
    db.query("DELETE FROM public.user_session WHERE user_id = $1 AND id IS DISTINCT FROM $2", [userId, exceptSessionId ?? null]),
  );
}
