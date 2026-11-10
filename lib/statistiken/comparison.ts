// Pure calculation helpers of the Statistiken page, shared by the page (own values) and the server
// (course comparison pool, lib/data/statistiken.ts), so both sides compute with exactly the same
// code. No React, no database.

// Activity IDs that count as "Schlaf" (subcategory 1: sleep + sick in bed)
export const SLEEP_ACTIVITY_IDS = new Set([1, 2]);

// Activity IDs that count as "Sport" (subcategories 24 and 26)
export const SPORT_ACTIVITY_IDS = new Set([77, 78, 79, 80, 81, 82, 83, 85]);

// digital_media_type_id for smartphone usage
export const SMARTPHONE_MEDIA_TYPE_ID = 2;

// Minimum submitted days a user must have to be included in the course comparison
export const MIN_DAYS_FOR_COMPARISON = 2;

// Minimum number of qualifying participants for the course comparison to be shown
export const MIN_USERS_FOR_COMPARISON = 3;

export type DayFilterMode = "alle" | "werktage" | "wochenende";

// Raw time entry row for aggregation purposes
export type RawEntry = {
  entry_id: number;
  day_id: number;
  start_time: string;
  end_time: string;
  primary_activity_id: number | null;
  location_transport_id: number | null;
  satisfaction_id: number | null;
  digital_media_type_ids: number[];
  social_context_ids: number[];
};

// Calculates how many minutes are covered by a single time_entry row
// e.g. "08:00:00", "09:30:00" → 90 minutes
// Handles the midnight wrap: end_time "00:00" after a non-zero start means 1440 min
export function calculateMinutes(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const startMinTotal = sh * 60 + sm;
  const endMinTotal =
    eh === 0 && em === 0 && startMinTotal > 0 ? 1440 : eh * 60 + em;
  return endMinTotal - startMinTotal;
}

export function normalizeDateOnly(value: string): string {
  return value.slice(0, 10);
}

export function isWeekend(dateString: string): boolean {
  const normalized = dateString.slice(0, 10);
  const [year, month, day] = normalized.split("-").map(Number);
  const d = new Date(year, month - 1, day);
  return d.getDay() === 0 || d.getDay() === 6;
}

// ISO week of a date as "YYYY-KWnn" plus the week number (for the translated label)
export function getIsoWeek(dateString: string): { key: string; week: number } {
  const normalized = dateString.slice(0, 10);
  const [year, month, day] = normalized.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return { key: `${isoYear}-KW${String(isoWeek).padStart(2, "0")}`, week: isoWeek };
}

// Code-based classification (language-neutral, safe across locales); mirrors
// the meanings documented in ActivitySelector.tsx's SOCIAL_CONTEXT_VISUAL_BY_CODE
// and LOCATION_MAPPING_BY_CODE.
export function isAloneContextCode(code: string): boolean {
  return code === "1"; // Alleine
}

// Codes 11 (Zuhause) and 14 (Zuhause anderer Personen) both count as "at home"
export function isAtHomeLocationCode(code: string): boolean {
  return code === "11" || code === "14";
}

// Satisfaction codes run 1 (sehr gut) … 5 (sehr schlecht); the rank scale is
// inverted (higher = better).
export function getSatisfactionRankFromCode(code: string): number | null {
  const n = Number(code);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return 6 - n;
}

/** Rank per satisfaction_id (rows ordered by satisfaction_id) and the highest rank. */
export function buildSatisfactionRanks(rows: { satisfaction_id: number; code: string }[]) {
  const satisfactionRankById: Record<number, number> = {};
  let maxSatisfactionRank = 1;
  rows.forEach((item, index) => {
    const derivedRank = getSatisfactionRankFromCode(item.code);
    const rank = derivedRank ?? index + 1;
    satisfactionRankById[item.satisfaction_id] = rank;
    if (rank > maxSatisfactionRank) {
      maxSatisfactionRank = rank;
    }
  });
  return { satisfactionRankById, maxSatisfactionRank };
}

/** activity_id → category_id (needed for the per-category comparison) */
export function buildActivityToCategory(
  subcategories: { subcategory_id: number; category_id: number }[],
  activities: { activity_id: number; subcategory_id: number }[],
): Record<number, number> {
  const activityToCategory: Record<number, number> = {};
  const subToCat: Record<number, number> = {};
  for (const sub of subcategories) subToCat[sub.subcategory_id] = sub.category_id;
  for (const act of activities) {
    const catId = subToCat[act.subcategory_id];
    if (catId != null) activityToCategory[act.activity_id] = catId;
  }
  return activityToCategory;
}

