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
import { sendTwilioSms } from "../../../src/lib/agentic/sms-transport";

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

// ── AI-2C.1: deterministic HELP reply ────────────────────────────────────
//
// Sent ONLY when the org has explicitly configured
// organizations.ai_center_settings.smsCompliance.helpReply (a plain-text,
// operator-authored string — never inferred from org name/phone/website,
// never composed by a model). Missing/empty configuration means HELP is
// classified and kept out of AI (see classifySmsComplianceMessage()) but
// no reply is sent — that is the deliberate default, not a bug.

const HELP_REPLY_MAX_LENGTH = 1600; // matches sendSmsInput's own max (action-registry.ts) — the same SMS transport, same real limit.

export type AICenterSmsComplianceSettings = { helpReply?: string };
export type AICenterSettingsForCompliance = { smsCompliance?: AICenterSmsComplianceSettings; [key: string]: unknown };

function parseAICenterSettings(value: unknown): AICenterSettingsForCompliance {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as AICenterSettingsForCompliance;
  }
  return {};
}

/** Loads the org's configured HELP reply text, or null if unset/blank. */
export async function loadHelpReply(supabase: SupabaseClient, orgId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("organizations")
    .select("ai_center_settings")
    .eq("id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[sms-compliance] loadHelpReply lookup failed:", error);
    return null;
  }
  const settings = parseAICenterSettings(data?.ai_center_settings);
  const reply = settings.smsCompliance?.helpReply;
  return typeof reply === "string" && reply.trim().length > 0 ? reply.trim().slice(0, HELP_REPLY_MAX_LENGTH) : null;
}

/**
 * HELP-specific consent check — DELIBERATELY NOT the same as
 * checkOutboundConsent()/splitByChannelEligibility() (marketing-eligibility
 * semantics, action-executor.ts / marketing-audience.ts). A HELP reply is
 * a deterministic compliance/support response, not a marketing message —
 * gating it behind marketing opt-in status would be backwards: a contact
 * who has never opted into marketing SMS (`unknown`), or who has already
 * opted out (`opted_out`) and is now asking HELP, is exactly who a
 * compliance reply must still be able to reach. The one status that DOES
 * block a HELP reply is `suppressed` — reserved for a future carrier-level
 * undeliverable-number signal (see processStartKeyword()'s own comment);
 * sending anything, including a compliance reply, to a number flagged
 * undeliverable is a transport-safety concern, not a consent one, and is
 * treated the same conservative way STOP/START already treat it (never
 * overridden). No CRM contact at all (`contactId` null — an unmatched
 * sender) is treated as "no known reason to block" — see this file's HELP
 * sender for the full unmatched-sender reasoning.
 */
async function helpReplyBlockedBySuppression(supabase: SupabaseClient, contactId: string | null): Promise<boolean> {
  if (!contactId) return false;
  const { data } = await supabase.from("marketing_contact_preferences").select("sms_status").eq("contact_id", contactId).maybeSingle();
  return data?.sms_status === "suppressed";
}

/**
 * Atomically claims the inbound sms_meta_messages row for a HELP reply —
 * the durable idempotency guard this task requires beyond the inbound
 * MessageSid dedupe alone. The inbound insert's own unique index already
 * prevents a genuine Twilio webhook retry from ever reaching this function
 * a second time for the SAME delivery (a duplicate MessageSid insert
 * fails with 23505 and returns before compliance handling ever runs) —
 * this claim is the belt-and-suspenders guard against any OTHER path that
 * could re-invoke this function for the same already-persisted row (e.g.
 * infrastructure-level function retry), using the exact same conditional-
 * UPDATE-with-meta pattern ai-twilio-sms-orchestrate-background.ts already
 * uses for its own AI-dispatch claim. Reuses the same `meta` column —
 * never collides with that AI-dispatch claim, since a given inbound row is
 * either a compliance message (this claim) or a normal message (the AI
 * claim), never both.
 */
async function claimForHelpReply(supabase: SupabaseClient, orgId: string, inboundMessageId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("sms_meta_messages")
    .update({ meta: { compliance_reply: "help", claimed_at: new Date().toISOString() } })
    .eq("id", inboundMessageId)
    .eq("org_id", orgId)
    .is("meta", null)
    .select("id");
  if (error) {
    console.error("[sms-compliance] claimForHelpReply failed:", error);
    return false;
  }
  return (data ?? []).length > 0;
}

/**
 * Sends the org's configured deterministic HELP reply, if any, and if not
 * blocked by suppression — entirely outside AI (no model call, no
 * orchestrator, no Gen-2 action/approval workflow; uses the shared
 * low-level sendTwilioSms() transport directly, then persists the
 * outbound row itself, mirroring handlers.ts's sendSms() persistence
 * shape). Safe to call unconditionally from the HELP branch of an inbound
 * webhook — every guard (missing config, suppression, duplicate claim,
 * send failure) is internal and this function never throws.
 */
export async function sendHelpReplyIfConfigured(
  supabase: SupabaseClient,
  orgId: string,
  inboundMessageId: string,
  toPhone: string,
  contactId: string | null,
): Promise<void> {
  const helpReply = await loadHelpReply(supabase, orgId);
  if (!helpReply) {
    console.log("[sms-compliance] HELP received but no helpReply is configured for org", orgId, "— no reply sent.");
    return;
  }

  if (await helpReplyBlockedBySuppression(supabase, contactId)) {
    console.log("[sms-compliance] HELP reply blocked — contact is suppressed, org", orgId);
    return;
  }

  const claimed = await claimForHelpReply(supabase, orgId, inboundMessageId);
  if (!claimed) {
    console.log("[sms-compliance] HELP reply already claimed for inbound message", inboundMessageId, "— skipping duplicate send.");
    return;
  }

  const sendResult = await sendTwilioSms(supabase, orgId, toPhone, helpReply);
  if (!sendResult.ok) {
    console.error("[sms-compliance] HELP reply send failed for org", orgId, ":", sendResult.error);
    return;
  }

  const { error: insertErr } = await supabase.from("sms_meta_messages").insert({
    org_id: orgId,
    contact_id: contactId,
    channel: "sms",
    direction: "out",
    body: helpReply,
    from_address: toPhone,
    provider_message_id: sendResult.providerMessageId,
  });
  if (insertErr) {
    // The send already succeeded — losing the local history row is a
    // lesser problem than reporting a false failure (same tradeoff
    // handlers.ts's sendSms() already makes for its own persistence).
    console.error("[sms-compliance] HELP reply sms_meta_messages insert failed:", insertErr.message);
  }
}
