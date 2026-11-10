import type { Locale } from "@/i18n/routing";
import type { Db } from "@/lib/db";
import { getLocalizedName } from "@/lib/i18n/localized-name";
import { totalPeriodDays } from "@/lib/course-periods";
import { minutesFromTimes } from "@/lib/admin/course-export";
import type {
  ActivityData,
  AdminStatistics,
  CategoryData,
  CourseProgressData,
  SatisfactionData,
  TrendPoint,
} from "./statistics-types";

// --- Server-side builder for the admin "Statistiken" tab ---
// Runs on the service connection inside app/api/admin/statistics. It reads raw
// time entries, but returns ONLY aggregates across all users.
// No per-user value ever leaves this module.

// --- Helpers ---

function formatDateShort(isoDate: string, locale: Locale): string {
  return new Date(isoDate).toLocaleDateString(
    locale === "en" ? "en-US" : "de-DE",
    {
      timeZone: "UTC", // "YYYY-MM-DD" parses as UTC midnight; formatting in UTC keeps the day
      weekday: "short",
      day: "numeric",
      month: "numeric",
    },
  );
}

// Timestamp of local midnight N days ago. Local = the server's time zone (TZ=Europe/Zurich in the
// image), the same one toDateKey/lastNDates use, so "last 7 days" and the trend chart agree.
function daysAgoISO(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// Returns YYYY-MM-DD for a given Date
function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Generates an array of date strings for the last N days (oldest first)
function lastNDates(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (n - 1 - i));
    return toDateKey(d);
  });
}

// Counts calendar days between two ISO date strings (inclusive)
function courseDurationDays(start: string, end: string): number {
  return (
    Math.round(
      (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000,
    ) + 1
  );
}

// Truncates long strings for chart axis labels
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Sort rank from the language-neutral code (1 = very good … 5 = very bad),
// so the chart reads "very bad → very good" in every language (never sort by
// the localized name).
function getSatisfactionSortRank(code: string): number {
  const numeric = Number(code);
  return Number.isFinite(numeric) ? -numeric : 0;
}

// --- Data processors ---

// Distinct users per day over the last 14 days, by the entries' created_at
function buildTrendData(
  recentEntries: { day_id: number; created_at: string }[],
  dayById: Record<number, { profiles_id: string }>,
  locale: Locale,
): TrendPoint[] {
  const dates = lastNDates(14);
  // Map: dateKey → Set<profiles_id>
  const usersByDate: Record<string, Set<string>> = {};
  for (const date of dates) usersByDate[date] = new Set();

  for (const entry of recentEntries) {
    const dateKey = toDateKey(new Date(entry.created_at));
    if (!usersByDate[dateKey]) continue;
    const day = dayById[entry.day_id];
    if (day) usersByDate[dateKey].add(day.profiles_id);
  }

  return dates.map((date) => ({
    date: formatDateShort(date, locale),
    users: usersByDate[date].size,
  }));
}

// Per course: done = submitted days, inProgress = started but not submitted,
// open = course days x enrolled users not started yet
function buildCourseProgress(
  courses: {
    course_id: number;
    name: string;
    start_date: string;
    end_date: string;
    periodDays: number;
  }[],
  userCountByCourse: Record<number, number>,
  days: { course_id: number; is_submitted: boolean }[],
): CourseProgressData[] {
  return courses.map((course) => {
    const enrolled = userCountByCourse[course.course_id] ?? 0;
    const totalPossible = course.periodDays * enrolled;
    const courseDays = days.filter((d) => d.course_id === course.course_id);
    const done = courseDays.filter((d) => d.is_submitted).length;
    const inProgress = courseDays.length - done;
    const open = Math.max(0, totalPossible - courseDays.length);

    return {
      name: truncate(course.name, 22),
      open,
      inProgress,
      done,
    };
  });
}

// The 7 most frequent main activities (by number of entries)
function buildTopActivities(
  entries: { primary_activity_id: number | null }[],
  activityById: Record<number, string>,
  activityToCategory: Record<number, number>,
): ActivityData[] {
  const counts: Record<number, number> = {};
  for (const e of entries) {
    if (e.primary_activity_id != null) {
      counts[e.primary_activity_id] = (counts[e.primary_activity_id] ?? 0) + 1;
    }
  }
  const total = Object.values(counts).reduce((s, c) => s + c, 0);
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([id, count]) => ({
      name: truncate(activityById[Number(id)] ?? `#${id}`, 28),
      count,
      label:
        total > 0
          ? `${count} (${Math.round((count / total) * 100)}%)`
          : `${count}`,
      categoryId: activityToCategory[Number(id)] ?? 0,
    }));
}

