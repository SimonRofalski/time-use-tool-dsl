import { NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/admin/auth";
import { withService } from "@/lib/db";
import { hashPassword, passwordProblem } from "@/lib/auth/core";
import { rejectCrossSite } from "@/lib/auth/request";
import { getApiLocale } from "@/lib/i18n/api-locale";

// POST /api/admin/users/set-password - an admin sets a temporary password
// (Nutzeruebersicht tab). Forces must_change_password and ends all sessions of
// the user. An edu-ID account is only converted to a password account with
// `force: true` (the UI asks for confirmation on the 409).

type SetPasswordBody = {
  userId?: string;
  temporaryPassword?: string;
  force?: boolean;
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

  const body = (await request.json()) as SetPasswordBody;

  if (!body.userId) {
    return NextResponse.json({ error: t("invalidRequest") }, { status: 400 });
  }

  if (!body.temporaryPassword || body.temporaryPassword.length < 6) {
    return NextResponse.json({ error: t("passwordTooShort") }, { status: 400 });
  }
  const problem = passwordProblem(body.temporaryPassword);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  if (!UUID_RE.test(body.userId)) {
    return NextResponse.json({ error: t("userNotFound") }, { status: 404 });
  }
  const targetId = body.userId;
  const passwordHash = await hashPassword(body.temporaryPassword);

  const outcome = await withService(async (db) => {
    const [target] = await db.query<{ auth_provider: string }>(
      "SELECT auth_provider FROM public.profiles WHERE id = $1",
      [targetId],
    );
    if (!target) return "not_found" as const;
    if (target.auth_provider === "switch_edu_id" && !body.force) return "needs_force" as const;

    await db.query("UPDATE public.app_user SET password_hash = $2 WHERE id = $1", [targetId, passwordHash]);
    await db.query(
      `UPDATE public.profiles
          SET must_change_password = true,
              auth_provider = CASE WHEN $2 THEN 'password' ELSE auth_provider END
        WHERE id = $1`,
      [targetId, target.auth_provider === "switch_edu_id" && !!body.force],
    );
    await db.query(
      "INSERT INTO public.admin_password_reset_log (target_profile_id, triggered_by_profile_id, action) VALUES ($1, $2, 'admin_set_password')",
      [targetId, adminUserId],
    );
    // The person has to log in again with the temporary password
    await db.query("DELETE FROM public.user_session WHERE user_id = $1", [targetId]);
    return "ok" as const;
  });

  if (outcome === "not_found") {
    return NextResponse.json({ error: t("userNotFound") }, { status: 404 });
  }
  if (outcome === "needs_force") {
    return NextResponse.json(
      { error: t("switchEduIdAccountNeedsForce") },
      { status: 409 },
    );
  }

  return NextResponse.json({ success: true });
}
