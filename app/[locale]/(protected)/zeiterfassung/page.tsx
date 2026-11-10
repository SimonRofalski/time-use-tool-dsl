"use client";
// Zeiterfassung page: the user picks a course day, selects 10-minute slots in the
// TimeGrid and answers the step-by-step ActivitySelector questionnaire; the answers
// are saved per slot. Optional per-course extras: extra ratings, ICT focus question
// and the DayQuestionnaireModal for completed days. Data goes through ./actions.ts.
// During the guided tour the page renders a scripted demo scene instead of real state.

import dynamic from "next/dynamic";
import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ClipboardList } from "lucide-react";
import {
  deleteSlotEntries,
  loadDayEntries,
  loadDayRecord,
  loadZeiterfassungBase,
  saveSlotEntries,
} from "./actions";
import {
  type TimeEntryRecord,
  type PendingEntry,
  type QuestionnaireStep,
  type LookupData,
} from "./types";
import { shouldAskIctAttention } from "./ict-attention";
import { getPeriodDates, getSinglePeriodDates } from "@/lib/course-periods";
import { getLocalIsoDate } from "@/lib/local-date";

// Fallbacks shown while the dynamically imported components load
function TimeGridLoading() {
  const t = useTranslations("zeiterfassung");
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-6 text-center text-sm text-slate-500 dark:text-slate-400">
      {t("gridLoading")}
    </div>
  );
}

function ActivitySelectorLoading() {
  const t = useTranslations("zeiterfassung");
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-6 text-center text-sm text-slate-500 dark:text-slate-400">
      {t("questionnaireLoading")}
    </div>
  );
}

import type { PendingSlotPreview } from "./TimeGrid";
import {
  TUTORIAL_DEMO_EVENT,
  getCurrentTutorialDemo,
  type TutorialDemo,
  type TutorialDemoEventDetail,
} from "@/app/components/tutorial/TutorialTour";

// Heavy components are code-split so the page shell renders first
const TimeGrid = dynamic(() => import("./TimeGrid"), {
  loading: TimeGridLoading,
});

const ActivitySelector = dynamic(() => import("./ActivitySelector"), {
  loading: ActivitySelectorLoading,
});

const DayQuestionnaireModal = dynamic(() => import("./DayQuestionnaireModal"));

// --- Constants ---

// 24 h x 6 slots of 10 minutes; a day is complete when all are covered
const TOTAL_SLOTS_PER_DAY = 144;

// --- Pure helper functions ---

// Formats a date string to long format, e.g. "Friday, March 28, 2026" (locale-dependent)
function formatDateLong(dateString: string, locale: string): string {
  return new Date(dateString).toLocaleDateString(
    locale === "en" ? "en-US" : "de-DE",
    {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    },
  );
}

// Formats a date string to compact format: "Di., 05.05.2026"
function formatDateCompact(dateString: string, locale: string): string {
  return new Date(dateString).toLocaleDateString(
    locale === "en" ? "en-US" : "de-DE",
    {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    },
  );
}

// Day + month only ("27.03."), for the narrow prev/next buttons on mobile
function formatDateShort(dateString: string, locale: string): string {
  return new Date(dateString).toLocaleDateString(
    locale === "en" ? "en-US" : "de-DE",
    { day: "2-digit", month: "2-digit" },
  );
}

// Strips seconds from a DB time string: "08:30:00" -> "08:30"
function normalizeDbTime(dbTime: string): string {
  return dbTime.substring(0, 5);
}

// Calculates how many 10-minute slots are covered by a time range
// Handles the midnight wrap: end_time "00:00" after a non-zero start means 1440 min
function calculateCoveredSlots(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const startMinTotal = sh * 60 + sm;
  const endMinTotal =
    eh === 0 && em === 0 && startMinTotal > 0 ? 1440 : eh * 60 + em;
  return Math.round((endMinTotal - startMinTotal) / 10);
}

// Determines the next questionnaire step based on the current step and pending data.
// Returns null when all steps are complete and the entry should be saved.
// The focused/background ICT question has no step of its own: it is shown on
// the device-type screen (see shouldAskIctAttention in ./ict-attention.ts).
function getNextStep(
  currentStep: QuestionnaireStep,
  entry: PendingEntry,
): QuestionnaireStep | null {
  switch (currentStep) {
    case "primary_activity":
      return "secondary_activity";
    case "secondary_activity":
      return "digital_media";
    case "digital_media":
      return entry.digital_media_used
        ? "digital_media_type"
        : "location_transport";
    case "digital_media_type":
      return "location_transport";
    case "location_transport":
      return "social_context";
    case "social_context":
      return "satisfaction";
    case "satisfaction":
      return null;
  }
}

// Creates a blank PendingEntry for a fresh questionnaire
function createEmptyPendingEntry(slots: string[]): PendingEntry {
  return {
    slots,
    primary_activity_id: null,
    secondary_activity_id: null,
    digital_media_used: false,
    digital_media_type_ids: [],
    ict_attention_id: null,
    location_transport_id: null,
    social_context_ids: [],
    satisfaction_id: null,
    meaningfulness_id: null,
    stressfulness_id: null,
  };
}

