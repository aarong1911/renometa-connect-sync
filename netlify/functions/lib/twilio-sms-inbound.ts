// netlify/functions/lib/twilio-sms-inbound.ts
//
// AI-3I — Twilio inbound SMS -> live Lead Qualification. The injectable,
// unit-testable core behind netlify/functions/ai-twilio-sms-inbound.ts
// (that file is deliberately THIN: internal auth/transport only — see its
// own header). Same split convention as meta-whatsapp-inbound.ts /
// meta-whatsapp-background.ts already established in this repo.
//
// ── WHY THIS FILE EXISTS (audit, done before writing any of this) ───────
//
// This branch (feat/ai-center-live-lead-qualification) had NO Twilio
// inbound SMS adapter at all — confirmed by a full search of this branch,
// its git history, and this repo's other local worktrees before writing
// anything. A complete, mature implementation DOES already exist, but on
// a DIFFERENT branch/worktree: `feat/ai-center-foundation`
// (C:\Users\info\OneDrive\Desktop\RenoMeta Apps\
// renometa-connect-sync-ui-lovable-parity-final, the "dirty worktree"),
// read via `git show feat/ai-center-foundation:<path>` — a read-only git
// operation; that worktree's own files were never opened or modified.
// Found there: netlify/functions/ai-twilio-sms-inbound.ts,
// ai-twilio-sms-orchestrate-background.ts, lib/twilio-signature.ts,
// lib/sms-compliance.ts, lib/sms-reply-mode.ts, plus matching
// action-executor.ts/action-registry.ts/handlers.ts changes for send_sms.
//
// Twilio signature verification (lib/twilio-signature.ts) was ported
// VERBATIM — pure, dependency-free crypto logic with nothing
// architecture-specific in it.
//
// The ORCHESTRATION side was NOT ported verbatim, by design: that other
// branch's ai-twilio-sms-orchestrate-background.ts calls orchestrateAI()
// directly with source "twilio_inbound_sms" and lets the deterministic
// router (router.ts) decide Reception vs. Lead Qualification from CRM
// context. This branch has since built a DEDICATED, newer live Lead
// Qualification dispatcher (lib/ai/lead-qualification-dispatch.ts's
// dispatchLeadQualification(), with its own enabled-gate/policy/
// idempotency/claim-row machinery) that did not exist yet when the other
// branch's SMS work was written. Per this task's explicit scope — reuse
// dispatchLeadQualification(), do not build a second approval system or a
// second SMS-send path — this file calls that dispatcher (via the
// existing background-dispatch HTTP hop, see DISPATCH below), not
// orchestrateAI() directly. send_sms itself (action-registry.ts/
// handlers.ts) already exists UNCHANGED on this branch — nothing about
// the actual send/approval path needed porting at all.
//
// AI-3K addition (final hardening pass, after live PR #15 validation):
// lib/sms-compliance.ts's STOP/START/HELP handling IS now ported and
// wired in — see the new COMPLIANCE section below. It runs BEFORE the
// no_contact/no_open_lead/dispatch decision, and structurally never
// reaches dispatchLeadQualificationBackground() for a recognized
// compliance keyword (see processTwilioInboundSms() below).
//
// ── FLOW ──────────────────────────────────────────────────────────────
//
//   parse form body (From/To/Body/MessageSid)
//     -> resolve owning org from the RECEIVING number (`To`), server-side
//        only — never from any client-claimed org id
//     -> verify Twilio signature using THAT org's own authToken
//     -> resolve contact by normalized `From`, org-scoped
//     -> resolve one open/active lead for that contact, org-scoped
//     -> persist the inbound message (sms_meta_messages) — this is also
//        the Twilio-retry dedupe guard (see DEDUPE below)
//     -> compliance-keyword check (STOP/START/HELP) — if matched, handled
//        deterministically here and returned; AI is NEVER reached
//     -> otherwise, if a contact AND an open lead were resolved: dispatch
//        the EXISTING live Lead Qualification background pipeline with
//        source "inbound_lead_message" / channel "sms"
//     -> otherwise: message is still persisted, no AI dispatch, success
//        returned to Twilio (per this task's explicit scope — no
//        auto-creation of contacts/leads here)
//
// ── COMPLIANCE (AI-3K) ──────────────────────────────────────────────────
//
// classifySmsComplianceMessage() (lib/sms-compliance.ts) is checked
// immediately after persistence, before ANY contact/lead-based dispatch
// decision. STOP/START act even for an UNMATCHED sender's number is
// logged and the message still just returns success — there is no
// contact row to update preferences on, matching the ported original's
// own behavior (never invented here). HELP's deterministic reply CAN
// still be sent to an unmatched sender (see sms-compliance.ts's own
// doc comment on why a compliance/support reply isn't gated by CRM
// identity). None of the three branches ever calls
// dispatchLeadQualificationBackground() — structurally, not by
// convention: each one returns before reaching that call.
//
// ── DEDUPE ────────────────────────────────────────────────────────────
//
// sms_meta_messages has a `provider_message_id` column with NO live
// uniqueness constraint today. supabase/migrations/
// 20260915_sms_meta_messages_dedupe.sql (already present on this branch,
// NOT written by this pass, and explicitly marked "NOT YET APPLIED" in its
// own header) adds a partial unique index on (org_id, provider_message_id)
// that makes persistInboundSms()'s insert atomically reject a retried
// Twilio delivery (Postgres 23505) before it ever reaches AI dispatch.
// Until that migration is actually applied, a Twilio retry could insert a
// second row for the same MessageSid and (because
// dispatchLeadQualification()'s own idempotency key for this trigger is
// buildInboundMessageIdempotencyKey(messageRowId) — keyed to the ROW id,
// not the MessageSid) WOULD be treated as a distinct row and could
// dispatch AI a second time. This is flagged explicitly in this pass's
// report; applying that pre-existing migration (reviewing it first, per
// this repo's database-migrations skill) closes the gap completely — no
// NEW migration was written for this task ("prefer no migration").
//
// ── DISPATCH (sync vs. background) ───────────────────────────────────
//
// Audited the existing WhatsApp/lead-created background pattern before
// choosing this. A Lead Qualification turn can make multiple sequential
// model calls; Twilio's own webhook timeout is short (~15s) and this
// repo's netlify.toml sets no function-timeout override. Running
// dispatchLeadQualification() synchronously inside this public webhook
// risks Twilio treating a slow response as a failure and retrying — the
// exact risk ai-whatsapp-orchestrate-background.ts and
// lead-qualification-background.ts were both already built to avoid.
// Rather than inventing a third background function, this reuses the
// EXISTING lead-qualification-background.ts endpoint (extended — see that
// file's own AI-3I comments — to accept an optional `source`/
// `inboundEvent`, defaulting to today's `lead_created` shape for every
// existing caller) via lead-created-hook.ts's existing
// dispatchLeadQualificationBackground() HTTP helper. No new background
// function, no new internal secret — the SAME
// AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET already documented in
// .env.example protects this call too.

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "../../../src/lib/phone";
import { verifyTwilioSignature } from "./twilio-signature";
import { isLiveTriggerEligible, type InboundTriggerCandidate } from "./ai/lead-trigger";
import type { LeadQualificationBackgroundPayload } from "./ai/lead-qualification-background";
import { classifySmsComplianceMessage, processStopKeyword, processStartKeyword, sendHelpReplyIfConfigured } from "./sms-compliance";

