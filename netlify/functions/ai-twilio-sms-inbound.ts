/// <reference types="node" />
// netlify/functions/ai-twilio-sms-inbound.ts
//
// AI-2A — Twilio SMS inbound integration into AI Center.
//
//   Twilio inbound SMS
//     -> signature validation (this file — NEW, see lib/twilio-signature.ts)
//     -> org resolution (this file, reusing marketing-sms-inbound.ts's
//        integration_settings.twilio.phoneNumber scan)
//     -> contact/lead resolution (this file, read-only, no creation)
//     -> inbound message persisted to sms_meta_messages (this file — the
//        SAME table context-builder.ts already reads conversation history
//        from, and the SAME table send-inbox-message.ts already writes
//        outbound SMS to; NOT a new store) — this also IS the atomic
//        Twilio-retry dedupe guard (see DEDUPE below)
//     -> compliance-keyword check (STOP/etc — see lib/sms-compliance.ts):
//        if matched, update consent and STOP here — no AI dispatch, ever
//     -> otherwise: AI orchestration dispatched to a Netlify BACKGROUND
//        function (ai-twilio-sms-orchestrate-background.ts) — see WHY
//        ASYNC below — but ONLY if a real CRM contact was resolved (see
//        UNMATCHED CONTACT below)
//     -> empty TwiML response
//
// This file is deliberately THIN: it owns transport (Twilio-facing HTTP,
// signature verification, org/contact/lead resolution, message
// persistence, retry dedupe, compliance-keyword short-circuit) and
// nothing about AI reasoning, routing, or tool execution — all of that
// stays in lib/ai/orchestrator.ts and the Gen-2 action-executor.ts, called
// only from the background function. Twilio is transport; it is never the
// orchestrator (see the ai-center skill).
//
// ── AI-2A CORRECTION PASS: ONE CANONICAL INBOUND ENTRYPOINT ─────────────
//
// This file is now the SINGLE canonical inbound SMS webhook — the one URL
// an operator points a Twilio number's "A message comes in" webhook at.
// It fully subsumes marketing-sms-inbound.ts's job (STOP handling, via
// the SAME shared lib/sms-compliance.ts logic that file now also calls)
// plus signature verification, general inbound persistence, and AI
// dispatch, which marketing-sms-inbound.ts never had. That file is left
// in place (unmodified in behavior) only for backward compatibility with
// any number still pointed at it — see its own header for the
// deprecation note. Never point a Twilio number at BOTH URLs.
//
// ── COMPLIANCE KEYWORDS PROCESSED BEFORE AI, UNCONDITIONALLY ────────────
//
// AI-2C: a STOP/START/HELP-family message NEVER reaches AI dispatch —
// structurally, not just by convention: each compliance branch below
// returns before dispatchBackgroundOrchestration() is ever called, so
// there is no code path from a recognized compliance keyword to "AI
// execution created" or "send_sms approval proposed." Classification is
// centralized in lib/sms-compliance.ts's classifySmsComplianceMessage() —
// see that file's header for the exact keyword sets and the evidence that
// Twilio is not already intercepting these at the platform level for this
// number. HELP is classified (and kept out of AI) but does not yet send a
// deterministic reply — see the "help" branch below for why.
//
// ── UNMATCHED CONTACT: NO AI DISPATCH AT ALL ─────────────────────────────
//
// When no CRM contact matches the inbound sender's phone number, the
// message is still persisted (for a human operator/future contact match
// to find later) but AI orchestration is never dispatched at all — not
// "dispatched but told not to reply." This avoids spending a model call
// on a sender the system has no trusted way to reply to anyway (a
// send_sms proposal would need a contactId to bind to, which doesn't
// exist here), and per this task's explicit instruction not to invent
// contact/lead auto-creation.
//
// ── WHY ASYNC (webhook timeout vs. LLM latency) ─────────────────────────
//
// A Lead Qualification turn can make TWO sequential model calls (decision,
// then a final response after a tool executes — see orchestrator.ts's
// runLeadQualificationTurn()), each a real network round trip to
// Anthropic. Twilio's own webhook timeout is ~15 seconds, and this repo's
// Netlify plan has no documented function-timeout override (netlify.toml
// sets no [functions] timeout at all). Running orchestrateAI() +
// executeStep() synchronously inside THIS webhook risks Twilio treating a
// slow response as a failure and retrying — which, combined with a
// same-conversation AI run already in flight, is exactly the "duplicate
// reply" failure mode this task explicitly guards against.
//
// This repo has no existing generic queue/event-bus (confirmed by
// research before this pass) — its only two async-dispatch precedents are
// marketing-campaign-process-queue.ts and appointment-reminder-sms.ts,
// both SCHEDULED functions polling every 5 minutes, which is far too slow
// for a conversational SMS reply. Netlify BACKGROUND functions (any
// function file ending in `-background`, a documented, zero-extra-config
// Netlify platform feature — not something invented for this repo) are
// the right fit instead: Netlify returns 202 to the caller immediately and
// keeps running the function server-side for up to 15 minutes. This is
// the FIRST background function in this repo (as opposed to a scheduled
// one) — flagged explicitly in this task's report as a new pattern, not
// silently introduced.
//
// The inbound message row (sms_meta_messages) and the retry-dedupe guard
// are both fully committed BEFORE the background function is even
// invoked, so a slow/failed AI run can never cause the customer's
// original message to go unrecorded, and a Twilio retry of the SAME
// delivery can never re-dispatch AI a second time (see DEDUPE below).

