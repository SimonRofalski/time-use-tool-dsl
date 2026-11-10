import { NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { withService } from "@/lib/db";
import { hashPassword, passwordProblem } from "@/lib/auth/core";
import { rejectCrossSite } from "@/lib/auth/request";
import { hashResetChallengeToken } from "@/lib/security-questions-server";
import { getApiLocale } from "@/lib/i18n/api-locale";

// POST /api/password-reset/complete - last step of the security-question reset:
// sets the new password with the one-time token from ../verify.

type CompleteBody = {
  token?: string;
  password?: string;
};

export async function POST(request: NextRequest) {
  const t = await getTranslations({
    locale: getApiLocale(request),
    namespace: "apiErrors.passwordResetComplete",
  });

  const forbidden = rejectCrossSite(request);
  if (forbidden) return forbidden;

  const body = (await request.json()) as CompleteBody;

  if (!body.token || !body.password) {
    return NextResponse.json({ error: t("invalidRequest") }, { status: 400 });
  }

  if (body.password.length < 6) {
    return NextResponse.json(
      { error: t("passwordTooShort") },
      { status: 400 },
    );
  }
  // Rejects e.g. passwords over 72 bytes, with the former auth service's text
  const problem = passwordProblem(body.password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const password = body.password;
  const tokenHash = hashResetChallengeToken(body.token);
  const passwordHash = await hashPassword(password);

  // One transaction: consume the challenge, set the password, end all sessions of the account
  const outcome = await withService(async (db) => {
    // The profile comes from the challenge row (found via the token hash);
    // the client never sends or sees a profile ID
    const rows = await db.query<{ id: string; profiles_id: string; expires_at: string; consumed_at: string | null }>(
      `SELECT security_question_reset_challenge_id AS id, profiles_id, expires_at, consumed_at
         FROM public.security_question_reset_challenge WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash],
    );
    const challenge = rows.length === 1 ? rows[0] : null;
    if (!challenge || challenge.consumed_at || new Date(challenge.expires_at) < new Date()) {
      return "invalid" as const;
    }
    const updated = await db.query("UPDATE public.app_user SET password_hash = $2 WHERE id = $1 RETURNING id", [
      challenge.profiles_id,
      passwordHash,
    ]);
    if (updated.length !== 1) return "invalid" as const;
    await db.query("UPDATE public.security_question_reset_challenge SET consumed_at = now() WHERE security_question_reset_challenge_id = $1", [challenge.id]);
    await db.query("DELETE FROM public.user_session WHERE user_id = $1", [challenge.profiles_id]);
    return "ok" as const;
  });

  if (outcome === "invalid") {
    return NextResponse.json(
      { error: t("invalidOrExpiredLink") },
      { status: 401 },
    );
  }

  return NextResponse.json({ success: true });
}
