import { createHash, createHmac } from "node:crypto";
import type { Db } from "@/lib/db";

// --- Shared server logic for the security-question password reset ---
// Used by app/api/password-reset/{security-questions,verify}. Goals:
//  - the responses never reveal whether an account exists for an email
//    (unknown emails get two stable decoy questions; answers to them fail),
//  - the internal profile ID never leaves the server,
//  - answers can't be brute-forced: 5 failed attempts within 15 minutes lock
//    further attempts for that email (also for unknown emails, so the lock
//    itself reveals nothing).
// All functions take the db handle of a withService() transaction.

export const RESET_MAX_FAILED_ATTEMPTS = 5;
const RESET_LOCK_WINDOW_MINUTES = 15;

export function normalizeResetEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Attempts are stored per email hash, not per profile, so emails without an
// account are rate-limited the same way
export function hashResetEmail(email: string): string {
  return createHash("sha256").update(normalizeResetEmail(email)).digest("hex");
}

// Exact, case-insensitive email match. Falls back to the login accounts
// (app_user) for profiles whose email isn't filled in.
export async function resolveProfileIdByEmail(db: Db, email: string): Promise<string | null> {
  const normalizedEmail = normalizeResetEmail(email);
  const profiles = await db.query<{ id: string }>(
    "SELECT id FROM public.profiles WHERE lower(email) = $1",
    [normalizedEmail],
  );
  // Only a unique profile match counts; otherwise the login account decides
  if (profiles.length === 1) return profiles[0].id;

  const accounts = await db.query<{ id: string }>(
    "SELECT id FROM public.app_user WHERE lower(email) = $1",
    [normalizedEmail],
  );
  return accounts[0]?.id ?? null;
}

// Secret for the decoy question choice (RESET_DECOY_SECRET, required in production).
function decoySecret(): string {
  const secret = process.env.RESET_DECOY_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    console.error("RESET_DECOY_SECRET is not set: decoy security questions are predictable");
  }
  return secret ?? "decoy";
}

// Two distinct questions picked deterministically from the email, so asking
// twice for the same unknown email shows the same questions (a random pick
// each time would give away that the account doesn't exist)
export function pickDecoyQuestionIds(
  email: string,
  availableQuestionIds: number[],
): number[] {
  if (availableQuestionIds.length < 2) return availableQuestionIds;
  const digest = createHmac("sha256", decoySecret())
    .update(normalizeResetEmail(email))
    .digest();
  const sorted = [...availableQuestionIds].sort((a, b) => a - b);
  const first = digest[0] % sorted.length;
  const offset = 1 + (digest[1] % (sorted.length - 1));
  return [sorted[first], sorted[(first + offset) % sorted.length]];
}

export async function isResetLocked(db: Db, emailHash: string): Promise<boolean> {
  try {
    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.security_question_reset_attempt
        WHERE email_hash = $1 AND attempted_at >= now() - make_interval(mins => $2)`,
      [emailHash, RESET_LOCK_WINDOW_MINUTES],
    );
    return rows[0].n >= RESET_MAX_FAILED_ATTEMPTS;
  } catch {
    // Fail closed: if the counter can't be read, don't allow guessing
    return true;
  }
}

export async function recordFailedResetAttempt(db: Db, emailHash: string): Promise<void> {
  await db.query("INSERT INTO public.security_question_reset_attempt (email_hash) VALUES ($1)", [emailHash]);
}

export async function clearResetAttempts(db: Db, emailHash: string): Promise<void> {
  await db.query("DELETE FROM public.security_question_reset_attempt WHERE email_hash = $1", [emailHash]);
}
