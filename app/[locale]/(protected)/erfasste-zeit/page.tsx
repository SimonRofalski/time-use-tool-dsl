"use client";
// "Erfasste Zeit" page: overview of all course days, one card row per course period,
// with per-day progress (covered 10-minute slots out of 144) and status. A card opens
// the day in Zeiterfassung. Data comes from the Server Action in ./actions.ts.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ClipboardList } from "lucide-react";
import { loadOverviewData as fetchOverviewData } from "./actions";
import {
  formatPeriodLabel,
  getPeriodDates,
  getSinglePeriodDates,
} from "@/lib/course-periods";
import { getLocalIsoDate } from "@/lib/local-date";

// --- Constants ---

// A full day consists of 144 time slots of 10 minutes each (24h x 6 slots/h)
const TOTAL_ENTRIES_PER_DAY = 144;

// Calculates how many 10-minute slots are covered by one time entry
// e.g. start="08:00:00", end="09:00:00" -> 6 slots
// Handles the midnight wrap: end_time "00:00" after a non-zero start means 1440 min
function calculateCoveredSlots(startTime: string, endTime: string): number {
  const [startHour, startMin] = startTime.split(":").map(Number);
  const [endHour, endMin] = endTime.split(":").map(Number);
  const startMinTotal = startHour * 60 + startMin;
  const endMinTotal =
    endHour === 0 && endMin === 0 && startMinTotal > 0
      ? 1440
      : endHour * 60 + endMin;
  return Math.round((endMinTotal - startMinTotal) / 10);
}

// --- Types ---

// The four possible states a diary day can be in
type DayStatus =
  | "nicht_verfuegbar" // date is in the future
  | "nicht_begonnen" // date is today or past, but no entries yet
  | "in_bearbeitung" // some entries exist, but day not submitted yet
  | "abgeschlossen"; // day is submitted (set automatically once all 144 slots are filled)

// Represents one calendar day in the course, enriched with progress data
type CourseDay = {
  date: string; // ISO format: "YYYY-MM-DD"
  dayId: number | null; // null if no day record exists in the database yet
  entryCount: number;
  isSubmitted: boolean;
  isComplete: boolean;
  dayQuestionnaireCompleted: boolean;
  status: DayStatus;
};

type CoursePeriodInfo = {
  course_period_id: number;
  start_date: string;
  end_date: string;
  sort_order: number;
};

// Basic course info shown in the page header
type CourseSummary = {
  courseName: string;
  periods: CoursePeriodInfo[];
};

type ErfassteZeitTranslate = ReturnType<typeof useTranslations<"erfassteZeit">>;

