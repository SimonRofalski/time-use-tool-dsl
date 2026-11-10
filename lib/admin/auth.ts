import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { orm, profiles, withUser } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";

// --- Admin guard for route handlers ---
// Verifies the calling session belongs to an admin (profiles.role = 'admin').
//
// Data protection: per the ethics review, admins must not see personal
// time-use data. Statistics and exports are therefore computed ONLY on the
// server and reach the browser aggregated / de-identified. The one exception
// is the research export (lib/admin/research-export.ts): pseudonymised via a
// PersonID, without names and e-mails.

type AdminContext = {
  userId: string;
};

/** Admin context, or a ready 401/403 response the route returns as-is. */
export async function requireAdmin(): Promise<
  { ok: true; ctx: AdminContext } | { ok: false; response: NextResponse }
> {
  const user = await getSessionUser();

  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 }),
    };
  }

  // Role is read with the caller's own (RLS-restricted) access; users can
  // always read their own profile row.
  const rows = await withUser(user.id, (db) =>
    orm(db).select({ role: profiles.role }).from(profiles).where(eq(profiles.id, user.id)),
  );

  if (rows[0]?.role !== "admin") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Keine Berechtigung." },
        { status: 403 },
      ),
    };
  }

  return { ok: true, ctx: { userId: user.id } };
}