// Checks if all selected slots already have entries with identical activity data.
// If so, pre-fills the questionnaire for editing. Otherwise returns null (fresh start).
// Mixed selections (some filled, some empty, or different data) always return null.
function getPreloadedEntry(
  selectedSlots: Set<string>,
  existingEntries: TimeEntryRecord[],
): PendingEntry | null {
  const slotList = [...selectedSlots].sort();

  // Match existing entries by start_time (one entry per slot)
  const matchingEntries = existingEntries.filter((e) =>
    slotList.includes(e.start_time),
  );

  // No existing data -> fresh entry
  if (matchingEntries.length === 0) return null;

  // Mixed: some slots filled, some empty -> overwrite, start fresh
  if (matchingEntries.length !== slotList.length) return null;

  // All slots filled: only pre-load if every entry has identical activity data
  const first = matchingEntries[0];
  const sameIds = (a: number[], b: number[]) =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const allIdentical = matchingEntries.every(
    (e) =>
      e.primary_activity_id === first.primary_activity_id &&
      e.secondary_activity_id === first.secondary_activity_id &&
      e.satisfaction_id === first.satisfaction_id &&
      e.meaningfulness_id === first.meaningfulness_id &&
      e.stressfulness_id === first.stressfulness_id &&
      e.location_transport_id === first.location_transport_id &&
      e.digital_media_used === first.digital_media_used &&
      e.ict_attention_id === first.ict_attention_id &&
      sameIds(e.digital_media_type_ids, first.digital_media_type_ids) &&
      sameIds(e.social_context_ids, first.social_context_ids),
  );

  if (!allIdentical) return null;

  return {
    slots: slotList,
    primary_activity_id: first.primary_activity_id,
    secondary_activity_id: first.secondary_activity_id,
    digital_media_used: first.digital_media_used,
    digital_media_type_ids: first.digital_media_type_ids,
    ict_attention_id: first.ict_attention_id,
    location_transport_id: first.location_transport_id,
    social_context_ids: first.social_context_ids,
    satisfaction_id: first.satisfaction_id,
    meaningfulness_id: first.meaningfulness_id,
    stressfulness_id: first.stressfulness_id,
  };
}

// --- Tutorial scenes ---

// The tutorial's example selection: midnight to 06:00 (36 slots)
const TUTORIAL_DEMO_SLOTS = Array.from(
  { length: 36 },
  (_, i) =>
    `${Math.floor(i / 6)
      .toString()
      .padStart(2, "0")}:${((i % 6) * 10).toString().padStart(2, "0")}`,
);

type TutorialSceneState = {
  selectedSlots: Set<string>;
  pendingEntry: PendingEntry | null;
  step: QuestionnaireStep | null;
};

// Scripted questionnaire state per tutorial scene, rendered instead of the
// real state while the tour runs (never saved). Example: sleeping 00:00-06:00,
// no secondary activity, at home. Lookups by language-neutral `code`.
function buildTutorialScene(
  scene: TutorialDemo,
  lookupData: LookupData,
): TutorialSceneState {
  if (scene === "empty") {
    return { selectedSlots: new Set(), pendingEntry: null, step: null };
  }

  const activityId = (code: string) =>
    lookupData.activities.find((a) => a.code === code)?.activity_id ?? null;
  const sleepingId = activityId("011"); // sleeping
  const homeId =
    lookupData.locationTransports.find((l) => l.code === "11")
      ?.location_transport_id ?? null; // at home
  const aloneId =
    lookupData.socialContexts.find((s) => s.code === "1")
      ?.social_context_id ?? null; // alone

  const selectedSlots = new Set(TUTORIAL_DEMO_SLOTS);
  const empty = createEmptyPendingEntry(TUTORIAL_DEMO_SLOTS);
  const withPrimary = { ...empty, primary_activity_id: sleepingId };
  const withDevice = { ...withPrimary, digital_media_used: false };
  const withLocation = { ...withDevice, location_transport_id: homeId };

  switch (scene) {
    case "select-night":
      return { selectedSlots, pendingEntry: empty, step: "primary_activity" };
    case "primary-chosen":
      return {
        selectedSlots,
        pendingEntry: withPrimary,
        step: "secondary_activity",
      };
    case "device":
      return { selectedSlots, pendingEntry: withPrimary, step: "digital_media" };
    case "location":
      return {
        selectedSlots,
        pendingEntry: withDevice,
        step: "location_transport",
      };
    case "social":
      return {
        selectedSlots,
        pendingEntry: withLocation,
        step: "social_context",
      };
    case "satisfaction":
      return {
        selectedSlots,
        pendingEntry: {
          ...withLocation,
          social_context_ids: aloneId !== null ? [aloneId] : [],
        },
        step: "satisfaction",
      };
  }
}

