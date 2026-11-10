import { NextResponse } from "next/server";
import { withService } from "@/lib/db";
import { DUMMY_PASSWORD_HASH, normalizeEmail, verifyPassword } from "@/lib/auth/core";
import { createSession } from "@/lib/auth/session";
import { clientIp, isRateLimited, rejectCrossSite } from "@/lib/auth/request";

// POST /api/auth/login - password sign-in; sets the session cookie on success.
// Error texts match the former auth service because the login page maps them
// ("Invalid login credentials" -> translated wrong-credentials message).
export async function POST(request: Request) {
  const forbidden = rejectCrossSite(request);
  if (forbidden) return forbidden;

  const body = (await request.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json({ error: "missing email or phone" }, { status: 400 });
  }

  if (await isRateLimited("signin", `${clientIp(request)}|${email}`, 30, 5)) {
    return NextResponse.json({ error: "Request rate limit reached" }, { status: 429 });
  }

  const rows = await withService((db) =>
    db.query<{ id: string; password_hash: string | null }>(
      "SELECT id, password_hash FROM public.app_user WHERE lower(email) = $1",
      [email],
    ),
  );
  const user = rows[0];
  // Compare against a dummy hash when the account does not exist: same response time either way
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!user || !user.password_hash || !ok) {
    return NextResponse.json({ error: "Invalid login credentials" }, { status: 400 });
  }

  await createSession(user.id);
  return NextResponse.json({ user: { id: user.id } }, { headers: { "Cache-Control": "no-store" } });
}