/** Matches router.ts's own ACTIVE_LEAD_STATUSES exactly (inlined here, same
 * reasoning as that file and the other branch's own ported original: keep
 * this module's dependency surface small rather than importing from the
 * router). */
const ACTIVE_LEAD_STATUSES: ReadonlySet<string> = new Set(["new", "contacted", "qualified"]);

// ── Form parsing ─────────────────────────────────────────────────────────

export type TwilioInboundForm = { from: string; to: string; body: string; messageSid: string };

/** Never throws. Returns null for anything that isn't a recognizable
 * Twilio SMS payload (missing From/To/MessageSid) — nothing safe to do
 * with that beyond a plain empty TwiML response. */
export function parseTwilioInboundForm(rawBody: string | null | undefined): TwilioInboundForm | null {
  const params = new URLSearchParams(rawBody ?? "");
  const from = params.get("From");
  const to = params.get("To");
  const body = (params.get("Body") ?? "").trim();
  const messageSid = params.get("MessageSid");
  if (!from || !to || !messageSid) return null;
  return { from, to, body, messageSid };
}

// ── Org resolution ───────────────────────────────────────────────────────

export type ResolvedTwilioOrg = { orgId: string; authToken: string };

export type OrgResolutionResult =
  | { status: "resolved"; org: ResolvedTwilioOrg }
  | { status: "no_match" }
  | { status: "ambiguous"; matchCount: number }
  | { status: "missing_credentials"; orgId: string };

