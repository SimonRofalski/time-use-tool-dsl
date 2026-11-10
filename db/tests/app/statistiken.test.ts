// Integration test of lib/data/statistiken.ts against the synthetic seed.
// Run via npm run db:test-all (separate database tut_test; the test changes data).
//
// The server computes the course comparison from all rows of the course (never zeros caused by
// missing read rights). statistiken-reference.ts computes the same values with plain selects;
// both results must be identical.
import assert from "node:assert/strict";
import { loadCourseComparison, loadStatistikenBase } from "../../../lib/data/statistiken";
import { withService } from "../../../lib/db";
import { buildComparisonIds, type DayFilterMode } from "../../../lib/statistiken/comparison";
import { referencePool } from "./statistiken-reference";

const id = (n: number) => `5eed0000-0000-4000-8000-000000000${n}`;
const A1 = id(101), P1 = id(111), P2 = id(112), P4 = id(114), P5 = id(115), P7 = id(117), P9 = id(119);

async function q<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return withService((db) => db.query<T>(sql, params));
}

async function main() {
  assert.equal((await q("SELECT 1 FROM public.app_user WHERE id = $1", [P1])).length, 1, "seed database expected");

  // sleep / sport / smartphone are defined by lookup codes; they must resolve to the same ids the
  // comparison used when they were fixed in the code
  const ids = buildComparisonIds(
    await q<{ activity_id: number; code: string }>("SELECT activity_id, code FROM public.activity"),
    await q<{ digital_media_type_id: number; code: string }>("SELECT digital_media_type_id, code FROM public.digital_media_type"),
  );
  assert.deepEqual([...ids.sleepActivityIds].sort((a, b) => a - b), [1, 2]);
  assert.deepEqual([...ids.sportActivityIds].sort((a, b) => a - b), [77, 78, 79, 80, 81, 82, 83, 85]);
  assert.equal(ids.smartphoneMediaTypeId, 2);

  // own data for the Zeitverteilung: all own days, entries of the submitted ones only
  const base = await loadStatistikenBase(P1);
  assert.equal(base.status, "ok");
  if (base.status !== "ok") return;
  assert.equal(base.course?.name, "SEED Offen");
  assert.equal(base.myDays.length, 4);
  const submitted = base.myDays.filter((d) => d.is_submitted).map((d) => d.day_id);
  const ownEntries = await q<{ n: number }>("SELECT count(*)::int AS n FROM public.time_entry WHERE day_id = ANY($1::int[])", [submitted]);
  assert.equal(base.myEntries.length, ownEntries[0].n);
  assert.ok(base.myEntries.every((e) => submitted.includes(e.day_id)));
  assert.equal(base.lookups.satisfactions.length, (await q("SELECT 1 FROM public.satisfaction")).length);
  assert.deepEqual(await loadStatistikenBase(P9), { status: "no_course" });
  console.log("ok own data");

  // same result as the former browser calculation, for several viewers and filters
  const cases: Array<[string, string, string[], DayFilterMode]> = [
    ["p1", P1, [], "alle"], ["p1", P1, ["2026-KW45"], "alle"], ["p1", P1, [], "werktage"],
    ["p1", P1, [], "wochenende"], ["p1", P1, ["2026-KW44"], "alle"],
    ["p4 (1 day)", P4, [], "alle"], ["p5 (excluded)", P5, [], "alle"], ["a1 (admin)", A1, [], "alle"],
  ];
  for (const [label, viewer, weeks, mode] of cases) {
    const now = await loadCourseComparison(viewer, weeks, mode);
    const before = await referencePool(viewer, 9001, weeks, mode);
    assert.equal(now.active, true, label);
    if (!now.active) continue;
    assert.deepEqual({ qualifyingUserCount: now.qualifyingUserCount, values: now.values }, before.pool, `${label} ${weeks} ${mode}`);
  }
  const p1All = await loadCourseComparison(P1, [], "alle");
  assert.equal(p1All.qualifyingUserCount, 3, "p1, p2, p3 (p4 has 1 day, p5 excluded, a1 1 day)");
  assert.equal((await loadCourseComparison(P5, [], "alle")).qualifyingUserCount, 4, "the excluded viewer still counts for themselves");
  const weekend = await loadCourseComparison(P1, [], "wochenende");
  assert.ok(weekend.active && weekend.values === null && weekend.qualifyingUserCount === 0, "weekend filter: nobody left");
  console.log("ok comparison identical to the reference calculation (8 cases)");

  // no zeros from missing read rights: the other participants' device rows count (p2 uses a
  // smartphone in the seed), and an admin enrolled in the course sees the same course values
  const p2Smartphone = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.time_entry_digital_media_type m JOIN public.time_entry te USING (entry_id)
       JOIN public.day d USING (day_id) WHERE d.profiles_id = $1 AND d.is_submitted AND m.digital_media_type_id = 2`, [P2]);
  assert.ok(p2Smartphone[0].n > 0, "seed: p2 has smartphone entries");
  assert.ok(p1All.active && p1All.values);
  if (!p1All.active || !p1All.values) return;
  assert.ok(p1All.values.smartphone.filter((v) => v > 0).length >= 2, "others' smartphone values are counted");
  const asAdmin = await loadCourseComparison(A1, [], "alle");
  assert.deepEqual(asAdmin, p1All, "admin a1 sees the same course values as p1");
  assert.ok(p1All.values.sleep.some((v) => v > 0));
  console.log("ok no zeros from missing read rights (others' devices, admin viewer)");

  // thresholds
  assert.deepEqual(await loadCourseComparison(P7, [], "alle"), { active: false, qualifyingUserCount: 2 }, "9003: only 2 people");
  assert.deepEqual(await loadCourseComparison(P9, [], "alle"), { active: false, qualifyingUserCount: 0 }, "no course");
  await q("UPDATE public.course SET comparison_enabled = false WHERE course_id = 9001");
  try {
    assert.deepEqual(await loadCourseComparison(P1, [], "alle"), { active: false, qualifyingUserCount: 0 }, "comparison off");
  } finally {
    await q("UPDATE public.course SET comparison_enabled = true WHERE course_id = 9001");
  }
  console.log("ok thresholds (too few people, no course, comparison off)");

  console.log("\nall statistiken checks passed");
  process.exit(0);
}

main().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
