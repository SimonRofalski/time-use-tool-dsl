import { randomInt } from "node:crypto";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/routing";
import type { Db } from "@/lib/db";
import { getLocalizedName } from "@/lib/i18n/localized-name";

/** Entries of the given day ids with their junction rows nested as JSON arrays. */
export const ENTRIES_WITH_JUNCTIONS_SQL = `
  SELECT te.entry_id, te.day_id, te.start_time, te.end_time, te.primary_activity_id, te.secondary_activity_id,
         te.location_transport_id, te.satisfaction_id, te.stressfulness_id, te.meaningfulness_id,
         te.digital_media_used, te.ict_attention_id,
         COALESCE((SELECT json_agg(json_build_object('digital_media_type_id', m.digital_media_type_id))
                     FROM public.time_entry_digital_media_type m WHERE m.entry_id = te.entry_id), '[]'::json)
           AS time_entry_digital_media_type,
         COALESCE((SELECT json_agg(json_build_object('social_context_id', s.social_context_id))
                     FROM public.time_entry_social_context s WHERE s.entry_id = te.entry_id), '[]'::json)
           AS time_entry_social_context
    FROM public.time_entry te
   WHERE te.day_id = ANY($1::int[])
   ORDER BY te.entry_id`;

/** Runs lookup queries and returns each result in a { data } wrapper (former client-library shape). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function lookupRows(db: Db, queries: string[]): Promise<{ data: any[] }[]> {
  const out: { data: Record<string, unknown>[] }[] = [];
  for (const sql of queries) out.push({ data: await db.query(sql) });
  return out;
}

// --- Server-side, de-identified course export (modes "aggregiert" and "roh") ---
// Per the ethics review, admins must not be able to link time-use data to
// persons. So no export contains names, e-mails, user ids, aliases or dates,
// and the rows are shuffled randomly.
//
// Why "days recorded" and the date are missing too: the admin sees per person
// which days are completed, so a row with "5 days" or "Sat 28.3." could be
// linked back to a person. Aggregated values are therefore normalised per
// submitted day (avg h/day) instead of being exported as sums.
//
// Minimum size: below MIN_PARTICIPANTS_FOR_EXPORT participants with data every
// row would be trivial to assign, so nothing is exported at all.
//
// For scientific analysis there is also the pseudonymised research export
// (PersonID + date, incl. survey and day questions), see
// lib/admin/research-export.ts.

export const MIN_PARTICIPANTS_FOR_EXPORT = 3;

export type ExportMode = "aggregiert" | "roh";
export type ExportRow = Record<string, string | number>;

export type CourseExportResult =
  | {
      ok: true;
      courseName: string;
      rows: ExportRow[];
      participants: number;
      submittedDays: number;
    }
  | { ok: false; reason: "COURSE_NOT_FOUND" }
  | { ok: false; reason: "TOO_FEW_PARTICIPANTS"; participants: number };

type RawEntry = {
  entry_id: number;
  day_id: number;
  start_time: string;
  end_time: string;
  primary_activity_id: number | null;
  secondary_activity_id: number | null;
  location_transport_id: number | null;
  satisfaction_id: number | null;
  stressfulness_id: number | null;
  meaningfulness_id: number | null;
  digital_media_used: boolean | null;
  ict_attention_id: number | null;
  time_entry_digital_media_type?: { digital_media_type_id: number | null }[];
  time_entry_social_context?: { social_context_id: number | null }[];
};

// --- Helpers ---

/** Duration of an entry in minutes; an end of 00:00 after a later start means midnight (24:00). */
export function minutesFromTimes(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh === 0 && em === 0 && startMin > 0 ? 1440 : eh * 60 + em;
  const mins = endMin - startMin;
  return mins > 0 ? mins : 0;
}

export function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

// Fisher-Yates with a CSPRNG so row order carries no information
function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Splits a list into batches (keeps the ANY($1) parameter arrays of the entry queries small). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --- Main ---

