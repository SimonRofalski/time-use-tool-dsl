import { NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { withService } from "@/lib/db";
import { rejectCrossSite } from "@/lib/auth/request";
import {
  createResetChallengeToken,
  getResetChallengeExpirationDate,
  hashResetChallengeToken,
  verifySecurityAnswer,
} from "@/lib/security-questions-server";
import {
  clearResetAttempts,
  hashResetEmail,
  isResetLocked,
  recordFailedResetAttempt,
  resolveProfileIdByEmail,
} from "@/lib/password-reset-server";
import { getApiLocale } from "@/lib/i18n/api-locale";

type VerifyBody = {
  email?: string;
  answers?: Array<{ questionId: number; answer: string }>;
};

// POST /api/password-reset/verify - second step of the reset: checks the two
// answers and returns a one-time token for ../complete. Unknown emails, accounts without questions and
// wrong answers all get the same response, and every failure counts towards
// the lock (5 within 15 minutes, see lib/password-reset-server.ts).
export async function POST(request: NextRequest) {
  const t = await getTranslations({
    locale: getApiLocale(request),
    namespace: "apiErrors.passwordResetVerify",
  });

  const forbidden = rejectCrossSite(request);
  if (forbidden) return forbidden;

  const body = (await request.json()) as VerifyBody;
  const email = body.email?.trim();

  if (!email || !body.answers || body.answers.length !== 2) {
    return NextResponse.json(
      { error: t("answerBothRequired") },
      { status: 400 },
    );
  }
  const answers = body.answers;
  const emailHash = hashResetEmail(email);

  const outcome = await withService(async (db) => {
    if (await isResetLocked(db, emailHash)) return { kind: "locked" as const };

    const profileId = await resolveProfileIdByEmail(db, email);
    const storedRows = profileId
      ? await db.query<{ security_question_id: number; answer_hash: string }>(
          "SELECT security_question_id, answer_hash FROM public.user_security_question WHERE profiles_id = $1",
          [profileId],
        )
      : null;

    const answerMap = new Map(answers.map((entry) => [entry.questionId, entry.answer]));
    const allAnswersMatch =
      !!storedRows &&
      storedRows.length === 2 &&
      storedRows.every((row) => {
        const candidate = answerMap.get(row.security_question_id) ?? "";
        return verifySecurityAnswer(String(candidate), row.answer_hash);
      });

    if (!profileId || !allAnswersMatch) {
      await recordFailedResetAttempt(db, emailHash);
      return { kind: "wrong" as const };
    }

    await clearResetAttempts(db, emailHash);

    // Only the hash is stored; older unused challenges of the account are replaced
    const rawToken = createResetChallengeToken();
    await db.query(
      "DELETE FROM public.security_question_reset_challenge WHERE profiles_id = $1 AND consumed_at IS NULL",
      [profileId],
    );
    await db.query(
      "INSERT INTO public.security_question_reset_challenge (profiles_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [profileId, hashResetChallengeToken(rawToken), getResetChallengeExpirationDate()],
    );
    return { kind: "ok" as const, token: rawToken };
  }).catch((error) => {
    console.error("password-reset verify error", error);
    return { kind: "failed" as const };
  });

  if (outcome.kind === "locked") {
    return NextResponse.json({ error: t("tooManyAttempts") }, { status: 429 });
  }
  if (outcome.kind === "wrong") {
    return NextResponse.json({ error: t("answersDontMatch") }, { status: 401 });
  }
  if (outcome.kind === "failed") {
    return NextResponse.json({ error: t("resetPrepareFailed") }, { status: 500 });
  }

  // Only the one-time token goes back: the complete step finds the profile
  // through the token, the profile ID never leaves the server
  return NextResponse.json({ token: outcome.token });
}
