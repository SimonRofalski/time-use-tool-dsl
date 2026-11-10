// Integration test of lib/data/zeiterfassung.ts (page load, slot saves, day flags, questionnaire)
// against the synthetic seed. Run via npm run db:test-all (separate database tut_test; changes data).
import assert from "node:assert/strict";
import * as z from "../../../lib/data/zeiterfassung";
import { withService } from "../../../lib/db";

const P1 = "5eed0000-0000-4000-8000-000000000111";
const COURSE = 9001;
const base = { courseId: COURSE, primary_activity_id: 0, secondary_activity_id: null, satisfaction_id: null, meaningfulness_id: null,
  stressfulness_id: null, location_transport_id: null, digital_media_used: false, ict_attention_id: null,
  digital_media_type_ids: [] as number[], social_context_ids: [] as number[] };

/** "HH:MM" start times of the 10-minute slots with index from..to (0 = 00:00, 143 = 23:50). */
function slots(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, i) => {
    const m = (from + i) * 10;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  });
}

async function count(sql: string, params: unknown[] = []) {
  const rows = await withService((db) => db.query<{ n: number }>(sql, params));
  return Number(rows[0].n);
}

async function main() {
  const seeded = await count("SELECT count(*) AS n FROM public.app_user WHERE id = $1", [P1]);
  assert.equal(seeded, 1, "seed database expected (npm run db:reset)");

  // 1. page load
  const b = await z.loadZeiterfassungBase(P1);
  assert.ok(b);
  assert.equal(b.courseId, COURSE);
  assert.equal(b.dayRecords.length, 4);
  assert.ok(b.lookups.activities.length > 50 && b.lookups.categories.length > 5);
  assert.equal(b.periods.length, 1);
  const act = (b.lookups.activities[0] as { activity_id: number }).activity_id;
  const act2 = (b.lookups.activities[1] as { activity_id: number }).activity_id;
  const social = (b.lookups.socialContexts[0] as { social_context_id: number }).social_context_id;
  const media = (b.lookups.digitalMediaTypes[0] as { digital_media_type_id: number }).digital_media_type_id;
  console.log("ok load base");

  // 2. partial day 2026-11-05 has 36 slots (00:00-05:50); add two slots with media + social context
  const day = await z.loadDayRecord(P1, COURSE, "2026-11-05");
  assert.ok(day);
  const r1 = await z.saveSlotEntries(P1, { ...base, date: "2026-11-05", slots: ["06:00", "06:10"], primary_activity_id: act,
    digital_media_used: true, digital_media_type_ids: [media], social_context_ids: [social] });
  assert.deepEqual(r1, { ok: true, dayId: day.day_id, becameComplete: false });
  const e1 = await z.loadDayEntries(P1, day.day_id);
  assert.equal(e1.data?.length, 38);
  const six = e1.data!.find((e) => e.start_time === "06:00:00")!;
  assert.deepEqual(six.time_entry_digital_media_type, [{ digital_media_type_id: media }]);
  assert.deepEqual(six.time_entry_social_context, [{ social_context_id: social }]);
  console.log("ok partial save with junction rows (same nesting as supabase-js)");

  // 3. overwrite one slot with another activity: replaced, not duplicated, old junction rows gone
  const r2 = await z.saveSlotEntries(P1, { ...base, date: "2026-11-05", slots: ["06:00"], primary_activity_id: act2 });
  assert.equal(r2.ok, true);
  const e2 = await z.loadDayEntries(P1, day.day_id);
  assert.equal(e2.data?.length, 38);
  const six2 = e2.data!.find((e) => e.start_time === "06:00:00")!;
  assert.equal(six2.primary_activity_id, act2);
  assert.deepEqual(six2.time_entry_digital_media_type, []);
  console.log("ok overwrite slot");

  // 4. fill the rest (06:20-23:50, incl. the midnight slot): day becomes complete + submitted
  const r3 = await z.saveSlotEntries(P1, { ...base, date: "2026-11-05", slots: slots(38, 143), primary_activity_id: act });
  assert.deepEqual(r3, { ok: true, dayId: day.day_id, becameComplete: true });
  const flags = await withService((db) => db.query<{ is_complete: boolean; is_submitted: boolean }>(
    "SELECT is_complete, is_submitted FROM public.day WHERE day_id = $1", [day.day_id]));
  assert.deepEqual(flags[0], { is_complete: true, is_submitted: true });
  const last = await count("SELECT count(*) AS n FROM public.time_entry WHERE day_id = $1 AND start_time = '23:50' AND end_time = '00:00'", [day.day_id]);
  assert.equal(last, 1);
  console.log("ok complete day -> is_complete/is_submitted, becameComplete");

  // 5. saving again on a complete day does not report becameComplete again
  const r4 = await z.saveSlotEntries(P1, { ...base, date: "2026-11-05", slots: ["12:00"], primary_activity_id: act2 });
  assert.deepEqual(r4, { ok: true, dayId: day.day_id, becameComplete: false });

  // 6. delete a slot: day back to incomplete / not submitted
  assert.deepEqual(await z.deleteSlotEntries(P1, day.day_id, ["12:00"]), { ok: true });
  const flags2 = await withService((db) => db.query<{ is_complete: boolean; is_submitted: boolean }>(
    "SELECT is_complete, is_submitted FROM public.day WHERE day_id = $1", [day.day_id]));
  assert.deepEqual(flags2[0], { is_complete: false, is_submitted: false });
  console.log("ok delete slot -> un-submitted");

  // 7. new date: the day is created in the same transaction
  const r5 = await z.saveSlotEntries(P1, { ...base, date: "2026-11-06", slots: ["08:00"], primary_activity_id: act });
  assert.equal(r5.ok, true);
  assert.ok(await z.loadDayRecord(P1, COURSE, "2026-11-06"));
  console.log("ok day created on first save");

  // 8. atomic: an invalid activity on a NEW date leaves neither a day nor entries behind
  const before = await count("SELECT count(*) AS n FROM public.time_entry");
  const r6 = await z.saveSlotEntries(P1, { ...base, date: "2026-11-07", slots: ["08:00", "08:10"], primary_activity_id: 999999 });
  assert.equal(r6.ok, false);
  assert.equal(await count("SELECT count(*) AS n FROM public.time_entry"), before);
  assert.equal(await z.loadDayRecord(P1, COURSE, "2026-11-07"), null);
  console.log("ok failed save rolls back completely (no half-saved day)");

  // 9. invalid slot strings are rejected before touching the database
  const r7 = await z.saveSlotEntries(P1, { ...base, date: "2026-11-06", slots: ["08:05"], primary_activity_id: act });
  assert.equal(r7.ok, false);

  // 10. somebody else's day: RLS hides it, delete changes nothing
  const otherDay = await withService((db) => db.query<{ day_id: number }>(
    "SELECT day_id FROM public.day WHERE profiles_id = '5eed0000-0000-4000-8000-000000000112' LIMIT 1"));
  const otherBefore = await count("SELECT count(*) AS n FROM public.time_entry WHERE day_id = $1", [otherDay[0].day_id]);
  await z.deleteSlotEntries(P1, otherDay[0].day_id, ["00:00"]);
  assert.equal(await count("SELECT count(*) AS n FROM public.time_entry WHERE day_id = $1", [otherDay[0].day_id]), otherBefore);
  console.log("ok other person's day untouched");

  // 11. day questionnaire: insert, then update (upsert on day_id), flag kept in sync by the trigger
  const qd = await z.loadDayQuestionnaireData(P1, day.day_id);
  assert.ok(qd && qd.fillTimings.length > 0 && qd.existing === null);
  const pick = (rows: Record<string, unknown>[], key: string) => rows[0][key] as number;
  const qInput = { day_id: day.day_id, diary_fill_timing_id: pick(qd.fillTimings, "diary_fill_timing_id"),
    most_pleasant_activity_id: act, most_unpleasant_activity_id: act, most_stressful_activity_id: act,
    day_appreciation_id: pick(qd.dayAppreciations, "day_appreciation_id"), is_unusual_day: false,
    day_type_context_id: pick(qd.dayTypes, "day_type_context_id"), trip_type_id: pick(qd.tripTypes, "trip_type_id") };
  assert.deepEqual(await z.saveDayQuestionnaire(P1, qInput), { error: null });
  assert.deepEqual(await z.saveDayQuestionnaire(P1, { ...qInput, is_unusual_day: true }), { error: null });
  assert.equal(await count("SELECT count(*) AS n FROM public.day_questionnaire WHERE day_id = $1 AND is_unusual_day", [day.day_id]), 1);
  assert.ok(await z.loadDayRecord(P1, COURSE, "2026-11-05").then((d) => d?.day_questionnaire_completed));
  console.log("ok day questionnaire upsert");

  console.log("\nall zeiterfassung checks passed");
  process.exit(0);
}

main().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
