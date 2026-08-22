// netlify/functions/google-ads-conversion-event-test-create.ts
//
// DEV-ONLY TEST HARNESS — Phase 3, Step 7A.1. The hardened production
// endpoint (google-ads-conversion-event-create.ts) now requires real CRM
// milestone proof (leads.status === 'qualified', a real linked
// appointment, or a real deals.status === 'won' row) before it will ever
// create a conversion event. That's correct production behavior, but it
// means the synthetic dev fixtures used to validate the Google-attribution
// foundation (phase3-browser-001/002 — leads that were never actually
// moved to 'qualified', have no real appointment/deal) can no longer
// exercise that endpoint at all.
//
// This endpoint exists SOLELY to keep that dev/controlled-verification
// path usable, without weakening the production endpoint in any way. It
// calls recordGoogleAdsConversionEvent() directly — the SAME function the
// production endpoint calls — skipping ONLY the CRM milestone validation
// (resolveGoogleAdsConversionMilestone()), never the Google attribution
// resolution or the synthetic-fixture ineligible override. A synthetic
// fixture's conversion event is STILL forced to export_status='ineligible'
// here, exactly as in production — this endpoint does not touch that
// logic at all.
//
// THIS IS NOT A PRODUCTION BACKDOOR. Same safety boundary as
// google-ads-lead-test-inject.ts — isLocalDevContext() is checked FIRST,
// before authentication, before parsing the body, before anything else.
// A hidden frontend button is a convenience, never the actual protection;
// this endpoint refuses to run outside a real local `netlify dev` session
// regardless of what calls it. 404 (not 403) on any other environment so
// a probe against a real deployment doesn't even learn the route exists.
//
// Accepts eventAt/conversionValue/currencyCode directly from the caller
// (unlike the production endpoint) BECAUSE this path is only ever reached
// in local dev, and the whole point is to exercise
// recordGoogleAdsConversionEvent() against leads/entities that have no
// real CRM milestone to derive those fields from.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import {
  recordGoogleAdsConversionEvent,
  isValidGoogleAdsConversionEventType,
} from "./lib/google-ads-conversion-events";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Same positive-allowlist guard as google-ads-lead-test-inject.ts — kept
// as its own local copy rather than shared, matching that file's existing
// convention (each dev-only endpoint carries its own copy of this check).
function isLocalDevContext(): boolean {
  return (
    process.env.NETLIFY_DEV === "true" &&
    process.env.CONTEXT !== "production" &&
    process.env.NODE_ENV !== "production"
  );
}

interface RequestBody {
  leadId?: unknown;
  eventType?: unknown;
  eventAt?: unknown;
  dealId?: unknown;
  appointmentId?: unknown;
  conversionValue?: unknown;
  currencyCode?: unknown;
}

function safeString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function safeStringOrNull(v: unknown): string | null {
  const s = safeString(v);
  return s.length > 0 ? s : null;
}

export const handler: Handler = async (event) => {
  const headers = googleAdsCorsHeaders(event, "POST, OPTIONS");

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  // Production guard FIRST — before auth, before body parsing, before
  // anything. This endpoint does not exist outside local dev, full stop.
  if (!isLocalDevContext()) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: "Not found" }) };
  }

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

  const leadId = safeString(reqBody.leadId);
  if (!leadId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "leadId is required" }) };
  }

  const eventTypeRaw = safeString(reqBody.eventType);
  if (!isValidGoogleAdsConversionEventType(eventTypeRaw)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "eventType must be one of qualified_lead, appointment_booked, deal_won" }) };
  }

  const eventAtRaw = safeString(reqBody.eventAt);
  const eventAtDate = eventAtRaw ? new Date(eventAtRaw) : new Date();
  if (Number.isNaN(eventAtDate.getTime())) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "eventAt must be a valid date/time" }) };
  }

  const dealId = safeStringOrNull(reqBody.dealId);
  const appointmentId = safeStringOrNull(reqBody.appointmentId);
  const conversionValue = typeof reqBody.conversionValue === "number" && Number.isFinite(reqBody.conversionValue)
    ? reqBody.conversionValue
    : null;
  const currencyCode = safeStringOrNull(reqBody.currencyCode);

  // Deliberately calls recordGoogleAdsConversionEvent() directly — NOT
  // resolveGoogleAdsConversionMilestone() — this is the one and only
  // difference from the production endpoint. Google attribution
  // resolution and the synthetic-fixture ineligible override are
  // unchanged and still fully enforced.
  const result = await recordGoogleAdsConversionEvent(supabaseAdmin, {
    organizationId: orgId,
    leadId,
    eventType: eventTypeRaw,
    eventAt: eventAtDate.toISOString(),
    dealId,
    appointmentId,
    conversionValue,
    currencyCode,
  });

  if (!result.ok) {
    if (result.reason === "no_provider_attribution") {
      return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: "no_provider_attribution" }) };
    }
    console.error("[google-ads-conversion-event-test-create] failed", { reason: result.reason });
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
      gclid: result.event.gclid,
    }),
  };
};
