"use server";
// Server Actions of the Zeiterfassung page. Thin wrappers: they take the user from the session
// (never from the browser) and call the data functions in lib/data/zeiterfassung.ts, which
// run under the user's row-level security. Without a session they return an empty/error result.
import { getSessionUser } from "@/lib/auth/session";
import * as data from "@/lib/data/zeiterfassung";
import type { DayQuestionnaireInput, SaveResult, SlotEntryInput, ZeiterfassungBase } from "@/lib/data/zeiterfassung";

/** Id of the logged-in user, or null without a valid session. */
async function userId(): Promise<string | null> {
  return (await getSessionUser())?.id ?? null;
}

export async function loadZeiterfassungBase(): Promise<ZeiterfassungBase | null> {
  const id = await userId();
  return id ? data.loadZeiterfassungBase(id) : null;
}

export async function loadDayRecord(courseId: number, date: string) {
  const id = await userId();
  return id ? data.loadDayRecord(id, courseId, date) : null;
}

export async function loadDayEntries(dayId: number) {
  const id = await userId();
  return id ? data.loadDayEntries(id, dayId) : { data: null, error: true };
}

/** Saves the questionnaire answers for the selected slots (one row per slot) in one transaction. */
export async function saveSlotEntries(input: SlotEntryInput): Promise<SaveResult> {
  const id = await userId();
  return id ? data.saveSlotEntries(id, input) : { ok: false, error: "save", message: "not authenticated" };
}

export async function deleteSlotEntries(dayId: number, slots: string[]) {
  const id = await userId();
  return id ? data.deleteSlotEntries(id, dayId, slots) : { ok: false };
}

export async function loadDayQuestionnaireData(dayId: number) {
  const id = await userId();
  return id ? data.loadDayQuestionnaireData(id, dayId) : null;
}

export async function saveDayQuestionnaire(input: DayQuestionnaireInput) {
  const id = await userId();
  return id ? data.saveDayQuestionnaire(id, input) : { error: "not authenticated" };
}