// "YYYY-MM-DD" -> days since 1970-01-01 (UTC-based, so no time-zone shift)
function dateOnlyToEpochDay(dateOnly: string): number {
  const normalized = dateOnly.slice(0, 10);
  const [year, month, day] = normalized.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

// --- Pure helper functions ---

// Determines the status of a day based on its date, entry count, and submission state.
// "Today" is the local date (getLocalIsoDate), never toISOString() (UTC).
function getDayStatus(
  date: string,
  entryCount: number,
  isSubmitted: boolean,
): DayStatus {
  if (isSubmitted) return "abgeschlossen";
  if (entryCount > 0) return "in_bearbeitung";

  const todayDate = getLocalIsoDate(new Date());
  if (dateOnlyToEpochDay(date) > dateOnlyToEpochDay(todayDate)) {
    return "nicht_verfuegbar";
  }

  return "nicht_begonnen";
}

// Returns a compact two-part date label for carousel cards
// e.g. "2026-03-28" -> { weekday: "Sat", dayMonth: "Mar 28" } (locale-dependent)
function formatDateCompact(
  dateString: string,
  locale: string,
): {
  weekday: string;
  dayMonth: string;
} {
  const date = new Date(dateString);
  const intlLocale = locale === "en" ? "en-US" : "de-DE";
  return {
    weekday: date.toLocaleDateString(intlLocale, { weekday: "short" }),
    dayMonth: date.toLocaleDateString(intlLocale, {
      day: "numeric",
      month: "short",
    }),
  };
}

// Returns Tailwind CSS classes for background, text, progress bar, and badge
// based on the day's status
function getStatusColors(status: DayStatus): {
  cardBg: string;
  labelBg: string;
  labelText: string;
  barFill: string;
  percentText: string;
} {
  switch (status) {
    case "nicht_verfuegbar":
      return {
        cardBg: "bg-slate-50 dark:bg-slate-900 opacity-60",
        labelBg: "bg-slate-100 dark:bg-slate-700",
        labelText: "text-slate-400 dark:text-slate-500",
        barFill: "bg-slate-200 dark:bg-slate-600",
        percentText: "text-slate-400 dark:text-slate-500",
      };
    case "nicht_begonnen":
      return {
        cardBg: "bg-white dark:bg-slate-800",
        labelBg: "bg-slate-100 dark:bg-slate-700",
        labelText: "text-slate-500 dark:text-slate-400",
        barFill: "bg-slate-300 dark:bg-slate-500",
        percentText: "text-slate-500 dark:text-slate-400",
      };
    case "in_bearbeitung":
      return {
        cardBg: "bg-orange-50 dark:bg-orange-900/20",
        labelBg: "bg-orange-100 dark:bg-orange-900/40",
        labelText: "text-orange-700 dark:text-orange-300",
        barFill: "bg-orange-400",
        percentText: "text-orange-600 dark:text-orange-400",
      };
    case "abgeschlossen":
      return {
        cardBg: "bg-green-50 dark:bg-green-900/20",
        labelBg: "bg-green-100 dark:bg-green-900/40",
        labelText: "text-green-700 dark:text-green-300",
        barFill: "bg-green-500",
        percentText: "text-green-600 dark:text-green-400",
      };
  }
}

// Returns the translated display label for a day status
function getStatusLabel(status: DayStatus, t: ErfassteZeitTranslate): string {
  switch (status) {
    case "nicht_verfuegbar":
      return t("status.nichtVerfuegbar");
    case "nicht_begonnen":
      return t("status.nichtBegonnen");
    case "in_bearbeitung":
      return t("status.inBearbeitung");
    case "abgeschlossen":
      return t("status.abgeschlossen");
  }
}

// --- Sub-components ---

// DayCarouselCard: compact vertical card used inside the horizontal carousel
function DayCarouselCard({
  day,
  onClick,
  onEditDayQuestions,
}: {
  day: CourseDay;
  onClick: () => void;
  // Only passed for completed days when the course asks the day questions
  onEditDayQuestions?: () => void;
}) {
  const t = useTranslations("erfassteZeit");
  const tDayQuestionnaire = useTranslations("dayQuestionnaire");
  const locale = useLocale();
  const colors = getStatusColors(day.status);
  const isAvailable = day.status !== "nicht_verfuegbar";
  const completionPercentage = Math.min(
    Math.round((day.entryCount / TOTAL_ENTRIES_PER_DAY) * 100),
    100,
  );
  const { weekday, dayMonth } = formatDateCompact(day.date, locale);

  return (
    <div
      className={`${colors.cardBg} flex-shrink-0 rounded-lg border border-slate-200 dark:border-slate-700 p-3 transition-shadow ${
        isAvailable
          ? "cursor-pointer hover:shadow-md"
          : "cursor-default opacity-60"
      }`}
      style={{ scrollSnapAlign: "start" }}
      onClick={isAvailable ? onClick : undefined}
    >
      {/* Date */}
      <p className="text-xs font-medium text-slate-400 dark:text-slate-500">{weekday}</p>
      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 leading-tight">
        {dayMonth}
      </p>

      {/* Status badge */}
      <span
        className={`mt-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${colors.labelBg} ${colors.labelText}`}
      >
        {getStatusLabel(day.status, t)}
      </span>

      {/* Progress bar */}
      <div className="mt-3 h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-700">
        <div
          className={`h-1.5 rounded-full ${colors.barFill} transition-all duration-300`}
          style={{ width: `${completionPercentage}%` }}
        />
      </div>

      {/* Percentage + entry count */}
      <div className="mt-1.5 flex items-center justify-between">
        <p className="text-xs text-slate-400">
          {day.entryCount}/{TOTAL_ENTRIES_PER_DAY}
        </p>
        <p className={`text-sm font-semibold ${colors.percentText}`}>
          {completionPercentage}%
        </p>
      </div>

      {/* w-0 + min-w-full: the button wraps its label instead of widening
          the (content-sized) card beyond its neighbours */}
      {onEditDayQuestions && (
        <button
          type="button"
          onClick={(event) => {
            // The card itself opens the day in Zeiterfassung
            event.stopPropagation();
            onEditDayQuestions();
          }}
          className={`mt-2 flex w-0 min-w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-center text-[11px] leading-tight transition-colors ${
            day.dayQuestionnaireCompleted
              ? "border-green-200 bg-white font-medium text-green-700 hover:bg-green-100 dark:border-green-800/50 dark:bg-slate-900 dark:text-green-300 dark:hover:bg-green-900/40"
              : "border-amber-300 bg-amber-50 font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
          }`}
        >
          <ClipboardList size={12} className="shrink-0" />
          {day.dayQuestionnaireCompleted
            ? tDayQuestionnaire("editButton")
            : tDayQuestionnaire("answerButton")}
        </button>
      )}
    </div>
  );
}

// DayCarousel: the days of one period; a grid on mobile, a horizontally
// scrolling (scroll-snap) card row on desktop
function DayCarousel({
  days,
  onDayClick,
  onEditDayQuestions,
  label,
}: {
  days: CourseDay[];
  onDayClick: (date: string) => void;
  // Set when the course asks the day questions; offered on completed days
  onEditDayQuestions?: (date: string) => void;
  label?: string;
}) {
  const t = useTranslations("erfassteZeit");

  const editHandlerFor = (day: CourseDay) =>
    onEditDayQuestions && day.isComplete
      ? () => onEditDayQuestions(day.date)
      : undefined;

  return (
    <div>
      {/* Header row: period date range + day count */}
      <div className="mb-3 flex items-center">
        <p className="text-sm font-medium text-slate-600">
          {label ?? t("dayCountLabel", { count: days.length })}
        </p>
      </div>

      {/* Mobile: all days visible in a responsive grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:hidden">
        {days.map((day) => (
          <DayCarouselCard
            key={day.date}
            day={day}
            onClick={() => onDayClick(day.date)}
            onEditDayQuestions={editHandlerFor(day)}
          />
        ))}
      </div>

      {/* Desktop: horizontally scrollable card row */}
      <div
        className="hidden gap-3 overflow-x-auto pb-2 md:flex"
        style={{ scrollSnapType: "x mandatory", scrollbarWidth: "none" }}
      >
        {days.map((day) => (
          <DayCarouselCard
            key={day.date}
            day={day}
            onClick={() => onDayClick(day.date)}
            onEditDayQuestions={editHandlerFor(day)}
          />
        ))}
      </div>
    </div>
  );
}

// SummaryBar: three summary containers at the bottom of the page
// Only counts days up to and including today (future days are excluded)
function SummaryBar({ days }: { days: CourseDay[] }) {
  const t = useTranslations("erfassteZeit");
  // Exclude future days from the summary counts
  const pastAndTodayDays = days.filter(
    (day) => day.status !== "nicht_verfuegbar",
  );

  const completedCount = pastAndTodayDays.filter(
    (day) => day.status === "abgeschlossen",
  ).length;

  const inProgressCount = pastAndTodayDays.filter(
    (day) => day.status === "in_bearbeitung",
  ).length;

  const notStartedCount = pastAndTodayDays.filter(
    (day) => day.status === "nicht_begonnen",
  ).length;

  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {/* Completed days */}
      <div className="w-full rounded-lg border border-green-200 dark:border-green-800/40 bg-green-50 dark:bg-green-900/20 px-3 py-2.5 text-center sm:w-[220px]">
        <p className="text-xl font-bold text-green-600 dark:text-green-400">{completedCount}</p>
        <p className="mt-0.5 text-xs font-medium text-green-700 dark:text-green-300">
          {t("status.abgeschlossen")}
        </p>
      </div>

      {/* In-progress days */}
      <div className="w-full rounded-lg border border-orange-200 dark:border-orange-800/40 bg-orange-50 dark:bg-orange-900/20 px-3 py-2.5 text-center sm:w-[220px]">
        <p className="text-xl font-bold text-orange-500 dark:text-orange-400">{inProgressCount}</p>
        <p className="mt-0.5 text-xs font-medium text-orange-700 dark:text-orange-300">
          {t("status.inBearbeitung")}
        </p>
      </div>

      {/* Not started days */}
      <div className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2.5 text-center sm:w-[220px]">
        <p className="text-xl font-bold text-slate-500 dark:text-slate-300">{notStartedCount}</p>
        <p className="mt-0.5 text-xs font-medium text-slate-600 dark:text-slate-400">
          {t("status.nichtBegonnen")}
        </p>
      </div>
    </div>
  );
}

