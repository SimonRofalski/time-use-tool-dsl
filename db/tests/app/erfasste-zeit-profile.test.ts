// Integration test of lib/data/erfasste-zeit.ts and lib/data/profile.ts against the synthetic seed.
// Run via npm run db:test-all (separate database tut_test; the test changes data).
import assert from "node:assert/strict";
import { loadOverview } from "../../../lib/data/erfasste-zeit";
import { loadProfileForm, saveProfileForm, type UserDataRow } from "../../../lib/data/profile";
import { withService } from "../../../lib/db";

const P1 = "5eed0000-0000-4000-8000-000000000111";
const P9 = "5eed0000-0000-4000-8000-000000000119";

async function q<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return withService((db) => db.query<T>(sql, params));
}

async function main() {
  assert.equal((await q("SELECT 1 FROM public.app_user WHERE id = $1", [P1])).length, 1, "seed database expected");

  // overview: same rows as the database holds for the user, nothing of other people
  const o = await loadOverview(P1);
  assert.equal(o.status, "ok");
  if (o.status !== "ok") return;
  const days = await q<{ n: number }>("SELECT count(*)::int AS n FROM public.day WHERE profiles_id = $1", [P1]);
  const entries = await q<{ n: number }>(
    "SELECT count(*)::int AS n FROM public.time_entry te JOIN public.day d ON d.day_id = te.day_id WHERE d.profiles_id = $1", [P1]);
  assert.equal(o.dayRecords.length, days[0].n);
  assert.equal(o.entryRows.length, entries[0].n);
  assert.equal(o.course.name, "SEED Offen");
  assert.equal(o.periods.length, 1);
  assert.match(o.dayRecords[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(o.entryRows[0].start_time, /^\d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(await loadOverview(P9), { status: "no_course" });
  console.log("ok overview (all entries of the user, no paging; no course -> no_course)");

  // profile form: load
  const p = await loadProfileForm(P1);
  assert.equal(p.profile?.role, "user");
  assert.ok(p.lookups.gender.length > 0 && p.lookups.urbanity.length > 0);
  assert.deepEqual(Object.keys(p.lookups.gender[0]).sort(), ["code", "id", "name", "name_en"]);
  assert.ok(p.userData && p.employmentStatusIds.length === 1);
  assert.equal(typeof p.userData.weekly_work_hours, "number");
  const p9 = await loadProfileForm(P9);
  assert.equal(p9.userData, null);
  console.log("ok profile load");

  // save for a user without user_data: insert; then update + replace employment statuses
  const g = p.lookups.gender[0].id;
  const [e1, e2] = p.lookups.employmentStatus.map((r) => r.id);
  const row: UserDataRow = {
    gender_id: g, age: 30, marital_status_id: null, partner_in_household: true, children_in_household_id: null,
    education_level_id: null, occupational_status_id: null, weekly_work_hours: 12.5, main_workplace_id: null,
    health_status_id: null, nationality_id: null, region_id: null, urbanity_id: null,
  };
  assert.deepEqual(await saveProfileForm(P9, { firstName: "Pirmin", lastName: "Neu", row, employmentStatusIds: [e1, e2] }), { error: null });
  let after = await loadProfileForm(P9);
  assert.equal(after.profile?.last_name, "Neu");
  assert.equal(after.userData?.age, 30);
  assert.deepEqual([...after.employmentStatusIds].sort(), [e1, e2].sort());
  assert.deepEqual(await saveProfileForm(P9, { firstName: "Pirmin", lastName: "Neu2", row: { ...row, age: 31 }, employmentStatusIds: [e2] }), { error: null });
  after = await loadProfileForm(P9);
  assert.equal(after.userData?.age, 31);
  assert.deepEqual(after.employmentStatusIds, [e2]);
  assert.equal((await q("SELECT 1 FROM public.user_data WHERE profiles_id = $1", [P9])).length, 1, "updated, not duplicated");
  console.log("ok profile insert + update + statuses replaced");

  // atomic: an invalid lookup id fails and leaves names and data unchanged
  const bad = await saveProfileForm(P9, { firstName: "X", lastName: "Y", row: { ...row, gender_id: 999999 }, employmentStatusIds: [e1] });
  assert.ok(bad.error);
  after = await loadProfileForm(P9);
  assert.equal(after.profile?.last_name, "Neu2");
  assert.deepEqual(after.employmentStatusIds, [e2]);
  console.log("ok failed save rolls back completely");

  console.log("\nall erfasste-zeit / profile checks passed");
  process.exit(0);
}

main().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
