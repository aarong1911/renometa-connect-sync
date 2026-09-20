// src/lib/agentic/sms-transport.ts
//
// AI-2C.1. Low-level, trusted Twilio SMS transport — extracted from
// handlers.ts's sendSms() so it can be reused by a second caller (the
// deterministic HELP compliance reply, netlify/functions/lib/sms-
// compliance.ts) without duplicating the Twilio REST call. This module
// does NOT check emergency pause, consent, approval, or autonomy — those
// are the CALLER's responsibility, and the two current callers apply
// different rules deliberately:
//   - handlers.ts's sendSms() (the Gen-2 send_sms action handler) is only
//     ever reached after executeStep()/executeApprovedStep() has already
//     enforced emergency pause, consent, and approval.
//   - lib/sms-compliance.ts's HELP reply sender applies its OWN, narrower
//     compliance-specific check (suppressed-only block — see that file)
//     because a deterministic compliance/support reply is not a marketing
//     action and must not be gated by marketing eligibility semantics.
// Never call this directly from model/agent code, an AI Tool, or any
// orchestrator path — see the channel-integrations skill's "provider
// calls happen through trusted server-side action handlers" rule.

import type { SupabaseClient } from "@supabase/supabase-js";

export type SendTwilioSmsResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; error: string };

function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  return raw.startsWith("+") ? raw : `+${digits}`;
}

/**
 * Sends one SMS via the org's own configured Twilio credentials
 * (organizations.integration_settings.twilio — the same per-org
 * credential convention send-inbox-message.ts already uses). Pure
 * transport: no persistence, no consent/pause/approval check, no
 * idempotency. `toPhone` must already be a trusted destination (resolved
 * server-side by the caller — this function never resolves a recipient
 * itself).
 */
export async function sendTwilioSms(
  supabase: SupabaseClient,
  orgId: string,
  toPhone: string,
  body: string,
): Promise<SendTwilioSmsResult> {
  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("integration_settings")
    .eq("id", orgId)
    .maybeSingle();
  if (orgError) return { ok: false, error: "Could not load organization settings." };

  const twilio = (org?.integration_settings as { twilio?: { accountSid?: string; authToken?: string; phoneNumber?: string } } | null)?.twilio;
  if (!twilio?.accountSid || !twilio?.authToken || !twilio?.phoneNumber) {
    return { ok: false, error: "Twilio is not configured for this organization." };
  }

  try {
    const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: toE164(twilio.phoneNumber), To: toE164(toPhone), Body: body }).toString(),
    });
    if (!res.ok) {
      const errBody: any = await res.json().catch(() => ({}));
      console.error("[sms-transport] Twilio send failed:", res.status, errBody?.code, errBody?.message);
      return { ok: false, error: "Could not send the SMS." };
    }
    const twilioResult: any = await res.json().catch(() => ({}));
    return { ok: true, providerMessageId: twilioResult?.sid ?? null };
  } catch (err) {
    console.error("[sms-transport] Twilio send threw:", err);
    return { ok: false, error: "Could not send the SMS." };
  }
}