/**
 * The inbound `To` number determines the owning org — server-side only,
 * scanning `organizations.integration_settings.twilio.phoneNumber` (the
 * same live convention marketing-sms-inbound.ts already uses; no
 * dedicated phone->org table exists to query instead). An org id is never
 * accepted from the request itself. Fails closed on every uncertain case:
 * zero matches, more than one match (ambiguous — this branch's own
 * addition; the ported original silently picked the first match via
 * `.find()`, which this deliberately does NOT reproduce), or a matched org
 * with an incomplete Twilio credential (no authToken configured, so its
 * signature could never be verified anyway).
 */
export async function resolveOwningOrgForTwilioNumber(supabase: SupabaseClient, toNumber: string): Promise<OrgResolutionResult> {
  const toDigits = normalizePhone(toNumber);
  const { data: orgs, error } = await supabase.from("organizations").select("id, integration_settings");
  if (error) {
    console.error("[twilio-sms-inbound] org scan failed:", error.message);
    return { status: "no_match" };
  }
  const matches = (orgs ?? []).filter((o: any) => {
    const num = o.integration_settings?.twilio?.phoneNumber;
    return !!num && normalizePhone(num) === toDigits;
  });
  if (matches.length === 0) return { status: "no_match" };
  if (matches.length > 1) {
    // Never log the phone number itself alongside this — see this file's
    // "never log PII" rule below.
    console.error("[twilio-sms-inbound] receiving number matched more than one org — failing closed.", { matchCount: matches.length });
    return { status: "ambiguous", matchCount: matches.length };
  }
  const org = matches[0];
  const authToken: string | undefined = org.integration_settings?.twilio?.authToken;
  if (!authToken) return { status: "missing_credentials", orgId: org.id };
  return { status: "resolved", org: { orgId: org.id, authToken } };
}

// ── Contact + open-lead resolution (read-only — never creates either) ───

export type ResolvedContactAndLead = { contactId: string | null; leadId: string | null };

export async function resolveContactAndOpenLead(supabase: SupabaseClient, orgId: string, fromNumber: string): Promise<ResolvedContactAndLead> {
  const fromDigits = normalizePhone(fromNumber);
  const { data: contacts, error: contactsError } = await supabase
    .from("contacts")
    .select("id, phone")
    .eq("org_id", orgId)
    .not("phone", "is", null);
  if (contactsError) {
    console.error("[twilio-sms-inbound] contact scan failed:", contactsError.message);
  }
  const matchedContact = (contacts ?? []).find((c: any) => c.phone && normalizePhone(c.phone) === fromDigits);
  const contactId: string | null = matchedContact?.id ?? null;
  if (!contactId) return { contactId: null, leadId: null };

  const { data: leads, error: leadsError } = await supabase
    .from("leads")
    .select("id, status, created_at")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false });
  if (leadsError) {
    console.error("[twilio-sms-inbound] lead scan failed:", leadsError.message);
  }
  const leadId: string | null = (leads ?? []).find((l: any) => ACTIVE_LEAD_STATUSES.has(l.status))?.id ?? null;
  return { contactId, leadId };
}

