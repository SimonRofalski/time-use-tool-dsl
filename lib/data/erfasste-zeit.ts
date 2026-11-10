// Data access for the "Erfasste Zeit" overview. Called only by the Server Action in
// app/[locale]/(protected)/erfasste-zeit/actions.ts, which passes the session user id.
// Returns raw rows; the page does the merging per day itself.
import { withUser } from "@/lib/db";

export type OverviewData =
  | { status: "no_course" | "course_error" | "days_error" | "entries_error" }
  | {
      status: "ok";
      course: { name: string; start_date: string; end_date: string; ask_day_questionnaire: boolean };
      periods: { course_period_id: number; start_date: string; end_date: string; sort_order: number }[];
      dayRecords: { day_id: number; date: string; is_submitted: boolean; is_complete: boolean; day_questionnaire_completed: boolean }[];
      /** all entries of the user's days in this course */
      entryRows: { day_id: number; start_time: string; end_time: string }[];
    };

/** Course, periods, days and entry times of the user's course, read with the user's RLS rights. */
export async function loadOverview(userId: string): Promise<OverviewData> {
  return withUser(
    userId,
    async (db) => {
      // One course per user: anything but exactly one enrollment counts as "no course"
      const enrollments = await db.query<{ course_id: number }>(
        "SELECT course_id FROM public.user_course WHERE profiles_id = $1",
        [userId],
      );
      if (enrollments.length !== 1) return { status: "no_course" as const };
      const courseId = enrollments[0].course_id;

      const course = await db.query<{ name: string; start_date: string; end_date: string; ask_day_questionnaire: boolean }>(
        "SELECT name, start_date, end_date, ask_day_questionnaire FROM public.course WHERE course_id = $1",
        [courseId],
      );
      if (course.length !== 1) return { status: "course_error" as const };

      const periods = await db.query<{ course_period_id: number; start_date: string; end_date: string; sort_order: number }>(
        "SELECT course_period_id, start_date, end_date, sort_order FROM public.course_period WHERE course_id = $1 ORDER BY sort_order ASC",
        [courseId],
      );
      const dayRecords = await db.query<{
        day_id: number; date: string; is_submitted: boolean; is_complete: boolean; day_questionnaire_completed: boolean;
      }>(
        `SELECT day_id, date, is_submitted, is_complete, day_questionnaire_completed
           FROM public.day WHERE profiles_id = $1 AND course_id = $2`,
        [userId, courseId],
      );
      const dayIds = dayRecords.map((d) => d.day_id);
      const entryRows = dayIds.length
        ? await db.query<{ day_id: number; start_time: string; end_time: string }>(
            "SELECT day_id, start_time, end_time FROM public.time_entry WHERE day_id = ANY($1::int[]) ORDER BY entry_id",
            [dayIds],
          )
        : [];
      return { status: "ok" as const, course: course[0], periods, dayRecords, entryRows };
    },
    { readOnly: true },
  );
}
