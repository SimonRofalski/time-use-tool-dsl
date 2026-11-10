// Reference for db/tests/app/statistiken.test.ts: the course comparison computed step by step from
// separate selects (days, exclusion list, time_entry, junction tables) on the service connection,
// i.e. with ALL rows readable, which is what the comparison must show.
import { withService } from "../../../lib/db";
import {
  MIN_DAYS_FOR_COMPARISON,
  buildActivityToCategory,
  buildSatisfactionRanks,
  computeCoursePool,
  type DayFilterMode,
  type RawEntry,
} from "../../../lib/statistiken/comparison";

/** Comparison pool of a course for one viewer, computed from separate selects with all rows readable. */
export async function referencePool(viewer: string, courseId: number, weeks: string[], mode: DayFilterMode) {
  return withService(async (db) => {
    const days = await db.query<{ day_id: number; profiles_id: string; date: string }>(
      "SELECT day_id, profiles_id, date FROM public.day WHERE course_id = $1 AND is_submitted = true ORDER BY day_id", [courseId]);
    const excluded = new Set((await db.query<{ id: string }>(
      "SELECT profiles_id AS id FROM public.user_course WHERE course_id = $1 AND is_excluded", [courseId])).map((r) => r.id).filter((x) => x !== viewer));
    const allDays = days.filter((d) => !excluded.has(d.profiles_id));
    const byUser: Record<string, number[]> = {};
    for (const d of allDays) (byUser[d.profiles_id] ??= []).push(d.day_id);
    const qualifying = Object.entries(byUser).filter(([, ids]) => ids.length >= MIN_DAYS_FOR_COMPARISON);
    const dayIds = qualifying.flatMap(([, ids]) => ids);
    const rows = await db.query<Omit<RawEntry, "digital_media_type_ids" | "social_context_ids">>(
      `SELECT entry_id, day_id, start_time, end_time, primary_activity_id, location_transport_id, satisfaction_id
         FROM public.time_entry WHERE day_id = ANY($1::int[]) ORDER BY entry_id`, [dayIds]);
    const entryIds = rows.map((r) => r.entry_id);
    const media = await db.query<{ entry_id: number; digital_media_type_id: number }>(
      "SELECT entry_id, digital_media_type_id FROM public.time_entry_digital_media_type WHERE entry_id = ANY($1::int[])", [entryIds]);
    const social = await db.query<{ entry_id: number; social_context_id: number }>(
      "SELECT entry_id, social_context_id FROM public.time_entry_social_context WHERE entry_id = ANY($1::int[])", [entryIds]);
    const entries: RawEntry[] = rows.map((r) => ({
      ...r,
      digital_media_type_ids: media.filter((m) => m.entry_id === r.entry_id).map((m) => m.digital_media_type_id).sort((a, b) => a - b),
      social_context_ids: social.filter((s) => s.entry_id === r.entry_id).map((s) => s.social_context_id).sort((a, b) => a - b),
    }));
    const categories = await db.query<{ category_id: number }>("SELECT category_id FROM public.category ORDER BY category_id");
    const subs = await db.query<{ subcategory_id: number; category_id: number }>("SELECT subcategory_id, category_id FROM public.subcategory");
    const acts = await db.query<{ activity_id: number; subcategory_id: number }>("SELECT activity_id, subcategory_id FROM public.activity");
    const sc = await db.query<{ social_context_id: number; code: string }>("SELECT social_context_id, code FROM public.social_context");
    const loc = await db.query<{ location_transport_id: number; code: string }>("SELECT location_transport_id, code FROM public.location_transport");
    const sat = await db.query<{ satisfaction_id: number; code: string }>("SELECT satisfaction_id, code FROM public.satisfaction ORDER BY satisfaction_id");
    const dayIdToDate: Record<number, string> = {};
    for (const d of allDays) dayIdToDate[d.day_id] = d.date.slice(0, 10);
    return {
      qualifyingCount: qualifying.length,
      pool: computeCoursePool({
        qualifyingUsers: qualifying,
        entries,
        dayIdToDate,
        categoryIds: categories.map((c) => c.category_id),
        activityToCategory: buildActivityToCategory(subs, acts),
        socialContextCodeById: Object.fromEntries(sc.map((s) => [s.social_context_id, s.code])),
        locationCodeById: Object.fromEntries(loc.map((l) => [l.location_transport_id, l.code])),
        satisfactionRankById: buildSatisfactionRanks(sat).satisfactionRankById,
        weeksFilter: weeks,
        dayMode: mode,
      }),
    };
  }, { readOnly: true });
}

