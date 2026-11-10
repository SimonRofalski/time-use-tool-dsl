"use client";
// Statistiken page: personal time distribution (ZeitverteilungTab) and the optional course
// comparison (KursvergleichTab). Data comes from the Server Actions in actions.ts; the viewer's
// own statistics are aggregated here in the browser, the course side is computed on the server.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { FileDown } from "lucide-react";
import type { Locale } from "@/i18n/routing";
import { getLocalizedName } from "@/lib/i18n/localized-name";
import { getPeriodDates, getSinglePeriodDates } from "@/lib/course-periods";
import ZeitverteilungTab from "./ZeitverteilungTab";
import KursvergleichTab from "./KursvergleichTab";
import { generatePersonalReportPdf } from "./export-pdf";
import type {
  CategoryRow,
  SubcategoryRow,
  ActivityRow,
  DayBarData,
  CategoryComparison,
  ComparisonMetric,
  ComparisonTopic,
  ComparisonMetaStats,
  MetaAggregates,
} from "./types";
import { getLocalIsoDate } from "@/lib/local-date";
import {
  SLEEP_ACTIVITY_IDS,
  SPORT_ACTIVITY_IDS,
  buildActivityToCategory,
  buildSatisfactionRanks,
  calcAverageHoursPerDay,
  calcSmartphoneHoursPerDay,
  calculateMinutes,
  filterDayIds,
  getIsoWeek,
  hoursPerDayByCategory,
  isAloneContextCode,
  isAtHomeLocationCode,
  isWeekend,
  normalizeDateOnly,
  sumContextMinutes,
  type CoursePool,
  type DayFilterMode,
  type RawEntry,
} from "@/lib/statistiken/comparison";
import { loadCourseComparisonData, loadStatistikenData } from "./actions";

// --- Types (local, only used in data loading) ---

type Tab = "zeitverteilung" | "kursvergleich";

// Lookup row shapes
type ActivityLookup = {
  activity_id: number;
  name: string;
  name_en: string;
  subcategory_id: number;
};
type SubcategoryLookup = {
  subcategory_id: number;
  name: string;
  name_en: string;
  category_id: number;
};
type CategoryLookup = {
  category_id: number;
  name: string;
  name_en: string;
};
type DigitalMediaTypeLookup = {
  digital_media_type_id: number;
  name: string;
  name_en: string;
  code: string;
};
type SocialContextLookup = {
  social_context_id: number;
  name: string;
  name_en: string;
  code: string;
};
type LocationTransportLookup = {
  location_transport_id: number;
  name: string;
  name_en: string;
  code: string;
};
type SatisfactionLookup = {
  satisfaction_id: number;
  name: string;
  name_en: string;
  code: string;
};

// { name, code } pair used for id → lookup maps: `name` is already localized
// at construction time, `code` is the language-neutral classification key
// (see ActivitySelector.tsx's *_VISUAL_BY_CODE maps for the canonical meanings).
type NamedCode = { name: string; code: string };

// --- Pure helpers ---

// (calculateMinutes, isWeekend, the code classifications etc. live in
// lib/statistiken/comparison.ts, shared with the server-side course comparison)

