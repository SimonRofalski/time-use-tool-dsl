// Data access for the Statistiken page. Called only by the Server Actions in
// app/[locale]/(protected)/statistiken/actions.ts, which pass the session user id.
//
// Own data (Zeitverteilung): read as the viewer (withUser), so RLS applies.
//
// Course comparison (Kursvergleich): read on the service connection, because a viewer may not read
// the other participants' raw rows (e.g. their device / company rows); with the viewer's rights
// those values would wrongly count as 0. The browser still gets no raw data: the server checks who
// may see the comparison (enrolled in exactly this one course, comparison_enabled, ≥ 3 participants
// with ≥ 2 submitted days, admin-excluded participants left out, the viewer never) and sends only
// aggregates (computeCoursePool in lib/statistiken/comparison.ts).
import { withService, withUser, type Db } from "@/lib/db";
import {
  MIN_DAYS_FOR_COMPARISON,
  MIN_USERS_FOR_COMPARISON,
  buildActivityToCategory,
  buildSatisfactionRanks,
  computeCoursePool,
  normalizeDateOnly,
  type CoursePool,
  type DayFilterMode,
  type RawEntry,
} from "@/lib/statistiken/comparison";

type Named = { name: string; name_en: string };

export type StatistikenLookups = {
  categories: ({ category_id: number } & Named)[];
  subcategories: ({ subcategory_id: number; category_id: number } & Named)[];
  activities: ({ activity_id: number; subcategory_id: number } & Named)[];
  mediaTypes: ({ digital_media_type_id: number; code: string } & Named)[];
  socialContexts: ({ social_context_id: number; code: string } & Named)[];
  locations: ({ location_transport_id: number; code: string } & Named)[];
  satisfactions: ({ satisfaction_id: number; code: string } & Named)[];
};

export type StatistikenBase =
  | { status: "no_course" }
  | {
      status: "ok";
      /** null when the course row is not readable */
      course: { name: string; comparison_enabled: boolean; start_date: string; end_date: string } | null;
      profile: { first_name: string | null; last_name: string | null } | null;
      periods: { start_date: string; end_date: string; sort_order: number }[];
      lookups: StatistikenLookups;
      myDays: { day_id: number; date: string; is_submitted: boolean; is_complete: boolean }[];
      /** entries of the viewer's SUBMITTED days */
      myEntries: RawEntry[];
    };

/**
 * Entry rows with their device / company id lists attached.
 * Runs with whatever rights `db` has (viewer for the own data, service for the comparison).
 */
async function loadEntries(db: Db, dayIds: number[]): Promise<RawEntry[]> {
  if (dayIds.length === 0) return [];
  const rows = await db.query<Omit<RawEntry, "digital_media_type_ids" | "social_context_ids">>(
    `SELECT entry_id, day_id, start_time, end_time, primary_activity_id, location_transport_id, satisfaction_id
       FROM public.time_entry WHERE day_id = ANY($1::int[]) ORDER BY entry_id`,
    [dayIds],
  );
  const entryIds = rows.map((r) => r.entry_id);
  const media = new Map<number, number[]>();
  const social = new Map<number, number[]>();
  if (entryIds.length > 0) {
    for (const m of await db.query<{ entry_id: number; id: number }>(
      `SELECT entry_id, digital_media_type_id::int AS id FROM public.time_entry_digital_media_type
        WHERE entry_id = ANY($1::int[]) ORDER BY entry_id, digital_media_type_id`,
      [entryIds],
    )) {
      const list = media.get(m.entry_id);
      if (list) list.push(m.id);
      else media.set(m.entry_id, [m.id]);
    }
    for (const x of await db.query<{ entry_id: number; id: number }>(
      `SELECT entry_id, social_context_id::int AS id FROM public.time_entry_social_context
        WHERE entry_id = ANY($1::int[]) ORDER BY entry_id, social_context_id`,
      [entryIds],
    )) {
      const list = social.get(x.entry_id);
      if (list) list.push(x.id);
      else social.set(x.entry_id, [x.id]);
    }
  }
  return rows.map((r) => ({
    ...r,
    digital_media_type_ids: media.get(r.entry_id) ?? [],
    social_context_ids: social.get(r.entry_id) ?? [],
  }));
}

