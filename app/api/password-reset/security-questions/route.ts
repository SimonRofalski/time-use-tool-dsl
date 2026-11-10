import { NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { withService } from "@/lib/db";
import { rejectCrossSite } from "@/lib/auth/request";
import { getApiLocale } from "@/lib/i18n/api-locale";
import {
  pickDecoyQuestionIds,
  resolveProfileIdByEmail,
} from "@/lib/password-reset-server";

type QuestionRow = {
  security_question_id: number;
  question_text: string;
};

// POST /api/password-reset/security-questions - first step of the reset:
// returns the two security questions for an email. Always answers the same
// way (for unknown emails or accounts without two questions it returns two
// stable decoy questions), so this endpoint can't be used to find out which
// emails have an account. The profile ID is never returned; the verify step
// takes the email again. See lib/password-reset-server.ts.
export async function POST(request: NextRequest) {
  const t = await getTranslations({
    locale: getApiLocale(request),
    namespace: "apiErrors.passwordResetSecurityQuestions",
  });

  const forbidden = rejectCrossSite(request);
  if (forbidden) return forbidden;

  try {
    const body = (await request.json()) as { email?: string };
    const email = body.email?.trim();

    if (!email) {
      return NextResponse.json(
        { error: t("emailRequired") },
        { status: 400 },
      );
    }

    const result = await withService(async (db) => {
      const allQuestions = await db.query<QuestionRow>(
        "SELECT security_question_id, question_text FROM public.security_question ORDER BY sort_order ASC",
      );
      const questionById = new Map(allQuestions.map((q) => [q.security_question_id, q]));

      let questionIds: number[] = [];
      const profileId = await resolveProfileIdByEmail(db, email);
      if (profileId) {
        const ownQuestions = await db.query<{ security_question_id: number }>(
          "SELECT security_question_id FROM public.user_security_question WHERE profiles_id = $1 ORDER BY created_at ASC",
          [profileId],
        );
        if (ownQuestions.length === 2) {
          questionIds = ownQuestions.map((row) => row.security_question_id);
        }
      }

      if (questionIds.length !== 2) {
        questionIds = pickDecoyQuestionIds(email, allQuestions.map((q) => q.security_question_id));
      }

      return questionIds.map((id) => ({
        questionId: id,
        questionText: questionById.get(id)?.question_text ?? "",
      }));
    }, { readOnly: true });

    return NextResponse.json({ questions: result });
  } catch (error) {
    console.error("password-reset security-questions POST error", error);
    return NextResponse.json({ error: t("loadError") }, { status: 500 });
  }
}
