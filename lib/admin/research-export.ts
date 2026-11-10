import { createHash } from "node:crypto";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/routing";
import type { Db } from "@/lib/db";
import { getLocalizedName } from "@/lib/i18n/localized-name";
import {
  chunk,
  ENTRIES_WITH_JUNCTIONS_SQL,
  lookupRows,
  minutesFromTimes,
  MIN_PARTICIPANTS_FOR_EXPORT,
  type ExportRow,
} from "@/lib/admin/course-export";

// --- Server-side, pseudonymised research export (mode "forschung") ---
// Unlike the anonymous export (course-export.ts), this export is meant for
// scientific analysis: time use, days (incl. day questions) and persons
// (survey) can be linked via a PersonID, and every entry carries the date of
// its day. Names, e-mails and user ids stay out; the PersonID is a stable
// pseudonym derived from user_course_id.
//
// Incomplete days are included and marked via "day complete", so the analysis
// can include or exclude them deliberately. Participants excluded by an admin
// (user_course.is_excluded) are left out, as everywhere.
//
// Result: three sheets (time use, days, persons).

export type ResearchSheet = {
  key: "timeUse" | "days" | "persons";
  name: string;
  rows: ExportRow[];
};

export type ResearchExportResult =
  | {
      ok: true;
      courseName: string;
      sheets: ResearchSheet[];
      participants: number;
    }
  | { ok: false; reason: "COURSE_NOT_FOUND" }
  | { ok: false; reason: "TOO_FEW_PARTICIPANTS"; participants: number };

type LookupRow = { id: number; code: string; name: string; name_en: string };

type DayRow = {
  day_id: number;
  profiles_id: string;
  date: string;
  is_submitted: boolean;
};

type EntryRow = {
  entry_id: number;
  day_id: number;
  start_time: string;
  end_time: string;
  primary_activity_id: number | null;
  secondary_activity_id: number | null;
  location_transport_id: number | null;
  satisfaction_id: number | null;
  stressfulness_id: number | null;
  meaningfulness_id: number | null;
  digital_media_used: boolean | null;
  ict_attention_id: number | null;
  time_entry_digital_media_type?: { digital_media_type_id: number | null }[];
  time_entry_social_context?: { social_context_id: number | null }[];
};

type QuestionnaireRow = {
  day_id: number;
  diary_fill_timing_id: number;
  most_pleasant_activity_id: number;
  most_unpleasant_activity_id: number;
  most_stressful_activity_id: number;
  day_appreciation_id: number;
  is_unusual_day: boolean;
  day_type_context_id: number;
  trip_type_id: number;
};

type UserDataRow = {
  user_data_id: number;
  profiles_id: string;
  gender_id: number | null;
  age: number | null;
  marital_status_id: number | null;
  partner_in_household: boolean | null;
  children_in_household_id: number | null;
  education_level_id: number | null;
  occupational_status_id: number | null;
  weekly_work_hours: number | null;
  main_workplace_id: number | null;
  health_status_id: number | null;
  nationality_id: number | null;
  region_id: number | null;
  urbanity_id: number | null;
};

// --- Helpers ---

// PersonID = short hash of user_course_id (a UUID): stable across exports,
// readable in Excel/SPSS/R, and not the raw database key. Starts with 6 hex
// characters and only grows if two enrolments of the course would collide.
function buildPersonIds(userCourseIds: string[]): Record<string, string> {
  const hashes = userCourseIds.map((id) => [
    id,
    createHash("sha256").update(id).digest("hex").toUpperCase(),
  ]);
  for (let length = 6; ; length += 2) {
    const ids = hashes.map(([, hash]) => `P-${hash.slice(0, length)}`);
    if (new Set(ids).size === ids.length || length >= 64)
      return Object.fromEntries(hashes.map(([id], i) => [id, ids[i]]));
  }
}

