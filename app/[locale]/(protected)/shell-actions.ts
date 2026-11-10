"use server";
// Server Actions of the protected layout (header, onboarding gates, tutorial, language).
// Each returns the row shape layout.tsx expects (the former PostgREST shape, snake_case keys).
// The user is always taken from the session, never from the caller; RLS applies via withUser.
import { and, eq } from "drizzle-orm";
import { course, orm, profiles, userCourse, userData, userSecurityQuestion, withUser } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";

/** profiles: role, first_name, last_name; null unless exactly one row */
export async function loadProfileBasics() {
  const user = await getSessionUser();
  if (!user) return null;
  const rows = await withUser(user.id, (db) =>
    orm(db)
      .select({ role: profiles.role, first_name: profiles.firstName, last_name: profiles.lastName })
      .from(profiles)
      .where(eq(profiles.id, user.id)),
  );
  return rows.length === 1 ? rows[0] : null;
}

/** profiles.tutorial_completed_at; on error the layout treats the tour as seen (never auto-shown) */
export async function loadTutorialState(): Promise<{ data: { tutorial_completed_at: string | null } | null; error: boolean }> {
  const user = await getSessionUser();
  if (!user) return { data: null, error: true };
  try {
    const rows = await withUser(user.id, (db) =>
      orm(db).select({ tutorial_completed_at: profiles.tutorialCompletedAt }).from(profiles).where(eq(profiles.id, user.id)),
    );
    return rows.length === 1 ? { data: rows[0], error: false } : { data: null, error: true };
  } catch {
    return { data: null, error: true };
  }
}

/** profiles: must_change_password, auth_provider */
export async function loadAuthState() {
  const user = await getSessionUser();
  if (!user) return null;
  const rows = await withUser(user.id, (db) =>
    orm(db)
      .select({ must_change_password: profiles.mustChangePassword, auth_provider: profiles.authProvider })
      .from(profiles)
      .where(eq(profiles.id, user.id)),
  );
  return rows.length === 1 ? rows[0] : null;
}

/** true if a user_data row exists (profile details completed); false on error */
export async function hasProfileDetails() {
  const user = await getSessionUser();
  if (!user) return false;
  try {
    const rows = await withUser(user.id, (db) =>
      orm(db).select({ id: userData.userDataId }).from(userData).where(eq(userData.profilesId, user.id)).limit(1),
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** number of saved security question answers; null on error (the layout treats that as "missing") */
export async function countSecurityQuestions(): Promise<number | null> {
  const user = await getSessionUser();
  if (!user) return null;
  try {
    const rows = await withUser(user.id, (db) =>
      orm(db)
        .select({ id: userSecurityQuestion.userSecurityQuestionId })
        .from(userSecurityQuestion)
        .where(eq(userSecurityQuestion.profilesId, user.id)),
    );
    return rows.length;
  } catch {
    return null;
  }
}

/** user_course + course name; null unless exactly one enrollment */
export async function loadEnrollment(): Promise<{ user_course_id: string; course: { name: string } | null } | null> {
  const user = await getSessionUser();
  if (!user) return null;
  const rows = await withUser(user.id, (db) =>
    orm(db)
      .select({ user_course_id: userCourse.userCourseId, name: course.name })
      .from(userCourse)
      .leftJoin(course, eq(course.courseId, userCourse.courseId))
      .where(eq(userCourse.profilesId, user.id)),
  );
  if (rows.length !== 1) return null;
  return { user_course_id: rows[0].user_course_id, course: rows[0].name === null ? null : { name: rows[0].name } };
}

/** marks the guided tour as seen (finish or skip) */
export async function markTutorialCompleted() {
  const user = await getSessionUser();
  if (!user) return;
  await withUser(user.id, (db) =>
    orm(db).update(profiles).set({ tutorialCompletedAt: new Date().toISOString() }).where(eq(profiles.id, user.id)),
  );
}

/** saves the chosen language (cross-device source of truth) */
export async function updateLocale(locale: "de" | "en") {
  if (locale !== "de" && locale !== "en") return;
  const user = await getSessionUser();
  if (!user) return;
  await withUser(user.id, (db) =>
    orm(db).update(profiles).set({ locale }).where(and(eq(profiles.id, user.id))),
  );
}
