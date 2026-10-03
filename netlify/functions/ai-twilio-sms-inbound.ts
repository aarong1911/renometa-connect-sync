/// <reference types="node" />
// netlify/functions/ai-twilio-sms-inbound.ts
//
// AI-3I — the missing Twilio inbound SMS adapter for live Lead
// Qualification. Deliberately THIN: HTTP/transport only (parsing the
// Twilio form POST, reconstructing the externally-visible URL for
// signature verification, constructing the real service-role client, and
// the real dispatchLeadQualificationBackground HTTP call). All actual
// logic — org/contact/lead resolution, persistence/dedupe, eligibility,
// dispatch decision — lives in the injectable
// lib/twilio-sms-inbound.ts::processTwilioInboundSms(), unit-tested there
// against the fake Supabase client. Same split this repo already uses for
// meta-whatsapp-inbound.ts / meta-whatsapp-background.ts.
//
// See lib/twilio-sms-inbound.ts's own header for: the audit of prior
// Twilio-inbound work found on feat/ai-center-foundation (ported/adapted,
// not reinvented), the exact flow, the dedupe/migration status, and why
// AI dispatch goes through the EXISTING lead-qualification-background.ts
// endpoint (extended to accept source="inbound_lead_message") rather than
// a new background function.
//
// SECURITY: never trusts an orgId/contactId/leadId from the request body
// or query string — the org is resolved from the RECEIVING (`To`) number
// only, and the request is rejected (403) unless its Twilio signature
// verifies against THAT resolved org's own authToken. Never logs the SMS
// body, the raw From/To phone numbers, or any auth token/credential — only
// ids and outcome labels.
//
// RESPONSE: always returns promptly. AI work (when dispatched) runs in the
// EXISTING background function, never synchronously in this request — see
// lib/twilio-sms-inbound.ts's header for why.

import type { Handler, HandlerEvent } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { reconstructRequestUrl } from "./lib/twilio-signature";
import { processTwilioInboundSms } from "./lib/twilio-sms-inbound";
import { dispatchLeadQualificationBackground } from "./lib/ai/lead-created-hook";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const EMPTY_TWIML = { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: "<Response></Response>" };
const FORBIDDEN = { statusCode: 403, headers: { "Content-Type": "text/plain" }, body: "" };

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== "POST") return EMPTY_TWIML;

  try {
    const fullUrl = reconstructRequestUrl(event as any);
    const signatureHeader = event.headers["x-twilio-signature"] ?? event.headers["X-Twilio-Signature"];

    const result = await processTwilioInboundSms(
      { rawBody: event.body, signatureHeader, fullUrl },
      { supabase: supabaseAdmin, dispatchLeadQualificationBackground },
    );

    switch (result.outcome) {
      case "ignored_non_twilio_payload":
      case "org_not_found":
      case "duplicate_delivery":
      case "persist_failed":
      case "no_contact":
      case "no_open_lead":
      case "dispatched":
        return EMPTY_TWIML;
      case "org_ambiguous":
        console.error("[ai-twilio-sms-inbound] receiving number resolved to more than one org — refusing.");
        return FORBIDDEN;
      case "org_missing_credentials":
        console.error("[ai-twilio-sms-inbound] org", result.orgId, "has a Twilio number but no authToken configured — cannot verify signature, refusing.");
        return FORBIDDEN;
      case "invalid_signature":
        console.error("[ai-twilio-sms-inbound] invalid Twilio signature for org", result.orgId);
        return FORBIDDEN;
      default:
        return EMPTY_TWIML;
    }
  } catch (err) {
    console.error("[ai-twilio-sms-inbound] unexpected error:", err instanceof Error ? err.message : err);
    // Never surface an internal error to Twilio as a customer-facing
    // failure — a raw 5xx would just cause a Twilio retry against the
    // same failure. The inbound message may or may not be persisted at
    // this point; this is the same "always return cleanly" contract the
    // ported original (feat/ai-center-foundation) already established.
    return EMPTY_TWIML;
  }
};