// Maps a raw entry row (with nested media type / social context arrays) to TimeEntryRecord
function mapRawEntryToRecord(raw: any): TimeEntryRecord {
  return {
    entry_id: raw.entry_id,
    day_id: raw.day_id,
    start_time: normalizeDbTime(raw.start_time),
    end_time: normalizeDbTime(raw.end_time),
    primary_activity_id: raw.primary_activity_id,
    secondary_activity_id: raw.secondary_activity_id ?? null,
    satisfaction_id: raw.satisfaction_id ?? null,
    meaningfulness_id: raw.meaningfulness_id ?? null,
    stressfulness_id: raw.stressfulness_id ?? null,
    location_transport_id: raw.location_transport_id ?? null,
    digital_media_used: raw.digital_media_used,
    digital_media_type_ids:
      raw.time_entry_digital_media_type?.map(
        (r: any) => r.digital_media_type_id,
      ) ?? [],
    ict_attention_id: raw.ict_attention_id ?? null,
    social_context_ids:
      raw.time_entry_social_context?.map((sc: any) => sc.social_context_id) ??
      [],
  };
}

// --- CompletionBar component ---

// Shows the current date with prev/next arrows and a slot-fill progress bar
function CompletionBar({
  currentDate,
  coveredSlots,
  allDates,
  onDateChange,
  onEditDayQuestions,
  dayQuestionsAnswered,
}: {
  currentDate: string;
  coveredSlots: number;
  allDates: string[];
  onDateChange: (date: string) => void;
  // Shown for completed days when the course asks the day questions
  onEditDayQuestions?: () => void;
  // false = still open (postponed) -> highlighted "answer" button
  dayQuestionsAnswered: boolean;
}) {
  const t = useTranslations("zeiterfassung");
  const tDayQuestionnaire = useTranslations("dayQuestionnaire");
  const locale = useLocale();
  const currentIndex = allDates.indexOf(currentDate);
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex < allDates.length - 1;
  const previousDate = canGoPrev ? allDates[currentIndex - 1] : null;
  const nextDate = canGoNext ? allDates[currentIndex + 1] : null;
  const progressPercent = Math.min(
    Math.round((coveredSlots / TOTAL_SLOTS_PER_DAY) * 100),
    100,
  );
  const progressFillClass =
    coveredSlots <= 0
      ? "bg-slate-300"
      : coveredSlots >= TOTAL_SLOTS_PER_DAY
        ? "bg-green-500"
        : "bg-orange-400";
  const progressTextClass =
    coveredSlots <= 0
      ? "text-slate-500"
      : coveredSlots >= TOTAL_SLOTS_PER_DAY
        ? "text-green-600"
        : "text-orange-600";

  return (
    <div
      data-tour="day-nav"
      className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2.5 shadow-sm"
    >
      {/* Date row: prev | current (with inline progress) | next; a single
          row on every screen size; on mobile the side buttons shrink to an
          arrow + short date so the bar takes one line instead of three */}
      <div className="grid grid-cols-[3rem_1fr_3rem] items-stretch gap-2 sm:grid-cols-[140px_1fr_140px]">
        <button
          type="button"
          onClick={() => canGoPrev && onDateChange(allDates[currentIndex - 1])}
          disabled={!canGoPrev}
          aria-label={t("completionBar.previousLabel")}
          className="relative flex flex-col items-center justify-center overflow-hidden rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-1 transition-colors hover:border-slate-300 dark:hover:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-35 sm:block sm:px-4 sm:py-1.5 sm:text-right"
        >
          {/* Mobile: arrow + short date */}
          <span className="text-2xl font-light leading-none text-slate-400 dark:text-slate-500 select-none sm:hidden">
            ‹
          </span>
          {previousDate && (
            <span className="text-[10px] font-medium leading-tight text-slate-500 dark:text-slate-400 sm:hidden">
              {formatDateShort(previousDate, locale)}
            </span>
          )}
          {/* Desktop: label + full date */}
          <span className="pointer-events-none absolute left-1 top-1/2 hidden -translate-y-1/2 text-5xl font-light text-slate-400 dark:text-slate-500 select-none leading-none sm:block">
            ‹
          </span>
          <p className="relative hidden text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500 sm:block">
            {t("completionBar.previousLabel")}
          </p>
          <p className="relative hidden text-xs font-medium text-slate-600 dark:text-slate-300 sm:block">
            {previousDate
              ? formatDateCompact(previousDate, locale)
              : t("completionBar.noPreviousDay")}
          </p>
        </button>

        {/* Current date + progress inline */}
        <div className="rounded-lg border border-blue-200 dark:border-blue-800/50 bg-blue-50 dark:bg-blue-900/20 px-3 py-1.5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:shadow-none">
          <p className="text-sm font-bold text-blue-950 dark:text-blue-200 sm:text-[15px] leading-tight">
            {formatDateLong(currentDate, locale)}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-blue-100">
              <div
                className={`h-1.5 rounded-full ${progressFillClass} transition-all duration-500`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span
              className={`text-[10px] font-semibold whitespace-nowrap ${progressTextClass}`}
            >
              {coveredSlots}/{TOTAL_SLOTS_PER_DAY} · {progressPercent}%
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => canGoNext && onDateChange(allDates[currentIndex + 1])}
          disabled={!canGoNext}
          aria-label={t("completionBar.nextLabel")}
          className="relative flex flex-col items-center justify-center overflow-hidden rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-1 transition-colors hover:border-slate-300 dark:hover:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-35 sm:block sm:px-4 sm:py-1.5 sm:text-left"
        >
          {/* Mobile: arrow + short date */}
          <span className="text-2xl font-light leading-none text-slate-400 dark:text-slate-500 select-none sm:hidden">
            ›
          </span>
          {nextDate && (
            <span className="text-[10px] font-medium leading-tight text-slate-500 dark:text-slate-400 sm:hidden">
              {formatDateShort(nextDate, locale)}
            </span>
          )}
          {/* Desktop: label + full date */}
          <span className="pointer-events-none absolute right-1 top-1/2 hidden -translate-y-1/2 text-5xl font-light text-slate-400 dark:text-slate-500 select-none leading-none sm:block">
            ›
          </span>
          <p className="relative hidden text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500 sm:block">
            {t("completionBar.nextLabel")}
          </p>
          <p className="relative hidden text-xs font-medium text-slate-600 dark:text-slate-300 sm:block">
            {nextDate
              ? formatDateCompact(nextDate, locale)
              : t("completionBar.noNextDay")}
          </p>
        </button>
      </div>

      {onEditDayQuestions && (
        <div className="mt-2 flex justify-center">
          {dayQuestionsAnswered ? (
            <button
              type="button"
              onClick={onEditDayQuestions}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-slate-800"
            >
              <ClipboardList size={14} className="text-blue-600 dark:text-blue-400" />
              {tDayQuestionnaire("editButton")}
            </button>
          ) : (
            <button
              type="button"
              onClick={onEditDayQuestions}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
            >
              <ClipboardList size={14} />
              {tDayQuestionnaire("answerButton")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// --- IdlePlaceholder component ---

// Shown both during initial load and whenever no slots are selected
function IdlePlaceholder() {
  const t = useTranslations("zeiterfassung");
  return (
    <>
      <p className="text-3xl mb-4">⏱️</p>
      <p className="text-base font-semibold text-slate-700 dark:text-slate-200">
        {t("idlePlaceholder.title")}
      </p>
      <p className="mt-2 text-sm text-slate-400 dark:text-slate-500 leading-relaxed">
        {t("idlePlaceholder.line1")}
        <br className="hidden sm:block" /> {t("idlePlaceholder.line2")}
      </p>
    </>
  );
}

// --- Main page component ---

export default function ZeiterfassungPage() {
  // --- State ---
  const t = useTranslations("zeiterfassung");
  const router = useRouter();
  const searchParams = useSearchParams();

  // Auth + course
  const [userId, setUserId] = useState<string | null>(null);
  const [courseId, setCourseId] = useState<number | null>(null);
  const [allDates, setAllDates] = useState<string[]>([]);
  // Per-course opt-in flags (admin-toggleable, default off)
  const [askExtraRatings, setAskExtraRatings] = useState(false);
  const [askDayQuestionnaire, setAskDayQuestionnaire] = useState(false);
  const [askIctAttention, setAskIctAttention] = useState(false);
  // Day whose questionnaire popup is open: set automatically right after a
  // day transitions to fully complete (144/144 slots), or by the user
  const [dayQuestionnaireDayId, setDayQuestionnaireDayId] = useState<
    number | null
  >(null);
  // "prompt" = shown automatically (can be postponed), "edit" = opened by the user
  const [dayQuestionnaireMode, setDayQuestionnaireMode] = useState<
    "prompt" | "edit"
  >("prompt");
  // Whether the current day's questionnaire is answered (day.day_questionnaire_completed)
  const [dayQuestionnaireCompleted, setDayQuestionnaireCompleted] =
    useState(false);
  // Deep link from Erfasste Zeit (?dayQuestions=1): open the day questions
  // once, as soon as the linked day has loaded
  const openDayQuestionsOnLoadRef = useRef(
    searchParams.get("dayQuestions") === "1",
  );

  // Current day
  const [currentDate, setCurrentDate] = useState<string>("");
  const [dayId, setDayId] = useState<number | null>(null);
  const [existingEntries, setExistingEntries] = useState<TimeEntryRecord[]>([]);
  const [coveredSlots, setCoveredSlots] = useState(0);

  // Grid + questionnaire
  const [selectedSlots, setSelectedSlots] = useState<Set<string>>(new Set());
  const [pendingEntry, setPendingEntry] = useState<PendingEntry | null>(null);
  // true when the pending entry was loaded from an existing (already saved) entry
  const [pendingIsExisting, setPendingIsExisting] = useState(false);
  const [currentStep, setCurrentStep] = useState<QuestionnaireStep | null>(
    null,
  );
  const [stepHistory, setStepHistory] = useState<QuestionnaireStep[]>([]);

  // Lookup data (reference tables)
  const [lookupData, setLookupData] = useState<LookupData | null>(null);

  // UI state
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [gridCollapsed, setGridCollapsed] = useState(false);
  const [isDeletingSelection, setIsDeletingSelection] = useState(false);
  // Lock so a second save cannot start while one is still running
  const isSavingRef = useRef(false);

  // Confirmation dialog when user tries to navigate away with progress
  const [abandonDialog, setAbandonDialog] = useState<null | (() => void)>(null);

  useEffect(() => {
    loadPageData();
  }, []);

  // Optional diagnostics: /zeiterfassung?perf=1 logs Largest Contentful Paint updates
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (searchParams.get("perf") !== "1") return;
    if (!("PerformanceObserver" in window)) return;

    let lastValue = 0;
    const observer = new PerformanceObserver((entryList) => {
      for (const entry of entryList.getEntries()) {
        if (entry.startTime <= lastValue) continue;
        lastValue = entry.startTime;

        const lcpEntry = entry as PerformanceEntry & {
          element?: Element;
          size?: number;
        };
        const element = lcpEntry.element;
        const className =
          element instanceof HTMLElement ? element.className : "(none)";

        console.info("[perf] LCP update", {
          valueMs: Math.round(entry.startTime),
          size: lcpEntry.size,
          tag: element?.tagName,
          className,
          path: window.location.pathname,
        });
      }
    });

    observer.observe({ type: "largest-contentful-paint", buffered: true });

    return () => observer.disconnect();
  }, [searchParams]);

  // Reload day entries whenever the date or user/course changes
  useEffect(() => {
    if (!currentDate || !userId || courseId === null) return;
    loadDayData(currentDate);
  }, [currentDate, userId, courseId]);

  // --- Data loading ---

  // Loads auth, course enrollment, lookup tables, and determines the initial date
  async function loadPageData() {
    setIsLoading(true);

    // One server call: session user, enrollment, course settings, periods,
    // lookup tables and the user's day records. null = no session.
    const base = await loadZeiterfassungBase();
    if (!base) {
      router.push("/");
      return;
    }
    const uid = base.userId;
    setUserId(uid);

    if (base.courseId === null) {
      setErrorMessage(t("noCourseFound"));
      setIsLoading(false);
      return;
    }
    const cid = base.courseId;
    setCourseId(cid);

    // Per-course opt-in flags (extra activity ratings, day questionnaire, ICT
    // focus question; admin-toggleable, default off), the course start/end date, and the periods
    const courseSettings = base.courseSettings;
    const periodsData = base.periods;
    setAskExtraRatings(courseSettings?.ask_extra_ratings === true);
    setAskDayQuestionnaire(courseSettings?.ask_day_questionnaire === true);
    setAskIctAttention(courseSettings?.ask_ict_attention === true);

    // Course date range via periods (lib/course-periods.ts); fallback to the
    // course's single start/end date
    let dates: string[];
    if (periodsData && periodsData.length > 0) {
      dates = getPeriodDates(periodsData);
    } else {
      dates = courseSettings
        ? getSinglePeriodDates(courseSettings.start_date, courseSettings.end_date)
        : [];
    }
    setAllDates(dates);

    setLookupData(base.lookups as unknown as LookupData);

    // Determine initial date: URL param -> today -> earliest incomplete -> last.
    // "today" is the local date (getLocalIsoDate), never toISOString() (UTC).
    const dateFromUrl = searchParams.get("date");
    const today = getLocalIsoDate(new Date());
    let targetDate: string;

    if (dateFromUrl && dates.includes(dateFromUrl)) {
      targetDate = dateFromUrl;
    } else if (dates.includes(today)) {
      targetDate = today;
    } else {
      const dayRecords = base.dayRecords;
      const completedDates = new Set(
        (dayRecords ?? []).filter((d) => d.is_complete).map((d) => d.date),
      );
      targetDate =
        dates.find((d) => !completedDates.has(d)) ?? dates[dates.length - 1];
    }

    setCurrentDate(targetDate);
    setIsLoading(false);
  }

  // Loads the day record and entries for the given date; also handles the
  // ?dayQuestions=1 deep link (opens the questionnaire if the day is complete)
  async function loadDayData(date: string) {
    if (!userId || courseId === null) return;

    const dayRecord = await loadDayRecord(courseId, date);

    const loadedDayId = dayRecord?.day_id ?? null;
    setDayId(loadedDayId);
    setDayQuestionnaireCompleted(
      dayRecord?.day_questionnaire_completed === true,
    );

    const openDayQuestions = openDayQuestionsOnLoadRef.current;
    if (openDayQuestions) {
      openDayQuestionsOnLoadRef.current = false;
      router.replace(`/zeiterfassung?date=${date}`);
    }

    if (loadedDayId === null) {
      setExistingEntries([]);
      setCoveredSlots(0);
      return;
    }
    const totalCovered = await loadEntriesForDay(loadedDayId);

    if (
      openDayQuestions &&
      askDayQuestionnaire &&
      totalCovered !== null &&
      totalCovered >= TOTAL_SLOTS_PER_DAY
    ) {
      setDayQuestionnaireMode("edit");
      setDayQuestionnaireDayId(loadedDayId);
    }
  }

  // Fetches all time entries (with media types and social contexts) for a day_id and returns
  // the number of covered slots (null on error)
  async function loadEntriesForDay(targetDayId: number): Promise<number | null> {
    const { data: rawEntries, error } = await loadDayEntries(targetDayId);

    if (error) {
      setErrorMessage(t("entriesLoadError"));
      return null;
    }

    const entries = (rawEntries ?? []).map(mapRawEntryToRecord);
    setExistingEntries(entries);

    // Update progress bar
    const totalCovered = entries.reduce(
      (sum, e) => sum + calculateCoveredSlots(e.start_time, e.end_time),
      0,
    );
    setCoveredSlots(totalCovered);
    return totalCovered;
  }

  // --- Grid interaction ---

  // Returns true when the user has made unsaved progress on a NEW entry
  function hasProgress(): boolean {
    return !!(
      pendingEntry &&
      pendingEntry.primary_activity_id !== null &&
      !pendingIsExisting
    );
  }

  // Triggered when the user finishes a drag: starts the questionnaire (after
  // confirmation if a new entry is half-filled)
  const handleSlotsSelected = useCallback(
    (slots: Set<string>) => {
      if (slots.size === 0) return;
      const proceed = () => {
        const preloaded = getPreloadedEntry(slots, existingEntries);
        setPendingEntry(
          preloaded ?? createEmptyPendingEntry([...slots].sort()),
        );
        setPendingIsExisting(!!preloaded);
        setSelectedSlots(slots);
        setCurrentStep("primary_activity");
        setStepHistory([]);
      };
      if (hasProgress()) {
        setAbandonDialog(() => proceed);
      } else {
        proceed();
      }
    },
    [existingEntries, pendingEntry],
  );

  // --- Questionnaire logic ---

  // Merges step data into pendingEntry and advances to next step (or saves).
  // Control flag that may come with the data: _advance = go to the next step
  // (sent by multi-select steps and the rating screen's save button).
  function handleStepComplete(stepData: Partial<PendingEntry>) {
    if (!pendingEntry || !currentStep) return;

    const isAdvance = (stepData as any)._advance === true;
    const { _advance, ...cleanData } = stepData as any;
    const updatedEntry: PendingEntry = { ...pendingEntry, ...cleanData };

    // social_context and digital_media_type toggles fire onStepComplete for state
    // updates without advancing; only proceed when _advance is set.
    // The satisfaction step joins this list only when askExtraRatings is on:
    // it then shows three rating groups on one screen (see ActivitySelector's
    // renderSatisfactionStep), so taps must not auto-save until the explicit
    // save button fires _advance. When the flag is off, a single tap on a
    // satisfaction option saves immediately.
    const isIntermediateUpdate =
      (currentStep === "social_context" ||
        currentStep === "digital_media_type" ||
        (currentStep === "satisfaction" && askExtraRatings)) &&
      !isAdvance;

    if (isIntermediateUpdate) {
      setPendingEntry(updatedEntry);
      return;
    }

    setPendingEntry(updatedEntry);
    // Once the user actively advances a step, treat as unsaved new progress
    setPendingIsExisting(false);

    const nextStep = getNextStep(currentStep, updatedEntry);
    if (nextStep === null) {
      saveEntry(updatedEntry);
    } else {
      setStepHistory((prev) => [...prev, currentStep]);
      setCurrentStep(nextStep);
    }
  }

  function handleBack() {
    if (stepHistory.length === 0) return;
    setCurrentStep(stepHistory[stepHistory.length - 1]);
    setStepHistory((prev) => prev.slice(0, -1));
  }

  function handleCancel() {
    setSelectedSlots(new Set());
    setPendingEntry(null);
    setCurrentStep(null);
    setStepHistory([]);
  }

  // --- Tutorial scenes ---

  // The tour announces which scene to show; the page then renders that
  // scripted state instead of its real one (derived below, real state is
  // untouched: an entry the user had open reappears after the tour)
  const [tutorialScene, setTutorialScene] = useState<TutorialDemo | null>(
    null,
  );
  useEffect(() => {
    function handleTutorialDemo(event: Event) {
      setTutorialScene(
        (event as CustomEvent<TutorialDemoEventDetail>).detail.demo,
      );
    }
    window.addEventListener(TUTORIAL_DEMO_EVENT, handleTutorialDemo);
    // Pick up a scene announced before this page mounted
    setTutorialScene(getCurrentTutorialDemo());
    return () =>
      window.removeEventListener(TUTORIAL_DEMO_EVENT, handleTutorialDemo);
  }, []);

  const scene = useMemo(
    () =>
      tutorialScene && lookupData
        ? buildTutorialScene(tutorialScene, lookupData)
        : null,
    [tutorialScene, lookupData],
  );

  // The example sits at 00:00-06:00: scroll the grid back to the top for it
  useEffect(() => {
    if (!scene || scene.selectedSlots.size === 0) return;
    requestAnimationFrame(() => {
      const gridScroller = document.querySelector<HTMLElement>(
        '[data-tour="time-grid"] > div',
      );
      if (gridScroller) gridScroller.scrollTop = 0;
    });
  }, [scene]);

  // --- Deleting and reselecting ---

  // Deletes one row of ActivitySelector's selection overview; the selection stays open
  async function handleDeleteSlots(slots: string[]) {
    if (slots.length === 0) return;
    if (dayId === null) return;
    setIsDeletingSelection(true);
    try {
      const result = await deleteSlotEntries(dayId, slots.sort());
      if (!result.ok) throw new Error("delete failed");
      await loadEntriesForDay(dayId);
    } catch {
      setErrorMessage(t("deleteError"));
    } finally {
      setIsDeletingSelection(false);
    }
  }

  // Replaces the selection with the given slots and restarts the questionnaire
  function handleReselectSlots(slots: string[]) {
    if (slots.length === 0) return;
    const newSet = new Set(slots);
    const preloaded = getPreloadedEntry(newSet, existingEntries);
    setPendingEntry(preloaded ?? createEmptyPendingEntry(slots.sort()));
    setPendingIsExisting(!!preloaded);
    setSelectedSlots(newSet);
    setCurrentStep("primary_activity");
    setStepHistory([]);
  }

  // --- Saving ---

  async function saveEntry(finalEntry: PendingEntry) {
    if (isSavingRef.current) return;
    if (!userId || courseId === null || !finalEntry.primary_activity_id) return;

    isSavingRef.current = true;
    // try/finally: any early return or thrown error must release the lock,
    // otherwise every further save is silently ignored until a reload
    try {
      const sortedSlots = [...finalEntry.slots].sort();

      // One transaction on the server: create the day if needed, remove the
      // entries of the selected slots, insert one row per slot (constraint:
      // end_time = start_time + 10 min) with media types and social contexts,
      // then update is_complete / is_submitted. Either all of it or nothing.
      const result = await saveSlotEntries({
        courseId,
        date: currentDate,
        slots: sortedSlots,
        primary_activity_id: finalEntry.primary_activity_id,
        secondary_activity_id: finalEntry.secondary_activity_id || null,
        satisfaction_id: finalEntry.satisfaction_id || null,
        meaningfulness_id: finalEntry.meaningfulness_id || null,
        stressfulness_id: finalEntry.stressfulness_id || null,
        location_transport_id: finalEntry.location_transport_id || null,
        digital_media_used: finalEntry.digital_media_used,
        // Only asked when the course has it on, a device was used AND there is
        // a secondary activity; cleared otherwise so a stale answer can't
        // survive an edit (e.g. secondary activity removed again)
        ict_attention_id: shouldAskIctAttention(askIctAttention, finalEntry)
          ? finalEntry.ict_attention_id
          : null,
        digital_media_type_ids: finalEntry.digital_media_used
          ? finalEntry.digital_media_type_ids
          : [],
        social_context_ids: finalEntry.social_context_ids,
      });

      if (!result.ok) {
        setErrorMessage(
          result.error === "day_create"
            ? t("dayCreateError", { message: result.message || t("unknownError") })
            : t("saveError", { message: result.message || t("unknownError") }),
        );
        return;
      }

      setDayId(result.dayId);
      // Refresh the grid; open the day questions when the day just became complete
      await loadEntriesForDay(result.dayId);
      if (result.becameComplete && askDayQuestionnaire) {
        setDayQuestionnaireMode("prompt");
        setDayQuestionnaireDayId(result.dayId);
      }
      handleCancel();
    } catch (error) {
      setErrorMessage(
        t("saveError", {
          message: error instanceof Error ? error.message : t("unknownError"),
        }),
      );
    } finally {
      isSavingRef.current = false;
    }
  }

  // --- Date navigation ---

  function handleDateChange(date: string) {
    const proceed = () => {
      handleCancel();
      setGridCollapsed(false);
      setCurrentDate(date);
      router.replace(`/zeiterfassung?date=${date}`);
    };
    if (hasProgress()) {
      setAbandonDialog(() => proceed);
    } else {
      proceed();
    }
  }

  // --- Render ---

  if (isLoading || !lookupData || !currentDate) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-3 shadow-sm">
          <div className="h-4 w-44 animate-pulse rounded bg-slate-200 dark:bg-slate-700" />
          <div className="mt-3 h-2 w-full animate-pulse rounded-full bg-slate-100 dark:bg-slate-700" />
        </div>

        <div className="flex flex-col gap-4 md:flex-row md:items-start">
          <div className="w-full md:w-1/3 min-w-0 md:self-start">
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-6 text-center text-sm text-slate-500 dark:text-slate-400">
              {t("gridLoading")}
            </div>
          </div>

          <div className="w-full md:w-2/3 min-w-0">
            <div className="rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-10 text-center">
              <IdlePlaceholder />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
        <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
      </div>
    );
  }

  // During the tutorial the scripted scene replaces the real state: an empty
  // day with the example selection. Interaction is blocked by the tour and
  // all handlers are no-ops, so nothing can be saved.
  const shownEntries = scene ? [] : existingEntries;
  const shownSelectedSlots = scene ? scene.selectedSlots : selectedSlots;
  const shownPendingEntry = scene ? scene.pendingEntry : pendingEntry;
  const shownStep = scene ? scene.step : currentStep;
  const shownCoveredSlots = scene ? 0 : coveredSlots;
  const shownPendingIsExisting = scene ? false : pendingIsExisting;
  const noop = () => {};

  // Collapse grid on mobile when questionnaire opens, expand when it closes
  const isQuestionnaireActive = !!(shownStep && shownPendingEntry);

  // Live preview of the entry being filled in, drawn on the selected slots as
  // soon as a primary activity is picked. Skipped while an existing entry is
  // only loaded but not yet changed: the grid already shows it as saved.
  const pendingPreview: PendingSlotPreview | null =
    isQuestionnaireActive &&
    !shownPendingIsExisting &&
    shownPendingEntry.primary_activity_id !== null
      ? {
          primaryActivityId: shownPendingEntry.primary_activity_id,
          secondaryActivityId: shownPendingEntry.secondary_activity_id,
          awaitingSecondary:
            shownStep === "primary_activity" ||
            shownStep === "secondary_activity",
        }
      : null;

  return (
    <div className="space-y-4">
      {/* Completion bar: date navigation + slot progress */}
      <CompletionBar
        currentDate={currentDate}
        coveredSlots={shownCoveredSlots}
        allDates={allDates}
        onDateChange={handleDateChange}
        onEditDayQuestions={
          askDayQuestionnaire &&
          !scene &&
          dayId !== null &&
          coveredSlots >= TOTAL_SLOTS_PER_DAY
            ? () => {
                setDayQuestionnaireMode("edit");
                setDayQuestionnaireDayId(dayId);
              }
            : undefined
        }
        dayQuestionsAnswered={dayQuestionnaireCompleted}
      />

      {/* Responsive layout: stacked on mobile, side-by-side on md+ */}
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        {/* Left: 24x6 time grid, collapsible on mobile when questionnaire is active */}
        <div className="w-full md:w-1/3 min-w-0 md:self-start">
          {/* Mobile collapse toggle, only shown when questionnaire is open */}
          {isQuestionnaireActive && !scene && (
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-600 dark:text-slate-300 shadow-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-700 md:hidden"
              onClick={() => setGridCollapsed((v) => !v)}
            >
              <span>{t("gridToggle.label")}</span>
              <span className="text-slate-400 dark:text-slate-500 text-xs">
                {gridCollapsed
                  ? t("gridToggle.expand")
                  : t("gridToggle.collapse")}
              </span>
            </button>
          )}

          {/* Grid: always visible on md+, toggleable on mobile when questionnaire active */}
          <div
            data-tour="time-grid"
            className={`${isQuestionnaireActive && gridCollapsed && !scene ? "hidden" : "block"} md:block ${isQuestionnaireActive && !scene ? "mt-2 md:mt-0" : ""}`}
          >
            <TimeGrid
              existingEntries={shownEntries}
              selectedSlots={shownSelectedSlots}
              lookupData={lookupData}
              pendingPreview={pendingPreview}
              onSlotsSelected={
                scene
                  ? noop
                  : (slots) => {
                      setGridCollapsed(true);
                      handleSlotsSelected(slots);
                    }
              }
            />
          </div>
        </div>

        {/* Right: activity questionnaire or idle placeholder */}
        <div data-tour="activity-panel" className="w-full md:w-2/3 min-w-0">
          {isQuestionnaireActive ? (
            <ActivitySelector
              step={shownStep}
              pendingEntry={shownPendingEntry}
              selectedSlots={shownSelectedSlots}
              existingEntries={shownEntries}
              lookupData={lookupData}
              onStepComplete={scene ? noop : handleStepComplete}
              onBack={scene ? noop : handleBack}
              onDeleteSlots={scene ? async () => {} : handleDeleteSlots}
              onReselectSlots={scene ? noop : handleReselectSlots}
              isDeletingSelection={isDeletingSelection}
              askExtraRatings={askExtraRatings}
              askIctAttention={askIctAttention}
            />
          ) : (
            <div className="rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-10 text-center">
              <IdlePlaceholder />
            </div>
          )}
        </div>
      </div>

      {/* Abandon-progress confirmation dialog */}
      {abandonDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-6 shadow-2xl">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {t("abandonDialog.title")}
            </h2>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              {t("abandonDialog.description")}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAbandonDialog(null)}
                className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
              >
                {t("abandonDialog.continueButton")}
              </button>
              <button
                type="button"
                onClick={() => {
                  abandonDialog();
                  setAbandonDialog(null);
                }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
              >
                {t("abandonDialog.discardButton")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Day-completion questionnaire: prompted once, right when a day
          transitions to fully complete (144/144 slots), if enabled for the
          course; can be postponed and re-opened via the day bar button */}
      {dayQuestionnaireDayId !== null && (
        <DayQuestionnaireModal
          key={dayQuestionnaireDayId}
          dayId={dayQuestionnaireDayId}
          existingEntries={existingEntries}
          activities={lookupData.activities}
          mode={dayQuestionnaireMode}
          onSaved={() => {
            if (dayQuestionnaireDayId === dayId) {
              setDayQuestionnaireCompleted(true);
            }
            setDayQuestionnaireDayId(null);
          }}
          onClose={() => setDayQuestionnaireDayId(null)}
        />
      )}
    </div>
  );
}
