import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";

// Server-only crypto for the security questions: answer hashing and the
// one-time token of the password reset (app/api/password-reset/*).

const RESET_TOKEN_BYTES = 32;
const SECURITY_HASH_KEY_LENGTH = 64;

/** Answers are compared trimmed and case-insensitively. */
export function normalizeSecurityAnswer(value: string) {
  return value.trim().toLowerCase();
}

/** scrypt with a random salt, stored as "salt:derivedKey" (hex). */
export function hashSecurityAnswer(value: string) {
  const normalized = normalizeSecurityAnswer(value);
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(
    normalized,
    salt,
    SECURITY_HASH_KEY_LENGTH,
  ).toString("hex");

  return `${salt}:${derivedKey}`;
}

/** Constant-time comparison against a stored "salt:derivedKey" hash. */
export function verifySecurityAnswer(value: string, storedHash: string) {
  const [salt, storedDerivedKey] = storedHash.split(":");
  if (!salt || !storedDerivedKey) {
    return false;
  }

  const normalized = normalizeSecurityAnswer(value);
  const derivedKey = scryptSync(normalized, salt, SECURITY_HASH_KEY_LENGTH);
  const storedBuffer = Buffer.from(storedDerivedKey, "hex");

  if (storedBuffer.length !== derivedKey.length) {
    return false;
  }

  return timingSafeEqual(storedBuffer, derivedKey);
}

/** Raw one-time token; only the client gets it, the DB stores its hash. */
export function createResetChallengeToken() {
  return randomBytes(RESET_TOKEN_BYTES).toString("hex");
}

export function hashResetChallengeToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** A reset challenge is valid for 15 minutes. */
export function getResetChallengeExpirationDate() {
  const expirationDate = new Date();
  expirationDate.setMinutes(expirationDate.getMinutes() + 15);
  return expirationDate.toISOString();
}
