/// <reference types="node" />
// netlify/functions/ai-whatsapp-orchestrate-background.ts
//
// AI-2E. The WhatsApp counterpart to ai-twilio-sms-orchestrate-
// background.ts — the actual AI reasoning + reply-proposal step for an
// inbound WhatsApp message, dispatched (fire-and-forget) by
// meta-webhook.ts's WhatsApp branch once the inbound message is safely
// persisted/deduped. A Netlify BACKGROUND function (filename suffix
// "-background" — same platform convention the SMS pipeline already
// uses: returns 202 immediately, keeps running up to 15 minutes).
//
// AI-2E TESTABILITY REFACTOR: this handler is now THIN by design — it owns
// only the HTTP-level/trust-boundary concerns (internal-secret
// verification, payload parsing/shape validation, constructing the REAL
// service-role admin client, returning the right status code). All actual
// WhatsApp orchestration logic (claim, contact re-verification,
// orchestrateAI() call, send_whatsapp proposal, Run Inspector linkage)
// moved to lib/meta-whatsapp-background.ts's processWhatsAppBackground(),
// a dependency-injected function that can be exercised in an automated
// test against scripts/fake-supabase-client.mjs + a mocked orchestrator —
// see that file's header for why. No behavior change from the previous,
// inline version of this handler.
//
// ── AI-2E SCOPE: ALWAYS APPROVAL-REQUIRED ────────────────────────────────
//
// Unlike SMS (which has AI-2D's Review/Automatic setting), WhatsApp has NO
// automatic-send mode in this phase — see processWhatsAppBackground()'s own
// header for the full reasoning (`trustedProposal: true` only ever reaches
// the approval-creation branch, never an auto-send).
//
// ── TRUST BOUNDARY FOR THIS ENDPOINT ─────────────────────────────────────
//
// Netlify background functions are still reachable at a public URL. This
// endpoint is NOT meant to be called by anything other than
// meta-webhook.ts, so it requires a shared-secret header (X-Internal-
// Secret, matched against AI_WHATSAPP_INTERNAL_DISPATCH_SECRET, compared
// timing-safely) — a SEPARATE secret from SMS's
// AI_SMS_INTERNAL_DISPATCH_SECRET, deliberately, to keep the two channels'
// trust boundaries independent (a leak of one secret does not grant
// dispatch access to the other channel's pipeline). orgId/contactId in the
// body are additionally independently re-verified inside
// processWhatsAppBackground() even though they originate from our own
// webhook.
//
// ── DURABLE DEDUPE FOR THIS FUNCTION ITSELF ──────────────────────────────
//
// See lib/meta-whatsapp-background.ts's claimForAiDispatch() — the same
// small, durable, atomic claim (`meta` jsonb, conditional UPDATE only
// succeeding when still null) ai-twilio-sms-orchestrate-background.ts uses
// on the SAME sms_meta_messages row, protecting against Netlify's own
// infrastructure (or a network retry) invoking this background function a
// second time for the same dispatch.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { processWhatsAppBackground, isValidWhatsAppBackgroundPayload } from "./lib/meta-whatsapp-background";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function secretsMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  try {
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "" };

  const expectedSecret = process.env.AI_WHATSAPP_INTERNAL_DISPATCH_SECRET;
  const providedSecret = event.headers["x-internal-secret"] ?? event.headers["X-Internal-Secret"];
  if (!expectedSecret || !providedSecret || !secretsMatch(expectedSecret, providedSecret)) {
    console.error("[ai-whatsapp-orchestrate-background] rejected request with missing/invalid internal secret.");
    return { statusCode: 403, body: "" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, body: "" };
  }
  if (!isValidWhatsAppBackgroundPayload(payload)) {
    console.error("[ai-whatsapp-orchestrate-background] malformed payload.");
    return { statusCode: 400, body: "" };
  }

  const result = await processWhatsAppBackground(payload, { supabase: supabaseAdmin });
  return { statusCode: result.statusCode, body: "" };
};
