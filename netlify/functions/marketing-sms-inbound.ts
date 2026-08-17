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

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const STOP_KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);

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
  const body = (params.get("Body") ?? "").trim().toLowerCase();

  if (!from || !to || !STOP_KEYWORDS.has(body)) {
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
      await supabaseAdmin
        .from("marketing_contact_preferences")
        .upsert(
          { org_id: owningOrg.id, contact_id: matchedContact.id, sms_status: "opted_out", sms_status_updated_at: new Date().toISOString() },
          { onConflict: "contact_id" },
        );
    } else {
      console.warn("[marketing-sms-inbound] STOP from unknown number for org", owningOrg.id);
    }
  } catch (err: any) {
    console.error("[marketing-sms-inbound]", err.message);
  }

  return EMPTY_TWIML;
};
