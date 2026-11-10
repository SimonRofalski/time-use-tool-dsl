// Data access for the Zeiterfassung page and the day questionnaire. Called only by the Server
// Actions in app/[locale]/(protected)/zeiterfassung/actions.ts, which pass the session user id.
// Rows keep the former PostgREST shapes (snake_case columns, nested junction arrays), so the page
// logic is unchanged. Every query runs as the logged-in user (withUser), so the RLS policies apply.
//
// A day has 144 slots of 10 minutes; the app saves one time_entry row per slot.
import { withUser, type Db } from "@/lib/db";

const TOTAL_SLOTS_PER_DAY = 144;
// Slot start "HH:M0" (00:00 ... 23:50)
const SLOT_RE = /^([01]\d|2[0-3]):[0-5]0$/;

type Row = Record<string, unknown>;

// --- Page load ---

export type ZeiterfassungBase = {
  userId: string;
  /** null unless the user has exactly one enrollment */
  courseId: number | null;
  courseSettings: {
    ask_extra_ratings: boolean;
    ask_day_questionnaire: boolean;
    ask_ict_attention: boolean;
    start_date: string;
    end_date: string;
  } | null;
  periods: { start_date: string; end_date: string; sort_order: number }[];
  lookups: Record<string, Row[]>;
  dayRecords: { date: string; is_complete: boolean }[];
};

const LOOKUP_QUERIES: [string, string][] = [
  ["categories", "SELECT * FROM public.category ORDER BY category_id"],
  ["subcategories", "SELECT * FROM public.subcategory ORDER BY subcategory_id"],
  ["activities", "SELECT * FROM public.activity ORDER BY activity_id"],
  ["locationTransports", "SELECT * FROM public.location_transport ORDER BY location_transport_id"],
  ["socialContexts", "SELECT * FROM public.social_context ORDER BY social_context_id"],
  ["digitalMediaTypes", "SELECT * FROM public.digital_media_type ORDER BY digital_media_type_id"],
  ["satisfactions", "SELECT * FROM public.satisfaction ORDER BY satisfaction_id"],
  ["meaningfulnesses", "SELECT * FROM public.meaningfulness ORDER BY meaningfulness_id"],
  ["stressfulnesses", "SELECT * FROM public.stressfulness ORDER BY stressfulness_id"],
  ["ictAttentions", "SELECT * FROM public.ict_attention ORDER BY ict_attention_id"],
];

/** Everything the page needs on mount (lookups, course settings, periods, day flags) in one transaction. */
export async function loadZeiterfassungBase(userId: string): Promise<ZeiterfassungBase | null> {
  return withUser(
    userId,
    async (db) => {
      const lookups: Record<string, Row[]> = {};
      for (const [key, sql] of LOOKUP_QUERIES) lookups[key] = await db.query(sql);

      const enrollments = await db.query<{ course_id: number }>(
        "SELECT course_id FROM public.user_course WHERE profiles_id = $1",
        [userId],
      );
      if (enrollments.length !== 1) {
        return { userId, courseId: null, courseSettings: null, periods: [], lookups, dayRecords: [] };
      }
      const courseId = enrollments[0].course_id;
      const settings = await db.query<NonNullable<ZeiterfassungBase["courseSettings"]>>(
        `SELECT ask_extra_ratings, ask_day_questionnaire, ask_ict_attention, start_date, end_date
           FROM public.course WHERE course_id = $1`,
        [courseId],
      );
      const periods = await db.query<ZeiterfassungBase["periods"][number]>(
        "SELECT start_date, end_date, sort_order FROM public.course_period WHERE course_id = $1 ORDER BY sort_order ASC",
        [courseId],
      );
      const dayRecords = await db.query<{ date: string; is_complete: boolean }>(
        "SELECT date, is_complete FROM public.day WHERE profiles_id = $1 AND course_id = $2",
        [userId, courseId],
      );
      return {
        userId,
        courseId,
        courseSettings: settings.length === 1 ? settings[0] : null,
        periods,
        lookups,
        dayRecords,
      };
    },
    { readOnly: true },
  );
}

