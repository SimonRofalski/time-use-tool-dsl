import type { Locale } from "@/i18n/routing";

// Every lookup table (category, activity, satisfaction, ...) has a German
// `name` and an English `name_en`. This is the single place that picks
// between them; use it instead of reading `.name` directly.
export function getLocalizedName(
  row: { name: string; name_en: string },
  locale: Locale,
): string {
  return locale === "en" ? row.name_en : row.name;
}
