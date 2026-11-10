import { NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/admin/auth";
import { pgErrorCode, withService } from "@/lib/db";
import { rejectCrossSite } from "@/lib/auth/request";
import { getApiLocale } from "@/lib/i18n/api-locale";

// POST /api/admin/users/delete - an admin permanently deletes an account
// (Nutzeruebersicht tab). Admins cannot delete themselves.

type DeleteUserBody = {
  userId?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const t = await getTranslations({
    locale: getApiLocale(request),
    namespace: "apiErrors.adminUsers",
  });

  const forbidden = rejectCrossSite(request);
  if (forbidden) return forbidden;

  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }
  const { userId: adminUserId } = guard.ctx;

  const body = (await request.json()) as DeleteUserBody;

  if (!body.userId) {
    return NextResponse.json({ error: t("invalidRequest") }, { status: 400 });
  }

  if (body.userId === adminUserId) {
    return NextResponse.json({ error: t("cannotDeleteSelf") }, { status: 400 });
  }

  if (!UUID_RE.test(body.userId)) {
    return NextResponse.json({ error: t("deleteFailed") }, { status: 400 });
  }
  const targetId = body.userId;

  try {
    // Deleting the login account cascades to the profile and all data of the person
    await withService((db) => db.query("DELETE FROM public.app_user WHERE id = $1", [targetId]));
  } catch (error) {
    // a table referencing profiles.id without ON DELETE CASCADE -> clear 409 instead of a bare 500
    if (pgErrorCode(error) === "23503") {
      return NextResponse.json({ error: error instanceof Error ? error.message : t("deleteFailed") }, { status: 409 });
    }
    return NextResponse.json({ error: t("deleteFailed") }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
