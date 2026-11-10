import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";

// GET /api/auth/session - current user for client components (lib/auth/client.ts),
// or null. Field names keep the former auth user object's shape.
export async function GET() {
  const user = await getSessionUser();
  return NextResponse.json(
    {
      user: user
        ? { id: user.id, email: user.email, last_sign_in_at: user.lastSignInAt, created_at: user.createdAt }
        : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
