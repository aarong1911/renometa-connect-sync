// netlify/functions/lib/sms-compliance.ts
//
// AI-2C — deterministic SMS compliance classification. Extracted in AI-2A's
// correction pass (STOP-only at the time) so ai-twilio-sms-inbound.ts and
// the legacy marketing-sms-inbound.ts share one implementation instead of
// drifting; extended here to cover START/re-subscribe and HELP
// classification (never model-decided — see the communications-compliance
// skill).
//
// ── PROVIDER-LEVEL COMPLIANCE: NOT CONFIRMED ACTIVE ──────────────────────
//
// Inspected before this pass: no reference anywhere in this repo to a
// Twilio Messaging Service, Advanced Opt-Out configuration, or any other
// provider-level compliance automation (grepped for "Messaging Service",
// "Advanced Opt-Out", "messagingServiceSid" — zero hits outside this
// skill's own documentation). Organizations' Twilio config
// (organizations.integration_settings.twilio) is a bare
// {accountSid, authToken, phoneNumber} — a plain phone number, not a
// Messaging Service SID.
//
// Stronger evidence than absence-of-config: ai-twilio-sms-inbound.ts's own
// STOP handling has already been exercised against REAL inbound Twilio
// webhook deliveries (AI-2A live verification) — a STOP message reached
// this application's webhook and was processed here. If Twilio's own
// Advanced Opt-Out were active for this number, Twilio would intercept a
// STOP delivery at their platform level and this webhook would never see
// it at all. That did not happen — this application is the only thing
// enforcing STOP/START/HELP semantics for this number today. By the same
// reasoning, START/HELP messages will also reach this webhook unfiltered.
//
// This conclusion is scoped to whatever Twilio number/account was used
// during that live verification — if RenoMeta ever moves to a Twilio
// Messaging Service with Advanced Opt-Out enabled, this reasoning no
// longer holds and must be re-verified, not assumed to still be true.

import type { SupabaseClient } from "@supabase/supabase-js";

export type SmsComplianceIntent = "stop" | "start" | "help" | null;

// Twilio's own documented default opt-out keyword family.
const SMS_STOP_KEYWORDS: ReadonlySet<string> = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
]);

// START + UNSTOP only — Twilio's own documented default opt-back-in
// family also includes "YES", deliberately NOT included here: this app is
// a two-way conversational SMS surface (Lead Qualification asks real
// questions), and a bare "yes" is a plausible, common, entirely ordinary
// conversational reply — treating it as a compliance command would
// misfire on real customer conversation. START/UNSTOP are unambiguous
// single-word commands with no plausible conversational double-meaning.
const SMS_START_KEYWORDS: ReadonlySet<string> = new Set([
  "start",
  "unstop",
]);

// HELP + INFO — both are Twilio's own documented default "how do I get
// help" family; neither is invented here.
const SMS_HELP_KEYWORDS: ReadonlySet<string> = new Set([
  "help",
  "info",
]);

/**
 * Deterministically classifies an inbound SMS body as a compliance
 * command, or null for an ordinary conversational message. Exact-match
 * only (the ENTIRE trimmed, case-insensitive body must equal a known
 * keyword) — never a substring/contains check, never fuzzy/semantic
 * classification, and this function never calls a model. "please stop
 * texting me" classifies as null, not "stop" — see the
 * communications-compliance skill for why.
 */
export function classifySmsComplianceMessage(body: string): SmsComplianceIntent {
  const normalized = body.trim().toLowerCase();
  if (SMS_STOP_KEYWORDS.has(normalized)) return "stop";
  if (SMS_START_KEYWORDS.has(normalized)) return "start";
  if (SMS_HELP_KEYWORDS.has(normalized)) return "help";
  return null;
}

/** Backward-compatible boolean check, kept only because it reads clearly
 * at a few call sites — equivalent to
 * `classifySmsComplianceMessage(body) === "stop"`. */
export function isStopKeyword(body: string): boolean {
  return classifySmsComplianceMessage(body) === "stop";
}

/**
 * Records an opt-out for the given contact — org-scoped via the caller's
 * already-trusted `contactId` (resolved server-side against `orgId`
 * before this is ever called; this function does not independently
 * re-verify that binding). `opted_out` is not fully terminal — see
 * `processStartKeyword()` below, which is the ONLY other place allowed to
 * move it forward again.
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

/**
 * AI-2C. Records a customer-initiated re-subscribe (START/UNSTOP) for the
 * given contact — org-scoped via the caller's already-trusted `contactId`,
 * same precondition as processStopKeyword().
 *
 * Deliberate per-state semantics (see the communications-compliance
 * skill):
 *   - 'opted_out' -> 'eligible': the exact reverse of processStopKeyword(),
 *     using the same trusted, service-role-only write path.
 *   - 'unknown' or no row at all -> 'eligible': a customer proactively
 *     texting START is treated as the same kind of explicit, affirmative
 *     opt-in event the fail-closed 'unknown' default was designed to
 *     require before eligibility exists — arguably a stronger consent
 *     signal than the existing staff "mark eligible" action
 *     (marketing-contact-preferences-set.ts), since it comes directly from
 *     the contact.
 *   - 'suppressed' -> UNCHANGED: per the schema's own documentation
 *     (20260829_marketing_campaigns_foundation.sql), 'suppressed' is
 *     reserved for a future carrier-level invalid/undeliverable-number
 *     signal, not a consent state — a text message from that number
 *     cannot itself prove the number is deliverable, so a customer-
 *     initiated START must never clear it. Only a future, deliberate
 *     carrier-signal-driven path should ever change 'suppressed'.
 *   - 'eligible' -> UNCHANGED (this function still runs, but the upsert is
 *     a no-op value-wise): idempotent, matches processStopKeyword()'s own
 *     unconditional-upsert shape.
 */
export async function processStartKeyword(
  supabase: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<void> {
  const { data: existing } = await supabase
    .from("marketing_contact_preferences")
    .select("sms_status")
    .eq("contact_id", contactId)
    .maybeSingle();

  if (existing?.sms_status === "suppressed") {
    return;
  }

  await supabase
    .from("marketing_contact_preferences")
    .upsert(
      { org_id: orgId, contact_id: contactId, sms_status: "eligible", sms_status_updated_at: new Date().toISOString() },
      { onConflict: "contact_id" },
    );
}
