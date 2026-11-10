import { NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/admin/auth";
import { pgErrorCode, withService } from "@/lib/db";
import { hashPassword, normalizeEmail, PASSWORD_MIN_LENGTH, passwordProblem } from "@/lib/auth/core";
import { rejectCrossSite } from "@/lib/auth/request";
import { getApiLocale } from "@/lib/i18n/api-locale";

// POST /api/admin/users/create - an admin creates a password account
// (Nutzeruebersicht tab, for people without SWITCH edu-ID). The temporary
// password sets must_change_password, so the user has to choose a new one
// at the first login.

type CreateUserBody = {
  email?: string;
  firstName?: string;
  lastName?: string;
  temporaryPassword?: string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const body = (await request.json()) as CreateUserBody;

  if (!body.email || !EMAIL_PATTERN.test(body.email)) {
    return NextResponse.json({ error: t("invalidEmail") }, { status: 400 });
  }

  if (!body.temporaryPassword || body.temporaryPassword.length < PASSWORD_MIN_LENGTH) {
    // same minimum as passwordProblem, but with the translated message
    return NextResponse.json({ error: t("passwordTooShort") }, { status: 400 });
  }
  const problem = passwordProblem(body.temporaryPassword);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const email = normalizeEmail(body.email);
  const passwordHash = await hashPassword(body.temporaryPassword);

  // Account, profile update and audit log entry in one transaction
  let createdId: string;
  try {
    createdId = await withService(async (db) => {
      const [created] = await db.query<{ id: string }>(
        "INSERT INTO public.app_user (email, password_hash) VALUES ($1, $2) RETURNING id",
        [email, passwordHash],
      );
      // the profile row was created by the trigger on app_user (handle_new_user)
      await db.query(
        `UPDATE public.profiles
            SET auth_provider = 'password', must_change_password = true,
                first_name = COALESCE(NULLIF($2, ''), first_name),
                last_name  = COALESCE(NULLIF($3, ''), last_name)
          WHERE id = $1`,
        [created.id, body.firstName ?? "", body.lastName ?? ""],
      );
      await db.query(
        "INSERT INTO public.admin_password_reset_log (target_profile_id, triggered_by_profile_id, action) VALUES ($1, $2, 'admin_created_account')",
        [created.id, adminUserId],
      );
      return created.id;
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      // Unique violation on the e-mail; same text as the former auth service,
      // shown as-is in the create dialog
      return NextResponse.json({ error: "A user with this email address has already been registered" }, { status: 400 });
    }
    console.error("admin create user failed", error);
    return NextResponse.json({ error: t("createFailed") }, { status: 500 });
  }

  return NextResponse.json({ success: true, userId: createdId });
}
