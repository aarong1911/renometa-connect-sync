// netlify/functions/lib/meta-whatsapp-inbound.ts
//
// AI-2E TESTABILITY REFACTOR. Pure extraction, zero behavior change: the
// WhatsApp branch of meta-webhook.ts's processWhatsAppPayload() (plus its
// dispatchWhatsAppOrchestration() helper) moved here verbatim, with the
// previously-module-level `supabaseAdmin` (and the previously-hardcoded
// dispatch function) turned into explicit, dependency-injected parameters.
//
// WHY: meta-webhook.ts constructed its own internal supabaseAdmin client,
// which made it impossible to exercise this logic against
// scripts/fake-supabase-client.mjs in an automated test without either (a)
// writing to a real Supabase project (forbidden — see
// scripts/TEST_SAFETY_RULES.md) or (b) this exact kind of extraction. This
// file is that extraction and nothing more — no routing, no policy, no
// persistence-schema, no signature-verification-semantics change. The
// Netlify handler (meta-webhook.ts) still owns: constructing the REAL
// admin client, verifying the HTTP-level signature, and returning Meta's
// expected response — this file only ever receives an already-parsed,
// already-authenticated payload and a supabase client to use.
//
// Messenger and Instagram (processPagePayload /
// processMessengerOrInstagramPayload in meta-webhook.ts) are explicitly
// OUT OF SCOPE for this pass and remain untouched, in place, in
// meta-webhook.ts.

import type { SupabaseClient } from "@supabase/supabase-js";

export type WhatsAppDispatchPayload = {
  orgId: string;
  contactId: string;
  phone: string;
  body: string;
  providerMessageId: string;
  inboundMessageId: string;
};

/**
 * AI-2E. Fires the SAME internal-secret-protected background-dispatch
 * pattern ai-twilio-sms-inbound.ts already uses for SMS, with a WhatsApp-
 * specific secret/endpoint (see ai-whatsapp-orchestrate-background.ts's
 * header for why the secret is separate from SMS's). Never throws —
 * dispatch failures are logged only, since the inbound message is already
 * safely persisted above regardless of whether AI processing happens.
 *
 * This is the REAL, production dispatcher — a live `fetch()` to the
 * background function's public URL. Tests must never let this run for
 * real; inject a fake `dispatch` via ProcessWhatsAppInboundDeps instead of
 * calling processWhatsAppInbound() without one.
 */
export async function dispatchWhatsAppOrchestration(payload: WhatsAppDispatchPayload): Promise<void> {
  await dispatchWhatsAppOrchestrationChecked(payload);
}

/**
 * Same request as dispatchWhatsAppOrchestration(), but reports whether the
 * background function accepted it (HTTP 202). Used by the lost-dispatch
 * recovery sweep (lib/meta-whatsapp-recovery.ts), which needs to know. Never
 * throws; a false return means "not accepted" (not "processing failed").
 */
