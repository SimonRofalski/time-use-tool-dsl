"use server";
// Server Action of the "Erfasste Zeit" page: takes the user from the session and loads the
// day overview via lib/data/erfasste-zeit.ts.
import { getSessionUser } from "@/lib/auth/session";
import { loadOverview, type OverviewData } from "@/lib/data/erfasste-zeit";

/** null = no logged-in user; a database error is reported as status "days_error". */
export async function loadOverviewData(): Promise<OverviewData | null> {
  const user = await getSessionUser();
  if (!user) return null;
  try {
    return await loadOverview(user.id);
  } catch {
    return { status: "days_error" };
  }
}