/** The day record of a date (null unless exactly one row). */
export async function loadDayRecord(userId: string, courseId: number, date: string) {
  const rows = await withUser(
    userId,
    (db) =>
      db.query<{ day_id: number; day_questionnaire_completed: boolean }>(
        "SELECT day_id, day_questionnaire_completed FROM public.day WHERE profiles_id = $1 AND course_id = $2 AND date = $3",
        [userId, courseId, date],
      ),
    { readOnly: true },
  );
  return rows.length === 1 ? rows[0] : null;
}

const ENTRIES_SQL = `
  SELECT te.entry_id, te.day_id, te.start_time, te.end_time,
         te.primary_activity_id, te.secondary_activity_id,
         te.satisfaction_id, te.meaningfulness_id, te.stressfulness_id,
         te.location_transport_id, te.digital_media_used, te.ict_attention_id,
         COALESCE((SELECT json_agg(json_build_object('digital_media_type_id', m.digital_media_type_id))
                     FROM public.time_entry_digital_media_type m WHERE m.entry_id = te.entry_id), '[]'::json)
           AS time_entry_digital_media_type,
         COALESCE((SELECT json_agg(json_build_object('social_context_id', s.social_context_id))
                     FROM public.time_entry_social_context s WHERE s.entry_id = te.entry_id), '[]'::json)
           AS time_entry_social_context
    FROM public.time_entry te
   WHERE te.day_id = $1`;

/** Entries of a day with their media types and social contexts nested as JSON arrays. */
export async function loadDayEntries(userId: string, dayId: number): Promise<{ data: Row[] | null; error: boolean }> {
  try {
    const data = await withUser(userId, (db) => db.query(ENTRIES_SQL, [dayId]), { readOnly: true });
    return { data, error: false };
  } catch {
    return { data: null, error: true };
  }
}

// --- Saving (each save or delete is one transaction) ---

export type SlotEntryInput = {
  courseId: number;
  date: string;
  slots: string[]; // "HH:MM"
  primary_activity_id: number;
  secondary_activity_id: number | null;
  satisfaction_id: number | null;
  meaningfulness_id: number | null;
  stressfulness_id: number | null;
  location_transport_id: number | null;
  digital_media_used: boolean;
  ict_attention_id: number | null;
  digital_media_type_ids: number[];
  social_context_ids: number[];
};

export type SaveResult =
  | { ok: true; dayId: number; becameComplete: boolean }
  | { ok: false; error: "day_create" | "save"; message: string };

// End of a slot ("HH:MM:00", 10 minutes later); the last slot of the day ends at "00:00:00"
function endTime(slot: string): string {
  const [h, m] = slot.split(":").map(Number);
  const total = h * 60 + m + 10;
  return total >= 1440 ? "00:00:00" : `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}:00`;
}

/** Deletes the entries starting at the given slots (junction rows first). */
async function deleteSlots(db: Db, dayId: number, slots: string[]) {
  const starts = slots.map((s) => `${s}:00`);
  const ids = (await db.query<{ entry_id: number }>(
    "SELECT entry_id FROM public.time_entry WHERE day_id = $1 AND start_time = ANY($2::time[])",
    [dayId, starts],
  )).map((r) => r.entry_id);
  if (!ids.length) return;
  await db.query("DELETE FROM public.time_entry_digital_media_type WHERE entry_id = ANY($1::int[])", [ids]);
  await db.query("DELETE FROM public.time_entry_social_context WHERE entry_id = ANY($1::int[])", [ids]);
  await db.query("DELETE FROM public.time_entry WHERE entry_id = ANY($1::int[])", [ids]);
}

