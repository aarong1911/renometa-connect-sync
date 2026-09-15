// netlify/functions/marketing-sms-inbound.ts
//
// Twilio inbound-SMS webhook — did NOT exist anywhere in this repo before
// Phase 14.1 (confirmed by audit: zero STOP/opt-out handling, no inbound
// Twilio webhook function). Point each org's Twilio number's "A message
// comes in" webhook (Twilio Console) at this function's URL to enable STOP
// handling for Campaigns sends.
//
// Twilio POSTs application/x-www-form-urlencoded with `From`/`To`/`Body`.
// This handler ONLY looks for the standard opt-out keywords (STOP,
// STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT — Twilio's own default list) as
// the entire message body and, on a match, sets sms_status = 'opted_out'
// in marketing_contact_preferences (the dedicated service-role-owned
// preference table — never a column on `contacts`, which ordinary
// authenticated CRM edits can freely write to) for the contact matching
// the sending phone number within the org that owns the receiving Twilio
// number. Anything else is a no-op (this is not a general inbound-SMS-to-
// Inbox pipeline — that would be a separate, larger feature).
//
// opted_out is terminal from THIS webhook's point of view: it only ever
// sets opted_out, never clears it back to 'eligible'/'unknown'. An
// opted-out contact must never become eligible again merely because their
// phone number is later edited on the contacts row — eligibility can only
// move forward again through the explicit trusted
// marketing-contact-preferences-set.ts path, which itself refuses to
// revert opted_out/suppressed (see that file).
//
// Responds with empty TwiML so Twilio does not also fire its own
// account-level auto-reply on top of this (both would otherwise send a
// confirmation).
//
// AI-2A CORRECTION PASS: netlify/functions/ai-twilio-sms-inbound.ts is now
// the canonical, signature-verified inbound SMS webhook — it processes
// this exact same STOP handling (via lib/sms-compliance.ts, extracted
// from this file so both call identical logic) BEFORE ever dispatching AI
// orchestration, then continues to normal inbound persistence/AI dispatch
// for non-compliance messages. This file is kept in place, UNCHANGED IN
// BEHAVIOR (still no signature validation, still STOP-only, still no
// general persistence), only for any Twilio number whose Console webhook
// might still point here. New/repointed numbers should use
// ai-twilio-sms-inbound.ts instead — see that file's own header. Not
// deleted in this pass: no live organization currently has Twilio
// configured at all (confirmed live before this pass), so nothing is
// actually broken by leaving it as a working, backward-compatible target,
// but it should be considered deprecated in favor of the canonical
// endpoint and removed once confirmed nothing points at it.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { isStopKeyword, processStopKeyword } from "./lib/sms-compliance";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const EMPTY_TWIML = { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: "<Response></Response>" };

function normalizeDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 && digits[0] === "1" ? digits.slice(1) : digits;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return EMPTY_TWIML;

  const params = new URLSearchParams(event.body ?? "");
  const from = params.get("From");
  const to = params.get("To");
  const body = params.get("Body") ?? "";

  if (!from || !to || !isStopKeyword(body)) {
    return EMPTY_TWIML;
  }

  try {
    // Find which org owns the receiving Twilio number (per-org credentials
    // live in organizations.integration_settings.twilio, same as
    // send-inbox-message.ts — there is no separate twilio_numbers table).
    const toDigits = normalizeDigits(to);
    const { data: orgs } = await supabaseAdmin
      .from("organizations")
      .select("id, integration_settings");
    const owningOrg = (orgs ?? []).find((o: any) => {
      const num = o.integration_settings?.twilio?.phoneNumber;
      return num && normalizeDigits(num) === toDigits;
    });
    if (!owningOrg) {
      console.warn("[marketing-sms-inbound] no org owns Twilio number", to);
      return EMPTY_TWIML;
    }

    const fromDigits = normalizeDigits(from);
    const { data: contacts } = await supabaseAdmin
      .from("contacts")
      .select("id, phone")
      .eq("org_id", owningOrg.id)
      .not("phone", "is", null);
    const matchedContact = (contacts ?? []).find((c: any) => c.phone && normalizeDigits(c.phone) === fromDigits);

    if (matchedContact) {
      await processStopKeyword(supabaseAdmin, owningOrg.id, matchedContact.id);
    } else {
      console.warn("[marketing-sms-inbound] STOP from unknown number for org", owningOrg.id);
    }
  } catch (err: any) {
    console.error("[marketing-sms-inbound]", err.message);
  }

  return EMPTY_TWIML;
};