/** The single course of the user (anything but exactly one enrollment = none). */
async function singleCourseId(db: Db, userId: string): Promise<number | null> {
  const rows = await db.query<{ course_id: number }>(
    "SELECT course_id FROM public.user_course WHERE profiles_id = $1",
    [userId],
  );
  return rows.length === 1 ? rows[0].course_id : null;
}

async function loadLookups(db: Db): Promise<StatistikenLookups> {
  const [categories, subcategories, activities, mediaTypes, socialContexts, locations, satisfactions] = [
    await db.query<StatistikenLookups["categories"][number]>(
      "SELECT category_id, name, name_en FROM public.category ORDER BY category_id"),
    await db.query<StatistikenLookups["subcategories"][number]>(
      "SELECT subcategory_id, name, name_en, category_id FROM public.subcategory ORDER BY subcategory_id"),
    await db.query<StatistikenLookups["activities"][number]>(
      "SELECT activity_id, name, name_en, subcategory_id FROM public.activity ORDER BY activity_id"),
    await db.query<StatistikenLookups["mediaTypes"][number]>(
      "SELECT digital_media_type_id, name, name_en, code FROM public.digital_media_type ORDER BY digital_media_type_id"),
    await db.query<StatistikenLookups["socialContexts"][number]>(
      "SELECT social_context_id, name, name_en, code FROM public.social_context ORDER BY social_context_id"),
    await db.query<StatistikenLookups["locations"][number]>(
      "SELECT location_transport_id, name, name_en, code FROM public.location_transport ORDER BY location_transport_id"),
    await db.query<StatistikenLookups["satisfactions"][number]>(
      "SELECT satisfaction_id, name, name_en, code FROM public.satisfaction ORDER BY satisfaction_id"),
  ];
  return { categories, subcategories, activities, mediaTypes, socialContexts, locations, satisfactions };
}

/** Everything the page needs for the Zeitverteilung (the viewer's own data + lookups). */
export async function loadStatistikenBase(userId: string): Promise<StatistikenBase> {
  return withUser(
    userId,
    async (db) => {
      const courseId = await singleCourseId(db, userId);
      if (courseId == null) return { status: "no_course" as const };

      const course = await db.query<{ name: string; comparison_enabled: boolean; start_date: string; end_date: string }>(
        "SELECT name, comparison_enabled, start_date, end_date FROM public.course WHERE course_id = $1",
        [courseId],
      );
      const profile = await db.query<{ first_name: string | null; last_name: string | null }>(
        "SELECT first_name, last_name FROM public.profiles WHERE id = $1",
        [userId],
      );
      const periods = await db.query<{ start_date: string; end_date: string; sort_order: number }>(
        "SELECT start_date, end_date, sort_order FROM public.course_period WHERE course_id = $1 ORDER BY sort_order ASC",
        [courseId],
      );
      const lookups = await loadLookups(db);
      const myDays = await db.query<{ day_id: number; date: string; is_submitted: boolean; is_complete: boolean }>(
        "SELECT day_id, date, is_submitted, is_complete FROM public.day WHERE profiles_id = $1 AND course_id = $2",
        [userId, courseId],
      );
      const submittedIds = myDays.filter((d) => d.is_submitted).map((d) => d.day_id);
      const myEntries = await loadEntries(db, submittedIds);
      return {
        status: "ok" as const,
        course: course.length === 1 ? course[0] : null,
        profile: profile[0] ?? null,
        periods,
        lookups,
        myDays,
        myEntries,
      };
    },
    { readOnly: true },
  );
}

export type ComparisonInputs = Omit<Parameters<typeof computeCoursePool>[0], "weeksFilter" | "dayMode">;

/** What the comparison is computed from: one snapshot per page load, any filter can be applied to it. */
export type ComparisonSnapshot =
  /** comparison switched off, or fewer than 3 participants with ≥ 2 submitted days (unfiltered) */
  | { active: false; qualifyingUserCount: number }
  | { active: true; inputs: ComparisonInputs };

