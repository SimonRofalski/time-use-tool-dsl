// Data access for the admin tabs (Nutzeruebersicht, Kursuebersicht). Called only by
// app/components/admin/admin-actions.ts, which passes the session user id after checking the admin
// role. Queries run as that admin via withUser, so the admin RLS policies apply (e.g. admins see all
// profiles and enrollments, but never other people's time entries).
import { withService, withUser, type Db } from "@/lib/db";

type Row = Record<string, unknown>;

// --- Nutzeruebersicht ---

/** Active profiles, all enrollments (with course + periods), day flags and last sign-in for the user table. */
export async function loadUserOverview(adminId: string) {
  const overview = await withUser(
    adminId,
    async (db) => {
      const profiles = await db.query<{
        id: string; email: string | null; first_name: string | null; last_name: string | null;
        auth_provider: string | null; must_change_password: boolean | null; role: string;
      }>(
        `SELECT id, email, first_name, last_name, auth_provider, must_change_password, role
           FROM public.profiles WHERE is_active = true ORDER BY id`,
      );
      // Course and its periods embedded as JSON
      const userCourses = await db.query<{
        user_course_id: string; profiles_id: string; is_excluded: boolean | null;
        course: { name: string; start_date: string; end_date: string; course_period: { start_date: string; end_date: string }[] } | null;
      }>(
        `SELECT uc.user_course_id, uc.profiles_id, uc.is_excluded,
                (SELECT json_build_object(
                          'name', c.name, 'start_date', c.start_date, 'end_date', c.end_date,
                          'course_period', COALESCE((SELECT json_agg(json_build_object('start_date', p.start_date, 'end_date', p.end_date))
                                                       FROM public.course_period p WHERE p.course_id = c.course_id), '[]'::json))
                   FROM public.course c WHERE c.course_id = uc.course_id) AS course
           FROM public.user_course uc ORDER BY uc.user_course_id`,
      );
      const allDays = await db.query<{ profiles_id: string; is_submitted: boolean }>(
        "SELECT profiles_id, is_submitted FROM public.day ORDER BY day_id",
      );
      return { profiles, userCourses, allDays, viewerId: adminId };
    },
    { readOnly: true },
  );
  // app_user (login accounts) is readable by the server only; the caller has been checked to be an
  // admin (admin-actions.ts). Only the timestamp leaves this function.
  const signIns = await withService(
    (db) => db.query<{ id: string; last_sign_in_at: string | null }>("SELECT id, last_sign_in_at FROM public.app_user"),
    { readOnly: true },
  );
  const lastSignInById: Record<string, string | null> = {};
  for (const r of signIns) lastSignInById[r.id] = r.last_sign_in_at;
  return { ...overview, lastSignInById };
}

/** user_course.is_excluded for the comparison and the exports */
export async function setUserCourseExcluded(adminId: string, userCourseId: string, excluded: boolean) {
  try {
    const rows = await withUser(adminId, (db) =>
      db.query("UPDATE public.user_course SET is_excluded = $2 WHERE user_course_id = $1 RETURNING user_course_id", [userCourseId, excluded]),
    );
    return { error: rows.length ? null : "not found" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unknown" };
  }
}

/**
 * Makes an active user an admin or takes the admin rights away (Nutzeruebersicht).
 * profiles.role is protected against app users by the trigger protect_profiles_auth_fields, so this
 * runs on the service connection; the caller must already be checked to be an admin. Nobody can take
 * away their own admin rights, so there is always at least one admin left.
 */
export async function setUserRole(
  adminId: string,
  targetId: string,
  role: "admin" | "user",
): Promise<{ error: null | "self" | "not_found" | "invalid" | "unknown" }> {
  if (role !== "admin" && role !== "user") return { error: "invalid" };
  if (targetId === adminId && role === "user") return { error: "self" };
  try {
    const rows = await withService((db) =>
      db.query("UPDATE public.profiles SET role = $2 WHERE id = $1 AND is_active RETURNING id", [targetId, role]),
    );
    return { error: rows.length ? null : "not_found" };
  } catch {
    return { error: "unknown" };
  }
}

// --- Shared helper for the Kursuebersicht functions ---

/** Runs fn as the admin (withUser) and returns { data, error } instead of throwing. */
export async function asAdmin<T>(adminId: string, fn: (db: Db) => Promise<T>): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await withUser(adminId, fn), error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : "unknown" };
  }
}

