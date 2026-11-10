// Shared types and constants of the Zeiterfassung feature (page, TimeGrid,
// ActivitySelector, DayQuestionnaireModal).

// One distinct color per category, assigned by category index (0-10).
// Both TimeGrid and ActivitySelector use this array.
export const CATEGORY_COLORS: string[] = [
  "#6366F1", // indigo
  "#059669", // emerald
  "#D97706", // amber
  "#DC2626", // red
  "#7C3AED", // violet
  "#0891B2", // cyan
  "#EA580C", // orange
  "#DB2777", // pink
  "#0D9488", // teal
  "#65A30D", // lime
  "#64748B", // slate - unspecified time use
];

// Returns the hex color for a category by its position in the sorted list.
// Falls back to slate-400 if the category is not found.
export function getCategoryColor(
  categoryId: number,
  categories: Category[],
): string {
  const index = categories.findIndex((c) => c.category_id === categoryId);
  return index >= 0
    ? CATEGORY_COLORS[index % CATEGORY_COLORS.length]
    : "#94A3B8";
}

// --- Lookup table types (static reference data from the DB) ---
// name = German, name_en = English; pick with getLocalizedName() (lib/i18n/localized-name.ts).
// code is language-neutral (HETUS/BFS codes) and drives icons, grouping and sorting.

export type Category = {
  category_id: number;
  code: string;
  name: string;
  name_en: string;
};

export type Subcategory = {
  subcategory_id: number;
  category_id: number;
  code: string;
  name: string;
  name_en: string;
};

export type Activity = {
  activity_id: number;
  subcategory_id: number;
  code: string;
  name: string;
  name_en: string;
  // Hidden search aliases per locale (matched in lib/activity-search.ts, never shown).
  // Optional so the type also fits rows that come without them.
  keywords_de?: string[] | null;
  keywords_en?: string[] | null;
};

export type LocationTransport = {
  location_transport_id: number;
  code: string;
  name: string;
  name_en: string;
};

export type SocialContext = {
  social_context_id: number;
  code: string;
  name: string;
  name_en: string;
};

export type DigitalMediaType = {
  digital_media_type_id: number;
  code: string;
  name: string;
  name_en: string;
};

export type Satisfaction = {
  satisfaction_id: number;
  code: string;
  name: string;
  name_en: string;
};

export type Meaningfulness = {
  meaningfulness_id: number;
  code: string;
  name: string;
  name_en: string;
};

export type Stressfulness = {
  stressfulness_id: number;
  code: string;
  name: string;
  name_en: string;
};

// Focused vs. background device use (see ict-attention.ts)
export type IctAttention = {
  ict_attention_id: number;
  code: string;
  name: string;
  name_en: string;
  description: string;
  description_en: string;
};

// All lookup tables bundled together for convenient passing between components
export type LookupData = {
  categories: Category[];
  subcategories: Subcategory[];
  activities: Activity[];
  locationTransports: LocationTransport[];
  socialContexts: SocialContext[];
  digitalMediaTypes: DigitalMediaType[];
  satisfactions: Satisfaction[];
  meaningfulnesses: Meaningfulness[];
  stressfulnesses: Stressfulness[];
  ictAttentions: IctAttention[];
};

// --- Core data types ---

// A time entry as stored in the database, normalized for use in the frontend.
// The app saves one row per 10-minute slot; start_time and end_time are "HH:MM"
// strings (seconds stripped from the DB format).
export type TimeEntryRecord = {
  entry_id: number;
  day_id: number;
  start_time: string;
  end_time: string;
  primary_activity_id: number;
  secondary_activity_id: number | null;
  satisfaction_id: number | null;
  meaningfulness_id: number | null;
  stressfulness_id: number | null;
  location_transport_id: number | null;
  digital_media_used: boolean;
  digital_media_type_ids: number[];
  ict_attention_id: number | null;
  social_context_ids: number[];
};

// Entry being built step-by-step in the questionnaire before it is saved
export type PendingEntry = {
  slots: string[]; // sorted "HH:MM" slot strings
  primary_activity_id: number | null;
  secondary_activity_id: number | null;
  digital_media_used: boolean;
  digital_media_type_ids: number[];
  ict_attention_id: number | null;
  location_transport_id: number | null;
  social_context_ids: number[];
  satisfaction_id: number | null;
  meaningfulness_id: number | null;
  stressfulness_id: number | null;
};

// The ordered steps in the questionnaire flow.
// digital_media_type is only shown when digital_media_used = true; it also
// hosts the ICT focus question when shouldAskIctAttention() applies.
export type QuestionnaireStep =
  | "primary_activity"
  | "secondary_activity"
  | "digital_media"
  | "digital_media_type"
  | "location_transport"
  | "social_context"
  | "satisfaction";