/**
 * Reads the comparison pool with its thresholds: comparison_enabled, ≥ 3
 * participants with ≥ 2 submitted days, participants excluded by an admin left out (the viewer
 * never is). Server-side only: the snapshot contains other participants' entries, never send it.
 */
export async function loadComparisonSnapshot(userId: string): Promise<ComparisonSnapshot> {
  return withService(
    async (db) => {
      const courseId = await singleCourseId(db, userId);
      if (courseId == null) return { active: false as const, qualifyingUserCount: 0 };
      const course = await db.query<{ comparison_enabled: boolean }>(
        "SELECT comparison_enabled FROM public.course WHERE course_id = $1",
        [courseId],
      );
      const enabled = course[0]?.comparison_enabled === true;

      // Submitted days of all participants of the course (as a participant could already read them)
      const submittedCourseDays = await db.query<{ day_id: number; profiles_id: string; date: string }>(
        "SELECT day_id, profiles_id, date FROM public.day WHERE course_id = $1 AND is_submitted = true ORDER BY day_id",
        [courseId],
      );
      // Same list as course_excluded_profile_ids() returns to an enrolled viewer
      const excluded = await db.query<{ id: string }>(
        "SELECT profiles_id AS id FROM public.user_course WHERE course_id = $1 AND is_excluded",
        [courseId],
      );
      const excludedProfileIds = new Set(excluded.map((r) => r.id).filter((id) => id !== userId));
      const allDays = submittedCourseDays.filter((d) => !excludedProfileIds.has(d.profiles_id));

      // Group submitted day IDs by user (in order of first appearance)
      const submittedDaysByUser = new Map<string, number[]>();
      for (const day of allDays) {
        const list = submittedDaysByUser.get(day.profiles_id);
        if (list) list.push(day.day_id);
        else submittedDaysByUser.set(day.profiles_id, [day.day_id]);
      }
      const qualifyingUsers = [...submittedDaysByUser.entries()].filter(
        ([, dayIds]) => dayIds.length >= MIN_DAYS_FOR_COMPARISON,
      );

      if (!(qualifyingUsers.length >= MIN_USERS_FOR_COMPARISON && enabled)) {
        return { active: false as const, qualifyingUserCount: enabled ? qualifyingUsers.length : 0 };
      }

      const dayIdToDate: Record<number, string> = {};
      for (const day of allDays) dayIdToDate[day.day_id] = normalizeDateOnly(day.date);

      const entries = await loadEntries(db, qualifyingUsers.flatMap(([, dayIds]) => dayIds));
      const lookups = await loadLookups(db);
      const socialContextCodeById: Record<number, string> = {};
      for (const s of lookups.socialContexts) socialContextCodeById[s.social_context_id] = s.code;
      const locationCodeById: Record<number, string> = {};
      for (const l of lookups.locations) locationCodeById[l.location_transport_id] = l.code;
      const { satisfactionRankById } = buildSatisfactionRanks(lookups.satisfactions);

      return {
        active: true as const,
        inputs: {
          qualifyingUsers,
          entries,
          dayIdToDate,
          categoryIds: lookups.categories.map((c) => c.category_id),
          activityToCategory: buildActivityToCategory(lookups.subcategories, lookups.activities),
          socialContextCodeById,
          locationCodeById,
          satisfactionRankById,
        },
      };
    },
    { readOnly: true },
  );
}

export type CourseComparison =
  | { active: false; qualifyingUserCount: number }
  | ({ active: true } & CoursePool);

/** Applies the filters to a snapshot; the result holds only aggregates and may go to the browser. */
export function comparisonFromSnapshot(
  snapshot: ComparisonSnapshot,
  weeksFilter: string[],
  dayMode: DayFilterMode,
): CourseComparison {
  if (!snapshot.active) return snapshot;
  return { active: true, ...computeCoursePool({ ...snapshot.inputs, weeksFilter, dayMode }) };
}

/** Snapshot + filters in one step (tests, scripts). */
export async function loadCourseComparison(
  userId: string,
  weeksFilter: string[],
  dayMode: DayFilterMode,
): Promise<CourseComparison> {
  return comparisonFromSnapshot(await loadComparisonSnapshot(userId), weeksFilter, dayMode);
}
