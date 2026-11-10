"use server";
// Server Actions of ProfileDetailsForm: the user comes from the session, the logic lives in lib/data/profile.ts.
import { getSessionUser } from "@/lib/auth/session";
import { loadProfileForm, saveProfileForm, type ProfileFormData, type UserDataRow } from "@/lib/data/profile";

/** Current profile data and lookup options for the form; null when not logged in. */
export async function loadProfileFormData(): Promise<ProfileFormData | null> {
  const user = await getSessionUser();
  return user ? loadProfileForm(user.id) : null;
}

/** Saves name, user_data row and employment statuses of the logged-in user. */
export async function saveProfileFormData(input: {
  firstName: string;
  lastName: string;
  row: UserDataRow;
  employmentStatusIds: number[];
}): Promise<{ error: string | null }> {
  const user = await getSessionUser();
  if (!user) return { error: "not authenticated" };
  return saveProfileForm(user.id, input);
}
