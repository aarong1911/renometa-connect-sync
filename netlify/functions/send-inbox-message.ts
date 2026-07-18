// netlify/functions/send-inbox-message.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import crypto from "node:crypto";

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Matches the encrypt half in meta-oauth-callback.ts — "enc:" + base64(iv||tag||ciphertext).
// Legacy rows from before this scheme shipped may be bare plaintext with no prefix.
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

// Normalize any phone format to E.164 (+1XXXXXXXXXX) for Twilio
function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  return raw.startsWith("+") ? raw : `+${digits}`;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  // Validate auth token
  const authToken = event.headers.authorization?.slice(7);
  if (!authToken) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };

  const { data: { user } } = await supabaseAdmin.auth.getUser(authToken);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Invalid token" }) };

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  let orgId: string | null = profile?.organization_id ?? null;
  if (!orgId) {
    const { data: membership } = await supabaseAdmin
      .from("org_memberships")
      .select("org_id")
      .eq("member_id", user.id)
      .maybeSingle();
    orgId = membership?.org_id ?? null;
  }
  if (!orgId) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "No organization found" }) };

  // Parse request body
  let reqBody: {
    channel: string; to: string; body: string; subject?: string; from_name?: string; contact_id?: string;
    // Optional explicit values for WhatsApp template variables (used only
    // when a template send is required — see the 24h session check below).
    // Falls back to sensible defaults (contact name from `contacts`,
    // current date/time, generic service/confirmation text) when not
    // supplied, since the Inbox compose box is currently a single
    // free-text field with no appointment-specific inputs.
    templateVars?: { dateTime?: string; service?: string; confirmationNumber?: string };
  };
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { channel, to, body, subject, from_name, contact_id, templateVars } = reqBody;
  if (!channel || !to || !body) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "channel, to, body are required" }) };
  }

  let sentAsTemplate = false;
  let templateNameUsed: string | undefined;

  try {
    if (channel === "sms") {
      // Fetch org's Twilio credentials from integration_settings
      const { data: org } = await supabaseAdmin
        .from("organizations")
        .select("integration_settings")
        .eq("id", orgId)
        .maybeSingle();

      const twilio = org?.integration_settings?.twilio;
      if (!twilio?.accountSid || !twilio?.authToken || !twilio?.phoneNumber) {
        return {
          statusCode: 422,
          headers: CORS,
          body: JSON.stringify({ error: "Twilio not configured — go to Settings → Integrations → Twilio to add your credentials" }),
        };
      }

      const { accountSid, authToken, phoneNumber } = twilio;
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            From: toE164(phoneNumber),
            To:   toE164(to),
            Body: body,
          }).toString(),
        },
      );

      if (!res.ok) {
        const err: any = await res.json().catch(() => ({}));
        throw new Error(err.message ?? `Twilio error ${res.status}: ${err.code ?? ""}`);
      }
    } else if (channel === "email") {
      // Fetch org's Gmail credentials from integration_settings
      const { data: orgForEmail } = await supabaseAdmin
        .from("organizations")
        .select("integration_settings")
        .eq("id", orgId)
        .maybeSingle();

      const gmail = orgForEmail?.integration_settings?.gmail;
      if (!gmail?.email || !gmail?.appPassword) {
        return {
          statusCode: 422,
          headers: CORS,
          body: JSON.stringify({ error: "Gmail not configured — go to Settings → Integrations → Gmail to add your credentials" }),
        };
      }

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: gmail.email, pass: gmail.appPassword },
      });
      await transporter.sendMail({
        from: `${from_name ?? "RenoMeta Connect"} <${gmail.email}>`,
        to,
        subject: subject || "(no subject)",
        text: body,
      });
    } else if (channel === "whatsapp" || channel === "messenger" || channel === "instagram") {
      const productKey = channel === "whatsapp" ? "whatsapp" : channel === "messenger" ? "messenger" : "instagram";

      // Per-product schema (supabase/migrations/006_meta_connections_per_product.sql)
      // — query the row for THIS product specifically, rather than a shared
      // org-level row with a connected_products array to check membership
      // against. If no row exists for this exact product, it was never
      // connected (or was disconnected), full stop.
      const { data: conn, error: connErr } = await supabaseAdmin
        .from("meta_connections")
        .select("waba_phone_number_id, page_id, access_token")
        .eq("org_id", orgId)
        .eq("product", productKey)
        .maybeSingle();

      if (connErr || !conn || !conn.access_token) {
        return {
          statusCode: 422,
          headers: CORS,
          body: JSON.stringify({ error: `${channel === "whatsapp" ? "WhatsApp" : channel === "messenger" ? "Messenger" : "Instagram"} is not connected — go to Settings → Integrations to connect it` }),
        };
      }

      let accessToken: string;
      try {
        accessToken = decryptOrPlaintext(conn.access_token as string);
      } catch (e: any) {
        console.error("[send-inbox-message] token decrypt failed:", e.message);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not read stored credentials — try reconnecting in Settings" }) };
      }

      if (channel === "whatsapp") {
        if (!conn.waba_phone_number_id) {
          return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: "No WhatsApp phone number on this connection — try reconnecting" }) };
        }
        // Meta's recipient allow-list (Development-mode WhatsApp numbers)
        // does an EXACT match against the full international format — a
        // 10-digit US number with no country code (e.g. "9548718466", as
        // many contacts are stored) is rejected with "(#131030) Recipient
        // phone number not in allowed list" even after that same number was
        // added/verified through Meta's console, since the console
        // stores/compares the full E.164 form. Reuse the same toE164()
        // normalizer SMS/Twilio already uses below, just without the "+"
        // since the Graph API's `to` field wants bare digits.
        const toDigits = toE164(to).replace("+", "");

        // WhatsApp's 24-hour session rule: free-form text (type: "text")
        // is only allowed if the contact has messaged US within the last
        // 24 hours, opening a "customer service window." Outside that
        // window — including the very first message to a contact who has
        // never written in — only pre-approved TEMPLATE messages are
        // accepted; a "text" send in that situation is rejected by Meta
        // even though our own API call returns 200 in some failure modes,
        // which is what made this bug hard to spot (it can look like it
        // sent, then never arrives). Check the most recent INBOUND
        // sms_meta_messages row for this contact+channel to determine
        // whether a session is currently open.
        let sessionOpen = false;
        if (contact_id) {
          const { data: lastInbound } = await supabaseAdmin
            .from("sms_meta_messages")
            .select("created_at")
            .eq("org_id", orgId)
            .eq("contact_id", contact_id)
            .eq("channel", "whatsapp")
            .eq("direction", "in")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (lastInbound?.created_at) {
            const hoursSince = (Date.now() - new Date(lastInbound.created_at).getTime()) / 36e5;
            sessionOpen = hoursSince < 24;
          }
        }

        async function buildTemplatePayload(
          toParam: string,
          contactId: string | undefined,
          vars: { dateTime?: string; service?: string; confirmationNumber?: string } | undefined,
        ) {
          // renometa_appointment_confirmed_ (Utility > Default, header
          // "Appointment confirmed") — Meta rejected the original {{1}}
          // style positional variables with "Variable parameters must be
          // lowercase characters, underscores and numbers with two sets of
          // curly brackets", so the template body uses NAMED variables
          // instead. Confirmed final body:
          //
          //   Hi {{customer_name}},
          //   Your appointment is scheduled for {{appointment_datetime}}.
          //   Service: {{service_name}}
          //   Confirmation number: {{confirmation_number}}
          //   We're looking forward to your visit.
          //
          // Named-variable templates use a DIFFERENT parameters shape than
          // older {{1}}-style templates: each parameter object includes a
          // `parameter_name` field and is NOT positionally ordered — Meta
          // matches by name, not array index. (hello_world and the older
          // template-library samples seen earlier in this project still
          // use the old {{1}} positional style; don't assume both
          // templates in this codebase use the same parameter shape.)
          //
          // Header is static text ("Appointment confirmed") with no
          // variable, so no `header` component is needed, only `body`.
          let contactName = "there";
          if (contactId) {
            const { data: c } = await supabaseAdmin
              .from("contacts")
              .select("full_name")
              .eq("id", contactId)
              .maybeSingle();
            if (c?.full_name) contactName = c.full_name;
          }

          const fallbackDateTime = new Date().toLocaleString(undefined, {
            month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
          });

          return {
            messaging_product: "whatsapp",
            to: toParam,
            type: "template",
            template: {
              name: process.env.WHATSAPP_TEMPLATE_NAME || "renometa_appointment_confirmed_",
              language: { code: process.env.WHATSAPP_TEMPLATE_LANG || "en_US" },
              components: [
                {
                  type: "body",
                  parameters: [
                    { type: "text", parameter_name: "customer_name", text: contactName },
                    { type: "text", parameter_name: "appointment_datetime", text: vars?.dateTime || fallbackDateTime },
                    { type: "text", parameter_name: "service_name", text: vars?.service || "your service" },
                    { type: "text", parameter_name: "confirmation_number", text: vars?.confirmationNumber || "—" },
                  ],
                },
              ],
            },
          };
        }

        let messagePayload: { messaging_product: string; to: string; type: string; text?: { body: string }; template?: { name: string; language: { code: string }; components: any[] } };
        let templateNameForThisSend: string | undefined;

        if (sessionOpen) {
          messagePayload = { messaging_product: "whatsapp", to: toDigits, type: "text", text: { body } };
        } else {
          const payload = await buildTemplatePayload(toDigits, contact_id, templateVars);
          templateNameForThisSend = payload.template.name;
          messagePayload = payload;
        }

        const res = await fetch(
          `https://graph.facebook.com/v21.0/${conn.waba_phone_number_id}/messages`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(messagePayload),
          },
        );
        if (!res.ok) {
          const err: any = await res.json().catch(() => ({}));
          throw new Error(err?.error?.message ?? `WhatsApp send failed (${res.status})`);
        }
        if (!sessionOpen) {
          sentAsTemplate = true;
          templateNameUsed = templateNameForThisSend;
          console.log(
            `[send-inbox-message] sent WhatsApp TEMPLATE (no open 24h session) to org ${orgId}, contact ${contact_id ?? "unknown"} — ` +
            `using template "${templateNameUsed}". The actual message body the user typed was NOT delivered as-is; ` +
            `only the template's fixed content was sent. Swap WHATSAPP_TEMPLATE_NAME once a real template is approved.`,
          );
        }
      } else {
        // Messenger and Instagram both send through the same Page-scoped
        // /me/messages endpoint — `to` here is the contact's PSID (Messenger)
        // or IGSID (Instagram), resolved by the caller from
        // contacts.messenger_psid / contacts.instagram_igsid, NOT a phone
        // number or username.
        const res = await fetch(
          `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(accessToken)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recipient: { id: to },
              message: { text: body },
            }),
          },
        );
        if (!res.ok) {
          const err: any = await res.json().catch(() => ({}));
          throw new Error(err?.error?.message ?? `${channel} send failed (${res.status})`);
        }
      }
    }
    // "note" channel: server-side no-op

    // Persist the outbound message for the 4 channels that have a real
    // table for it (see supabase/migrations/005_sms_meta_messages.sql).
    // Email is NOT included here — it has its own dedicated tables
    // (inbox_emails / emails / gmail_messages) with a richer schema
    // (gmail_message_id, body_html, thread linkage) that almost certainly
    // already has its own sync/send logic elsewhere; duplicating that here
    // without seeing it risks creating a second, conflicting source of
    // truth for email history. "note" is a client-side-only concept with
    // no external send and no persistence table.
    if (channel === "sms" || channel === "whatsapp" || channel === "messenger" || channel === "instagram") {
      const { error: insertErr } = await supabaseAdmin.from("sms_meta_messages").insert({
        org_id: orgId,
        contact_id: contact_id ?? null,
        channel,
        direction: "out",
        // If a template was sent instead of free text (no open WhatsApp
        // session), record what actually went out — Meta's fixed template
        // content, not the user's typed draft — so the conversation history
        // doesn't show a message that was never really delivered as written.
        body: sentAsTemplate ? `[Template: ${templateNameUsed}] (sent because no message was received from this contact in the last 24h)` : body,
        from_address: to,
        meta: sentAsTemplate ? { sent_as_template: templateNameUsed } : null,
      });
      if (insertErr) {
        // Don't fail the request over this — the external send already
        // succeeded, losing the local history row is a lesser problem than
        // reporting a false failure to the user.
        console.error("[send-inbox-message] sms_meta_messages insert failed:", insertErr.message);
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        sentAsTemplate,
        ...(sentAsTemplate ? { templateName: templateNameUsed } : {}),
      }),
    };
  } catch (err: any) {
    console.error("[send-inbox-message]", err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};