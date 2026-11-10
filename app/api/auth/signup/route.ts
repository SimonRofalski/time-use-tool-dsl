import { NextResponse } from "next/server";
import { pgErrorCode, withService } from "@/lib/db";
import { hashPassword, normalizeEmail, passwordProblem } from "@/lib/auth/core";
import { createSession } from "@/lib/auth/session";
import { clientIp, isRateLimited, rejectCrossSite } from "@/lib/auth/request";

// POST /api/auth/signup - self sign-up with e-mail and password. No e-mail confirmation: the new
// account is logged in immediately; the profile row is created by the trigger on app_user
// (handle_new_user). Error texts match the former auth service; the login page shows them as they are.
export async function POST(request: Request) {
  const forbidden = rejectCrossSite(request);
  if (forbidden) return forbidden;

  const body = (await request.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (await isRateLimited("signup", clientIp(request), 30, 5)) {
    return NextResponse.json({ error: "Request rate limit reached" }, { status: 429 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Unable to validate email address: invalid format" }, { status: 400 });
  }
  const problem = passwordProblem(password);
  if (problem) return NextResponse.json({ error: problem }, { status: 422 });

  const passwordHash = await hashPassword(password);
  let userId: string;
  try {
    const rows = await withService((db) =>
      db.query<{ id: string }>("INSERT INTO public.app_user (email, password_hash) VALUES ($1, $2) RETURNING id", [email, passwordHash]),
    );
    userId = rows[0].id;
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return NextResponse.json({ error: "User already registered" }, { status: 422 });
    }
    throw error;
  }

  await createSession(userId);
  return NextResponse.json({ user: { id: userId }, session: true }, { headers: { "Cache-Control": "no-store" } });
}
