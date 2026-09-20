// src/lib/agentic/whatsapp-transport.ts
//
// AI-2E. Low-level, trusted WhatsApp transport — the WhatsApp counterpart
// to sms-transport.ts's sendTwilioSms(). Extracted from send-inbox-
// message.ts's WhatsApp branch (see that file for the full connection-
// resolution / token-decrypt / 24-hour-session / template-fallback logic
// this reuses only the connection-resolution and token-decrypt half of).
//
// This module does NOT check emergency pause, consent/eligibility,
// approval, autonomy, or the 24-hour session window — those are the
// CALLER's responsibility (per channel-integrations skill: "the transport
// helper should accept trusted provider connection context, send, return
// provider message id, not decide policy/consent/approval"). For AI-2E's
// one caller (handlers.ts's sendWhatsapp, reached only through
// executeStep()/executeApprovedStep()), the 24-hour window is already
// enforced upstream by action-executor.ts's checkOutboundConsent() WhatsApp
// branch, which blocks the action entirely before this function is ever
// called if no open reactive conversation window exists — so this
// function ONLY ever sends `type: "text"` (free-form), matching AI-2E's
// explicit scope ("prefer ONLY reactive free-form replies... do NOT add
// proactive template-message automation"). It deliberately does not carry
// send-inbox-message.ts's template-fallback branch at all — a future
// phase that wants AI-generated proactive/template WhatsApp sends should
// extend this transport (or add a sibling function) once that policy
// question has been deliberately decided, not inherit it silently from
// here.
//
// Never call this directly from model/agent code, an AI Tool, or any
// orchestrator path — see the channel-integrations skill's "provider
// calls happen through trusted server-side action handlers" rule.

import type { SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

export type SendWhatsAppTextResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; error: string };

/** Matches the encrypt half in meta-oauth-callback.ts — "enc:" +
 * base64(iv||tag||ciphertext). Legacy rows from before this scheme
 * shipped may be bare plaintext with no prefix — see meta-integrations
 * skill. Identical to send-inbox-message.ts's own decryptOrPlaintext();
 * duplicated here (not imported) to keep this module's dependency surface
 * small and self-contained, same reasoning sms-transport.ts already
 * applies to its own toE164 helper. */
function decryptOrPlaintext(stored: string): string {
  if (!stored.startsWith("enc:")) return stored;
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) throw new Error("ENCRYPTION_KEY env var is not set — cannot decrypt Meta token");
  const raw = Buffer.from(stored.slice(4), "base64");
  const key = crypto.createHash("sha256").update(encKey).digest();
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Graph API's `to` field wants bare digits (no leading "+") — same
 * normalization send-inbox-message.ts already applies before its own
 * WhatsApp send. */
function toWhatsAppDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `1${digits}`;
  return digits;
}

/**
 * Sends one free-form WhatsApp text message via the org's own connected
 * WhatsApp Business Account (meta_connections, product="whatsapp"). Pure
 * transport: no persistence, no consent/pause/approval/session-window
 * check, no idempotency. `toPhone` must already be a trusted destination
 * (resolved server-side by the caller — this function never resolves a
 * recipient itself, and never accepts a phone number or connection id
 * from a model/request).
 */
export async function sendWhatsAppText(
  supabase: SupabaseClient,
  orgId: string,
  toPhone: string,
  body: string,
): Promise<SendWhatsAppTextResult> {
  const { data: conn, error: connError } = await supabase
    .from("meta_connections")
    .select("waba_phone_number_id, access_token")
    .eq("org_id", orgId)
    .eq("product", "whatsapp")
    .maybeSingle();
  if (connError) return { ok: false, error: "Could not load WhatsApp connection." };
  if (!conn?.access_token || !conn.waba_phone_number_id) {
    return { ok: false, error: "WhatsApp is not connected for this organization." };
  }

  let accessToken: string;
  try {
    accessToken = decryptOrPlaintext(conn.access_token as string);
  } catch (err) {
    console.error("[whatsapp-transport] token decrypt failed:", err);
    return { ok: false, error: "Could not read stored WhatsApp credentials." };
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${conn.waba_phone_number_id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toWhatsAppDigits(toPhone),
        type: "text",
        text: { body },
      }),
    });
    if (!res.ok) {
      const errBody: any = await res.json().catch(() => ({}));
      console.error("[whatsapp-transport] send failed:", res.status, errBody?.error?.code, errBody?.error?.message);
      return { ok: false, error: "Could not send the WhatsApp message." };
    }
    const result: any = await res.json().catch(() => ({}));
    return { ok: true, providerMessageId: result?.messages?.[0]?.id ?? null };
  } catch (err) {
    console.error("[whatsapp-transport] send threw:", err);
    return { ok: false, error: "Could not send the WhatsApp message." };
  }
}
