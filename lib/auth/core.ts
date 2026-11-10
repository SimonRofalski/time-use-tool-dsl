// Framework-independent auth building blocks (no Next.js imports, so scripts can test them).
// Session design after Lucia + OWASP: 32 random bytes in the cookie, only the SHA-256 stored in the DB.
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

/** Inactivity timeout: a session that is used keeps living; 30 days without use ends it. */
export const SESSION_IDLE_DAYS = 30;
/** last_seen_at / expires_at are refreshed at most this often (limits DB writes, as Lucia does). */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Same password rules as the former auth service, so existing accounts and messages stay valid. */
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_BYTES = 72; // bcrypt ignores everything after 72 bytes
const BCRYPT_COST = 10; // same cost as the migrated hashes

/** Random session token; only the browser cookie holds it. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** user_session.id is the SHA-256 of the token, so a DB leak does not reveal usable tokens. */
export function sessionIdFromToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionExpiry(from = new Date()): Date {
  return new Date(from.getTime() + SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000);
}

/** E-mails are stored trimmed and lower-cased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Returns the error message (former auth service's wording), or null if the password is acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password should be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) return "Password cannot be longer than 72 characters.";
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

/** Verifies bcrypt hashes of migrated accounts ($2a$) and new ones ($2b$). Never throws on a bad hash. */
export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/** A hash used to spend the same time when an account does not exist (no account enumeration by timing). */
export const DUMMY_PASSWORD_HASH = "$2a$10$UE49I1Rx5KLy4MHiLMpV1Ozu8qRdrt/52H6u6MrJ0htBQKwybttXC";

/** Hashed key for auth_attempt rows, so no e-mail or IP is stored in plain text. */
export function attemptKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}