export async function dispatchWhatsAppOrchestrationChecked(payload: WhatsAppDispatchPayload, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const secret = process.env.AI_WHATSAPP_INTERNAL_DISPATCH_SECRET;
  if (!secret) {
    console.error("[meta-whatsapp-inbound] AI_WHATSAPP_INTERNAL_DISPATCH_SECRET is not set — cannot dispatch AI orchestration.");
    return false;
  }
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;
  if (!siteUrl) {
    console.error("[meta-whatsapp-inbound] No site URL available (URL/DEPLOY_URL env var) — cannot dispatch AI orchestration.");
    return false;
  }
  try {
    const res = await fetch(`${siteUrl}/.netlify/functions/ai-whatsapp-orchestrate-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": secret },
      body: JSON.stringify(payload),
      // Only the recovery sweep passes a timeout (it runs inside a 30 s scheduled
      // function); the webhook path keeps the platform default, unchanged.
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
    if (res.status !== 202) {
      console.error("[meta-whatsapp-inbound] WhatsApp background dispatch did not return 202:", res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[meta-whatsapp-inbound] WhatsApp background dispatch failed:", err);
    return false;
  }
}

export type ProcessWhatsAppInboundDeps = {
  /** Server-side Supabase client. Production: the real service-role admin
   * client. Tests: scripts/fake-supabase-client.mjs. */
  supabase: SupabaseClient;
  /** Defaults to the real dispatchWhatsAppOrchestration() (a live fetch) —
   * ALWAYS override this in a test with a synchronous fake that records
   * calls, never let the default run under test-network-guard.mjs (it
   * would correctly get BLOCKED as an un-mocked internal URL, which is
   * safe but makes the test's dispatch assertion opaque; an explicit fake
   * is clearer and matches this repo's existing DI conventions). */
  dispatch?: (payload: WhatsAppDispatchPayload) => Promise<void>;
};

/**
 * Processes one already-verified, already-parsed WhatsApp Cloud API
 * webhook payload (`payload.object === "whatsapp_business_account"`):
 * resolves org by the receiving phone_number_id, upserts the CRM contact,
 * persists+dedupes the inbound message, and dispatches AI orchestration.
 *
 * Extracted verbatim from meta-webhook.ts's processWhatsAppPayload() — see
 * this file's header. No behavior change from that version.
 */
export async function processWhatsAppInbound(payload: any, deps: ProcessWhatsAppInboundDeps): Promise<void> {
  const { supabase } = deps;
  const dispatch = deps.dispatch ?? dispatchWhatsAppOrchestration;

  for (const entry of payload.entry ?? []) {
    // entry.id is the WABA (WhatsApp Business Account) id — no longer used
    // for org resolution (see phoneNumberId below), kept implicit in the
    // payload shape only.
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;

      const value = change.value ?? {};

      // The specific phone number this message was sent TO — Meta always
      // includes this on every "messages" change (WhatsApp Cloud API
      // webhook payload shape: value.metadata.phone_number_id/
      // display_phone_number). AI-2E resolution fix: org is now resolved
      // by this exact phone-number id, scoped to product="whatsapp", NOT
      // by the WABA-level `wabaId` (entry.id) used previously. A single
      // WABA can own more than one phone number, and `meta_connections.
      // waba_id` has no unique constraint (confirmed by repo audit) — the
      // (org_id, product) unique connection this org actually uses is
      // identified by its OWN specific waba_phone_number_id, which is
      // exactly what the selector (meta-oauth-callback.ts / meta-whatsapp-
      // select-number.ts) persists there. Resolving by the receiving
      // phone number is also simply more correct: it's the number the
      // customer actually messaged, independent of how many numbers the
      // WABA happens to own.
      const phoneNumberId: string | undefined = value.metadata?.phone_number_id;

      for (const msg of value.messages ?? []) {
        // Skip non-text for now (image, audio, etc.)
        if (msg.type !== "text") continue;

        const fromPhone: string  = msg.from;                  // digits only, no leading +
        const body: string       = msg.text?.body ?? "";
        const msgId: string      = msg.id;
        const senderName: string = value.contacts?.[0]?.profile?.name ?? fromPhone;

        if (!phoneNumberId) {
          console.warn("[meta-whatsapp-inbound] WhatsApp message missing value.metadata.phone_number_id, cannot resolve org — skipping:", msgId);
          continue;
        }

        // Find the org whose ACTIVE WhatsApp connection owns this exact
        // phone number. Never trust org_id from the request body — the
        // only trusted input here is the receiving phone-number id Meta
        // itself reports, matched against our own server-side connection
        // record.
        const { data: connRow, error: connErr } = await supabase
          .from("meta_connections")
          .select("org_id")
          .eq("product", "whatsapp")
          .eq("waba_phone_number_id", phoneNumberId)
          .maybeSingle();

        if (connErr) {
          console.error("[meta-whatsapp-inbound] meta_connections lookup error:", connErr.message);
        }
        const orgId: string | undefined = connRow?.org_id;

        if (!orgId) {
          console.warn("[meta-whatsapp-inbound] no active WhatsApp connection found for phone_number_id:", phoneNumberId);
          continue;
        }

        const e164 = `+${fromPhone}`;

        // Upsert contact by phone so they appear in the Inbox conversation list
        const { data: contactRow, error: contactErr } = await supabase
          .from("contacts")
          .upsert(
            { org_id: orgId, phone: e164, full_name: senderName },
            { onConflict: "org_id,phone" },
          )
          .select("id")
          .maybeSingle();

        if (contactErr) {
          console.error("[meta-whatsapp-inbound] contact upsert error:", contactErr.message);
        }

        const contactId: string | null = contactRow?.id ?? null;

        // Persist the inbound message. This insert is ALSO the atomic
        // Meta-retry dedupe guard (AI-2E) — the same
        // (org_id, provider_message_id) unique index the SMS pipeline
        // relies on (confirmed live in production before this pass, not
        // merely assumed from the migration file). A 23505 conflict means
        // Meta already delivered this exact message id once; the AI has
        // already been dispatched (or is being dispatched by whichever
        // request won the race) for it, so this delivery is a no-op.
        //
        // `meta` is left null (AI-2E change — previously
        // `{ waba_id: wabaId }`, confirmed unread anywhere downstream by
        // repo-wide search) so the background dispatcher below can use the
        // SAME `.is("meta", null)` atomic claim pattern the SMS pipeline
        // already uses for its own retry-safety — see
        // ai-whatsapp-orchestrate-background.ts's header for why that
        // matters.
        const { data: inboundRow, error: insertErr } = await supabase
          .from("sms_meta_messages")
          .insert({
            org_id:       orgId,
            contact_id:   contactId,
            channel:      "whatsapp",
            direction:    "in",
            body,
            from_address: e164,
            provider_message_id: msgId,
            meta:         null,
          })
          .select("id")
          .single();

        if (insertErr) {
          if (insertErr.code === "23505") {
            console.log("[meta-whatsapp-inbound] duplicate WhatsApp delivery for provider_message_id", msgId, "— already processed, skipping.");
          } else {
            console.error("[meta-whatsapp-inbound] message insert error:", insertErr.message);
          }
          continue;
        }

        // AI-2E: dispatch AI orchestration the same way the SMS pipeline
        // does — fire-and-forget to a Netlify Background Function, so
        // this webhook (and Meta's own delivery timeout) is never held
        // open waiting for a model call. Only dispatched when a real CRM
        // contact was resolved — WhatsApp's contact resolution above
        // ALWAYS upserts one (unlike SMS's read-only match, see this
        // pass's own report), so in practice this should always have a
        // contactId when the upsert itself succeeded; kept as an explicit
        // guard rather than assumed.
        if (contactId) {
          await dispatch({
            orgId,
            contactId,
            phone: e164,
            body,
            providerMessageId: msgId,
            inboundMessageId: inboundRow.id,
          });
        } else {
          console.warn("[meta-whatsapp-inbound] WhatsApp contact upsert did not return a contactId — AI not dispatched for message", msgId);
        }
      }
    }
  }
}