// --- Kursuebersicht ---

/** courses with course_access_code(access_code) embedded, enrollment rows for counting, all periods */
export function loadCoursesList(adminId: string) {
  return asAdmin(adminId, async (db) => ({
    courses: await db.query<{
      course_id: number; name: string; start_date: string; end_date: string; is_locked: boolean;
      anonymized_at: string | null; comparison_enabled: boolean; ask_extra_ratings: boolean;
      ask_ict_attention: boolean; ask_day_questionnaire: boolean; course_access_code: { access_code: string } | null;
    }>(
      `SELECT c.course_id, c.name, c.start_date, c.end_date, c.is_locked, c.anonymized_at, c.comparison_enabled,
              c.ask_extra_ratings, c.ask_ict_attention, c.ask_day_questionnaire,
              (SELECT json_build_object('access_code', a.access_code) FROM public.course_access_code a
                WHERE a.course_id = c.course_id) AS course_access_code
         FROM public.course c ORDER BY c.start_date DESC`,
    ),
    userCourses: await db.query<{ course_id: number }>("SELECT course_id FROM public.user_course ORDER BY user_course_id"),
    periods: await db.query<{ course_period_id: number; course_id: number; start_date: string; end_date: string; sort_order: number }>(
      "SELECT course_period_id, course_id, start_date, end_date, sort_order FROM public.course_period ORDER BY sort_order ASC",
    ),
  }));
}

/** enrolled users of a course: enrollments, their profiles, their submitted days */
export function loadCourseUsers(adminId: string, courseId: number) {
  return asAdmin(adminId, async (db) => {
    const enrollments = await db.query<{ user_course_id: string; profiles_id: string; is_excluded: boolean | null; alias: string | null }>(
      "SELECT user_course_id, profiles_id, is_excluded, alias FROM public.user_course WHERE course_id = $1",
      [courseId],
    );
    const ids = enrollments.map((e) => e.profiles_id);
    const profiles = ids.length
      ? await db.query<{ id: string; email: string | null; first_name: string | null; last_name: string | null }>(
          "SELECT id, email, first_name, last_name FROM public.profiles WHERE id = ANY($1::uuid[])",
          [ids],
        )
      : [];
    const submittedDays = ids.length
      ? await db.query<{ profiles_id: string; day_questionnaire_completed: boolean }>(
          "SELECT profiles_id, day_questionnaire_completed FROM public.day WHERE course_id = $1 AND is_submitted = true ORDER BY day_id",
          [courseId],
        )
      : [];
    return { enrollments, profiles, submittedDays };
  });
}

/** per-day completion flags of one user in a course (never time entries or answers) */
export function loadUserDays(adminId: string, userId: string, courseId: number) {
  return asAdmin(adminId, async (db) => {
    const periods = await db.query<{ start_date: string; end_date: string }>(
      "SELECT start_date, end_date FROM public.course_period WHERE course_id = $1",
      [courseId],
    );
    const days = await db.query<{ date: string; is_submitted: boolean; day_questionnaire_completed: boolean }>(
      "SELECT date, is_submitted, day_questionnaire_completed FROM public.day WHERE profiles_id = $1 AND course_id = $2",
      [userId, courseId],
    );
    const course = await db.query<{ start_date: string; end_date: string }>(
      "SELECT start_date, end_date FROM public.course WHERE course_id = $1",
      [courseId],
    );
    return { periods, days, course: course.length === 1 ? course[0] : null };
  });
}

const COURSE_FLAGS = ["is_locked", "comparison_enabled", "ask_extra_ratings", "ask_ict_attention", "ask_day_questionnaire"] as const;
export type CourseFlag = (typeof COURSE_FLAGS)[number];

