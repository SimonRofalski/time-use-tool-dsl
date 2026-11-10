// Suggestion for an admin-set temporary password (create user / reset password). Uses the
// cryptographically secure crypto.getRandomValues (browser and Node), never Math.random. Ambiguous
// characters (0/O, 1/l/I) are left out because the admin passes the password on by hand.
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateTemporaryPassword(length = 12): string {
  // Rejection sampling: bytes >= the largest multiple of the alphabet size are dropped, so every
  // character is equally likely.
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}