// Day number since 1970-01-01 (UTC), for timezone-safe comparisons of "YYYY-MM-DD" dates
function dateOnlyToEpochDay(dateOnly: string): number {
  const normalized = dateOnly.slice(0, 10);
  const [year, month, day] = normalized.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

// `t` is passed in explicitly since this is a plain helper, not a component —
// it can't call useTranslations() itself.
function getIsoWeekInfo(
  dateString: string,
  t: ReturnType<typeof useTranslations<"statistiken">>,
): { key: string; label: string } {
  const { key, week } = getIsoWeek(dateString);
  return { key, label: t("weekLabel", { week }) };
}

// Formats a time-weighted wellbeing average as "4.1 / 5 (82%)" (parsed again in satisfaction.ts); "-" without data
function formatAverageSatisfactionLabel(
  weightedSum: number,
  weight: number,
  maxRank: number,
): string {
  if (weight <= 0 || maxRank <= 0) return "-";
  const avgRank = weightedSum / weight;
  // Keep percent consistent with the displayed 1-decimal average value.
  const avgRankRounded = Number(avgRank.toFixed(1));
  const ratio = avgRankRounded / maxRank;
  const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  return `${avgRankRounded.toFixed(1)} / ${maxRank} (${percent}%)`;
}

// --- Data aggregation helpers ---

// Builds the drill-down category tree, the daily bar chart data and the context aggregates
// (devices / social / location / wellbeing) from raw time entries. Only entries of tracked
// (submitted) days count. In the context aggregates, an entry with several devices or social
// contexts splits its minutes evenly between them.
function buildZeitverteilungData(
  entries: RawEntry[],
  dayIdToDate: Record<number, string>,
  allCourseDates: string[],
  trackedDayIds: Set<number>,
  activities: ActivityLookup[],
  subcategories: SubcategoryLookup[],
  categories: CategoryLookup[],
  digitalMediaById: Record<number, NamedCode>,
  socialContextById: Record<number, NamedCode>,
  locationById: Record<number, NamedCode>,
  satisfactionRankById: Record<number, number>,
  maxSatisfactionRank: number,
  t: ReturnType<typeof useTranslations<"statistiken">>,
): {
  categoryRows: CategoryRow[];
  barData: DayBarData[];
  categoryNames: string[];
  metaAggregates: MetaAggregates;
} {
  // Build lookup maps for fast access by ID
  const activityMap = new Map(activities.map((a) => [a.activity_id, a]));
  const subcategoryMap = new Map(
    subcategories.map((s) => [s.subcategory_id, s]),
  );
  const categoryMap = new Map(categories.map((c) => [c.category_id, c]));

  // Accumulate minutes: category → subcategory → activity
  // Structure: { categoryId: { subcategoryId: { activityId: minutes } } }
  const minuteTree: Record<number, Record<number, Record<number, number>>> = {};

  // Accumulate minutes per day per category for the bar chart
  // Structure: { date: { categoryId: minutes } }
  const dailyMinutes: Record<string, Record<number, number>> = {};
  const uncategorizedByDate: Record<string, number> = {};
  let uncategorizedTotal = 0;

  // Keyed by the language-neutral `code` (or a stable fallback sentinel) so
  // buckets stay consistent across locales; `name` inside each entry is the
  // already-localized display name.
  const deviceMinutesByCode: Record<string, { name: string; code: string; minutes: number }> = {};
  const socialMinutesByCode: Record<string, { name: string; code: string; minutes: number }> = {};
  const locationMinutesByCode: Record<string, { name: string; code: string; minutes: number }> = {};

  const activityMetaById: Record<
    number,
    {
      withDevicesMinutes: number;
      withoutDevicesMinutes: number;
      withPeopleMinutes: number;
      aloneMinutes: number;
      atHomeMinutes: number;
      elsewhereMinutes: number;
      satisfactionWeightedSum: number;
      satisfactionWeight: number;
    }
  > = {};

  let overallSatisfactionWeightedSum = 0;
  let overallSatisfactionWeight = 0;
  const trackedDates = new Set(
    Object.values(dayIdToDate).map((d) => normalizeDateOnly(d)),
  );

  for (const entry of entries) {
    // Only include entries from tracked days
    if (!trackedDayIds.has(entry.day_id)) continue;

    const dateRaw = dayIdToDate[entry.day_id];
    if (!dateRaw) continue;
    const date = normalizeDateOnly(dateRaw);

    const activity =
      entry.primary_activity_id != null
        ? activityMap.get(entry.primary_activity_id)
        : undefined;

    const minutes = calculateMinutes(entry.start_time, entry.end_time);

    const deviceTypeIds = entry.digital_media_type_ids;
    if (deviceTypeIds.length > 0) {
      const split = minutes / deviceTypeIds.length;
      for (const id of deviceTypeIds) {
        const info = digitalMediaById[id];
        const key = info?.code ?? `id-${id}`;
        if (!deviceMinutesByCode[key]) {
          deviceMinutesByCode[key] = {
            name: info?.name ?? t("fallbackLabels.unknownDevice", { id }),
            code: info?.code ?? "",
            minutes: 0,
          };
        }
        deviceMinutesByCode[key].minutes += split;
      }
    } else {
      const key = "__no_device__";
      if (!deviceMinutesByCode[key]) {
        // code "0" (Kein IT-Hilfsmittel) so it picks up the matching icon
        deviceMinutesByCode[key] = { name: t("fallbackLabels.noDevice"), code: "0", minutes: 0 };
      }
      deviceMinutesByCode[key].minutes += minutes;
    }

    const contextIds = entry.social_context_ids;
    if (contextIds.length > 0) {
      const split = minutes / contextIds.length;
      for (const id of contextIds) {
        const info = socialContextById[id];
        const key = info?.code ?? `id-${id}`;
        if (!socialMinutesByCode[key]) {
          socialMinutesByCode[key] = {
            name: info?.name ?? t("fallbackLabels.unknownContext", { id }),
            code: info?.code ?? "",
            minutes: 0,
          };
        }
        socialMinutesByCode[key].minutes += split;
      }
    } else {
      // Kept as a distinct bucket from an explicit "Alleine" selection (code "1"),
      // matching the previous behavior where the two used different label text.
      const key = "__no_context__";
      if (!socialMinutesByCode[key]) {
        socialMinutesByCode[key] = { name: t("fallbackLabels.aloneFallback"), code: "1", minutes: 0 };
      }
      socialMinutesByCode[key].minutes += minutes;
    }

    const locationInfo =
      entry.location_transport_id != null
        ? locationById[entry.location_transport_id]
        : undefined;
    const locationKey = locationInfo?.code ?? "__unknown_location__";
    if (!locationMinutesByCode[locationKey]) {
      locationMinutesByCode[locationKey] = {
        name: locationInfo?.name ?? t("fallbackLabels.unknownLocation"),
        code: locationInfo?.code ?? "",
        minutes: 0,
      };
    }
    locationMinutesByCode[locationKey].minutes += minutes;
    const isAtHomeForEntry = locationInfo
      ? isAtHomeLocationCode(locationInfo.code)
      : false;

    if (entry.satisfaction_id != null) {
      const rank = satisfactionRankById[entry.satisfaction_id];
      if (rank != null) {
        overallSatisfactionWeightedSum += rank * minutes;
        overallSatisfactionWeight += minutes;
      }
    }

    if (!activity) {
      uncategorizedByDate[date] = (uncategorizedByDate[date] ?? 0) + minutes;
      uncategorizedTotal += minutes;
      continue;
    }

    const subcategory = subcategoryMap.get(activity.subcategory_id);
    if (!subcategory) {
      uncategorizedByDate[date] = (uncategorizedByDate[date] ?? 0) + minutes;
      uncategorizedTotal += minutes;
      continue;
    }

    const category = categoryMap.get(subcategory.category_id);
    if (!category) {
      uncategorizedByDate[date] = (uncategorizedByDate[date] ?? 0) + minutes;
      uncategorizedTotal += minutes;
      continue;
    }
    const catId = category.category_id;
    const subId = subcategory.subcategory_id;
    const actId = activity.activity_id;

    if (!activityMetaById[actId]) {
      activityMetaById[actId] = {
        withDevicesMinutes: 0,
        withoutDevicesMinutes: 0,
        withPeopleMinutes: 0,
        aloneMinutes: 0,
        atHomeMinutes: 0,
        elsewhereMinutes: 0,
        satisfactionWeightedSum: 0,
        satisfactionWeight: 0,
      };
    }
    const activityMeta = activityMetaById[actId];

    if (deviceTypeIds.length > 0) {
      activityMeta.withDevicesMinutes += minutes;
    } else {
      activityMeta.withoutDevicesMinutes += minutes;
    }

    const contextCodes = contextIds.map((id) => socialContextById[id]?.code ?? "");
    const hasOtherPeople = contextCodes.some((code) => !isAloneContextCode(code));
    if (hasOtherPeople) {
      activityMeta.withPeopleMinutes += minutes;
    } else {
      activityMeta.aloneMinutes += minutes;
    }

    if (isAtHomeForEntry) {
      activityMeta.atHomeMinutes += minutes;
    } else {
      activityMeta.elsewhereMinutes += minutes;
    }

    if (entry.satisfaction_id != null) {
      const rank = satisfactionRankById[entry.satisfaction_id];
      if (rank != null) {
        activityMeta.satisfactionWeightedSum += rank * minutes;
        activityMeta.satisfactionWeight += minutes;
      }
    }

    // Accumulate into the tree
    if (!minuteTree[catId]) minuteTree[catId] = {};
    if (!minuteTree[catId][subId]) minuteTree[catId][subId] = {};
    minuteTree[catId][subId][actId] =
      (minuteTree[catId][subId][actId] ?? 0) + minutes;

    // Accumulate into daily map
    if (!dailyMinutes[date]) dailyMinutes[date] = {};
    dailyMinutes[date][catId] = (dailyMinutes[date][catId] ?? 0) + minutes;
  }

  // Total minutes across everything (for percentage calculation)
  const categorizedTotal = Object.values(minuteTree).reduce(
    (catSum, subs) =>
      catSum +
      Object.values(subs).reduce(
        (subSum, acts) =>
          subSum + Object.values(acts).reduce((a, b) => a + b, 0),
        0,
      ),
    0,
  );
  const grandTotal = categorizedTotal + uncategorizedTotal;

  // Build the CategoryRow array, sorted by total minutes descending
  const categoryRows: CategoryRow[] = categories
    .filter((cat) => minuteTree[cat.category_id])
    .map((cat) => {
      const subTree = minuteTree[cat.category_id];

      // Build subcategory rows
      const subcategoryRows: SubcategoryRow[] = subcategories
        .filter((sub) => subTree[sub.subcategory_id])
        .map((sub) => {
          const actTree = subTree[sub.subcategory_id];

          // Build activity rows
          const activityRows: ActivityRow[] = activities
            .filter((act) => actTree[act.activity_id])
            .map((act) => {
              const mins = actTree[act.activity_id];
              const meta = activityMetaById[act.activity_id];
              return {
                activityId: act.activity_id,
                name: act.name,
                totalMinutes: mins,
                percentOfTotal: grandTotal > 0 ? (mins / grandTotal) * 100 : 0,
                meta: {
                  withDevicesMinutes: meta?.withDevicesMinutes ?? 0,
                  withoutDevicesMinutes: meta?.withoutDevicesMinutes ?? 0,
                  withPeopleMinutes: meta?.withPeopleMinutes ?? 0,
                  aloneMinutes: meta?.aloneMinutes ?? 0,
                  atHomeMinutes: meta?.atHomeMinutes ?? 0,
                  elsewhereMinutes: meta?.elsewhereMinutes ?? 0,
                  satisfactionWeightedSum: meta?.satisfactionWeightedSum ?? 0,
                  satisfactionWeight: meta?.satisfactionWeight ?? 0,
                  avgSatisfactionLabel: formatAverageSatisfactionLabel(
                    meta?.satisfactionWeightedSum ?? 0,
                    meta?.satisfactionWeight ?? 0,
                    maxSatisfactionRank,
                  ),
                },
              };
            })
            .sort((a, b) => b.totalMinutes - a.totalMinutes);

          const subTotal = activityRows.reduce((s, a) => s + a.totalMinutes, 0);
          return {
            subcategoryId: sub.subcategory_id,
            name: sub.name,
            totalMinutes: subTotal,
            percentOfTotal: grandTotal > 0 ? (subTotal / grandTotal) * 100 : 0,
            isExpanded: true,
            activities: activityRows,
          };
        })
        .sort((a, b) => b.totalMinutes - a.totalMinutes);

      const catTotal = subcategoryRows.reduce(
        (s, sub) => s + sub.totalMinutes,
        0,
      );
      return {
        categoryId: cat.category_id,
        name: cat.name,
        totalMinutes: catTotal,
        percentOfTotal: grandTotal > 0 ? (catTotal / grandTotal) * 100 : 0,
        isExpanded: true,
        subcategories: subcategoryRows,
      };
    })
    .sort((a, b) => b.totalMinutes - a.totalMinutes);

  if (uncategorizedTotal > 0) {
    categoryRows.push({
      categoryId: 0,
      name: t("uncategorizedLabel"),
      totalMinutes: uncategorizedTotal,
      percentOfTotal:
        grandTotal > 0 ? (uncategorizedTotal / grandTotal) * 100 : 0,
      isExpanded: false,
      subcategories: [],
    });
    categoryRows.sort((a, b) => b.totalMinutes - a.totalMinutes);
  }

  // Build the sorted category name list (same order as categoryRows)
  const categoryNames = categoryRows.map((r) => r.name);

  // Build one DayBarData entry per course date
  const normalizedCourseDates = Array.from(
    new Set(allCourseDates.map((d) => normalizeDateOnly(d))),
  );
  const todayEpochDay = dateOnlyToEpochDay(getLocalIsoDate(new Date()));
  const barData: DayBarData[] = normalizedCourseDates.map((date) => {
    const isTrackedDay = trackedDates.has(date);

    // Not tracked day: show a small placeholder for past/today,
    // and no placeholder for future days.
    if (!isTrackedDay) {
      const dateEpochDay = dateOnlyToEpochDay(date);
      if (dateEpochDay > todayEpochDay) {
        return {
          date,
          isSubmitted: false,
        };
      }
      return {
        date,
        isSubmitted: false,
        unsubmitted: 60,
      };
    }

    // Submitted day: populate per-category minutes
    const dayEntry: DayBarData = { date, isSubmitted: true };
    for (const cat of categoryRows) {
      dayEntry[cat.name] =
        cat.categoryId === 0
          ? (uncategorizedByDate[date] ?? 0)
          : (dailyMinutes[date]?.[cat.categoryId] ?? 0);
    }
    return dayEntry;
  });

  const toSortedItems = (
    obj: Record<string, { name: string; code: string; minutes: number }>,
  ) =>
    Object.values(obj)
      .map((item) => ({
        name: item.name,
        code: item.code,
        minutes: Math.round(item.minutes),
      }))
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 8);

  const metaAggregates: MetaAggregates = {
    devices: toSortedItems(deviceMinutesByCode),
    social: toSortedItems(socialMinutesByCode),
    locations: toSortedItems(locationMinutesByCode),
    avgSatisfactionLabel: formatAverageSatisfactionLabel(
      overallSatisfactionWeightedSum,
      overallSatisfactionWeight,
      maxSatisfactionRank,
    ),
  };

  return { categoryRows, barData, categoryNames, metaAggregates };
}

