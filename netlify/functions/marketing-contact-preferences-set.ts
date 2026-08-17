// netlify/functions/marketing-contact-preferences-set.ts
//
// Minimal trusted path for staff to record that a contact may receive
// marketing SMS (sms_status: 'unknown' -> 'eligible'). This exists because
// the Phase 14.1 hardening pass made SMS eligibility fail-closed — a CRM
// phone number is never implicitly eligible — and without ANY legitimate
// way to move a contact to 'eligible', SMS Campaigns would have no
// audience at all, forever. This function is that legitimate way, added
// as the minimum necessary to make the fail-closed model usable, not as a
// consent-collection UI/feature (no client-facing form is built here —
// this is a plain org-resolved, permission-gated backend action a staff
// member's own click in the Contacts UI would call).
//
// Deliberately narrow and one-directional:
//   - Only 'unknown' -> 'eligible' is permitted through this endpoint.
//   - It can NEVER set 'opted_out' or 'suppressed' (those are exclusively
//     owned by marketing-sms-inbound.ts's STOP handling / future carrier
//     suppression signals).
//   - It can NEVER revert an existing 'opted_out'/'suppressed' contact
//     back to 'eligible' or 'unknown' — once a contact has opted out, an
//     ordinary staff action must not be able to silently undo that. A
//     contact who wants back in must text back in through the carrier
//     flow (Twilio's own START/UNSTOP handling on their platform), not
//     through this app.
//
// No browser code calls Supabase directly for this — marketing_contact_
// preferences has no authenticated write grant at all (see the migration).
// This function resolves org server-side and is the only client-reachable
// way to move sms_status forward.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";

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

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  const { orgId } = resolved;

  let reqBody: { contactId?: string };
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) };
  }
  const { contactId } = reqBody;
  if (!contactId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "contactId is required" }) };

  const { data: contact, error: contactErr } = await supabaseAdmin
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("org_id", orgId) // never trust a cross-org contact id
    .maybeSingle();
  if (contactErr || !contact) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Contact not found" }) };
  }

  const { data: existing } = await supabaseAdmin
    .from("marketing_contact_preferences")
    .select("sms_status")
    .eq("contact_id", contactId)
    .maybeSingle();

  if (existing && existing.sms_status !== "unknown") {
    return {
      statusCode: 409,
      headers: CORS,
      body: JSON.stringify({ error: `Contact SMS status is already '${existing.sms_status}' — cannot set eligible from here` }),
    };
  }

  const { error: upsertErr } = await supabaseAdmin
    .from("marketing_contact_preferences")
    .upsert(
      { org_id: orgId, contact_id: contactId, sms_status: "eligible", sms_status_updated_at: new Date().toISOString() },
      { onConflict: "contact_id" },
    );
  if (upsertErr) {
    console.error("[marketing-contact-preferences-set]", upsertErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to update SMS eligibility" }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, smsStatus: "eligible" }) };
};
