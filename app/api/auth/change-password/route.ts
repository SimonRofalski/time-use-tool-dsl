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
// Exception: the forced change (must_change_password) within FRESH_SESSION_MINUTES of signing in.
// The person has just typed the temporary password to get this session, so asking again adds
// nothing. An older session must confirm it again; the response then says
// currentPasswordRequired: true and the form shows the field.
const FRESH_SESSION_MINUTES = 30;
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

  const [state] = await withService((db) =>
    db.query<{ password_hash: string | null; forced_and_fresh: boolean }>(
      `SELECT a.password_hash,
              (p.must_change_password AND s.created_at > now() - make_interval(mins => $3)) AS forced_and_fresh
         FROM public.app_user a
         JOIN public.profiles p ON p.id = a.id
         JOIN public.user_session s ON s.id = $2 AND s.user_id = a.id
        WHERE a.id = $1`,
      [user.id, user.sessionId, FRESH_SESSION_MINUTES],
    ),
  );
  const passwordHash = state?.password_hash ?? null;

  if (!state?.forced_and_fresh) {
    if (!body.currentPassword) {
      return NextResponse.json(
        { error: t("currentPasswordWrong"), currentPasswordRequired: true },
        { status: 400 },
      );
    }
    // Checking the current password is a sign-in attempt: same limit as the login
    if (await isRateLimited("signin", `${clientIp(request)}|${user.email.toLowerCase()}`, 30, 5)) {
      return NextResponse.json({ error: "Request rate limit reached" }, { status: 429 });
    }
    if (!(await verifyPassword(body.currentPassword, passwordHash))) {
      return NextResponse.json(
        { error: t("currentPasswordWrong"), currentPasswordRequired: true },
        { status: 400 },
      );
    }
  }

  // The new password must differ from the current (temporary) one
  if (await verifyPassword(body.newPassword, passwordHash)) {
    return NextResponse.json({ error: t("newPasswordSameAsCurrent") }, { status: 400 });
  }

  const problem = passwordProblem(body.newPassword);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  // Password + clearing must_change_password in one transaction (profiles.must_change_password can
  // only be written by the server, see db/migrations/0003_access_model.sql)
  const newHash = await hashPassword(body.newPassword);
  await withService(async (db) => {
    await db.query("UPDATE public.app_user SET password_hash = $2 WHERE id = $1", [user.id, newHash]);
    await db.query("UPDATE public.profiles SET must_change_password = false WHERE id = $1", [user.id]);
  });
  // Other devices are logged out; the current session stays
  await deleteSessionsOfUser(user.id, user.sessionId);

  return NextResponse.json({ success: true });
}
