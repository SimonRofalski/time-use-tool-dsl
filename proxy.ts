import { NextResponse, type NextRequest } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import { withService } from "@/lib/db";
import { sessionIdFromToken } from "@/lib/auth/core";
import { sessionCookieName } from "@/lib/auth/session";

/**
 * Next.js proxy (formerly middleware) entry point: locale negotiation + auth gating.
 * Must live in the project root; Next.js does not pick it up inside app/.
 * Runs in the Node.js runtime (Next.js 16 default), so it can use lib/db.
 *
 * What happens per request:
 * - For a logged-in user, sync their saved `profiles.locale` into the
 *   NEXT_LOCALE cookie so next-intl's middleware picks it up. Anonymous
 *   visitors fall back to next-intl's own Accept-Language negotiation.
 * - Run next-intl's routing (no visible URL prefix, see i18n/routing.ts).
 * - Redirect anonymous users away from the protected pages to `/`.
 *
 * The session lookup is one indexed query (session id + profile locale). It only decides
 * redirects and the language; every page, Server Action and route checks the session itself.
 */
const intlMiddleware = createIntlMiddleware(routing);

// Visible paths of the (protected) route group (route groups don't appear in the URL)
const PROTECTED_PATHS = [
  "/zeiterfassung",
  "/erfasste-zeit",
  "/statistiken",
  "/admin",
  "/settings",
];

/** Whether the cookie belongs to a valid session, plus the user's saved locale. Errors count as logged out. */
async function sessionLocale(token: string | undefined): Promise<{ loggedIn: boolean; locale: string | null }> {
  if (!token) return { loggedIn: false, locale: null };
  try {
    const rows = await withService(
      (db) =>
        db.query<{ locale: string | null }>(
          `SELECT p.locale FROM public.user_session s LEFT JOIN public.profiles p ON p.id = s.user_id
            WHERE s.id = $1 AND s.expires_at > now()`,
          [sessionIdFromToken(token)],
        ),
      { readOnly: true },
    );
    return rows[0] ? { loggedIn: true, locale: rows[0].locale } : { loggedIn: false, locale: null };
  } catch {
    return { loggedIn: false, locale: null };
  }
}

export async function proxy(request: NextRequest) {
  // API routes aren't locale-scoped pages: skip straight through.
  if (request.nextUrl.pathname.startsWith("/api")) {
    return NextResponse.next();
  }

  const { loggedIn, locale } = await sessionLocale(request.cookies.get(sessionCookieName())?.value);
  if (locale) {
    request.cookies.set("NEXT_LOCALE", locale);
  }

  const response = intlMiddleware(request);

  // whole path segments only: "/admin" and "/admin/x" match, "/administration" does not
  const { pathname } = request.nextUrl;
  const isProtectedPath = PROTECTED_PATHS.some(
    (path) => pathname === path || pathname.startsWith(path + "/"),
  );
  if (!loggedIn && isProtectedPath) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

// Skip framework internals and static files (extensions); avoids running
// the session/locale checks on every JS chunk, image, etc.
export const config = {
  matcher: ["/((?!_next|.*\\..*).*)"],
};
