import { NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { withService } from "@/lib/db";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/core";
import { clientIp, isRateLimited, rejectCrossSite } from "@/lib/auth/request";
import { deleteSessionsOfUser, getSessionUser } from "@/lib/auth/session";
import { getApiLocale } from "@/lib/i18n/api-locale";

type ChangePasswordBody = {
  currentPassword?: string;
  newPassword?: string;
};

// POST /api/auth/change-password - own password change (also the forced
// change after an admin-set password, see MustChangePasswordForm).
// The current password is required: without it, anyone holding someone else's
// session could set a password of their own and keep the account.
export async function POST(request: NextRequest) {
  const t = await getTranslations({
    locale: getApiLocale(request),
    namespace: "apiErrors.changePassword",
  });

  const forbidden = rejectCrossSite(request);
  if (forbidden) return forbidden;

  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: t("notAuthenticated") }, { status: 401 });
  }

  const body = (await request.json()) as ChangePasswordBody;

  if (!body.newPassword || body.newPassword.length < 6) {
    return NextResponse.json({ error: t("passwordTooShort") }, { status: 400 });
  }

  // Checking the current password is a sign-in attempt: same limit as the login
  if (await isRateLimited("signin", `${clientIp(request)}|${user.email.toLowerCase()}`, 30, 5)) {
    return NextResponse.json({ error: "Request rate limit reached" }, { status: 429 });
  }

  const rows = await withService((db) =>
    db.query<{ password_hash: string | null }>("SELECT password_hash FROM public.app_user WHERE id = $1", [user.id]),
  );
  if (!body.currentPassword || !(await verifyPassword(body.currentPassword, rows[0]?.password_hash ?? null))) {
    return NextResponse.json(
      { error: t("currentPasswordWrong") },
      { status: 400 },
    );
  }

  if (body.currentPassword === body.newPassword) {
    return NextResponse.json({ error: t("newPasswordSameAsCurrent") }, { status: 400 });
  }

  const problem = passwordProblem(body.newPassword);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  // Password + clearing must_change_password in one transaction (profiles.must_change_password can
  // only be written by the server, see db/migrations/0003_access_model.sql)
  const passwordHash = await hashPassword(body.newPassword);
  await withService(async (db) => {
    await db.query("UPDATE public.app_user SET password_hash = $2 WHERE id = $1", [user.id, passwordHash]);
    await db.query("UPDATE public.profiles SET must_change_password = false WHERE id = $1", [user.id]);
  });
  // Other devices are logged out; the current session stays
  await deleteSessionsOfUser(user.id, user.sessionId);

  return NextResponse.json({ success: true });
}
