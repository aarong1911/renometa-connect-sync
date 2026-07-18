// netlify/functions/meta-webhook.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

// Writes inbound messages to sms_meta_messages — see
// supabase/migrations/005_sms_meta_messages.sql for the real schema.
// (This file previously assumed a table called "inbox_messages" that was
// never actually created — see .claude/skills/meta-integrations/SKILL.md
// for how that was discovered and fixed.)

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
};

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export const handler: Handler = async (event) => {
  // ── GET — Meta webhook verification ────────────────────────────────────────
  if (event.httpMethod === "GET") {
    const p = event.queryStringParameters ?? {};
    const mode      = p["hub.mode"];
    const token     = p["hub.verify_token"];
    const challenge = p["hub.challenge"] ?? "";

    if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
      return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: challenge };
    }
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Forbidden" }) };
  }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // ── POST — incoming WhatsApp message ───────────────────────────────────────
  // Meta requires a 200 response quickly or it will retry. Process inline —
  // Supabase ops are fast enough that we won't hit the 20-second timeout.
  try {
    await processPayload(event.body ?? "{}");
  } catch (err: any) {
    console.error("[meta-webhook] unhandled error:", err.message);
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
};

async function processPayload(rawBody: string): Promise<void> {
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return;
  }

  if (payload.object === "whatsapp_business_account") {
    await processWhatsAppPayload(payload);
    return;
  }
  if (payload.object === "page") {
    await processMessengerOrInstagramPayload(payload, "messenger");
    return;
  }
  if (payload.object === "instagram") {
    await processMessengerOrInstagramPayload(payload, "instagram");
    return;
  }
}

async function processWhatsAppPayload(payload: any): Promise<void> {
  for (const entry of payload.entry ?? []) {
    const wabaId: string = entry.id; // WhatsApp Business Account ID

    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;

      const value = change.value ?? {};

      for (const msg of value.messages ?? []) {
        // Skip non-text for now (image, audio, etc.)
        if (msg.type !== "text") continue;

        const fromPhone: string  = msg.from;                  // digits only, no leading +
        const body: string       = msg.text?.body ?? "";
        const msgId: string      = msg.id;
        const receivedAt: string = new Date(parseInt(msg.timestamp, 10) * 1000).toISOString();
        const senderName: string = value.contacts?.[0]?.profile?.name ?? fromPhone;

        // Find the org whose WhatsApp connection matches this WABA ID.
        // Primary path: meta_connections (real OAuth flow, see
        // .claude/skills/meta-integrations/SKILL.md). Falls back to the
        // legacy organizations.integration_settings JSONB path so any
        // connections made before the meta_connections migration still
        // route correctly — remove the fallback once confirmed unused.
        let orgId: string | undefined;

        const { data: connRow, error: connErr } = await supabaseAdmin
          .from("meta_connections")
          .select("org_id")
          .eq("waba_id", wabaId)
          .maybeSingle();

        if (connErr) {
          console.error("[meta-webhook] meta_connections lookup error:", connErr.message);
        }
        orgId = connRow?.org_id;

        if (!orgId) {
          const { data: orgs, error: orgErr } = await supabaseAdmin
            .from("organizations")
            .select("id")
            .filter("integration_settings->whatsapp->>waba_id", "eq", wabaId);

          if (orgErr) {
            console.error("[meta-webhook] legacy org lookup error:", orgErr.message);
          }
          orgId = orgs?.[0]?.id;
        }

        if (!orgId) {
          console.warn("[meta-webhook] no org found for waba_id:", wabaId);
          continue;
        }

        const e164 = `+${fromPhone}`;

        // Upsert contact by phone so they appear in the Inbox conversation list
        const { data: contactRow, error: contactErr } = await supabaseAdmin
          .from("contacts")
          .upsert(
            { org_id: orgId, phone: e164, full_name: senderName },
            { onConflict: "org_id,phone" },
          )
          .select("id")
          .maybeSingle();

        if (contactErr) {
          console.error("[meta-webhook] contact upsert error:", contactErr.message);
        }

        const contactId: string | null = contactRow?.id ?? null;

        // Persist the inbound message
        const { error: insertErr } = await supabaseAdmin
          .from("sms_meta_messages")
          .insert({
            org_id:       orgId,
            contact_id:   contactId,
            channel:      "whatsapp",
            direction:    "in",
            body,
            from_address: e164,
            provider_message_id: msgId,
            meta:         { waba_id: wabaId },
          });

        if (insertErr) {
          console.error("[meta-webhook] message insert error:", insertErr.message);
        }
      }
    }
  }
}

