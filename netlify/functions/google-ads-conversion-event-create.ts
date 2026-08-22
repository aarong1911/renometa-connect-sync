// netlify/functions/google-ads-conversion-event-create.ts
//
// Phase 3, Step 7A / 7A.1: trusted PRODUCTION endpoint for recording a
// LOCAL Google Ads conversion event (qualified_lead / appointment_booked /
// deal_won) for a CRM lead. Makes NO Google Ads API call — this only
// queues a row in google_ads_conversion_events for a future export
// (Step 7B).
//
// Step 7A.1 hardening: an authenticated, org-scoped caller must NOT be
// able to fabricate a milestone that didn't actually happen in the CRM.
// Every request is validated against canonical database state BEFORE any
// conversion event is created:
//   - qualified_lead requires leads.status === 'qualified'
//   - appointment_booked requires a real appointment linked to this
//     exact lead (via entity_type/entity_id or shared contact_id)
//   - deal_won requires a real deal linked to this exact lead with
//     status === 'won'
// eventAt, dealId/appointmentId's downstream conversion_value, and
// currencyCode are ALL derived server-side from that validated CRM state
// — never accepted from the request body anymore. See
// resolveGoogleAdsConversionMilestone() in
// lib/google-ads-conversion-events.ts, the single place this validation
// logic lives (not duplicated here).
//
// Google attribution (provider submission, gclid, campaign, contact) is
// still resolved separately and exactly by lead_id — never accepted from
// the request body, and never "the contact's latest submission" — via
// recordGoogleAdsConversionEvent(), called only after milestone
// validation succeeds.
//
// This endpoint is intentionally NOT automatically wired into lead status
// changes, appointment creation, or deal updates — it exists for
// controlled/manual invocation while the event model is validated. A
// synthetic dev-fixture submission (marked via
// raw_fields.__renometa_test_fixture) always resolves to
// export_status='ineligible' regardless of caller, unconditionally
// overriding CRM-milestone-derived readiness — see
// lib/google-ads-conversion-events.ts.
//
// Synthetic/dev testing (leads/appointments/deals that don't have real
// qualified/booked/won state) is NOT possible through this endpoint
// anymore — see the separate dev-only
// google-ads-conversion-event-test-create.ts, which never runs outside a
// real local `netlify dev` session.
//
// Never logs or returns: encrypted tokens, raw provider responses, or raw
// Supabase error details. gclid appears only in this endpoint's own
// controlled-verification response, never rendered prominently in the
// normal conversion-events UI (Marketing → Paid Ads → Google Ads →
// Conversion Feedback).

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import {
  recordGoogleAdsConversionEvent,
  resolveGoogleAdsConversionMilestone,
  isValidGoogleAdsConversionEventType,
} from "./lib/google-ads-conversion-events";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Reduced production request shape (Step 15) — no gclid,
// google_ads_customer_id, eventAt, conversionValue, or currencyCode. Those
// are all server-derived from validated CRM state now.
interface RequestBody {
  leadId?: unknown;
  eventType?: unknown;
  dealId?: unknown;
  appointmentId?: unknown;
}

function safeString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function safeStringOrNull(v: unknown): string | null {
  const s = safeString(v);
  return s.length > 0 ? s : null;
}

// Safe error codes (Step 16) — never a raw Supabase error message.
const MILESTONE_REJECTION_STATUS: Record<string, number> = {
  lead_not_found: 404,
  lead_not_qualified: 422,
  appointment_not_found: 404,
  appointment_lead_mismatch: 409,
  deal_not_found: 404,
  deal_not_won: 422,
  deal_lead_mismatch: 409,
};

export const handler: Handler = async (event) => {
  const headers = googleAdsCorsHeaders(event, "POST, OPTIONS");

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  let reqBody: RequestBody;
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  // Only trusted CRM identifiers are ever read — organizationId always
  // comes from resolveOrgFromBearerToken, never the body. gclid,
  // google_ads_customer_id, eventAt, and conversionValue are NEVER
  // accepted here at all.
  const leadId = safeString(reqBody.leadId);
  if (!leadId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "leadId is required" }) };
  }

  const eventTypeRaw = safeString(reqBody.eventType);
  if (!isValidGoogleAdsConversionEventType(eventTypeRaw)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "eventType must be one of qualified_lead, appointment_booked, deal_won" }) };
  }

  const dealId = safeStringOrNull(reqBody.dealId);
  const appointmentId = safeStringOrNull(reqBody.appointmentId);

  if (eventTypeRaw === "appointment_booked" && !appointmentId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "appointmentId is required for appointment_booked" }) };
  }
  if (eventTypeRaw === "deal_won" && !dealId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "dealId is required for deal_won" }) };
  }

  // Step 3/5/8 — prove the milestone actually happened before creating
  // anything. Every field of a valid result is server-derived from the
  // rows this call loads, never from the request body.
  const milestone = await resolveGoogleAdsConversionMilestone(supabaseAdmin, {
    organizationId: orgId,
    leadId,
    eventType: eventTypeRaw,
    appointmentId,
    dealId,
  });

  if (!milestone.valid) {
    const statusCode = MILESTONE_REJECTION_STATUS[milestone.reason] ?? 422;
    return { statusCode, headers, body: JSON.stringify({ ok: false, error: milestone.reason }) };
  }

  const result = await recordGoogleAdsConversionEvent(supabaseAdmin, {
    organizationId: orgId,
    leadId: milestone.leadId,
    eventType: eventTypeRaw,
    eventAt: milestone.eventAt,
    dealId: milestone.dealId,
    appointmentId: milestone.appointmentId,
    conversionValue: milestone.conversionValue,
    currencyCode: milestone.currencyCode,
  });

  if (!result.ok) {
    if (result.reason === "no_provider_attribution") {
      return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: "google_ads_attribution_not_found" }) };
    }
    console.error("[google-ads-conversion-event-create] failed", { reason: result.reason });
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: "server_configuration" }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      created: result.created,
      eventId: result.event.id,
      eventType: result.event.eventType,
      exportStatus: result.event.exportStatus,
      // Only exposed here (the controlled-verification create response),
      // never in the general Conversion Feedback list UI.
      gclid: result.event.gclid,
    }),
  };
};
