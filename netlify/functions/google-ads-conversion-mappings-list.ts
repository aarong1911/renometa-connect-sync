// netlify/functions/google-ads-conversion-mappings-list.ts
//
// Phase 3, Step 7B.1: read-only listing of google_ads_conversion_mappings
// for the authenticated organization's SELECTED Google Ads advertiser.
// Both organizationId and google_ads_customer_id are always resolved
// server-side (bearer token -> org -> that org's google_ads_connections
// row) — never accepted as query parameters, so this endpoint can never
// be used to read another organization's or another customer's mappings.
//
// Service-role DB access only — google_ads_conversion_mappings has RLS
// enabled with zero policies (see 20260902_google_ads_conversion_attribution.sql),
// so this endpoint (using the service-role client) is the only way any of
// this data is ever read.
//
// Makes no Google Ads API call at all — this is a pure database read.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { preflightGoogleAdsConnection, type GoogleAdsConnectionRowForSummary } from "./lib/google-ads-api";
import type { GoogleAdsConversionEventType } from "./lib/google-ads-conversion-events";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

interface ConnectionRow extends GoogleAdsConnectionRowForSummary {
  id: string;
}

interface MappingRow {
  event_type: GoogleAdsConversionEventType;
  conversion_action_id: string;
  enabled: boolean;
}

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
    console.error("[google-ads-conversion-mappings-list] connection_lookup_failed", { code: connErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const preflight = preflightGoogleAdsConnection(connection);
  if (!preflight.ok) {
    const statusCode = preflight.errorCode === "google_ads_not_connected" ? 404 : 409;
    return errorResponse(headers, statusCode, preflight.errorCode);
  }
  const { selectedCustomerId } = preflight;

  const { data: rows, error: mappingsErr } = await supabaseAdmin
    .from("google_ads_conversion_mappings")
    .select("event_type, conversion_action_id, enabled")
    .eq("organization_id", orgId)
    .eq("google_ads_customer_id", selectedCustomerId);

  if (mappingsErr) {
    console.error("[google-ads-conversion-mappings-list] mappings_lookup_failed", { code: mappingsErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const mappings = ((rows ?? []) as MappingRow[]).map((r) => ({
    eventType: r.event_type,
    conversionActionId: r.conversion_action_id,
    enabled: r.enabled,
  }));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ mappings }),
  };
};
