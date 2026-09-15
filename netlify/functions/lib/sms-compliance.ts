// netlify/functions/lib/sms-compliance.ts
//
// AI-2A correction pass. Extracted from marketing-sms-inbound.ts (the
// ONLY place STOP/opt-out handling existed before this pass) so both that
// file and the new canonical AI inbound webhook (ai-twilio-sms-inbound.ts)
// call the exact same logic instead of maintaining two copies that could
// silently drift. Behavior is byte-for-byte unchanged from
// marketing-sms-inbound.ts's original implementation — this is a pure
// extraction, not a redesign.
//
// SCOPE: Twilio's own default opt-out keyword list only (STOP, STOPALL,
// UNSUBSCRIBE, CANCEL, END, QUIT) — matching the set marketing-sms-
// inbound.ts already used. No HELP/START/re-subscribe handling exists
// anywhere in this repo today (confirmed by a full-repo search before
// this pass) — this file does NOT invent any of that; see the AI-2A
// correction-pass report for that gap.

import type { SupabaseClient } from "@supabase/supabase-js";

export const SMS_STOP_KEYWORDS: ReadonlySet<string> = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
]);

/** True only when the ENTIRE trimmed/lowercased message body is one of
 * Twilio's own default opt-out keywords — matches marketing-sms-inbound.ts's
 * original exact-match behavior (never a substring/contains check). */
export function isStopKeyword(body: string): boolean {
  return SMS_STOP_KEYWORDS.has(body.trim().toLowerCase());
}

/**
 * Records an opt-out for the given contact — the ONLY effect a STOP
 * keyword has anywhere in this codebase. `opted_out` is terminal from
 * this function's point of view: it only ever sets opted_out, never
 * clears it back to eligible/unknown (unchanged from the original
 * marketing-sms-inbound.ts implementation — see that file's own header
 * for why: an opted-out contact must never become eligible again merely
 * because a later message arrives; only the explicit trusted
 * marketing-contact-preferences-set.ts path can move eligibility forward
 * again).
 */
export async function processStopKeyword(
  supabase: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<void> {
  await supabase
    .from("marketing_contact_preferences")
    .upsert(
      { org_id: orgId, contact_id: contactId, sms_status: "opted_out", sms_status_updated_at: new Date().toISOString() },
      { onConflict: "contact_id" },
    );
}