import type { Handler, HandlerEvent } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { normalizePhone } from "../../src/lib/phone";
import { verifyTwilioSignature, reconstructRequestUrl } from "./lib/twilio-signature";
import { classifySmsComplianceMessage, processStopKeyword, processStartKeyword } from "./lib/sms-compliance";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const EMPTY_TWIML = { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: "<Response></Response>" };
const FORBIDDEN = { statusCode: 403, headers: { "Content-Type": "text/plain" }, body: "" };

/** Lead statuses treated as "open" — matches router.ts's ACTIVE_LEAD_STATUSES
 * exactly (inlined here, same reasoning as that file: keep this function's
 * dependency surface small rather than importing from the router). */
const ACTIVE_LEAD_STATUSES = new Set(["new", "contacted", "qualified"]);

async function dispatchBackgroundOrchestration(payload: {
  orgId: string;
  contactId: string | null;
  leadId: string | null;
  phone: string;
  body: string;
  messageSid: string;
  inboundMessageId: string;
}): Promise<void> {
  const secret = process.env.AI_SMS_INTERNAL_DISPATCH_SECRET;
  if (!secret) {
    console.error("[ai-twilio-sms-inbound] AI_SMS_INTERNAL_DISPATCH_SECRET is not set — cannot dispatch AI orchestration.");
    return;
  }
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;
  if (!siteUrl) {
    console.error("[ai-twilio-sms-inbound] No site URL available (URL/DEPLOY_URL env var) — cannot dispatch AI orchestration.");
    return;
  }
  try {
    const res = await fetch(`${siteUrl}/.netlify/functions/ai-twilio-sms-orchestrate-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": secret },
      body: JSON.stringify(payload),
    });
    // Background functions return 202 immediately — anything else means
    // the dispatch itself failed (routing/auth), not that AI failed.
    if (res.status !== 202) {
      console.error("[ai-twilio-sms-inbound] background dispatch did not return 202:", res.status);
    }
  } catch (err) {
    console.error("[ai-twilio-sms-inbound] background dispatch failed:", err);
  }
}

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== "POST") return EMPTY_TWIML;

  const params = new URLSearchParams(event.body ?? "");
  const from = params.get("From");
  const to = params.get("To");
  const body = (params.get("Body") ?? "").trim();
  const messageSid = params.get("MessageSid");

  if (!from || !to || !messageSid) {
    // Not a recognizable Twilio SMS payload — nothing safe to do with it.
    return EMPTY_TWIML;
  }

  try {
    // ── Org resolution (untrusted `to` selects WHICH org's authToken to
    // try — trust is only established once that org's signature check
    // passes below, never before). Reuses the exact scan pattern already
    // proven live by marketing-sms-inbound.ts; no dedicated phone->org
    // table exists to query instead. ─────────────────────────────────────
    const toDigits = normalizePhone(to);
    const { data: orgs, error: orgsError } = await supabaseAdmin
      .from("organizations")
      .select("id, integration_settings");
    if (orgsError) {
      console.error("[ai-twilio-sms-inbound] org scan failed:", orgsError);
      return EMPTY_TWIML;
    }
    const owningOrg = (orgs ?? []).find((o: any) => {
      const num = o.integration_settings?.twilio?.phoneNumber;
      return num && normalizePhone(num) === toDigits;
    });
    if (!owningOrg) {
      console.warn("[ai-twilio-sms-inbound] no org owns Twilio number", to);
      return EMPTY_TWIML;
    }

    const authToken: string | undefined = owningOrg.integration_settings?.twilio?.authToken;
    if (!authToken) {
      console.error("[ai-twilio-sms-inbound] org", owningOrg.id, "has a Twilio number but no authToken configured — cannot verify signature, refusing.");
      return FORBIDDEN;
    }

    // ── Signature validation — the ONLY thing that turns "a request that
    // claims to be Twilio" into a trusted one. See lib/twilio-signature.ts
    // for the exact algorithm and why the reconstructed URL must match the
    // Twilio Console's configured webhook URL byte-for-byte. ────────────
    const fullUrl = reconstructRequestUrl(event as any);
    const signatureHeader = event.headers["x-twilio-signature"] ?? event.headers["X-Twilio-Signature"];
    const validSignature = verifyTwilioSignature(authToken, fullUrl, params, signatureHeader);
    if (!validSignature) {
      console.error("[ai-twilio-sms-inbound] invalid Twilio signature for org", owningOrg.id, "url", fullUrl);
      return FORBIDDEN;
    }

    // ── Contact resolution (read-only — no contact/lead creation; see
    // this task's explicit instruction not to invent CRM-creation
    // behavior). Reuses marketing-sms-inbound.ts's per-org scan pattern,
    // using the canonical src/lib/phone.ts normalizer instead of a fourth
    // local duplicate. ───────────────────────────────────────────────────
    const fromDigits = normalizePhone(from);
    const { data: contacts, error: contactsError } = await supabaseAdmin
      .from("contacts")
      .select("id, phone")
      .eq("org_id", owningOrg.id)
      .not("phone", "is", null);
    if (contactsError) {
      console.error("[ai-twilio-sms-inbound] contact scan failed:", contactsError);
    }
    const matchedContact = (contacts ?? []).find((c: any) => c.phone && normalizePhone(c.phone) === fromDigits);
    const contactId: string | null = matchedContact?.id ?? null;

    let leadId: string | null = null;
    if (contactId) {
      const { data: leads } = await supabaseAdmin
        .from("leads")
        .select("id, status, created_at")
        .eq("org_id", owningOrg.id)
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false });
      leadId = (leads ?? []).find((l: any) => ACTIVE_LEAD_STATUSES.has(l.status))?.id ?? null;
    }

    // ── Persist the inbound message FIRST — this is also the atomic
    // retry-dedupe guard (see supabase/migrations/
    // 20260915_sms_meta_messages_dedupe.sql's unique index on
    // (org_id, provider_message_id)). A unique-violation here means Twilio
    // already delivered this exact MessageSid once — return success
    // immediately without dispatching AI a second time. ──────────────────
    const { data: inboundRow, error: insertError } = await supabaseAdmin
      .from("sms_meta_messages")
      .insert({
        org_id: owningOrg.id,
        contact_id: contactId,
        channel: "sms",
        direction: "in",
        body,
        from_address: from,
        provider_message_id: messageSid,
      })
      .select("id")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        // Duplicate delivery of an already-processed MessageSid — a Twilio
        // retry. Already persisted, AI already dispatched once. No-op.
        return EMPTY_TWIML;
      }
      console.error("[ai-twilio-sms-inbound] inbound message insert failed:", insertError);
      // Persistence failed for a reason OTHER than the dedupe guard — do
      // not dispatch AI against an unrecorded message; still return
      // success to Twilio (a raw 5xx would just cause Twilio to retry
      // against the same failure).
      return EMPTY_TWIML;
    }

    // ── Compliance keyword — processed BEFORE any AI dispatch, and
    // structurally exclusive of it (see this file's header). Covers
    // STOP/START/HELP via one deterministic classifier
    // (lib/sms-compliance.ts) — none of the three branches below ever
    // calls dispatchBackgroundOrchestration(). ──────────────────────────
    const complianceIntent = classifySmsComplianceMessage(body);

    if (complianceIntent === "stop") {
      if (contactId) {
        await processStopKeyword(supabaseAdmin, owningOrg.id, contactId);
      } else {
        console.warn("[ai-twilio-sms-inbound] STOP from unmatched number for org", owningOrg.id);
      }
      return EMPTY_TWIML;
    }

    if (complianceIntent === "start") {
      if (contactId) {
        await processStartKeyword(supabaseAdmin, owningOrg.id, contactId);
      } else {
        console.warn("[ai-twilio-sms-inbound] START from unmatched number for org", owningOrg.id);
      }
      // No confirmation SMS is sent — matches STOP's existing silent
      // behavior in this app (no outbound reply for either). If a
      // customer-facing confirmation is wanted later, it needs the same
      // trusted-transport/persistence/idempotency treatment as any other
      // outbound send — not added speculatively here.
      return EMPTY_TWIML;
    }

    if (complianceIntent === "help") {
      // AI-2C: classification only. Deliberately NOT sending a
      // deterministic HELP reply in this pass — there is no authoritative,
      // per-org-configured SMS support/help text anywhere in the current
      // schema (organizations.phone is general business contact info, not
      // something any org has explicitly designated as an SMS compliance
      // support line), and this task's own instruction is to stop rather
      // than invent support contact info or compliance copy. The hard
      // requirement — HELP must never reach the AI model or create an
      // execution/approval — is fully satisfied by returning here. See
      // the AI-2C report for the exact product/config decision needed
      // before a real HELP reply can be added.
      if (!contactId) {
        console.warn("[ai-twilio-sms-inbound] HELP from unmatched number for org", owningOrg.id);
      }
      return EMPTY_TWIML;
    }

    // ── Unmatched sender — persisted above, but no AI dispatch at all
    // (see this file's header "UNMATCHED CONTACT"). ──────────────────────
    if (!contactId) {
      console.warn("[ai-twilio-sms-inbound] no CRM contact matched sender", from, "for org", owningOrg.id, "— message persisted, AI not dispatched.");
      return EMPTY_TWIML;
    }

    await dispatchBackgroundOrchestration({
      orgId: owningOrg.id,
      contactId,
      leadId,
      phone: from,
      body,
      messageSid,
      inboundMessageId: inboundRow.id,
    });
  } catch (err) {
    console.error("[ai-twilio-sms-inbound] unexpected error:", err);
    // Never surface an internal error to Twilio as a customer-facing
    // failure — the inbound message may or may not be persisted at this
    // point, but returning anything other than a clean TwiML response
    // only risks a Twilio retry storm.
  }

  return EMPTY_TWIML;
};
