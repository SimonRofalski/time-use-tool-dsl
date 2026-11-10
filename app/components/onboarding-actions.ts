"use server";
// Server Actions for the onboarding forms (SecurityQuestionsForm, EnrollmentModal).
// Read-only queries as the logged-in user (withUser), so RLS decides what is visible.
import { asc, desc, eq } from "drizzle-orm";
import { course, orm, securityQuestion, userSecurityQuestion, withUser } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";

type Result<T> = { data: T | null; error: boolean };

/** Selectable security questions, ordered by sort_order, id (RLS: participants see only active ones). */
export async function listSecurityQuestionOptions(): Promise<Result<{ security_question_id: number; question_text: string }[]>> {
  const user = await getSessionUser();
  if (!user) return { data: null, error: true };
  try {
    const data = await withUser(user.id, (db) =>
      orm(db)
        .select({ security_question_id: securityQuestion.securityQuestionId, question_text: securityQuestion.questionText })
        .from(securityQuestion)
        .orderBy(asc(securityQuestion.sortOrder), asc(securityQuestion.securityQuestionId)),
    );
    return { data, error: false };
  } catch {
    return { data: null, error: true };
  }
}

/** The user's own saved questions (ids only, never answers), oldest first. */
export async function loadOwnSecurityQuestions(): Promise<Result<{ user_security_question_id: string; security_question_id: number }[]>> {
  const user = await getSessionUser();
  if (!user) return { data: null, error: true };
  try {
    const data = await withUser(user.id, (db) =>
      orm(db)
        .select({
          user_security_question_id: userSecurityQuestion.userSecurityQuestionId,
          security_question_id: userSecurityQuestion.securityQuestionId,
        })
        .from(userSecurityQuestion)
        .where(eq(userSecurityQuestion.profilesId, user.id))
        .orderBy(asc(userSecurityQuestion.createdAt)),
    );
    return { data, error: false };
  } catch {
    return { data: null, error: true };
  }
}

/** Courses open for enrollment (not locked), newest first. Access codes are not part of this. */
export async function listOpenCourses(): Promise<Result<{ course_id: number; name: string; start_date: string; end_date: string }[]>> {
  const user = await getSessionUser();
  if (!user) return { data: null, error: true };
  try {
    const data = await withUser(user.id, (db) =>
      orm(db)
        .select({ course_id: course.courseId, name: course.name, start_date: course.startDate, end_date: course.endDate })
        .from(course)
        .where(eq(course.isLocked, false))
        .orderBy(desc(course.startDate)),
    );
    return { data, error: false };
  } catch {
    return { data: null, error: true };
  }
}
