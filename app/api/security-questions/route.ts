import { NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { eq } from "drizzle-orm";
import { orm, userSecurityQuestion, withUser } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { rejectCrossSite } from "@/lib/auth/request";
import { hashSecurityAnswer } from "@/lib/security-questions-server";
import { getApiLocale } from "@/lib/i18n/api-locale";

// /api/security-questions - the logged-in user's own security questions, used
// by the mandatory setup step in the protected layout. Answers are stored only
// as hashes (lib/security-questions-server.ts).

/** GET: whether the user has set up both questions. */
export async function GET(request: NextRequest) {
  const t = await getTranslations({
    locale: getApiLocale(request),
    namespace: "apiErrors.securityQuestions",
  });
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: t("notAuthenticated") }, { status: 401 });
  }

  try {
    const rows = await withUser(user.id, (db) =>
      orm(db)
        .select({ id: userSecurityQuestion.userSecurityQuestionId })
        .from(userSecurityQuestion)
        .where(eq(userSecurityQuestion.profilesId, user.id)),
    );
    return NextResponse.json({ hasCompleted: rows.length === 2 });
  } catch {
    return NextResponse.json({ error: t("loadError") }, { status: 500 });
  }
}

/** POST: saves two answers to two different questions, replacing earlier ones. */
export async function POST(request: NextRequest) {
  const t = await getTranslations({
    locale: getApiLocale(request),
    namespace: "apiErrors.securityQuestions",
  });

  const forbidden = rejectCrossSite(request);
  if (forbidden) return forbidden;

  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: t("notAuthenticated") }, { status: 401 });
    }

    let body: {
      answers?: Array<{ questionId: number; answer: string }>;
    };

    try {
      body = (await request.json()) as {
        answers?: Array<{ questionId: number; answer: string }>;
      };
    } catch {
      return NextResponse.json(
        { error: t("invalidRequest") },
        { status: 400 },
      );
    }

    if (!body.answers || body.answers.length !== 2) {
      return NextResponse.json(
        { error: t("needTwoQuestions") },
        { status: 400 },
      );
    }

    const distinctQuestionIds = new Set(
      body.answers.map((entry) => entry.questionId),
    );

    if (
      distinctQuestionIds.size !== 2 ||
      body.answers.some(
        (entry) =>
          !Number.isInteger(entry.questionId) ||
          entry.questionId <= 0 ||
          typeof entry.answer !== "string" ||
          entry.answer.trim().length === 0,
      )
    ) {
      return NextResponse.json(
        { error: t("needTwoDifferentQuestions") },
        { status: 400 },
      );
    }

    const answers = body.answers;
    try {
      // Replace both answers in one transaction
      await withUser(user.id, async (db) => {
        const q = orm(db);
        await q.delete(userSecurityQuestion).where(eq(userSecurityQuestion.profilesId, user.id));
        await q.insert(userSecurityQuestion).values(
          answers.map((entry) => ({
            profilesId: user.id,
            securityQuestionId: entry.questionId,
            answerHash: hashSecurityAnswer(entry.answer),
          })),
        );
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : t("internalError") },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("security-questions POST error", error);
    return NextResponse.json(
      { error: t("internalError") },
      { status: 500 },
    );
  }
}