// Splits two minute totals into rounded percentages that add up to 100; null without data
function pairPercent(leftMinutes: number, rightMinutes: number) {
  const total = leftMinutes + rightMinutes;
  if (total <= 0) return null;
  const leftPercent = Math.round((leftMinutes / total) * 100);
  return {
    leftPercent,
    rightPercent: 100 - leftPercent,
  };
}

// --- Main page component ---

export default function StatistikenPage() {
  const t = useTranslations("statistiken");
  const locale = useLocale() as Locale;
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<Tab>("zeitverteilung");
  const [isLoading, setIsLoading] = useState(true);
  // The course comparison loads in the background after the page is shown
  const [isComparisonLoading, setIsComparisonLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  // Incremented per loadAllData run, so an outdated run can bail out
  const loadIdRef = useRef(0);
  const [isCourseComparisonEnabled, setIsCourseComparisonEnabled] =
    useState(false);

  // Zeitverteilung tab state
  const [categoryRows, setCategoryRows] = useState<CategoryRow[]>([]);
  const [barData, setBarData] = useState<DayBarData[]>([]);
  const [categoryNames, setCategoryNames] = useState<string[]>([]);
  const [metaAggregates, setMetaAggregates] = useState<MetaAggregates | null>(
    null,
  );
  const [selectedWeeks, setSelectedWeeks] = useState<string[]>([]);
  const [weekOptions, setWeekOptions] = useState<
    { key: string; label: string }[]
  >([]);
  const [dayFilter, setDayFilter] = useState<DayFilterMode>("alle");
  // Latest filters, for the background comparison load to apply on arrival
  const filtersRef = useRef({ weeks: selectedWeeks, dayFilter });
  filtersRef.current = { weeks: selectedWeeks, dayFilter };

  // Raw data kept for KW-filter recomputation
  type RawDataSnapshot = {
    myEntries: RawEntry[];
    myDayIdToDate: Record<number, string>;
    allCourseDates: string[];
    trackedDayIds: Set<number>;
    activities: ActivityLookup[];
    subcategories: SubcategoryLookup[];
    categories: CategoryLookup[];
    digitalMediaById: Record<number, NamedCode>;
    socialContextById: Record<number, NamedCode>;
    locationById: Record<number, NamedCode>;
    satisfactionRankById: Record<number, number>;
    maxSatisfactionRank: number;
  };
  const rawDataRef = useRef<RawDataSnapshot | null>(null);

  // The viewer's own side of the course comparison. The course side (the other
  // participants) is computed on the server per filter, see loadCourseComparisonData.
  type RawComparisonSnapshot = {
    myEntries: RawEntry[];
    mySubmittedDayIds: Set<number>;
    myDayIdToDate: Record<number, string>;
    socialContextById: Record<number, NamedCode>;
    locationById: Record<number, NamedCode>;
    satisfactionRankById: Record<number, number>;
    maxSatisfactionRank: number;
  };
  const rawComparisonRef = useRef<RawComparisonSnapshot | null>(null);
  // "inactive" = switched off / too few participants: filters don't change anything
  const comparisonModeRef = useRef<"pending" | "inactive" | "active">("pending");
  // Only the answer to the latest comparison request is applied
  const comparisonRequestRef = useRef(0);

  // Kursvergleich tab state
  const [comparisonTopics, setComparisonTopics] = useState<ComparisonTopic[]>(
    [],
  );
  const [comparisonMetaStats, setComparisonMetaStats] =
    useState<ComparisonMetaStats | null>(null);
  const [categoryComparison, setCategoryComparison] = useState<
    CategoryComparison[]
  >([]);
  const [contextMetrics, setContextMetrics] = useState<ComparisonMetric[]>([]);
  const [qualifyingUserCount, setQualifyingUserCount] = useState(0);

  // Header info for the personal PDF export
  const [courseName, setCourseName] = useState("");
  const [participantName, setParticipantName] = useState("");
  const [participantId, setParticipantId] = useState("");
  const [isExportingPdf, setIsExportingPdf] = useState(false);

  // Tracks the last time data was loaded to avoid unnecessary reloads on tab switch
  const lastLoadTimeRef = useRef<number>(0);
  const RELOAD_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  useEffect(() => {
    loadAllData();

    const shouldReload = () =>
      Date.now() - lastLoadTimeRef.current > RELOAD_THRESHOLD_MS;

    const handleFocus = () => {
      if (shouldReload()) void loadAllData();
    };

    const handlePageShow = () => {
      if (shouldReload()) void loadAllData();
    };

    const handleVisibility = () => {
      if (!document.hidden && shouldReload()) void loadAllData();
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  // Recomputes Zeitverteilung stats from raw data, filtered by KW and day-of-week
  function computeAndSetStats(weeksFilter: string[], dayMode: DayFilterMode) {
    const raw = rawDataRef.current;
    if (!raw) return;

    let filteredCourseDates = raw.allCourseDates;
    let filteredTrackedDayIds = raw.trackedDayIds;

    // Apply KW filter
    if (weeksFilter.length > 0) {
      const weekKeySet = new Set(weeksFilter);
      filteredCourseDates = filteredCourseDates.filter((date) =>
        weekKeySet.has(getIsoWeekInfo(date, t).key),
      );
      filteredTrackedDayIds = new Set(
        [...filteredTrackedDayIds].filter((dayId) => {
          const date = raw.myDayIdToDate[dayId];
          return date != null && weekKeySet.has(getIsoWeekInfo(date, t).key);
        }),
      );
    }

    // Apply day-of-week filter
    if (dayMode === "werktage") {
      filteredCourseDates = filteredCourseDates.filter((d) => !isWeekend(d));
      filteredTrackedDayIds = new Set(
        [...filteredTrackedDayIds].filter((dayId) => {
          const date = raw.myDayIdToDate[dayId];
          return date != null && !isWeekend(date);
        }),
      );
    } else if (dayMode === "wochenende") {
      filteredCourseDates = filteredCourseDates.filter((d) => isWeekend(d));
      filteredTrackedDayIds = new Set(
        [...filteredTrackedDayIds].filter((dayId) => {
          const date = raw.myDayIdToDate[dayId];
          return date != null && isWeekend(date);
        }),
      );
    }

    const result = buildZeitverteilungData(
      raw.myEntries,
      raw.myDayIdToDate,
      filteredCourseDates,
      filteredTrackedDayIds,
      raw.activities,
      raw.subcategories,
      raw.categories,
      raw.digitalMediaById,
      raw.socialContextById,
      raw.locationById,
      raw.satisfactionRankById,
      raw.maxSatisfactionRank,
      t,
    );
    setCategoryRows(result.categoryRows);
    setBarData(result.barData);
    setCategoryNames(result.categoryNames);
    setMetaAggregates(result.metaAggregates);
  }

  function clearComparison(qualifyingCount: number) {
    setQualifyingUserCount(qualifyingCount);
    setComparisonTopics([]);
    setComparisonMetaStats(null);
    setCategoryComparison([]);
    setContextMetrics([]);
  }

  // Asks the server for the course side of the comparison (for these filters)
  // and combines it with the viewer's own values. Only the latest request wins.
  // fresh = new data snapshot (page load); filter changes reuse the snapshot.
  async function computeAndSetComparison(
    weeksFilter: string[],
    dayMode: DayFilterMode,
    fresh = false,
  ) {
    if (!rawComparisonRef.current) return;
    if (comparisonModeRef.current === "inactive") return;
    const requestId = ++comparisonRequestRef.current;
    let result: Awaited<ReturnType<typeof loadCourseComparisonData>>;
    try {
      result = await loadCourseComparisonData(weeksFilter, dayMode, fresh);
    } catch {
      result = null;
    }
    if (requestId !== comparisonRequestRef.current) return;
    setIsComparisonLoading(false);

    if (!result) {
      clearComparison(0);
      return;
    }
    if (!result.active) {
      comparisonModeRef.current = "inactive";
      clearComparison(result.qualifyingUserCount);
      return;
    }
    comparisonModeRef.current = "active";
    applyComparison(result, weeksFilter, dayMode);
  }

  function applyComparison(
    pool: CoursePool,
    weeksFilter: string[],
    dayMode: DayFilterMode,
  ) {
    const raw = rawComparisonRef.current;
    if (!raw) return;

    if (!pool.values) {
      clearComparison(pool.qualifyingUserCount);
      return;
    }
    const course = pool.values;
    setQualifyingUserCount(pool.qualifyingUserCount);

    // activity_id → category_id (needed for the per-category comparison)
    const lookups = rawDataRef.current;
    const activityToCategory = lookups
      ? buildActivityToCategory(lookups.subcategories, lookups.activities)
      : {};

    const myFilteredSubmittedDayIds = new Set(
      filterDayIds(
        [...raw.mySubmittedDayIds],
        raw.myDayIdToDate,
        weeksFilter,
        dayMode,
      ),
    );

    const mySleepValue = calcAverageHoursPerDay(
      raw.myEntries,
      myFilteredSubmittedDayIds,
      SLEEP_ACTIVITY_IDS,
    );
    const mySportValue = calcAverageHoursPerDay(
      raw.myEntries,
      myFilteredSubmittedDayIds,
      SPORT_ACTIVITY_IDS,
    );
    const mySmartphoneValue = calcSmartphoneHoursPerDay(
      raw.myEntries,
      myFilteredSubmittedDayIds,
    );

    const codeOf = (byId: Record<number, NamedCode>) => {
      const codes: Record<number, string> = {};
      for (const [id, item] of Object.entries(byId)) codes[Number(id)] = item.code;
      return codes;
    };
    const mine = sumContextMinutes(
      raw.myEntries,
      myFilteredSubmittedDayIds,
      codeOf(raw.socialContextById),
      codeOf(raw.locationById),
      raw.satisfactionRankById,
    );

    setComparisonTopics([
      {
        key: "schlaf",
        label: t("comparisonTopics.schlaf"),
        unit: t("perDayUnit"),
        allValues: course.sleep,
        userValue: mySleepValue,
      },
      {
        key: "sport",
        label: t("comparisonTopics.sport"),
        unit: t("perDayUnit"),
        allValues: course.sport,
        userValue: mySportValue,
      },
      {
        key: "smartphone",
        label: t("comparisonTopics.smartphone"),
        unit: t("perDayUnit"),
        allValues: course.smartphone,
        userValue: mySmartphoneValue,
      },
    ]);

    const myCategoryValues = hoursPerDayByCategory(
      raw.myEntries,
      myFilteredSubmittedDayIds,
      activityToCategory,
    );
    setCategoryComparison(
      (lookups?.categories ?? [])
        .map((cat) => ({
          categoryId: cat.category_id,
          name: cat.name,
          allValues: course.categoryValues[cat.category_id] ?? [],
          userValue: myCategoryValues[cat.category_id] ?? 0,
        }))
        // Skip categories nobody in the course used in this period
        .filter((c) => c.userValue > 0 || c.allValues.some((v) => v > 0)),
    );

    // Labels are resolved in the tab / PDF via the metric key (translatable)
    const myShare = (part: number, total: number) =>
      total > 0 ? (part / total) * 100 : 0;
    setContextMetrics([
      {
        key: "itDevice",
        unit: "%",
        scaleMax: 100,
        allValues: course.deviceShare,
        userValue: myShare(mine.withDevice, mine.withDevice + mine.withoutDevice),
      },
      {
        key: "social",
        unit: "%",
        scaleMax: 100,
        allValues: course.socialShare,
        userValue: myShare(mine.withOthers, mine.withOthers + mine.alone),
      },
      {
        key: "location",
        unit: "%",
        scaleMax: 100,
        allValues: course.homeShare,
        userValue: myShare(mine.atHome, mine.atHome + mine.elsewhere),
      },
      {
        key: "wellbeing",
        unit: "Punkte",
        scaleMax: raw.maxSatisfactionRank,
        allValues: course.wellbeing,
        userValue:
          mine.satisfactionWeight > 0
            ? mine.satisfactionWeightedSum / mine.satisfactionWeight
            : 0,
      },
    ]);

    const totals = course.totals;
    setComparisonMetaStats({
      itDevice: {
        user: pairPercent(mine.withDevice, mine.withoutDevice),
        course: pairPercent(totals.withDevice, totals.withoutDevice),
      },
      social: {
        user: pairPercent(mine.withOthers, mine.alone),
        course: pairPercent(totals.withOthers, totals.alone),
      },
      location: {
        user: pairPercent(mine.atHome, mine.elsewhere),
        course: pairPercent(totals.atHome, totals.elsewhere),
      },
      wellbeing: {
        userLabel: formatAverageSatisfactionLabel(
          mine.satisfactionWeightedSum,
          mine.satisfactionWeight,
          raw.maxSatisfactionRank,
        ),
        courseLabel: formatAverageSatisfactionLabel(
          totals.satisfactionWeightedSum,
          totals.satisfactionWeight,
          raw.maxSatisfactionRank,
        ),
      },
    });
  }

  // --- Data loading ---

  async function loadAllData() {
    // A later reload (focus/visibility) supersedes this one: results of an
    // outdated run are dropped instead of overwriting newer state
    const loadId = ++loadIdRef.current;
    const isStale = () => loadId !== loadIdRef.current;
    // Answers to comparison requests of an earlier run are dropped as well
    comparisonRequestRef.current++;

    lastLoadTimeRef.current = Date.now();
    setIsLoading(true);
    setErrorMessage("");

    // One server call returns the course enrollment, course settings, profile, periods,
    // lookup tables, this user's days and the time entries of this user's SUBMITTED days.
    // Only submitted days count, the same basis as the Kursvergleich, the PDF
    // and the admin export. Days still "in Bearbeitung" are partially filled and
    // would distort totals and per-day averages; they show as grey placeholders.
    let data: Awaited<ReturnType<typeof loadStatistikenData>>;
    try {
      data = await loadStatistikenData();
    } catch {
      data = { status: "error" };
    }
    if (isStale()) return;
    if (data.status === "unauthenticated") {
      router.push("/");
      return;
    }
    if (data.status === "error") {
      setErrorMessage(t("errors.lookupDataLoadError"));
      setIsLoading(false);
      return;
    }
    const userId = data.userId;
    setParticipantId(userId);
    if (data.status === "no_course") {
      setErrorMessage(t("errors.noCourseFound"));
      setIsLoading(false);
      return;
    }
    const {
      course: courseSettings,
      profile: myProfile,
      periods: periodsData,
      lookups,
      myDays,
      myEntries: allMyEntries,
    } = data;

    setIsCourseComparisonEnabled(courseSettings?.comparison_enabled === true);
    setCourseName(courseSettings?.name ?? "");
    setParticipantName(
      [myProfile?.first_name, myProfile?.last_name]
        .map((v) => (v ?? "").trim())
        .filter(Boolean)
        .join(" ") ||
        data.email ||
        "",
    );

    // Course dates come from the course periods; courses without periods fall back to
    // the start_date / end_date columns of the course
    let allCourseDates: string[];
    if (periodsData && periodsData.length > 0) {
      allCourseDates = getPeriodDates(periodsData);
    } else {
      if (!courseSettings) {
        setErrorMessage(t("errors.courseDataLoadError"));
        setIsLoading(false);
        return;
      }
      allCourseDates = getSinglePeriodDates(
        courseSettings.start_date,
        courseSettings.end_date,
      );
    }

    // Localize display names once, here, so every downstream consumer that
    // reads `.name` (chart keys, table rows, etc.) gets the right locale
    // without further changes.
    const categories: CategoryLookup[] = lookups.categories.map((c) => ({
      ...c,
      name: getLocalizedName(c, locale),
    }));
    const subcategories: SubcategoryLookup[] = lookups.subcategories.map(
      (s) => ({
        ...s,
        name: getLocalizedName(s, locale),
      }),
    );
    const activities: ActivityLookup[] = lookups.activities.map((a) => ({
      ...a,
      name: getLocalizedName(a, locale),
    }));
    const mediaTypeRows: DigitalMediaTypeLookup[] = lookups.mediaTypes;
    const socialContextRows: SocialContextLookup[] = lookups.socialContexts;
    const locationRows: LocationTransportLookup[] = lookups.locations;
    const satisfactionRows: SatisfactionLookup[] = lookups.satisfactions;

    const digitalMediaById: Record<number, NamedCode> = {};
    for (const item of mediaTypeRows) {
      digitalMediaById[item.digital_media_type_id] = {
        name: getLocalizedName(item, locale),
        code: item.code,
      };
    }
    const socialContextById: Record<number, NamedCode> = {};
    for (const item of socialContextRows) {
      socialContextById[item.social_context_id] = {
        name: getLocalizedName(item, locale),
        code: item.code,
      };
    }
    const locationById: Record<number, NamedCode> = {};
    for (const item of locationRows) {
      locationById[item.location_transport_id] = {
        name: getLocalizedName(item, locale),
        code: item.code,
      };
    }
    const { satisfactionRankById, maxSatisfactionRank } =
      buildSatisfactionRanks(satisfactionRows);

    const allMyDays = myDays ?? [];
    const submittedDayIds = new Set(
      allMyDays.filter((d) => d.is_submitted).map((d) => d.day_id),
    );

    const trackedDays = allMyDays.filter((d) => d.is_submitted);
    const trackedDayIds = new Set(trackedDays.map((d) => d.day_id));

    const myDayIdToDate: Record<number, string> = {};
    for (const d of trackedDays) {
      myDayIdToDate[d.day_id] = normalizeDateOnly(d.date);
    }

    const myEntries = allMyEntries.filter((e) => trackedDayIds.has(e.day_id));

    // Build the Zeitverteilung data from the user's own entries
    const zeitverteilungResult = buildZeitverteilungData(
      myEntries,
      myDayIdToDate,
      allCourseDates,
      trackedDayIds,
      activities,
      subcategories,
      categories,
      digitalMediaById,
      socialContextById,
      locationById,
      satisfactionRankById,
      maxSatisfactionRank,
      t,
    );
    setCategoryRows(zeitverteilungResult.categoryRows);
    setBarData(zeitverteilungResult.barData);
    setCategoryNames(zeitverteilungResult.categoryNames);
    setMetaAggregates(zeitverteilungResult.metaAggregates);

    // Store raw data for KW-filter recomputation
    rawDataRef.current = {
      myEntries,
      myDayIdToDate,
      allCourseDates,
      trackedDayIds,
      activities,
      subcategories,
      categories,
      digitalMediaById,
      socialContextById,
      locationById,
      satisfactionRankById,
      maxSatisfactionRank,
    };

    // Build week options from all course dates
    const weekOptionsList: { key: string; label: string }[] = [];
    const seenWeekKeys = new Set<string>();
    for (const date of zeitverteilungResult.barData.map((d) => d.date)) {
      const info = getIsoWeekInfo(date, t);
      if (!seenWeekKeys.has(info.key)) {
        seenWeekKeys.add(info.key);
        weekOptionsList.push(info);
      }
    }
    setWeekOptions(weekOptionsList);
    setSelectedWeeks([]);

    // Zeitverteilung is ready: show the page now. The course comparison
    // continues in the background and only gates the Kursvergleich tab.
    lastLoadTimeRef.current = Date.now();
    setIsLoading(false);

    // Course comparison. The server checks comparison_enabled and the
    // thresholds (≥ 3 participants with ≥ 2 submitted days, excluded
    // participants left out) and returns only the course values; the
    // viewer's own values are computed here from the entries above.
    rawComparisonRef.current = {
      myEntries,
      mySubmittedDayIds: submittedDayIds,
      myDayIdToDate,
      socialContextById,
      locationById,
      satisfactionRankById,
      maxSatisfactionRank,
    };
    comparisonModeRef.current = "pending";
    setIsComparisonLoading(courseSettings?.comparison_enabled === true);
    // Weeks were just reset above (that state update has not rendered yet),
    // the day filter stays as picked
    await computeAndSetComparison([], filtersRef.current.dayFilter, true);
  }

  // --- Filter and accordion handlers ---

  // Week (KW) and day filters recompute both tabs: Zeitverteilung locally, Kursvergleich on the server
  function handleToggleWeek(weekKey: string) {
    setSelectedWeeks((prev) => {
      const next = prev.includes(weekKey)
        ? prev.filter((k) => k !== weekKey)
        : [...prev, weekKey];
      computeAndSetStats(next, dayFilter);
      void computeAndSetComparison(next, dayFilter);
      return next;
    });
  }

  function handleClearWeeks() {
    computeAndSetStats([], dayFilter);
    void computeAndSetComparison([], dayFilter);
    setSelectedWeeks([]);
  }

  function handleSetDayFilter(mode: DayFilterMode) {
    setDayFilter(mode);
    computeAndSetStats(selectedWeeks, mode);
    void computeAndSetComparison(selectedWeeks, mode);
  }

  // Toggles the expanded state of a category row in the drill-down table
  function handleToggleCategory(categoryId: number) {
    setCategoryRows((prev) =>
      prev.map((cat) =>
        cat.categoryId === categoryId
          ? { ...cat, isExpanded: !cat.isExpanded }
          : cat,
      ),
    );
  }

  // Toggles the expanded state of a subcategory row within a category
  function handleToggleSubcategory(categoryId: number, subcategoryId: number) {
    setCategoryRows((prev) =>
      prev.map((cat) =>
        cat.categoryId !== categoryId
          ? cat
          : {
              ...cat,
              subcategories: cat.subcategories.map((sub) =>
                sub.subcategoryId === subcategoryId
                  ? { ...sub, isExpanded: !sub.isExpanded }
                  : sub,
              ),
            },
      ),
    );
  }

  // --- Personal PDF export ---

  function buildFilterLabel(): string {
    const parts: string[] = [];
    if (dayFilter === "werktage") parts.push(t("pdf.filter.weekdaysOnly"));
    else if (dayFilter === "wochenende") parts.push(t("pdf.filter.weekendOnly"));
    if (selectedWeeks.length > 0) {
      const labels = weekOptions
        .filter((w) => selectedWeeks.includes(w.key))
        .map((w) => w.label);
      parts.push(labels.join(", "));
    }
    return parts.length > 0 ? parts.join(" · ") : t("pdf.filter.allDays");
  }

  async function handleExportPdf() {
    // The report's own texts are German only (see export-pdf.ts); the data labels passed in
    // (categories, activities, filter) follow the UI language
    setIsExportingPdf(true);
    try {
      await generatePersonalReportPdf({
        courseName,
        participantName,
        participantId,
        filterLabel: buildFilterLabel(),
        barData,
        categoryRows,
        metaAggregates,
        comparison: {
          enabled: isCourseComparisonEnabled,
          qualifyingUserCount,
          topics: comparisonTopics,
          metaStats: comparisonMetaStats,
          categories: categoryComparison,
        },
      });
    } finally {
      setIsExportingPdf(false);
    }
  }

  // Rendered inside the filter bar of both tabs (next to Tage / KW)
  const exportButton = (
    <button
      type="button"
      // The PDF includes the course comparison, so wait until it's loaded
      disabled={isExportingPdf || isComparisonLoading}
      onClick={() => void handleExportPdf()}
      title={t("pdf.buttonTitle")}
      className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:bg-blue-500/15"
    >
      <FileDown size={13} />
      {isExportingPdf ? t("pdf.buttonBusy") : t("pdf.button")}
    </button>
  );

  // --- Render ---

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-slate-500">{t("loading")}</p>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
        <p className="text-sm text-red-600">{errorMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Tab bar */}
      {isCourseComparisonEnabled && (
        <div className="flex gap-1 rounded-xl bg-slate-100 dark:bg-slate-800 p-1">
          <button
            type="button"
            onClick={() => setActiveTab("zeitverteilung")}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-all ${
              activeTab === "zeitverteilung"
                ? "bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 shadow-sm"
                : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            }`}
          >
            {t("tabs.zeitverteilung")}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("kursvergleich")}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-all ${
              activeTab === "kursvergleich"
                ? "bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 shadow-sm"
                : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            }`}
          >
            {t("tabs.kursvergleich")}
          </button>
        </div>
      )}

      {/* Tab content */}
      {activeTab === "zeitverteilung" ? (
        <ZeitverteilungTab
          barData={barData}
          categoryRows={categoryRows}
          categoryNames={categoryNames}
          metaAggregates={metaAggregates}
          selectedWeeks={selectedWeeks}
          weekOptions={weekOptions}
          dayFilter={dayFilter}
          onToggleWeek={handleToggleWeek}
          onClearWeeks={handleClearWeeks}
          onSetDayFilter={handleSetDayFilter}
          onToggleCategory={handleToggleCategory}
          onToggleSubcategory={handleToggleSubcategory}
          actions={exportButton}
        />
      ) : isCourseComparisonEnabled && isComparisonLoading ? (
        <div className="flex items-center justify-center py-20">
          <p className="text-slate-500 dark:text-slate-400">{t("loading")}</p>
        </div>
      ) : isCourseComparisonEnabled ? (
        <KursvergleichTab
          topics={comparisonTopics}
          categoryComparison={categoryComparison}
          contextMetrics={contextMetrics}
          qualifyingUserCount={qualifyingUserCount}
          selectedWeeks={selectedWeeks}
          weekOptions={weekOptions}
          dayFilter={dayFilter}
          onToggleWeek={handleToggleWeek}
          onClearWeeks={handleClearWeeks}
          onSetDayFilter={handleSetDayFilter}
          actions={exportButton}
        />
      ) : (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-6 text-center">
          <p className="text-sm font-semibold text-amber-800">
            {t("comparisonLocked.title")}
          </p>
          <p className="mt-1 text-xs text-amber-700">
            {t("comparisonLocked.description")}
          </p>
        </div>
      )}
    </div>
  );
}