function buildCategoryDistribution(
  entries: {
    primary_activity_id: number | null;
    start_time: string;
    end_time: string;
  }[],
  activityToCategory: Record<number, number>, // activity_id → category_id
  categoryById: Record<number, string>,
): CategoryData[] {
  const minutesByCategory: Record<number, number> = {};
  for (const e of entries) {
    if (e.primary_activity_id == null) continue;
    const catId = activityToCategory[e.primary_activity_id];
    if (catId == null) continue;
    // minutesFromTimes treats an end time of 00:00 as midnight (23:50–24:00 slot)
    const mins = minutesFromTimes(e.start_time, e.end_time);
    if (mins > 0) {
      minutesByCategory[catId] = (minutesByCategory[catId] ?? 0) + mins;
    }
  }

  const totalMinutes = Object.values(minutesByCategory).reduce(
    (sum, mins) => sum + mins,
    0,
  );

  return Object.entries(minutesByCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([id, minutes]) => ({
      categoryId: Number(id),
      name: categoryById[Number(id)] ?? `#${id}`,
      minutes,
      percentage:
        totalMinutes > 0 ? Math.round((minutes / totalMinutes) * 100) : 0,
    }));
}

function buildSatisfactionData(
  entries: { satisfaction_id: number | null }[],
  satisfactions: { satisfaction_id: number; name: string; code: string }[],
): SatisfactionData[] {
  const counts: Record<number, number> = {};
  for (const e of entries) {
    if (e.satisfaction_id != null) {
      counts[e.satisfaction_id] = (counts[e.satisfaction_id] ?? 0) + 1;
    }
  }
  const total = Object.values(counts).reduce((s, c) => s + c, 0);
  return [...satisfactions]
    .sort(
      (a, b) =>
        getSatisfactionSortRank(a.code) - getSatisfactionSortRank(b.code),
    )
    .map((s) => {
      const count = counts[s.satisfaction_id] ?? 0;
      return {
        name: truncate(s.name, 20),
        count,
        label:
          total > 0
            ? `${count} (${Math.round((count / total) * 100)}%)`
            : `${count}`,
      };
    });
}

// --- Loader ---