// --- Main page component ---

export default function ErfassteZeitPage() {
  const t = useTranslations("erfassteZeit");
  const locale = useLocale();
  const router = useRouter();

  // --- State ---
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [courseSummary, setCourseSummary] = useState<CourseSummary | null>(
    null,
  );
  const [courseDays, setCourseDays] = useState<CourseDay[]>([]);
  const [periods, setPeriods] = useState<CoursePeriodInfo[]>([]);
  // Per-course opt-in flag for the day questionnaire (admin-toggleable)
  const [askDayQuestionnaire, setAskDayQuestionnaire] = useState(false);

  // Tracks the last time data was loaded to avoid unnecessary reloads on tab switch
  const lastLoadTimeRef = useRef<number>(0);
  const RELOAD_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  // --- Data loading ---
  // Load all overview data when the component mounts and again when the tab/page
  // becomes visible after more than RELOAD_THRESHOLD_MS (e.g. returning from Zeiterfassung)
  useEffect(() => {
    loadOverviewData();

    const shouldReload = () =>
      Date.now() - lastLoadTimeRef.current > RELOAD_THRESHOLD_MS;

    const handleFocus = () => {
      if (shouldReload()) void loadOverviewData();
    };

    const handlePageShow = () => {
      if (shouldReload()) void loadOverviewData();
    };

    const handleVisibility = () => {
      if (!document.hidden && shouldReload()) void loadOverviewData();
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

  // Loads the overview and merges it into one CourseDay per course date
  async function loadOverviewData() {
    lastLoadTimeRef.current = Date.now();
    setIsLoading(true);
    setErrorMessage("");

    // One server call: session user, enrollment (one course per user), course,
    // periods, day records and the entries of those days
    const overview = await fetchOverviewData();
    if (!overview) {
      setErrorMessage(t("errors.userLoadError"));
      setIsLoading(false);
      return;
    }
    if (overview.status !== "ok") {
      setErrorMessage(
        t(
          overview.status === "no_course"
            ? "errors.noCourseFound"
            : overview.status === "course_error"
              ? "errors.courseInfoLoadError"
              : overview.status === "entries_error"
                ? "errors.entriesLoadError"
                : "errors.daysLoadError",
        ),
      );
      setIsLoading(false);
      return;
    }
    const courseData = overview.course;
    const periodsData = overview.periods;
    const dayRecords = overview.dayRecords;

    const loadedPeriods: CoursePeriodInfo[] = (periodsData ?? []).map((p) => ({
      course_period_id: p.course_period_id,
      start_date: p.start_date,
      end_date: p.end_date,
      sort_order: p.sort_order,
    }));

    // Fallback for courses without periods: the course's own start/end date
    const effectivePeriods =
      loadedPeriods.length > 0
        ? loadedPeriods
        : [
            {
              course_period_id: 0,
              start_date: courseData.start_date,
              end_date: courseData.end_date,
              sort_order: 0,
            },
          ];

    setPeriods(effectivePeriods);
    setAskDayQuestionnaire(courseData.ask_day_questionnaire === true);
    setCourseSummary({
      courseName: courseData.name,
      periods: effectivePeriods,
    });

    // Count covered slots per day from the loaded entry rows
    const dayIds = (dayRecords ?? []).map((d) => d.day_id);
    const entryCountByDayId: Record<number, number> = {};

    if (dayIds.length > 0) {
      // start_time + end_time of every entry, so covered 10-min slots can be
      // counted per day (one DB row can span multiple slots, so row count != slot count)
      const entryRows = overview.entryRows;

      // Sum covered slots per day instead of counting rows
      for (const row of entryRows) {
        const coveredSlots = calculateCoveredSlots(
          row.start_time,
          row.end_time,
        );
        entryCountByDayId[row.day_id] =
          (entryCountByDayId[row.day_id] ?? 0) + coveredSlots;
      }
    }

    // Lookup map from date string -> day record
    const dayRecordByDate: Record<string, (typeof dayRecords)[0]> = {};
    for (const dayRecord of dayRecords ?? []) {
      dayRecordByDate[dayRecord.date] = dayRecord;
    }

    // Generate all dates from all periods (lib/course-periods.ts) and merge with DB data
    const allDates = getPeriodDates(effectivePeriods);

    const mergedCourseDays: CourseDay[] = allDates.map((date) => {
      const dayRecord = dayRecordByDate[date] ?? null;
      const entryCount = dayRecord
        ? (entryCountByDayId[dayRecord.day_id] ?? 0)
        : 0;
      const isSubmitted = dayRecord?.is_submitted ?? false;

      return {
        date,
        dayId: dayRecord?.day_id ?? null,
        entryCount,
        isSubmitted,
        isComplete: dayRecord?.is_complete ?? false,
        dayQuestionnaireCompleted:
          dayRecord?.day_questionnaire_completed ?? false,
        status: getDayStatus(date, entryCount, isSubmitted),
      };
    });

    setCourseDays(mergedCourseDays);
    lastLoadTimeRef.current = Date.now();
    setIsLoading(false);
  }

  // Navigates to the Zeiterfassung page for the selected date
  function handleDayClick(date: string) {
    router.push(`/zeiterfassung?date=${date}`);
  }

  // Opens the day in Zeiterfassung with its day questions already open
  function handleEditDayQuestions(date: string) {
    router.push(`/zeiterfassung?date=${date}&dayQuestions=1`);
  }

  // --- Render states ---

  if (isLoading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label={t("loadingAriaLabel")}>
        {/* Skeleton SummaryBar */}
        <div className="flex flex-wrap items-stretch gap-2">
          <div className="w-full rounded-lg border border-green-200 dark:border-green-800/40 bg-green-50 dark:bg-green-900/20 px-3 py-2.5 text-center sm:w-[220px]">
            <div className="mx-auto h-7 w-8 animate-pulse rounded bg-green-200 dark:bg-green-800/50" />
            <p className="mt-0.5 text-xs font-medium text-green-700 dark:text-green-400">
              {t("status.abgeschlossen")}
            </p>
          </div>
          <div className="w-full rounded-lg border border-orange-200 dark:border-orange-800/40 bg-orange-50 dark:bg-orange-900/20 px-3 py-2.5 text-center sm:w-[220px]">
            <div className="mx-auto h-7 w-8 animate-pulse rounded bg-orange-200 dark:bg-orange-800/50" />
            <p className="mt-0.5 text-xs font-medium text-orange-700 dark:text-orange-400">
              {t("status.inBearbeitung")}
            </p>
          </div>
          <div className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2.5 text-center sm:w-[220px]">
            <div className="mx-auto h-7 w-8 animate-pulse rounded bg-slate-200 dark:bg-slate-700" />
            <p className="mt-0.5 text-xs font-medium text-slate-600 dark:text-slate-400">
              {t("status.nichtBegonnen")}
            </p>
          </div>
        </div>

        {/* Skeleton carousel section */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 shadow-sm">
          <div className="mb-3 flex items-center">
            <p className="text-sm font-medium text-slate-600 dark:text-slate-400">{t("loadingCarouselLabel")}</p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:hidden">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="flex-shrink-0 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 animate-pulse"
              >
                <div className="h-3 w-8 rounded bg-slate-200 dark:bg-slate-700" />
                <div className="mt-1 h-4 w-14 rounded bg-slate-200 dark:bg-slate-700" />
                <div className="mt-2 h-4 w-20 rounded-full bg-slate-100 dark:bg-slate-700" />
                <div className="mt-3 h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-700" />
              </div>
            ))}
          </div>
          <div className="hidden gap-3 md:flex">
            {Array.from({ length: 7 }).map((_, i) => (
              <div
                key={i}
                className="flex-shrink-0 w-28 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 animate-pulse"
              >
                <div className="h-3 w-8 rounded bg-slate-200 dark:bg-slate-700" />
                <div className="mt-1 h-4 w-14 rounded bg-slate-200 dark:bg-slate-700" />
                <div className="mt-2 h-4 w-20 rounded-full bg-slate-100 dark:bg-slate-700" />
                <div className="mt-3 h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-700" />
              </div>
            ))}
          </div>
        </section>
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

  // Groups the flat courseDays list into one entry per period
  const groupedPeriods = periods.map((period) => {
    const periodDates = new Set(
      getSinglePeriodDates(period.start_date, period.end_date),
    );
    return {
      period,
      days: courseDays.filter((d) => periodDates.has(d.date)),
    };
  });

  return (
    <div className="space-y-4">
      {/* Compact status summary across all periods */}
      <SummaryBar days={courseDays} />

      {/* One carousel section per period */}
      {groupedPeriods.map(({ period, days: periodDays }) => (
        <section
          key={period.course_period_id}
          className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 shadow-sm"
        >
          <DayCarousel
            days={periodDays}
            onDayClick={handleDayClick}
            onEditDayQuestions={
              askDayQuestionnaire ? handleEditDayQuestions : undefined
            }
            label={formatPeriodLabel(
              period.start_date,
              period.end_date,
              locale === "en" ? "en" : "de",
            )}
          />
        </section>
      ))}
    </div>
  );
}