// ── Message persistence (also the atomic Twilio-retry dedupe guard) ─────

export type PersistInboundSmsParams = { orgId: string; contactId: string | null; body: string; from: string; messageSid: string };
export type PersistInboundSmsResult = { status: "inserted"; id: string } | { status: "duplicate" } | { status: "error" };

/**
 * Persists exactly once. A 23505 (unique-violation) on
 * (org_id, provider_message_id) — see this file's header's DEDUPE section
 * for the migration this depends on — means Twilio already delivered this
 * exact MessageSid; callers must treat that as a safe no-op, never a
 * reason to dispatch AI again. Never logs the SMS body or the raw phone
 * number on error — see this file's footer rule.
 */
export async function persistInboundSms(supabase: SupabaseClient, params: PersistInboundSmsParams): Promise<PersistInboundSmsResult> {
  const { data, error } = await supabase
    .from("sms_meta_messages")
    .insert({
      org_id: params.orgId,
      contact_id: params.contactId,
      channel: "sms",
      direction: "in",
      body: params.body,
      from_address: params.from,
      provider_message_id: params.messageSid,
    })
    .select("id")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return { status: "duplicate" };
    console.error("[twilio-sms-inbound] inbound message insert failed:", error.message);
    return { status: "error" };
  }
  return { status: "inserted", id: data.id as string };
}

// ── The orchestrating core ───────────────────────────────────────────────

export type ProcessTwilioInboundSmsDeps = {
  supabase: SupabaseClient;
  /** Injected for testability — defaults to the real HTTP dispatch in the
   * real handler (lead-created-hook.ts's dispatchLeadQualificationBackground). */
  dispatchLeadQualificationBackground: (payload: LeadQualificationBackgroundPayload) => Promise<boolean>;
};

export type ProcessTwilioInboundSmsParams = {
  rawBody: string | null | undefined;
  signatureHeader: string | undefined;
  /** The externally-visible full URL Twilio actually called — see
   * twilio-signature.ts's reconstructRequestUrl() for how the handler
   * builds this. Passed in rather than reconstructed here so this core
   * stays free of any HTTP-event-shape dependency. */
  fullUrl: string;
};

export type ProcessTwilioInboundSmsResult =
  | { outcome: "ignored_non_twilio_payload" }
  | { outcome: "org_not_found" }
  | { outcome: "org_ambiguous" }
  | { outcome: "org_missing_credentials"; orgId: string }
  | { outcome: "invalid_signature"; orgId: string }
  | { outcome: "duplicate_delivery" }
  | { outcome: "persist_failed" }
  | { outcome: "stop"; orgId: string; contactId: string | null }
  | { outcome: "start"; orgId: string; contactId: string | null }
  | { outcome: "help"; orgId: string; contactId: string | null }
  | { outcome: "no_contact" }
  | { outcome: "no_open_lead"; contactId: string }
  | { outcome: "dispatched"; orgId: string; contactId: string; leadId: string; messageRowId: string };

