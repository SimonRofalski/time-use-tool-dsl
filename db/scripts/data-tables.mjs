// The tables that hold user data, in foreign-key order. Shared by export-data.mjs and import-data.mjs,
// so an export always fits the import. Lookup tables are not listed: they come from migration 0002.
// Sessions and login attempts are deliberately not exported (users simply log in again).
// identity: the table has GENERATED ALWAYS columns, so the import needs OVERRIDING SYSTEM VALUE.
export const DATA_TABLES = [
  { name: "app_user", identity: false },
  { name: "profiles", identity: false },
  { name: "course", identity: true },
  { name: "course_period", identity: false },
  { name: "course_access_code", identity: false },
  { name: "user_course", identity: false },
  { name: "user_data", identity: true },
  { name: "user_employment_status", identity: false },
  { name: "user_security_question", identity: false },
  { name: "day", identity: true },
  { name: "time_entry", identity: true },
  { name: "time_entry_social_context", identity: false },
  { name: "time_entry_digital_media_type", identity: false },
  { name: "day_questionnaire", identity: true },
];
