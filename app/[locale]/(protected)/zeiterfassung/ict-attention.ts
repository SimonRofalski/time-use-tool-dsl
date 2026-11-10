import type { PendingEntry } from "./types";

// Business rule for the ICT focus question (focused vs. background device use).
// It is asked only when the course has it switched on (course.ask_ict_attention),
// a device was used AND the entry has a secondary activity. Device use during a
// sole main activity counts as focused, so the question is skipped and the answer
// is saved as NULL ("not asked"). It has no step of its own: it is shown on the
// device-type screen, right below the device selection.
export function shouldAskIctAttention(
  askIctAttention: boolean,
  entry: Pick<PendingEntry, "digital_media_used" | "secondary_activity_id">,
): boolean {
  return (
    askIctAttention &&
    entry.digital_media_used &&
    entry.secondary_activity_id !== null
  );
}
