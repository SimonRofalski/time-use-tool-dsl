// Data access for the profile details form (names + socio-demographic data). Called only by the Server Actions in
// app/components/profile-actions.ts, which pass the session user id. RLS applies (withUser).
import { withUser } from "@/lib/db";

export type LookupRow = { id: number; code: string; name: string; name_en: string };

// Form key -> [table, id column]; fixed list, never built from user input
// (the names are interpolated into SQL below)
const LOOKUPS = {
  gender: ["gender", "gender_id"],
  maritalStatus: ["marital_status", "marital_status_id"],
  childrenInHousehold: ["children_in_household", "children_in_household_id"],
  educationLevel: ["education_level", "education_level_id"],
  employmentStatus: ["employment_status", "employment_status_id"],
  occupationalStatus: ["occupational_status", "occupational_status_id"],
  mainWorkplace: ["main_workplace", "main_workplace_id"],
  healthStatus: ["health_status", "health_status_id"],
  nationality: ["nationality", "nationality_id"],
  region: ["region", "region_id"],
  urbanity: ["urbanity", "urbanity_id"],
} as const;

export type ProfileLookups = Record<keyof typeof LOOKUPS, LookupRow[]>;

export type ProfileFormData = {
  lookups: ProfileLookups;
  profile: { role: string; first_name: string; last_name: string } | null;
  /** the full user_data row (select *), or null */
  userData: Record<string, unknown> | null;
  employmentStatusIds: number[];
};

/** All lookup lists of the form plus the user's current answers. */
export async function loadProfileForm(userId: string): Promise<ProfileFormData> {
  return withUser(
    userId,
    async (db) => {
      const lookups = {} as ProfileLookups;
      for (const [key, [table, idCol]] of Object.entries(LOOKUPS) as [keyof typeof LOOKUPS, readonly [string, string]][]) {
        lookups[key] = await db.query<LookupRow>(
          `SELECT ${idCol} AS id, code, name, name_en FROM public.${table} ORDER BY ${idCol}`,
        );
      }
      const profiles = await db.query<{ role: string; first_name: string; last_name: string }>(
        "SELECT role, first_name, last_name FROM public.profiles WHERE id = $1",
        [userId],
      );
      const userDataRows = await db.query("SELECT * FROM public.user_data WHERE profiles_id = $1", [userId]);
      const userData = userDataRows.length === 1 ? userDataRows[0] : null;
      const employmentStatusIds = userData
        ? (await db.query<{ employment_status_id: number }>(
            "SELECT employment_status_id FROM public.user_employment_status WHERE user_data_id = $1",
            [userData.user_data_id],
          )).map((r) => r.employment_status_id)
        : [];
      return { lookups, profile: profiles.length === 1 ? profiles[0] : null, userData, employmentStatusIds };
    },
    { readOnly: true },
  );
}

export type UserDataRow = {
  gender_id: number | null;
  age: number | null;
  marital_status_id: number | null;
  partner_in_household: boolean | null;
  children_in_household_id: number | null;
  education_level_id: number | null;
  occupational_status_id: number | null;
  weekly_work_hours: number | null;
  main_workplace_id: number | null;
  health_status_id: number | null;
  nationality_id: number | null;
  region_id: number | null;
  urbanity_id: number | null;
};

const USER_DATA_COLUMNS: (keyof UserDataRow)[] = [
  "gender_id", "age", "marital_status_id", "partner_in_household", "children_in_household_id", "education_level_id",
  "occupational_status_id", "weekly_work_hours", "main_workplace_id", "health_status_id", "nationality_id",
  "region_id", "urbanity_id",
];

/** Names + socio-demographic data + employment statuses in ONE transaction (insert or update). */
export async function saveProfileForm(
  userId: string,
  input: { firstName: string; lastName: string; row: UserDataRow; employmentStatusIds: number[] },
): Promise<{ error: string | null }> {
  try {
    await withUser(userId, async (db) => {
      await db.query("UPDATE public.profiles SET first_name = $2, last_name = $3 WHERE id = $1", [
        userId, input.firstName, input.lastName,
      ]);
      const values = USER_DATA_COLUMNS.map((c) => input.row[c] ?? null);
      const existing = await db.query<{ user_data_id: number }>(
        "SELECT user_data_id FROM public.user_data WHERE profiles_id = $1",
        [userId],
      );
      let userDataId: number;
      if (existing[0]) {
        userDataId = existing[0].user_data_id;
        await db.query(
          `UPDATE public.user_data SET ${USER_DATA_COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE user_data_id = $1`,
          [userDataId, ...values],
        );
      } else {
        const [inserted] = await db.query<{ user_data_id: number }>(
          `INSERT INTO public.user_data (profiles_id, ${USER_DATA_COLUMNS.join(", ")})
           VALUES ($1, ${USER_DATA_COLUMNS.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING user_data_id`,
          [userId, ...values],
        );
        userDataId = inserted.user_data_id;
      }
      await db.query("DELETE FROM public.user_employment_status WHERE user_data_id = $1", [userDataId]);
      if (input.employmentStatusIds.length) {
        await db.query(
          `INSERT INTO public.user_employment_status (user_data_id, employment_status_id)
           SELECT $1, s FROM unnest($2::int[]) s`,
          [userDataId, input.employmentStatusIds],
        );
      }
    });
    return { error: null };
  } catch (error) {
    console.error("saving the profile failed", error);
    return { error: "save_failed" };
  }
}