/**
 * Recounts the covered slots and keeps is_complete + is_submitted in sync (a full day is submitted
 * automatically, editing it below 144 slots un-submits it). Returns true on a false -> true transition.
 */
async function updateDayCompletion(db: Db, dayId: number): Promise<boolean> {
  // An entry ending at 00:00 ends at midnight (24:00), so its length is counted up to 1440 minutes
  const [{ covered }] = await db.query<{ covered: number }>(
    `SELECT COALESCE(sum(
              CASE WHEN end_time = '00:00' AND start_time > '00:00'
                   THEN (1440 - extract(epoch FROM start_time) / 60) / 10
                   ELSE extract(epoch FROM (end_time - start_time)) / 60 / 10 END), 0)::int AS covered
       FROM public.time_entry WHERE day_id = $1`,
    [dayId],
  );
  const isComplete = covered >= TOTAL_SLOTS_PER_DAY;
  const [previous] = await db.query<{ is_complete: boolean }>("SELECT is_complete FROM public.day WHERE day_id = $1", [dayId]);
  await db.query("UPDATE public.day SET is_complete = $2, is_submitted = $2 WHERE day_id = $1", [dayId, isComplete]);
  return previous?.is_complete !== true && isComplete;
}

function validSlots(slots: unknown): slots is string[] {
  return Array.isArray(slots) && slots.length > 0 && slots.length <= TOTAL_SLOTS_PER_DAY && slots.every((s) => typeof s === "string" && SLOT_RE.test(s));
}

