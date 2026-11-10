"use server";
// Server Actions of the Statistiken page. The user always comes from the session; the logic lives
// in lib/data/statistiken.ts (shared comparison math in lib/statistiken/comparison.ts).
import { getSessionUser } from "@/lib/auth/session";
import {
  comparisonFromSnapshot,
  loadComparisonSnapshot,
  loadStatistikenBase,
  type ComparisonSnapshot,
  type CourseComparison,
  type StatistikenBase,
} from "@/lib/data/statistiken";
import type { DayFilterMode } from "@/lib/statistiken/comparison";

export type StatistikenData =
  | { status: "unauthenticated" }
  | { status: "error" }
  | (StatistikenBase & { userId: string; email: string });

/** Everything the page needs for the viewer's own statistics (course, lookups, own days and entries). */
export async function loadStatistikenData(): Promise<StatistikenData> {
  const user = await getSessionUser();
  if (!user) return { status: "unauthenticated" };
  try {
    const base = await loadStatistikenBase(user.id);
    return { ...base, userId: user.id, email: user.email };
  } catch {
    return { status: "error" };
  }
}

// Comparison snapshot cache: the page load takes a fresh snapshot (fresh = true), week / day filter
// changes reuse it, so they stay quick and work on the same data as the rest of the page. Kept in
// server memory only (per session, max. 10 minutes, max. 25 entries); never sent to the browser.
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const MAX_SNAPSHOTS = 25;
const snapshots = new Map<string, { userId: string; at: number; snapshot: ComparisonSnapshot }>();

function rememberSnapshot(sessionId: string, userId: string, snapshot: ComparisonSnapshot) {
  snapshots.delete(sessionId);
  snapshots.set(sessionId, { userId, at: Date.now(), snapshot });
  const now = Date.now();
  for (const [key, value] of snapshots) {
    if (snapshots.size > MAX_SNAPSHOTS || now - value.at > SNAPSHOT_TTL_MS) snapshots.delete(key);
  }
}

const DAY_MODES: DayFilterMode[] = ["alle", "werktage", "wochenende"];

/**
 * Course side of the Kursvergleich for the given filters (aggregates only).
 * Input comes from the browser, so weeks ("YYYY-KWnn") and day mode are validated.
 * null = not logged in, invalid filters or load error (the tab then shows no comparison)
 */
export async function loadCourseComparisonData(
  weeks: string[],
  dayMode: DayFilterMode,
  fresh: boolean,
): Promise<CourseComparison | null> {
  const user = await getSessionUser();
  if (!user) return null;
  if (
    !Array.isArray(weeks) ||
    weeks.length > 60 ||
    !weeks.every((w) => typeof w === "string" && /^\d{4}-KW\d{2}$/.test(w)) ||
    !DAY_MODES.includes(dayMode)
  ) {
    return null;
  }
  try {
    const cached = snapshots.get(user.sessionId);
    let snapshot: ComparisonSnapshot;
    if (!fresh && cached && cached.userId === user.id && Date.now() - cached.at <= SNAPSHOT_TTL_MS) {
      snapshot = cached.snapshot;
    } else {
      snapshot = await loadComparisonSnapshot(user.id);
      rememberSnapshot(user.sessionId, user.id, snapshot);
    }
    return comparisonFromSnapshot(snapshot, weeks, dayMode);
  } catch {
    return null;
  }
}
