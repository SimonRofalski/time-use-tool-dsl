import type { Db } from "@/lib/db";

// Maps a verified SWITCH edu-ID identity to an app account (find, link or
// create). Called by app/api/auth/switch/callback/route.ts.

/** The identity can't be assigned to exactly one account; the login is refused. */
export class OidcAccountConflictError extends Error {
  constructor() {
    super("SWITCH edu-ID account conflict");
    this.name = "OidcAccountConflictError";
  }
}

export type SwitchEduIdIdentity = {
  sub: string;
  email: string;
  firstName?: string;
  lastName?: string;
  // From the ID token's email_verified claim; linking an existing account by
  // email is only allowed for a verified address (prevents account takeover)
  emailVerified: boolean;
};

export type ProvisionResult = {
  userId: string;
  created: boolean;
  linked: boolean;
};

// Find-or-create the profile for a verified SWITCH edu-ID identity.
// `db` is the handle of a withService() transaction: either everything below
// happens, or nothing.
//
// Linking policy (deliberate simplification):
// - Returning edu-ID user (matched by the stable `sub` claim) -> reuse as-is.
// - First-ever edu-ID login whose email matches an existing password-based
//   profile -> link automatically (same account id, full history kept).
//   No extra confirmation step is required from the user.
// - Otherwise -> provision a brand-new account.
export async function resolveOrProvisionProfile(
  db: Db,
  identity: SwitchEduIdIdentity,
): Promise<ProvisionResult> {
  const { sub, email, firstName, lastName, emailVerified } = identity;

  const bySub = await db.query<{ id: string }>(
    "SELECT id FROM public.profiles WHERE switch_edu_id_sub = $1",
    [sub],
  );
  if (bySub.length > 1) throw new OidcAccountConflictError(); // UNIQUE, cannot happen; fail closed
  if (bySub[0]) {
    return { userId: bySub[0].id, created: false, linked: false };
  }

  // Exact, case-insensitive e-mail match
  const emailMatches = await db.query<{ id: string; switch_edu_id_sub: string | null }>(
    "SELECT id, switch_edu_id_sub FROM public.profiles WHERE lower(email) = lower($1) LIMIT 2",
    [email.trim()],
  );

  // Several profiles with the same address (case variants): linking any one
  // of them would be a guess, so fail closed and let an admin sort it out
  if (emailMatches.length > 1) {
    throw new OidcAccountConflictError();
  }

  const byEmail = emailMatches[0];

  if (byEmail) {
    if (!emailVerified) {
      throw new OidcAccountConflictError();
    }
    if (byEmail.switch_edu_id_sub && byEmail.switch_edu_id_sub !== sub) {
      // Same email, already linked to a *different* edu-ID identity: fail
      // closed rather than silently reassigning accounts.
      throw new OidcAccountConflictError();
    }

    // An admin-created account still carries must_change_password from its
    // temporary password; once it signs in via edu-ID there is no password
    // to change, so the forced password gate would only get in the way
    await db.query(
      `UPDATE public.profiles
          SET auth_provider = 'switch_edu_id', switch_edu_id_sub = $2, must_change_password = false
        WHERE id = $1`,
      [byEmail.id, sub],
    );

    return { userId: byEmail.id, created: false, linked: true };
  }

  // New account without a password (edu-ID only); the trigger on app_user creates the profile
  const [created] = await db.query<{ id: string }>(
    "INSERT INTO public.app_user (email, password_hash) VALUES ($1, NULL) RETURNING id",
    [email.trim().toLowerCase()],
  );

  await db.query(
    `UPDATE public.profiles
        SET auth_provider = 'switch_edu_id', switch_edu_id_sub = $2,
            first_name = COALESCE(NULLIF($3, ''), first_name),
            last_name  = COALESCE(NULLIF($4, ''), last_name)
      WHERE id = $1`,
    [created.id, sub, firstName ?? "", lastName ?? ""],
  );

  return { userId: created.id, created: true, linked: false };
}
