// netlify/functions/google-ads-conversion-events-list.ts
//
// Phase 3, Step 7B.2 (Step 19 — optional export list endpoint, needed by
// the Conversion Feedback UI's per-event Upload/Retry table). Read-only
// listing of google_ads_conversion_events for the authenticated
// organization's SELECTED Google Ads customer. Both are always resolved
// server-side — never accepted as query parameters.
//
// Returns only sanitized, already-safe-to-display fields. Deliberately
// does NOT return raw_fields — only the derived `syntheticFixture`
// boolean the UI needs to hide the Upload/Retry action and show a "Test
// fixture — never uploaded" indicator for synthetic rows.
//
// Service-role DB access only — google_ads_conversion_events has RLS with
// zero policies (20260902_google_ads_conversion_attribution.sql).
// Makes no Google Ads API call — pure database read.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { preflightGoogleAdsConnection, type GoogleAdsConnectionRowForSummary } from "./lib/google-ads-api";
import { isSyntheticGoogleAdsConversionEvent, type GoogleAdsConversionEventType, type GoogleAdsConversionExportStatus } from "./lib/google-ads-conversion-events";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

interface ConnectionRow extends GoogleAdsConnectionRowForSummary {
  id: string;
}

interface EventRow {
  id: string;
  event_type: GoogleAdsConversionEventType;
  lead_id: string | null;
  contact_id: string | null;
  event_at: string;
  gclid: string | null;
  conversion_value: number | string | null;
  currency_code: string | null;
  export_status: GoogleAdsConversionExportStatus;
  exported_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  // PostgREST embeds the referenced row as an object (single FK -> single
  // related row) — typed loosely since only raw_fields is ever read from it.
  google_ads_lead_submissions: { raw_fields: unknown } | { raw_fields: unknown }[] | null;
}

// A handful of recent events is what the compact UI table needs — no
// pagination requested by the task; capped defensively so this endpoint
// can never return an unbounded result set.
const LIST_LIMIT = 100;

function errorResponse(headers: Record<string, string>, statusCode: number, errorCode: string) {
  return { statusCode, headers, body: JSON.stringify({ error: errorCode }) };
}

export const handler: Handler = async (event) => {
  const headers = googleAdsCorsHeaders(event, "GET, OPTIONS");

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  const { data: connection, error: connErr } = (await supabaseAdmin
    .from("google_ads_connections")
    .select("id, status, encrypted_refresh_token, selected_customer_id, login_customer_id")
    .eq("organization_id", orgId)
    .maybeSingle()) as unknown as { data: ConnectionRow | null; error: any };

  if (connErr) {
    console.error("[google-ads-conversion-events-list] connection_lookup_failed", { code: connErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const preflight = preflightGoogleAdsConnection(connection);
  if (!preflight.ok) {
    const statusCode = preflight.errorCode === "google_ads_not_connected" ? 404 : 409;
    return errorResponse(headers, statusCode, preflight.errorCode);
  }
  const { selectedCustomerId } = preflight;

  const { data: rows, error: listErr } = await supabaseAdmin
    .from("google_ads_conversion_events")
    .select(
      "id, event_type, lead_id, contact_id, event_at, gclid, conversion_value, currency_code, export_status, exported_at, last_error_code, last_error_message, google_ads_lead_submissions(raw_fields)",
    )
    .eq("organization_id", orgId)
    .eq("google_ads_customer_id", selectedCustomerId)
    .order("event_at", { ascending: false })
    .limit(LIST_LIMIT);

  if (listErr) {
    console.error("[google-ads-conversion-events-list] list_failed", { code: listErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const events = ((rows ?? []) as EventRow[]).map((r) => {
    const embedded = r.google_ads_lead_submissions;
    const rawFields = Array.isArray(embedded) ? embedded[0]?.raw_fields : embedded?.raw_fields;
    const syntheticFixture = isSyntheticGoogleAdsConversionEvent(rawFields, r.gclid);
    return {
      id: r.id,
      eventType: r.event_type,
      leadId: r.lead_id,
      contactId: r.contact_id,
      eventAt: r.event_at,
      gclid: r.gclid,
      exportStatus: r.export_status,
      exportedAt: r.exported_at,
      conversionValue: r.conversion_value === null ? null : Number(r.conversion_value),
      currencyCode: r.currency_code,
      errorCode: r.last_error_code,
      errorMessage: r.last_error_message,
      syntheticFixture,
    };
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ events }),
  };
};