/** `db`: the handle of a withService() transaction (admin check happens in the route). */
export async function loadAdminStatistics(
  db: Db,
  locale: Locale = "de",
): Promise<AdminStatistics> {
  const sevenDaysAgo = daysAgoISO(7);
  const fourteenDaysAgo = daysAgoISO(14);

  type DayLite = {
    day_id: number;
    profiles_id: string;
    course_id: number;
    is_submitted: boolean;
  };
  type RecentEntry = { entry_id: number; day_id: number; created_at: string };
  type EntryLite = {
    day_id: number;
    primary_activity_id: number | null;
    satisfaction_id: number | null;
    start_time: string;
    end_time: string;
  };

  // Plain SQL on the service connection; the helpers keep the former { count } / { data } shapes
  const count = async (sql: string, params: unknown[] = []) =>
    ({ count: (await db.query<{ n: number }>(sql, params))[0].n });
  const data = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    ({ data: await db.query<T>(sql, params) });

  const profilesRes = await count("SELECT count(*)::int AS n FROM public.profiles WHERE is_active = true");
  const coursesRes = await data<{ course_id: number; name: string; start_date: string; end_date: string; is_locked: boolean }>(
    "SELECT course_id, name, start_date, end_date, is_locked FROM public.course");
  const periodsRes = await data<{ course_id: number; start_date: string; end_date: string }>(
    "SELECT course_id, start_date, end_date FROM public.course_period");
  const userCoursesRes = await db.query<{ profiles_id: string; course_id: number; is_excluded: boolean | null }>(
    "SELECT profiles_id, course_id, is_excluded FROM public.user_course ORDER BY user_course_id");
  const allDays = await db.query<DayLite>(
    "SELECT day_id, profiles_id, course_id, is_submitted FROM public.day ORDER BY day_id");
  const newEntriesRes = await count("SELECT count(*)::int AS n FROM public.time_entry WHERE created_at >= $1", [sevenDaysAgo]);
  const totalEntriesRes = await count("SELECT count(*)::int AS n FROM public.time_entry");
  const recentEntries = await db.query<RecentEntry>(
    "SELECT entry_id, day_id, created_at FROM public.time_entry WHERE created_at >= $1 ORDER BY entry_id", [fourteenDaysAgo]);
  const allEntries = await db.query<EntryLite>(
    "SELECT day_id, primary_activity_id, satisfaction_id, start_time, end_time FROM public.time_entry ORDER BY entry_id");
  const activitiesRes = await data<{ activity_id: number; name: string; name_en: string; subcategory_id: number }>(
    "SELECT activity_id, name, name_en, subcategory_id FROM public.activity");
  const subcategoriesRes = await data<{ subcategory_id: number; category_id: number }>(
    "SELECT subcategory_id, category_id FROM public.subcategory");
  const categoriesRes = await data<{ category_id: number; name: string; name_en: string }>(
    "SELECT category_id, name, name_en FROM public.category");
  const satisfactionsRes = await data<{ satisfaction_id: number; code: string; name: string; name_en: string }>(
    "SELECT satisfaction_id, code, name, name_en FROM public.satisfaction");

  const rawCourses = coursesRes.data ?? [];
  const allPeriods = periodsRes.data ?? [];
  const userCourses = userCoursesRes;

  // Group periods by course_id and compute total days per course
  const periodsByCourseId: Record<
    number,
    { start_date: string; end_date: string }[]
  > = {};
  for (const p of allPeriods) {
    if (!periodsByCourseId[p.course_id]) periodsByCourseId[p.course_id] = [];
    periodsByCourseId[p.course_id].push(p);
  }
  const courses = rawCourses.map((c) => {
    const cp = periodsByCourseId[c.course_id] ?? [];
    return {
      ...c,
      periodDays:
        cp.length > 0
          ? totalPeriodDays(cp)
          : courseDurationDays(c.start_date, c.end_date),
    };
  });

  const activities = activitiesRes.data ?? [];
  const subcategories = subcategoriesRes.data ?? [];
  const categories = categoriesRes.data ?? [];
  const satisfactions = satisfactionsRes.data ?? [];

  // Enrolments excluded from statistics by admin (is_excluded = true on
  // user_course), per course, so an exclusion in one course doesn't hide the
  // same person's days in another
  const excludedEnrolments = new Set<string>();
  for (const uc of userCourses) {
    if (uc.is_excluded)
      excludedEnrolments.add(`${uc.profiles_id}|${uc.course_id}`);
  }

  // Filter days to remove excluded users' data
  const filteredDays = allDays.filter(
    (d) => !excludedEnrolments.has(`${d.profiles_id}|${d.course_id}`),
  );
  // Content statistics (activities, categories, well-being) only use complete
  // (submitted) days, so half-filled days don't skew the distribution,
  // consistent with the participant statistics and the course export
  const submittedDayIds = new Set(
    filteredDays.filter((d) => d.is_submitted).map((d) => d.day_id),
  );
  const filteredEntries = allEntries.filter((e) =>
    submittedDayIds.has(e.day_id),
  );

  const dayById: Record<number, { profiles_id: string }> = {};
  for (const d of allDays) dayById[d.day_id] = { profiles_id: d.profiles_id };

  const userCountByCourse: Record<number, number> = {};
  for (const uc of userCourses) {
    if (!uc.is_excluded) {
      userCountByCourse[uc.course_id] =
        (userCountByCourse[uc.course_id] ?? 0) + 1;
    }
  }

  // Lookup names in the requested language (German `name`, English `name_en`)
  const activityById: Record<number, string> = {};
  for (const a of activities)
    activityById[a.activity_id] = getLocalizedName(a, locale);

  // activity_id → category_id (via subcategory)
  const subcatToCategory: Record<number, number> = {};
  for (const s of subcategories)
    subcatToCategory[s.subcategory_id] = s.category_id;

  const activityToCategory: Record<number, number> = {};
  for (const a of activities) {
    const catId = subcatToCategory[a.subcategory_id];
    if (catId != null) activityToCategory[a.activity_id] = catId;
  }

  const categoryById: Record<number, string> = {};
  for (const c of categories)
    categoryById[c.category_id] = getLocalizedName(c, locale);
  const localizedSatisfactions = satisfactions.map((s) => ({
    ...s,
    name: getLocalizedName(s, locale),
  }));

  return {
    kpis: {
      totalUsers: profilesRes.count ?? 0,
      activeCourses: courses.filter((c) => !c.is_locked).length,
      closedCourses: courses.filter((c) => c.is_locked).length,
      newEntriesLast7Days: newEntriesRes.count ?? 0,
      totalEntries: totalEntriesRes.count ?? 0,
    },
    trendData: buildTrendData(recentEntries, dayById, locale),
    courseProgress: buildCourseProgress(courses, userCountByCourse, filteredDays),
    topActivities: buildTopActivities(
      filteredEntries,
      activityById,
      activityToCategory,
    ),
    categoryData: buildCategoryDistribution(
      filteredEntries,
      activityToCategory,
      categoryById,
    ),
    satisfactionData: buildSatisfactionData(
      filteredEntries,
      localizedSatisfactions,
    ),
  };
}