/** Saves one questionnaire answer for the selected slots: day, overlap removal, entries, junctions, day status. */
export async function saveSlotEntries(userId: string, input: SlotEntryInput): Promise<SaveResult> {
  if (!validSlots(input.slots) || !Number.isInteger(input.courseId) || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return { ok: false, error: "save", message: "invalid request" };
  }
  const slots = [...new Set(input.slots)].sort();

  try {
    return await withUser(userId, async (db) => {
      // Ensure the day record exists (savepoint: a failed insert must not abort the transaction)
      let [day] = await db.query<{ day_id: number }>(
        "SELECT day_id FROM public.day WHERE profiles_id = $1 AND course_id = $2 AND date = $3",
        [userId, input.courseId, input.date],
      );
      if (!day) {
        try {
          await db.query("SAVEPOINT create_day");
          [day] = await db.query<{ day_id: number }>(
            "INSERT INTO public.day (profiles_id, course_id, date) VALUES ($1, $2, $3) RETURNING day_id",
            [userId, input.courseId, input.date],
          );
        } catch (error) {
          await db.query("ROLLBACK TO SAVEPOINT create_day");
          // Database details go to the server log only, never to the browser
          console.error("creating the day failed", error);
          return { ok: false as const, error: "day_create" as const, message: "" };
        }
      }

      // Overwrite: whatever was recorded in these slots before is replaced
      await deleteSlots(db, day.day_id, slots);

      // One multi-row INSERT, 11 parameters per slot
      const values: unknown[] = [];
      const tuples = slots.map((slot, i) => {
        const b = i * 11;
        values.push(day.day_id, `${slot}:00`, endTime(slot), input.primary_activity_id, input.secondary_activity_id,
          input.satisfaction_id, input.meaningfulness_id, input.stressfulness_id, input.location_transport_id,
          input.digital_media_used, input.ict_attention_id);
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11})`;
      });
      const inserted = await db.query<{ entry_id: number }>(
        `INSERT INTO public.time_entry (day_id, start_time, end_time, primary_activity_id, secondary_activity_id,
                                        satisfaction_id, meaningfulness_id, stressfulness_id, location_transport_id,
                                        digital_media_used, ict_attention_id)
         VALUES ${tuples.join(", ")} RETURNING entry_id`,
        values,
      );
      const entryIds = inserted.map((r) => r.entry_id);

      // Junction rows: every new entry gets every selected media type / social context

      if (input.digital_media_used && input.digital_media_type_ids.length) {
        await db.query(
          `INSERT INTO public.time_entry_digital_media_type (entry_id, digital_media_type_id)
           SELECT e, m FROM unnest($1::int[]) e CROSS JOIN unnest($2::int[]) m`,
          [entryIds, input.digital_media_type_ids],
        );
      }
      if (input.social_context_ids.length) {
        await db.query(
          `INSERT INTO public.time_entry_social_context (entry_id, social_context_id)
           SELECT e, s FROM unnest($1::int[]) e CROSS JOIN unnest($2::int[]) s`,
          [entryIds, input.social_context_ids],
        );
      }

      const becameComplete = await updateDayCompletion(db, day.day_id);
      return { ok: true as const, dayId: day.day_id, becameComplete };
    });
  } catch (error) {
    console.error("saving time entries failed", error);
    return { ok: false, error: "save", message: "" };
  }
}

/** Deletes the entries of the given slots and updates the day status, in one transaction. */
export async function deleteSlotEntries(userId: string, dayId: number, slots: string[]): Promise<{ ok: boolean }> {
  if (!Number.isInteger(dayId) || !validSlots(slots)) return { ok: false };
  try {
    await withUser(userId, async (db) => {
      await deleteSlots(db, dayId, slots);
      await updateDayCompletion(db, dayId);
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// --- Day questionnaire ---

/** Lookup lists of the day questionnaire plus the existing answers of the day (or null). */
export async function loadDayQuestionnaireData(userId: string, dayId: number) {
  return withUser(
    userId,
    async (db) => {
      const fillTimings = await db.query("SELECT * FROM public.diary_fill_timing ORDER BY diary_fill_timing_id");
      const dayTypes = await db.query("SELECT * FROM public.day_type_context ORDER BY day_type_context_id");
      const tripTypes = await db.query("SELECT * FROM public.trip_type ORDER BY trip_type_id");
      const dayAppreciations = await db.query("SELECT * FROM public.day_appreciation ORDER BY day_appreciation_id");
      const existing = await db.query("SELECT * FROM public.day_questionnaire WHERE day_id = $1", [dayId]);
      return { fillTimings, dayTypes, tripTypes, dayAppreciations, existing: existing.length === 1 ? existing[0] : null };
    },
    { readOnly: true },
  );
}

export type DayQuestionnaireInput = {
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

/** Insert or update the questionnaire of a day (one row per day_id). */
export async function saveDayQuestionnaire(userId: string, input: DayQuestionnaireInput): Promise<{ error: string | null }> {
  try {
    await withUser(userId, (db) =>
      db.query(
        `INSERT INTO public.day_questionnaire (day_id, diary_fill_timing_id, most_pleasant_activity_id,
                most_unpleasant_activity_id, most_stressful_activity_id, day_appreciation_id, is_unusual_day,
                day_type_context_id, trip_type_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (day_id) DO UPDATE SET
                diary_fill_timing_id = EXCLUDED.diary_fill_timing_id,
                most_pleasant_activity_id = EXCLUDED.most_pleasant_activity_id,
                most_unpleasant_activity_id = EXCLUDED.most_unpleasant_activity_id,
                most_stressful_activity_id = EXCLUDED.most_stressful_activity_id,
                day_appreciation_id = EXCLUDED.day_appreciation_id,
                is_unusual_day = EXCLUDED.is_unusual_day,
                day_type_context_id = EXCLUDED.day_type_context_id,
                trip_type_id = EXCLUDED.trip_type_id`,
        [input.day_id, input.diary_fill_timing_id, input.most_pleasant_activity_id, input.most_unpleasant_activity_id,
          input.most_stressful_activity_id, input.day_appreciation_id, input.is_unusual_day, input.day_type_context_id,
          input.trip_type_id],
      ),
    );
    return { error: null };
  } catch (error) {
    console.error("saving the day questionnaire failed", error);
    return { error: "save_failed" };
  }
}