// Loads `{table}` as id -> { code, name, name_en } (every lookup table follows
// the `{table}_id, code, name, name_en` convention)
async function loadLookup(
  db: Db,
  table: string,
): Promise<Record<number, LookupRow>> {
  // Table names come from the fixed list below, never from input
  if (!/^[a-z_]+$/.test(table)) throw new Error(`invalid lookup table ${table}`);
  const idColumn = `${table}_id`;
  const data = await db.query(`SELECT ${idColumn}, code, name, name_en FROM public.${table}`);
  const map: Record<number, LookupRow> = {};
  for (const row of data) {
    const id = row[idColumn] as number;
    map[id] = {
      id,
      code: String(row.code ?? ""),
      name: String(row.name ?? ""),
      name_en: String(row.name_en ?? ""),
    };
  }
  return map;
}

// Rating codes are "1".."5": exported as numbers so they can be analysed directly
function numericCode(code: string | undefined): number | string {
  if (code == null || code === "") return "";
  const n = Number(code);
  return Number.isFinite(n) ? n : code;
}

function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- Main ---

/** `db`: the handle of a withService() transaction (admin check happens in the route). */
export async function buildResearchExport(
  db: Db,
  courseId: number,
  locale: Locale = "de",
): Promise<ResearchExportResult> {
  const tc = await getTranslations({
    locale,
    namespace: "apiErrors.courseExport.columns",
  });
  const tr = await getTranslations({
    locale,
    namespace: "apiErrors.courseExport.research",
  });

  const courseRows = await db.query<{ course_id: number; name: string }>(
    "SELECT course_id, name FROM public.course WHERE course_id = $1",
    [courseId],
  );
  const course = courseRows.length === 1 ? courseRows[0] : null;
  if (!course) return { ok: false, reason: "COURSE_NOT_FOUND" };

  // Enrolled, non-excluded participants -> stable pseudonym
  const enrollments = await db.query<{
    user_course_id: string;
    profiles_id: string;
    is_excluded: boolean | null;
  }>(
    "SELECT user_course_id, profiles_id, is_excluded FROM public.user_course WHERE course_id = $1 ORDER BY user_course_id",
    [courseId],
  );
  const personIdByEnrolment = buildPersonIds(
    (enrollments ?? []).map((e) => e.user_course_id as string),
  );
  const personIdByProfile: Record<string, string> = {};
  for (const e of enrollments ?? []) {
    if (e.is_excluded) continue;
    // A profile enrolled twice keeps its first pseudonym
    if (!personIdByProfile[e.profiles_id])
      personIdByProfile[e.profiles_id] = personIdByEnrolment[e.user_course_id];
  }
  const profileIds = Object.keys(personIdByProfile);

  // All days (complete and incomplete) of eligible participants
  const allDays = await db.query<DayRow>(
    "SELECT day_id, profiles_id, date, is_submitted FROM public.day WHERE course_id = $1 ORDER BY day_id",
    [courseId],
  );
  const days = allDays.filter((d) => personIdByProfile[d.profiles_id]);
  const dayById: Record<number, DayRow> = {};
  for (const d of days) dayById[d.day_id] = d;
  const dayIds = days.map((d) => d.day_id);

  // Time entries (junction rows nested) and day questionnaires of those days
  const entries: EntryRow[] = [];
  const questionnaires: QuestionnaireRow[] = [];
  for (const ids of chunk(dayIds, 400)) {
    entries.push(...(await db.query<EntryRow>(ENTRIES_WITH_JUNCTIONS_SQL, [ids])));
    questionnaires.push(
      ...(await db.query<QuestionnaireRow>(
        `SELECT day_id, diary_fill_timing_id, most_pleasant_activity_id, most_unpleasant_activity_id,
                most_stressful_activity_id, day_appreciation_id, is_unusual_day, day_type_context_id, trip_type_id
           FROM public.day_questionnaire WHERE day_id = ANY($1::int[]) ORDER BY day_id`,
        [ids],
      )),
    );
  }

  const minutesByDay: Record<number, number> = {};
  for (const e of entries)
    minutesByDay[e.day_id] =
      (minutesByDay[e.day_id] ?? 0) + minutesFromTimes(e.start_time, e.end_time);
  const questionnaireByDay: Record<number, QuestionnaireRow> = {};
  for (const q of questionnaires) questionnaireByDay[q.day_id] = q;

  // Only days with any data count (an opened but empty day carries no information)
  const daysWithData = days.filter(
    (d) => minutesByDay[d.day_id] != null || questionnaireByDay[d.day_id],
  );
  const participantsWithData = new Set(daysWithData.map((d) => d.profiles_id));
  if (participantsWithData.size < MIN_PARTICIPANTS_FOR_EXPORT) {
    return {
      ok: false,
      reason: "TOO_FEW_PARTICIPANTS",
      participants: participantsWithData.size,
    };
  }

  // Survey data (one user_data row per profile)
  const userData: UserDataRow[] = [];
  const employmentByUserData: Record<number, number[]> = {};
  for (const ids of chunk(profileIds, 200)) {
    const data = await db.query<UserDataRow>(
      `SELECT user_data_id, profiles_id, gender_id, age, marital_status_id, partner_in_household,
              children_in_household_id, education_level_id, occupational_status_id, weekly_work_hours,
              main_workplace_id, health_status_id, nationality_id, region_id, urbanity_id
         FROM public.user_data WHERE profiles_id = ANY($1::uuid[])`,
      [ids],
    );
    userData.push(...data);
  }
  for (const ids of chunk(
    userData.map((u) => u.user_data_id),
    400,
  )) {
    const data = await db.query<{ user_data_id: number; employment_status_id: number }>(
      "SELECT user_data_id, employment_status_id FROM public.user_employment_status WHERE user_data_id = ANY($1::int[])",
      [ids],
    );
    for (const row of data) {
      (employmentByUserData[row.user_data_id] ??= []).push(
        row.employment_status_id,
      );
    }
  }
  const userDataByProfile: Record<string, UserDataRow> = {};
  for (const u of userData) userDataByProfile[u.profiles_id] = u;

  // Lookups
  const [
    category,
    location,
    socialContext,
    digitalMediaType,
    satisfaction,
    stressfulness,
    meaningfulness,
    ictAttention,
    diaryFillTiming,
    dayAppreciation,
    dayTypeContext,
    tripType,
    gender,
    maritalStatus,
    childrenInHousehold,
    educationLevel,
    occupationalStatus,
    employmentStatus,
    mainWorkplace,
    healthStatus,
    nationality,
    region,
    urbanity,
    activitiesRes,
  ] = await Promise.all([
    loadLookup(db, "category"),
    loadLookup(db, "location_transport"),
    loadLookup(db, "social_context"),
    loadLookup(db, "digital_media_type"),
    loadLookup(db, "satisfaction"),
    loadLookup(db, "stressfulness"),
    loadLookup(db, "meaningfulness"),
    loadLookup(db, "ict_attention"),
    loadLookup(db, "diary_fill_timing"),
    loadLookup(db, "day_appreciation"),
    loadLookup(db, "day_type_context"),
    loadLookup(db, "trip_type"),
    loadLookup(db, "gender"),
    loadLookup(db, "marital_status"),
    loadLookup(db, "children_in_household"),
    loadLookup(db, "education_level"),
    loadLookup(db, "occupational_status"),
    loadLookup(db, "employment_status"),
    loadLookup(db, "main_workplace"),
    loadLookup(db, "health_status"),
    loadLookup(db, "nationality"),
    loadLookup(db, "region"),
    loadLookup(db, "urbanity"),
    // Activity with its category embedded as { subcategory: { category_id } }
    lookupRows(db, [
      `SELECT a.activity_id, a.code, a.name, a.name_en, json_build_object('category_id', s.category_id) AS subcategory
         FROM public.activity a LEFT JOIN public.subcategory s ON s.subcategory_id = a.subcategory_id`,
    ]).then((r) => r[0]),
  ]);

  const activityById: Record<number, LookupRow & { categoryId: number | null }> =
    {};
  for (const a of activitiesRes.data ?? []) {
    const sub = a.subcategory as unknown;
    const catId =
      sub && typeof sub === "object" && "category_id" in sub
        ? (sub as { category_id: number }).category_id
        : Array.isArray(sub) && sub.length > 0
          ? (sub[0] as { category_id: number }).category_id
          : null;
    activityById[a.activity_id] = {
      id: a.activity_id,
      code: String(a.code ?? ""),
      name: a.name,
      name_en: a.name_en,
      categoryId: catId,
    };
  }

  const label = (map: Record<number, LookupRow>, id: number | null) =>
    id != null && map[id] ? getLocalizedName(map[id], locale) : "";
  const code = (map: Record<number, LookupRow>, id: number | null) =>
    id != null && map[id] ? numericCode(map[id].code) : "";
  const activityLabel = (id: number | null) =>
    id != null && activityById[id]
      ? getLocalizedName(activityById[id], locale)
      : "";
  const activityCode = (id: number | null) =>
    id != null && activityById[id] ? activityById[id].code : "";
  const yesNo = (value: boolean | null | undefined) =>
    value == null ? "" : value ? tc("yes") : tc("no");

  const weekdayFormat = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "de-CH", {
    weekday: "long",
    timeZone: "UTC",
  });
  const weekday = (date: string) =>
    weekdayFormat.format(new Date(`${date}T00:00:00Z`));

  const sortDays = (a: DayRow, b: DayRow) =>
    compareDates(personIdByProfile[a.profiles_id], personIdByProfile[b.profiles_id]) ||
    compareDates(a.date, b.date);

  // --- Sheet: time use (one row per entry) ---
  const sortedEntries = [...entries].sort((a, b) => {
    const dayA = dayById[a.day_id];
    const dayB = dayById[b.day_id];
    return (
      sortDays(dayA, dayB) ||
      compareDates(a.start_time, b.start_time) ||
      a.entry_id - b.entry_id
    );
  });
  const timeUseRows: ExportRow[] = sortedEntries.map((e) => {
    const d = dayById[e.day_id];
    const categoryId =
      e.primary_activity_id != null
        ? (activityById[e.primary_activity_id]?.categoryId ?? null)
        : null;
    return {
      [tr("personId")]: personIdByProfile[d.profiles_id],
      [tr("date")]: d.date,
      [tr("weekday")]: weekday(d.date),
      [tr("dayComplete")]: yesNo(d.is_submitted),
      [tc("start")]: e.start_time.slice(0, 5),
      [tc("end")]: e.end_time.slice(0, 5),
      [tc("durationMinutes")]: minutesFromTimes(e.start_time, e.end_time),
      [tr("categoryCode")]: categoryId != null ? (category[categoryId]?.code ?? "") : "",
      [tc("category")]: label(category, categoryId),
      [tr("activityCode")]: activityCode(e.primary_activity_id),
      [tc("activity")]: activityLabel(e.primary_activity_id),
      [tr("secondaryActivityCode")]: activityCode(e.secondary_activity_id),
      [tc("secondaryActivity")]: activityLabel(e.secondary_activity_id),
      [tc("digitalMediaUsed")]: yesNo(e.digital_media_used),
      [tc("mediaTypes")]: (e.time_entry_digital_media_type ?? [])
        .map((m) => label(digitalMediaType, m.digital_media_type_id))
        .filter(Boolean)
        .join(", "),
      [tr("ictAttentionCode")]: code(ictAttention, e.ict_attention_id),
      [tc("ictAttention")]: label(ictAttention, e.ict_attention_id),
      [tc("locationTransport")]: label(location, e.location_transport_id),
      [tc("socialContext")]: (e.time_entry_social_context ?? [])
        .map((s) => label(socialContext, s.social_context_id))
        .filter(Boolean)
        .join(", "),
      [tr("wellbeingCode")]: code(satisfaction, e.satisfaction_id),
      [tc("wellbeing")]: label(satisfaction, e.satisfaction_id),
      [tr("stressfulnessCode")]: code(stressfulness, e.stressfulness_id),
      [tc("stressfulness")]: label(stressfulness, e.stressfulness_id),
      [tr("meaningfulnessCode")]: code(meaningfulness, e.meaningfulness_id),
      [tc("meaningfulness")]: label(meaningfulness, e.meaningfulness_id),
    };
  });

  // --- Sheet: days (one row per day with data, incl. day questionnaire) ---
  const dayRows: ExportRow[] = [...daysWithData].sort(sortDays).map((d) => {
    const q = questionnaireByDay[d.day_id];
    return {
      [tr("personId")]: personIdByProfile[d.profiles_id],
      [tr("date")]: d.date,
      [tr("weekday")]: weekday(d.date),
      [tr("dayComplete")]: yesNo(d.is_submitted),
      [tr("trackedMinutes")]: minutesByDay[d.day_id] ?? 0,
      [tr("dayQuestionnaireAnswered")]: yesNo(!!q),
      [tr("diaryFillTiming")]: q ? label(diaryFillTiming, q.diary_fill_timing_id) : "",
      [tr("mostPleasantActivity")]: q ? activityLabel(q.most_pleasant_activity_id) : "",
      [tr("mostUnpleasantActivity")]: q
        ? activityLabel(q.most_unpleasant_activity_id)
        : "",
      [tr("mostStressfulActivity")]: q
        ? activityLabel(q.most_stressful_activity_id)
        : "",
      [tr("dayAppreciationCode")]: q ? code(dayAppreciation, q.day_appreciation_id) : "",
      [tr("dayAppreciation")]: q ? label(dayAppreciation, q.day_appreciation_id) : "",
      [tr("unusualDay")]: q ? yesNo(q.is_unusual_day) : "",
      [tr("dayType")]: q ? label(dayTypeContext, q.day_type_context_id) : "",
      [tr("tripType")]: q ? label(tripType, q.trip_type_id) : "",
    };
  });

  // --- Sheet: persons (one row per enrolled participant, incl. survey) ---
  const completeDays: Record<string, number> = {};
  const incompleteDays: Record<string, number> = {};
  for (const d of daysWithData) {
    const target = d.is_submitted ? completeDays : incompleteDays;
    target[d.profiles_id] = (target[d.profiles_id] ?? 0) + 1;
  }
  const personRows: ExportRow[] = [...profileIds]
    .sort((a, b) => compareDates(personIdByProfile[a], personIdByProfile[b]))
    .map((profileId) => {
      const u = userDataByProfile[profileId];
      const employment = u ? (employmentByUserData[u.user_data_id] ?? []) : [];
      return {
        [tr("personId")]: personIdByProfile[profileId],
        [tr("completeDays")]: completeDays[profileId] ?? 0,
        [tr("incompleteDays")]: incompleteDays[profileId] ?? 0,
        [tr("age")]: u?.age ?? "",
        [tr("gender")]: label(gender, u?.gender_id ?? null),
        [tr("maritalStatus")]: label(maritalStatus, u?.marital_status_id ?? null),
        [tr("partnerInHousehold")]: yesNo(u?.partner_in_household),
        [tr("childrenInHousehold")]: label(
          childrenInHousehold,
          u?.children_in_household_id ?? null,
        ),
        [tr("educationLevel")]: label(educationLevel, u?.education_level_id ?? null),
        [tr("occupationalStatus")]: label(
          occupationalStatus,
          u?.occupational_status_id ?? null,
        ),
        [tr("employmentStatus")]: employment
          .map((id) => label(employmentStatus, id))
          .filter(Boolean)
          .join(", "),
        [tr("weeklyWorkHours")]:
          u?.weekly_work_hours != null ? Number(u.weekly_work_hours) : "",
        [tr("mainWorkplace")]: label(mainWorkplace, u?.main_workplace_id ?? null),
        [tr("healthStatus")]: label(healthStatus, u?.health_status_id ?? null),
        [tr("nationalityCode")]:
          u?.nationality_id != null ? (nationality[u.nationality_id]?.code ?? "") : "",
        [tr("nationality")]: label(nationality, u?.nationality_id ?? null),
        [tr("region")]: label(region, u?.region_id ?? null),
        [tr("urbanity")]: label(urbanity, u?.urbanity_id ?? null),
      };
    });

  return {
    ok: true,
    courseName: course.name,
    participants: participantsWithData.size,
    sheets: [
      { key: "timeUse", name: tr("sheets.timeUse"), rows: timeUseRows },
      { key: "days", name: tr("sheets.days"), rows: dayRows },
      { key: "persons", name: tr("sheets.persons"), rows: personRows },
    ],
  };
}
