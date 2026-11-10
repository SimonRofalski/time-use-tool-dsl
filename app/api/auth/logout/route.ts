import { NextResponse } from "next/server";
import { deleteCurrentSession } from "@/lib/auth/session";
import { rejectCrossSite } from "@/lib/auth/request";

// POST /api/auth/logout - deletes the session server-side and clears the cookie.
export async function POST(request: Request) {
  const forbidden = rejectCrossSite(request);
  if (forbidden) return forbidden;
  await deleteCurrentSession();
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store", "Clear-Site-Data": '"cookies"' } });
}