/** `db`: the handle of a withService() transaction (admin check happens in the route). */
export async function buildCourseExport(
  db: Db,
  courseId: number,
  mode: ExportMode,
  locale: Locale = "de",
): Promise<CourseExportResult> {
  const tc = await getTranslations({
    locale,
    namespace: "apiErrors.courseExport.columns",
  });

  const courseRows = await db.query<{ course_id: number; name: string }>(
    "SELECT course_id, name FROM public.course WHERE course_id = $1",
    [courseId],
  );
  const course = courseRows.length === 1 ? courseRows[0] : null;
  if (!course) return { ok: false, reason: "COURSE_NOT_FOUND" };

  // Enrolled participants not excluded by an admin
  const enrollments = await db.query<{
    profiles_id: string;
    is_excluded: boolean | null;
  }>(
    "SELECT profiles_id, is_excluded FROM public.user_course WHERE course_id = $1 ORDER BY user_course_id",
    [courseId],
  );
  const eligibleProfileIds = new Set(
    (enrollments ?? [])
      .filter((e) => !e.is_excluded)
      .map((e) => e.profiles_id as string),
  );

  // Submitted days of eligible participants
  const allDays = await db.query<{
    day_id: number;
    profiles_id: string;
    is_submitted: boolean;
  }>(
    "SELECT day_id, profiles_id, is_submitted FROM public.day WHERE course_id = $1 AND is_submitted = true ORDER BY day_id",
    [courseId],
  );

  const submittedDays = allDays.filter((d) =>
    eligibleProfileIds.has(d.profiles_id),
  );
  const dayProfileMap: Record<number, string> = {};
  const submittedDaysByUser: Record<string, number> = {};
  for (const d of submittedDays) {
    dayProfileMap[d.day_id] = d.profiles_id;
    submittedDaysByUser[d.profiles_id] =
      (submittedDaysByUser[d.profiles_id] ?? 0) + 1;
  }

  const participantIds = Object.keys(submittedDaysByUser);
  if (participantIds.length < MIN_PARTICIPANTS_FOR_EXPORT) {
    return {
      ok: false,
      reason: "TOO_FEW_PARTICIPANTS",
      participants: participantIds.length,
    };
  }

  // Lookups
  const [
    categoriesRes,
    activitiesRes,
    locationsRes,
    socialContextsRes,
    digitalMediaTypesRes,
    satisfactionsRes,
    stressfulnessRes,
    meaningfulnessRes,
    ictAttentionRes,
  ] = await lookupRows(db, [
    "SELECT category_id, name, name_en FROM public.category ORDER BY category_id",
    // Activity with its category embedded as { subcategory: { category_id } }
    `SELECT a.activity_id, a.name, a.name_en, json_build_object('category_id', s.category_id) AS subcategory
       FROM public.activity a LEFT JOIN public.subcategory s ON s.subcategory_id = a.subcategory_id`,
    "SELECT location_transport_id, name, name_en FROM public.location_transport",
    "SELECT social_context_id, name, name_en FROM public.social_context",
    "SELECT digital_media_type_id, name, name_en FROM public.digital_media_type",
    "SELECT satisfaction_id, name, name_en FROM public.satisfaction",
    "SELECT stressfulness_id, name, name_en FROM public.stressfulness",
    "SELECT meaningfulness_id, name, name_en FROM public.meaningfulness",
    "SELECT ict_attention_id, name, name_en FROM public.ict_attention",
  ]);

  const categoryNameById: Record<number, string> = {};
  const categoryIds: number[] = [];
  for (const c of categoriesRes.data ?? []) {
    categoryNameById[c.category_id] = getLocalizedName(c, locale);
    categoryIds.push(c.category_id);
  }

  const activityToCategoryId: Record<number, number> = {};
  const activityNameById: Record<number, string> = {};
  for (const a of activitiesRes.data ?? []) {
    const sub = a.subcategory as unknown;
    const catId =
      sub && typeof sub === "object" && "category_id" in sub
        ? (sub as { category_id: number }).category_id
        : Array.isArray(sub) && sub.length > 0
          ? (sub[0] as { category_id: number }).category_id
          : null;
    if (catId != null) activityToCategoryId[a.activity_id] = catId;
    activityNameById[a.activity_id] = getLocalizedName(a, locale);
  }

  const locationNameById: Record<number, string> = {};
  for (const l of locationsRes.data ?? [])
    locationNameById[l.location_transport_id] = getLocalizedName(l, locale);
  const socialContextNameById: Record<number, string> = {};
  for (const s of socialContextsRes.data ?? [])
    socialContextNameById[s.social_context_id] = getLocalizedName(s, locale);
  const digitalMediaTypeNameById: Record<number, string> = {};
  for (const m of digitalMediaTypesRes.data ?? [])
    digitalMediaTypeNameById[m.digital_media_type_id] = getLocalizedName(
      m,
      locale,
    );
  const satisfactionNameById: Record<number, string> = {};
  for (const s of satisfactionsRes.data ?? [])
    satisfactionNameById[s.satisfaction_id] = getLocalizedName(s, locale);
  const stressfulnessNameById: Record<number, string> = {};
  for (const s of stressfulnessRes.data ?? [])
    stressfulnessNameById[s.stressfulness_id] = getLocalizedName(s, locale);
  const meaningfulnessNameById: Record<number, string> = {};
  for (const m of meaningfulnessRes.data ?? [])
    meaningfulnessNameById[m.meaningfulness_id] = getLocalizedName(m, locale);
  const ictAttentionNameById: Record<number, string> = {};
  for (const a of ictAttentionRes.data ?? [])
    ictAttentionNameById[a.ict_attention_id] = getLocalizedName(a, locale);

  // Time entries of the submitted days, with the junction rows nested
  const dayIds = submittedDays.map((d) => d.day_id);
  const entries: RawEntry[] = [];
  for (const ids of chunk(dayIds, 400)) {
    entries.push(...(await db.query<RawEntry>(ENTRIES_WITH_JUNCTIONS_SQL, [ids])));
  }

  let rows: ExportRow[];

  if (mode === "aggregiert") {
    // Minutes per participant per category
    const minutesByUserCategory: Record<string, Record<number, number>> = {};
    for (const e of entries) {
      const profileId = dayProfileMap[e.day_id];
      if (!profileId || e.primary_activity_id == null) continue;
      const catId = activityToCategoryId[e.primary_activity_id];
      if (catId == null) continue;
      const mins = minutesFromTimes(e.start_time, e.end_time);
      if (mins <= 0) continue;
      if (!minutesByUserCategory[profileId])
        minutesByUserCategory[profileId] = {};
      minutesByUserCategory[profileId][catId] =
        (minutesByUserCategory[profileId][catId] ?? 0) + mins;
    }

    // One anonymous row per participant: Ø hours per submitted day
    const rowKey = tc("rowLabel");
    const perParticipant = participantIds.map((profileId) => {
      const days = submittedDaysByUser[profileId] ?? 0;
      const row: ExportRow = { [rowKey]: tc("anonymousParticipant") };
      let total = 0;
      for (const catId of categoryIds) {
        const mins = minutesByUserCategory[profileId]?.[catId] ?? 0;
        const hoursPerDay = days > 0 ? mins / 60 / days : 0;
        total += hoursPerDay;
        row[`${categoryNameById[catId]} ${tc("hoursPerDaySuffix")}`] = round(
          hoursPerDay,
          2,
        );
      }
      row[tc("totalTracked")] = round(total, 2);
      return row;
    });

    // Course mean across participants (mean of per-participant Ø values)
    const meanRow: ExportRow = { [rowKey]: tc("courseAverage") };
    for (const key of Object.keys(perParticipant[0]).filter(
      (k) => k !== rowKey,
    )) {
      const sum = perParticipant.reduce((s, r) => s + Number(r[key] ?? 0), 0);
      meanRow[key] = round(sum / perParticipant.length, 2);
    }

    rows = [...shuffle(perParticipant), meanRow];
  } else {
    // One row per time entry: no person, day or date reference, shuffled
    rows = shuffle(
      entries.map((e) => {
        const minutes = minutesFromTimes(e.start_time, e.end_time);
        const categoryId =
          e.primary_activity_id != null
            ? activityToCategoryId[e.primary_activity_id]
            : undefined;
        return {
          [tc("start")]: e.start_time.slice(0, 5),
          [tc("end")]: e.end_time.slice(0, 5),
          [tc("durationMinutes")]: minutes,
          [tc("durationHours")]: round(minutes / 60, 2),
          [tc("category")]:
            categoryId != null ? (categoryNameById[categoryId] ?? "") : "",
          [tc("activity")]:
            e.primary_activity_id != null
              ? (activityNameById[e.primary_activity_id] ?? "")
              : "",
          [tc("secondaryActivity")]:
            e.secondary_activity_id != null
              ? (activityNameById[e.secondary_activity_id] ?? "")
              : "",
          [tc("digitalMediaUsed")]: e.digital_media_used
            ? tc("yes")
            : tc("no"),
          [tc("mediaTypes")]: (e.time_entry_digital_media_type ?? [])
            .map((m) => m.digital_media_type_id)
            .filter((id): id is number => typeof id === "number")
            .map((id) => digitalMediaTypeNameById[id] ?? `#${id}`)
            .join(", "),
          [tc("ictAttention")]:
            e.ict_attention_id != null
              ? (ictAttentionNameById[e.ict_attention_id] ?? "")
              : "",
          [tc("locationTransport")]:
            e.location_transport_id != null
              ? (locationNameById[e.location_transport_id] ?? "")
              : "",
          [tc("socialContext")]: (e.time_entry_social_context ?? [])
            .map((s) => s.social_context_id)
            .filter((id): id is number => typeof id === "number")
            .map((id) => socialContextNameById[id] ?? `#${id}`)
            .join(", "),
          [tc("wellbeing")]:
            e.satisfaction_id != null
              ? (satisfactionNameById[e.satisfaction_id] ?? "")
              : "",
          [tc("stressfulness")]:
            e.stressfulness_id != null
              ? (stressfulnessNameById[e.stressfulness_id] ?? "")
              : "",
          [tc("meaningfulness")]:
            e.meaningfulness_id != null
              ? (meaningfulnessNameById[e.meaningfulness_id] ?? "")
              : "",
        };
      }),
    );
  }

  return {
    ok: true,
    courseName: course.name,
    rows,
    participants: participantIds.length,
    submittedDays: submittedDays.length,
  };
}
