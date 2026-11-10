// Integration test of lib/data/admin.ts and lib/admin/statistics.ts against the synthetic seed.
// Run via npm run db:test-all (separate database tut_test; the test changes data).
// The exports use next-intl and are not covered here.
import assert from "node:assert/strict";
import * as admin from "../../../lib/data/admin";
import { loadAdminStatistics } from "../../../lib/admin/statistics";
import { withService } from "../../../lib/db";

const A1 = "5eed0000-0000-4000-8000-000000000101";
const P1 = "5eed0000-0000-4000-8000-000000000111";

async function q<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return withService((db) => db.query<T>(sql, params));
}

async function main() {
  assert.equal((await q("SELECT 1 FROM public.app_user WHERE id = $1", [A1])).length, 1, "seed database expected");

  // Nutzerübersicht: active profiles only, all enrollments (with nested course + periods), all days
  const o = await admin.loadUserOverview(A1);
  const active = await q<{ n: number }>("SELECT count(*)::int AS n FROM public.profiles WHERE is_active");
  assert.equal(o.profiles.length, active[0].n);
  assert.equal(o.userCourses.length, (await q("SELECT 1 FROM public.user_course")).length);
  // last sign-in for every login account (app_user is read on the server connection)
  assert.equal(Object.keys(o.lastSignInById).length, (await q("SELECT 1 FROM public.app_user")).length);
  assert.ok(o.profiles.every((p) => p.id in o.lastSignInById));
  const uc9001 = o.userCourses.find((u) => u.course?.name === "SEED Offen")!;
  assert.deepEqual(uc9001.course!.course_period, [{ start_date: "2026-11-02", end_date: "2026-11-08" }]);
  assert.equal(o.allDays.length, (await q("SELECT 1 FROM public.day")).length);
  console.log("ok user overview");

  // exclusion toggle
  assert.deepEqual(await admin.setUserCourseExcluded(A1, uc9001.user_course_id, true), { error: null });
  assert.equal((await q<{ is_excluded: boolean }>("SELECT is_excluded FROM public.user_course WHERE user_course_id = $1", [uc9001.user_course_id]))[0].is_excluded, true);
  await admin.setUserCourseExcluded(A1, uc9001.user_course_id, false);

  // course list with the access code embedded as an object
  const list = await admin.loadCoursesList(A1);
  assert.equal(list.error, null);
  const c9001 = list.data!.courses.find((c) => c.course_id === 9001)!;
  assert.deepEqual(c9001.course_access_code, { access_code: "SEED-OFFEN" });
  assert.equal(list.data!.periods.filter((p) => p.course_id === 9001).length, 1);
  console.log("ok course list");

  // course detail + user days
  const users = await admin.loadCourseUsers(A1, 9001);
  assert.equal(users.data!.enrollments.length, 6);
  assert.equal(users.data!.profiles.length, 6);
  const days = await admin.loadUserDays(A1, P1, 9001);
  assert.equal(days.data!.days.length, 4);
  assert.equal(days.data!.course?.start_date, "2026-11-02");
  console.log("ok course users + user days");

  // flags, access code
  assert.equal((await admin.setCourseFlag(A1, 9001, "ask_ict_attention", false)).error, null);
  assert.equal((await admin.setCourseFlag(A1, 9001, "not_a_column" as admin.CourseFlag, true)).error, "invalid flag");
  assert.equal((await admin.setAccessCode(A1, 9001, "NEU-CODE")).error, null);
  assert.equal((await q<{ access_code: string }>("SELECT access_code FROM public.course_access_code WHERE course_id = 9001"))[0].access_code, "NEU-CODE");
  console.log("ok flags + access code upsert");

  // create course: all or nothing
  const input: admin.NewCourseInput = {
    name: "Test Neu", start_date: "2026-12-01", end_date: "2026-12-14", ask_extra_ratings: true,
    ask_ict_attention: false, ask_day_questionnaire: true,
    periods: [{ start_date: "2026-12-01", end_date: "2026-12-05" }, { start_date: "2026-12-10", end_date: "2026-12-14" }],
    access_code: "TEST-NEU",
  };
  assert.deepEqual(await admin.createCourse(A1, input), { error: null });
  const created = await q<{ course_id: number }>("SELECT course_id FROM public.course WHERE name = 'Test Neu'");
  assert.equal((await q("SELECT 1 FROM public.course_period WHERE course_id = $1", [created[0].course_id])).length, 2);
  const before = (await q("SELECT 1 FROM public.course")).length;
  const bad = await admin.createCourse(A1, { ...input, name: "Kaputt", periods: [{ start_date: "2026-12-10", end_date: "2026-12-01" }] });
  assert.equal(bad.error?.step, "periods");
  assert.equal((await q("SELECT 1 FROM public.course")).length, before, "no half-created course left behind");
  console.log("ok create course (atomic)");

  // anonymize: deterministic aliases + anonymized_at in one transaction
  const an = await admin.anonymizeCourse(A1, 9001);
  assert.equal(an.error, null);
  const aliases = await q<{ profiles_id: string; alias: string }>(
    "SELECT profiles_id, alias FROM public.user_course WHERE course_id = 9001");
  const expected = [...aliases].sort((a, b) => a.profiles_id.localeCompare(b.profiles_id)).map((_, i) => `TN-${String(i + 1).padStart(4, "0")}`);
  assert.deepEqual([...aliases].sort((a, b) => a.profiles_id.localeCompare(b.profiles_id)).map((a) => a.alias), expected);
  assert.ok((await q<{ anonymized_at: string | null }>("SELECT anonymized_at FROM public.course WHERE course_id = 9001"))[0].anonymized_at);
  console.log("ok anonymize");

  // a participant cannot do any of this (RLS, even if the action check were bypassed)
  const asP1 = await admin.createCourse(P1, { ...input, name: "Von P1" });
  assert.ok(asP1.error);
  assert.equal((await q("SELECT 1 FROM public.course WHERE name = 'Von P1'")).length, 0);
  const flagP1 = await admin.setCourseFlag(P1, 9001, "is_locked", true);
  assert.equal((await q<{ is_locked: boolean }>("SELECT is_locked FROM public.course WHERE course_id = 9001"))[0].is_locked, false);
  void flagP1;
  console.log("ok participant blocked by RLS");

  // make admin / remove admin rights (Nutzerübersicht); never one's own
  const roleOf = async (id: string) => (await q<{ role: string }>("SELECT role FROM public.profiles WHERE id = $1", [id]))[0].role;
  assert.equal(o.viewerId, A1);
  assert.ok(o.profiles.find((p) => p.id === A1)?.role === "admin");
  assert.deepEqual(await admin.setUserRole(A1, P1, "admin"), { error: null });
  assert.equal(await roleOf(P1), "admin");
  assert.deepEqual(await admin.setUserRole(A1, P1, "user"), { error: null });
  assert.equal(await roleOf(P1), "user");
  assert.deepEqual(await admin.setUserRole(A1, A1, "user"), { error: "self" });
  assert.equal(await roleOf(A1), "admin");
  assert.deepEqual(await admin.setUserRole(A1, "5eed0000-0000-4000-8000-000000000102", "user"), { error: "not_found" }, "inactive a2 is not changed");
  assert.deepEqual(await admin.setUserRole(A1, P1, "root" as "admin"), { error: "invalid" });
  console.log("ok make admin / remove admin rights");

  // admin statistics (service connection, aggregated)
  const stats = await withService((db) => loadAdminStatistics(db, "de"), { readOnly: true });
  const totalEntries = (await q<{ n: number }>("SELECT count(*)::int AS n FROM public.time_entry"))[0].n;
  assert.equal(stats.kpis.totalEntries, totalEntries);
  assert.equal(stats.kpis.totalUsers, active[0].n);
  console.log("ok admin statistics");

  console.log("\nall admin checks passed");
  process.exit(0);
}

main().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