// Calculates average hours per day for a set of entries, filtered to a specific set of activity IDs.
// Returns 0 if no matching entries exist.
export function calcAverageHoursPerDay(
  entries: RawEntry[],
  submittedDayIds: Set<number>,
  activityIdFilter: Set<number>,
): number {
  const minutesByDay: Record<number, number> = {};

  for (const entry of entries) {
    if (!submittedDayIds.has(entry.day_id)) continue;
    if (entry.primary_activity_id == null) continue;
    if (!activityIdFilter.has(entry.primary_activity_id)) continue;

    const mins = calculateMinutes(entry.start_time, entry.end_time);
    minutesByDay[entry.day_id] = (minutesByDay[entry.day_id] ?? 0) + mins;
  }

  // Average over ALL submitted days (including days with zero minutes for this activity)
  const totalDays = submittedDayIds.size;
  if (totalDays === 0) return 0;

  const totalMinutes = Object.values(minutesByDay).reduce((s, m) => s + m, 0);
  return totalMinutes / 60 / totalDays;
}

// Calculates average hours per day the user used smartphone (digital_media_type_id = 2)
export function calcSmartphoneHoursPerDay(
  entries: RawEntry[],
  submittedDayIds: Set<number>,
): number {
  const totalDays = submittedDayIds.size;
  if (totalDays === 0) return 0;

  let totalMinutes = 0;
  for (const entry of entries) {
    if (!submittedDayIds.has(entry.day_id)) continue;
    if (!entry.digital_media_type_ids.includes(SMARTPHONE_MEDIA_TYPE_ID)) {
      continue;
    }
    totalMinutes += calculateMinutes(entry.start_time, entry.end_time);
  }

  return totalMinutes / 60 / totalDays;
}

// Ø h/Tag per category for one participant's entries over `dayIdSet` days
export function hoursPerDayByCategory(
  entries: RawEntry[],
  dayIdSet: Set<number>,
  activityToCategory: Record<number, number>,
): Record<number, number> {
  const minutes: Record<number, number> = {};
  for (const entry of entries) {
    if (!dayIdSet.has(entry.day_id)) continue;
    if (entry.primary_activity_id == null) continue;
    const catId = activityToCategory[entry.primary_activity_id];
    if (catId == null) continue;
    minutes[catId] =
      (minutes[catId] ?? 0) +
      calculateMinutes(entry.start_time, entry.end_time);
  }
  const result: Record<number, number> = {};
  const days = dayIdSet.size;
  for (const [catId, mins] of Object.entries(minutes)) {
    result[Number(catId)] = days > 0 ? mins / 60 / days : 0;
  }
  return result;
}

/** Minutes split by device / company / place plus the satisfaction weighting of a set of entries. */
export type ContextMinutes = {
  withDevice: number;
  withoutDevice: number;
  withOthers: number;
  alone: number;
  atHome: number;
  elsewhere: number;
  satisfactionWeightedSum: number;
  satisfactionWeight: number;
};

// Entries without a social context count as "alone", without a location as "elsewhere".
// dayIdSet = null: use all given entries
export function sumContextMinutes(
  entries: RawEntry[],
  dayIdSet: Set<number> | null,
  socialContextCodeById: Record<number, string>,
  locationCodeById: Record<number, string>,
  satisfactionRankById: Record<number, number>,
): ContextMinutes {
  const sums: ContextMinutes = {
    withDevice: 0,
    withoutDevice: 0,
    withOthers: 0,
    alone: 0,
    atHome: 0,
    elsewhere: 0,
    satisfactionWeightedSum: 0,
    satisfactionWeight: 0,
  };
  for (const entry of entries) {
    if (dayIdSet && !dayIdSet.has(entry.day_id)) continue;

    const minutes = calculateMinutes(entry.start_time, entry.end_time);

    if (entry.digital_media_type_ids.length > 0) {
      sums.withDevice += minutes;
    } else {
      sums.withoutDevice += minutes;
    }

    const hasOtherPeople = entry.social_context_ids.some((id) => {
      const code = socialContextCodeById[id] ?? "";
      return !isAloneContextCode(code);
    });
    if (hasOtherPeople) {
      sums.withOthers += minutes;
    } else {
      sums.alone += minutes;
    }

    const locationCode =
      entry.location_transport_id != null
        ? (locationCodeById[entry.location_transport_id] ?? "")
        : "";
    if (isAtHomeLocationCode(locationCode)) {
      sums.atHome += minutes;
    } else {
      sums.elsewhere += minutes;
    }

    if (entry.satisfaction_id != null) {
      const rank = satisfactionRankById[entry.satisfaction_id];
      if (rank != null) {
        sums.satisfactionWeightedSum += rank * minutes;
        sums.satisfactionWeight += minutes;
      }
    }
  }
  return sums;
}

// Applies the page filters: selected ISO weeks (none = all) and weekdays / weekend / all
export function filterDayIds(
  dayIds: number[],
  dayIdToDate: Record<number, string>,
  weeksFilter: string[],
  dayMode: DayFilterMode,
): number[] {
  const weekKeySet = new Set(weeksFilter);
  return dayIds.filter((dayId) => {
    const date = dayIdToDate[dayId];
    if (!date) return false;

    if (weekKeySet.size > 0 && !weekKeySet.has(getIsoWeek(date).key)) {
      return false;
    }
    if (dayMode === "werktage" && isWeekend(date)) return false;
    if (dayMode === "wochenende" && !isWeekend(date)) return false;

    return true;
  });
}