export async function processTwilioInboundSms(
  params: ProcessTwilioInboundSmsParams,
  deps: ProcessTwilioInboundSmsDeps,
): Promise<ProcessTwilioInboundSmsResult> {
  const form = parseTwilioInboundForm(params.rawBody);
  if (!form) return { outcome: "ignored_non_twilio_payload" };

  const orgResolution = await resolveOwningOrgForTwilioNumber(deps.supabase, form.to);
  if (orgResolution.status === "no_match") return { outcome: "org_not_found" };
  if (orgResolution.status === "ambiguous") return { outcome: "org_ambiguous" };
  if (orgResolution.status === "missing_credentials") return { outcome: "org_missing_credentials", orgId: orgResolution.orgId };

  const { orgId, authToken } = orgResolution.org;

  // Signature verification — the ONLY thing that turns "a request that
  // claims to be Twilio" into a trusted one. Computed with the RESOLVED
  // org's own authToken, never a global/env secret. Twilio's algorithm
  // signs the FULL set of posted form params (not just the 4 this file
  // extracts above), so the raw body is re-parsed here rather than reusing
  // `form`'s narrower shape.
  const allParams = new URLSearchParams(params.rawBody ?? "");
  const validSignature = verifyTwilioSignature(authToken, params.fullUrl, allParams, params.signatureHeader);
  if (!validSignature) return { outcome: "invalid_signature", orgId };

  const { contactId, leadId } = await resolveContactAndOpenLead(deps.supabase, orgId, form.from);

  const persistResult = await persistInboundSms(deps.supabase, { orgId, contactId, body: form.body, from: form.from, messageSid: form.messageSid });
  if (persistResult.status === "duplicate") return { outcome: "duplicate_delivery" };
  if (persistResult.status === "error") return { outcome: "persist_failed" };

  // ── Compliance keyword (AI-3K) — checked BEFORE any contact/lead-based
  // AI dispatch decision. Never reaches dispatchLeadQualificationBackground()
  // for any of the three outcomes below — see this file's header. ───────
  const complianceIntent = classifySmsComplianceMessage(form.body);
  if (complianceIntent === "stop") {
    if (contactId) {
      await processStopKeyword(deps.supabase, orgId, contactId);
    } else {
      console.warn("[twilio-sms-inbound] STOP from unmatched number for org", orgId);
    }
    return { outcome: "stop", orgId, contactId };
  }
  if (complianceIntent === "start") {
    if (contactId) {
      await processStartKeyword(deps.supabase, orgId, contactId);
    } else {
      console.warn("[twilio-sms-inbound] START from unmatched number for org", orgId);
    }
    // No confirmation SMS is sent — matches STOP's existing silent
    // behavior (no outbound reply for either), same as the ported
    // original.
    return { outcome: "start", orgId, contactId };
  }
  if (complianceIntent === "help") {
    if (!contactId) {
      console.warn("[twilio-sms-inbound] HELP from unmatched number for org", orgId);
    }
    await sendHelpReplyIfConfigured(deps.supabase, orgId, persistResult.id, form.from, contactId);
    return { outcome: "help", orgId, contactId };
  }

  if (!contactId) {
    console.warn("[twilio-sms-inbound] no CRM contact matched sender for org", orgId, "— message persisted, AI not dispatched.");
    return { outcome: "no_contact" };
  }
  if (!leadId) {
    console.warn("[twilio-sms-inbound] no open lead for matched contact, org", orgId, "— message persisted, AI not dispatched.");
    return { outcome: "no_open_lead", contactId };
  }

  const candidate: InboundTriggerCandidate = { channel: "sms", direction: "in", syncOrigin: "live" };
  if (!isLiveTriggerEligible(candidate)) {
    // Defensive only — "sms" is always eligible per lead-trigger.ts's
    // LIVE_TRIGGER_CHANNELS today; this guards against that set silently
    // changing underneath this file without updating it to match.
    console.warn("[twilio-sms-inbound] sms is not currently a live-trigger-eligible channel — message persisted, AI not dispatched.");
    return { outcome: "no_open_lead", contactId };
  }

  // Fire-and-forget, same contract as lead-created-hook.ts's own
  // fireLeadCreatedTrigger(): never throws, never meaningfully delays the
  // caller. The inbound message is ALREADY safely persisted above by the
  // time this runs.
  await deps.dispatchLeadQualificationBackground({
    orgId,
    leadId,
    contactId,
    source: "inbound_lead_message",
    inboundEvent: {
      channel: "sms",
      messageRowId: persistResult.id,
      text: form.body,
      externalMessageId: form.messageSid,
      candidate,
    },
  });

  return { outcome: "dispatched", orgId, contactId, leadId, messageRowId: persistResult.id };
}