/** Toggles one course setting; the column name comes from the fixed COURSE_FLAGS list only. */
export async function setCourseFlag(adminId: string, courseId: number, flag: CourseFlag, value: boolean) {
  if (!COURSE_FLAGS.includes(flag)) return { data: null, error: "invalid flag" };
  return asAdmin(adminId, (db) =>
    db.query(`UPDATE public.course SET ${flag} = $2 WHERE course_id = $1`, [courseId, value]),
  );
}

/** upsert of the access code (course_access_code is admin-only) */
export function setAccessCode(adminId: string, courseId: number, code: string) {
  return asAdmin(adminId, (db) =>
    db.query(
      `INSERT INTO public.course_access_code (course_id, access_code) VALUES ($1, $2)
       ON CONFLICT (course_id) DO UPDATE SET access_code = EXCLUDED.access_code`,
      [courseId, code],
    ),
  );
}

/** removes an enrollment */
export function deleteUserCourse(adminId: string, userCourseId: string) {
  return asAdmin(adminId, (db) => db.query("DELETE FROM public.user_course WHERE user_course_id = $1", [userCourseId]));
}

/**
 * Anonymizes a course in ONE transaction: every participant gets the alias TN-0001, TN-0002, ...
 * (sorted by profile id), then anonymized_at is set.
 */
export function anonymizeCourse(adminId: string, courseId: number) {
  return asAdmin(adminId, async (db) => {
    const enrollments = await db.query<{ user_course_id: string; profiles_id: string }>(
      "SELECT user_course_id, profiles_id FROM public.user_course WHERE course_id = $1",
      [courseId],
    );
    const sorted = [...enrollments].sort((a, b) => a.profiles_id.localeCompare(b.profiles_id));
    const aliases: Record<string, string> = {};
    for (const [i, e] of sorted.entries()) {
      const alias = `TN-${String(i + 1).padStart(4, "0")}`;
      aliases[e.user_course_id] = alias;
      await db.query("UPDATE public.user_course SET alias = $2 WHERE user_course_id = $1", [e.user_course_id, alias]);
    }
    const [row] = await db.query<{ anonymized_at: string }>(
      "UPDATE public.course SET anonymized_at = now() WHERE course_id = $1 RETURNING anonymized_at",
      [courseId],
    );
    if (!row) throw new Error("course not found");
    return { anonymizedAt: row.anonymized_at, aliases };
  });
}

export type NewCourseInput = {
  name: string;
  start_date: string;
  end_date: string;
  ask_extra_ratings: boolean;
  ask_ict_attention: boolean;
  ask_day_questionnaire: boolean;
  periods: { start_date: string; end_date: string }[];
  access_code: string;
};

/** course + periods + access code in ONE transaction; a new course starts unlocked, comparison off */
export async function createCourse(adminId: string, input: NewCourseInput): Promise<{ error: null | { step: "course" | "periods" | "access_code"; message: string } }> {
  let step: "course" | "periods" | "access_code" = "course";
  try {
    await withUser(adminId, async (db) => {
      const [course] = await db.query<{ course_id: number }>(
        `INSERT INTO public.course (name, start_date, end_date, is_locked, comparison_enabled,
                                    ask_extra_ratings, ask_ict_attention, ask_day_questionnaire)
         VALUES ($1, $2, $3, false, false, $4, $5, $6) RETURNING course_id`,
        [input.name, input.start_date, input.end_date, input.ask_extra_ratings, input.ask_ict_attention, input.ask_day_questionnaire],
      );
      step = "periods";
      for (const [i, p] of input.periods.entries()) {
        await db.query(
          "INSERT INTO public.course_period (course_id, start_date, end_date, sort_order) VALUES ($1, $2, $3, $4)",
          [course.course_id, p.start_date, p.end_date, i],
        );
      }
      step = "access_code";
      await db.query("INSERT INTO public.course_access_code (course_id, access_code) VALUES ($1, $2)", [
        course.course_id, input.access_code,
      ]);
    });
    return { error: null };
  } catch (error) {
    return { error: { step, message: error instanceof Error ? error.message : "unknown" } };
  }
}

export type { Row };