/**
 * Course side of the Kursvergleich: one anonymous value per participant and the course totals.
 * Only these numbers leave the server; the participants' entries never do.
 */
export type CoursePool = {
  /** participants that still have ≥ MIN_DAYS_FOR_COMPARISON days after the filters */
  qualifyingUserCount: number;
  /** null when fewer than MIN_USERS_FOR_COMPARISON participants remain */
  values: null | {
    sleep: number[];
    sport: number[];
    smartphone: number[];
    /** category_id → one value per participant, for every category (same order as the lookup) */
    categoryValues: Record<number, number[]>;
    deviceShare: number[];
    socialShare: number[];
    homeShare: number[];
    wellbeing: number[];
    totals: ContextMinutes;
  };
};

/**
 * Applies the filters per participant, drops those left with too few days, and computes one value
 * per remaining participant (no profile ids in the result) plus the summed context minutes.
 */
export function computeCoursePool(input: {
  /** [profileId, submitted day ids] of every participant with ≥ MIN_DAYS_FOR_COMPARISON days */
  qualifyingUsers: Array<[string, number[]]>;
  /** entries of all those days */
  entries: RawEntry[];
  dayIdToDate: Record<number, string>;
  categoryIds: number[];
  activityToCategory: Record<number, number>;
  socialContextCodeById: Record<number, string>;
  locationCodeById: Record<number, string>;
  satisfactionRankById: Record<number, number>;
  weeksFilter: string[];
  dayMode: DayFilterMode;
}): CoursePool {
  const filteredUsers = input.qualifyingUsers
    .map(([profileId, dayIds]) => {
      const filteredDayIds = filterDayIds(
        dayIds,
        input.dayIdToDate,
        input.weeksFilter,
        input.dayMode,
      );
      return [profileId, filteredDayIds] as const;
    })
    .filter(([, dayIds]) => dayIds.length >= MIN_DAYS_FOR_COMPARISON);

  if (filteredUsers.length < MIN_USERS_FOR_COMPARISON) {
    return { qualifyingUserCount: filteredUsers.length, values: null };
  }

  const categoryValues: Record<number, number[]> = {};
  const sleep: number[] = [];
  const sport: number[] = [];
  const smartphone: number[] = [];
  const deviceShare: number[] = [];
  const socialShare: number[] = [];
  const homeShare: number[] = [];
  const wellbeing: number[] = [];
  const totals: ContextMinutes = {
    withDevice: 0,
    withoutDevice: 0,
    withOthers: 0,
    alone: 0,
    atHome: 0,
    elsewhere: 0,
    satisfactionWeightedSum: 0,
    satisfactionWeight: 0,
  };
  const share = (part: number, total: number) =>
    total > 0 ? (part / total) * 100 : 0;

  for (const [, dayIds] of filteredUsers) {
    const dayIdSet = new Set(dayIds);
    const userEntries = input.entries.filter((e) => dayIdSet.has(e.day_id));

    sleep.push(calcAverageHoursPerDay(userEntries, dayIdSet, SLEEP_ACTIVITY_IDS));
    sport.push(calcAverageHoursPerDay(userEntries, dayIdSet, SPORT_ACTIVITY_IDS));
    smartphone.push(calcSmartphoneHoursPerDay(userEntries, dayIdSet));

    const perCategory = hoursPerDayByCategory(userEntries, dayIdSet, input.activityToCategory);
    for (const catId of input.categoryIds) {
      if (!categoryValues[catId]) categoryValues[catId] = [];
      categoryValues[catId].push(perCategory[catId] ?? 0);
    }

    const u = sumContextMinutes(
      userEntries,
      null,
      input.socialContextCodeById,
      input.locationCodeById,
      input.satisfactionRankById,
    );
    totals.withDevice += u.withDevice;
    totals.withoutDevice += u.withoutDevice;
    totals.withOthers += u.withOthers;
    totals.alone += u.alone;
    totals.atHome += u.atHome;
    totals.elsewhere += u.elsewhere;
    totals.satisfactionWeightedSum += u.satisfactionWeightedSum;
    totals.satisfactionWeight += u.satisfactionWeight;

    deviceShare.push(share(u.withDevice, u.withDevice + u.withoutDevice));
    socialShare.push(share(u.withOthers, u.withOthers + u.alone));
    homeShare.push(share(u.atHome, u.atHome + u.elsewhere));
    if (u.satisfactionWeight > 0) {
      wellbeing.push(u.satisfactionWeightedSum / u.satisfactionWeight);
    }
  }

  return {
    qualifyingUserCount: filteredUsers.length,
    values: {
      sleep,
      sport,
      smartphone,
      categoryValues,
      deviceShare,
      socialShare,
      homeShare,
      wellbeing,
      totals,
    },
  };
}