// Messenger and Instagram Direct share the same `entry[].messaging[]`
// payload shape. `entry.id` is the Page ID in both cases — Instagram
// Direct webhooks route through the Page the IG Business Account is
// linked to, not a separate Instagram-only id. `channel` distinguishes
// which product this run is for, since the same shape can't otherwise be
// told apart from the payload alone in every case (a Page can have both
// Messenger and a linked IG account active).
async function processMessengerOrInstagramPayload(
  payload: any,
  channel: "messenger" | "instagram",
): Promise<void> {
  for (const entry of payload.entry ?? []) {
    const pageId: string = entry.id;

    for (const msgEvent of entry.messaging ?? []) {
      // Skip echoes (messages the page itself sent, delivered back to us),
      // read receipts, and anything without an actual text message body
      if (msgEvent.message?.is_echo) continue;
      const body: string | undefined = msgEvent.message?.text;
      if (!body) continue;

      const senderId: string = msgEvent.sender?.id; // PSID (Messenger) or IGSID (Instagram)
      const msgId: string = msgEvent.message?.mid ?? `${pageId}-${msgEvent.timestamp}`;
      const receivedAt: string = new Date(msgEvent.timestamp).toISOString();

      if (!senderId) {
        console.warn(`[meta-webhook] ${channel} message missing sender id, skipping`);
        continue;
      }

      // Find the org whose connection matches this Page ID
      const { data: connRow, error: connErr } = await supabaseAdmin
        .from("meta_connections")
        .select("org_id")
        .eq("page_id", pageId)
        .maybeSingle();

      if (connErr) {
        console.error(`[meta-webhook] meta_connections lookup error (${channel}):`, connErr.message);
      }
      const orgId = connRow?.org_id;

      if (!orgId) {
        console.warn(`[meta-webhook] no org found for page_id (${channel}):`, pageId);
        continue;
      }

      // Upsert contact by platform-specific identifier — these are NOT
      // phone numbers or emails, so they go in messenger_psid/instagram_igsid
      // (see supabase/migrations/004_contacts_meta_identifiers.sql), not the
      // phone column. We don't get a display name from this webhook payload
      // alone — fetching it requires a separate Graph API call
      // (/{psid}?fields=first_name,last_name), which is left as a future
      // enhancement; for now the contact is created with a placeholder name
      // if one doesn't already exist.
      const idColumn = channel === "messenger" ? "messenger_psid" : "instagram_igsid";

      const { data: existingContact } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .eq("org_id", orgId)
        .eq(idColumn, senderId)
        .maybeSingle();

      let contactId: string | null = existingContact?.id ?? null;

      if (!contactId) {
        const { data: newContact, error: contactErr } = await supabaseAdmin
          .from("contacts")
          .insert({
            org_id: orgId,
            full_name: channel === "messenger" ? "Messenger Contact" : "Instagram Contact",
            [idColumn]: senderId,
          })
          .select("id")
          .maybeSingle();

        if (contactErr) {
          console.error(`[meta-webhook] contact insert error (${channel}):`, contactErr.message);
        }
        contactId = newContact?.id ?? null;
      }

      const { error: insertErr } = await supabaseAdmin
        .from("sms_meta_messages")
        .insert({
          org_id: orgId,
          contact_id: contactId,
          channel,
          direction: "in",
          body,
          from_address: senderId,
          provider_message_id: msgId,
          meta: { page_id: pageId },
        });

      if (insertErr) {
        console.error(`[meta-webhook] message insert error (${channel}):`, insertErr.message);
      }
    }
  }
}