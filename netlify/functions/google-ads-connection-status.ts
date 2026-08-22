// netlify/functions/google-ads-connection-status.ts
//
// Read-only, authenticated status check for the org's Google Ads
// connection — mirrors gmail-connection-status.ts / meta-connection-status.ts.
// Used by Settings → Integrations to drive the Google Ads card's real
// state (never trusts the OAuth-callback's redirect query param as lasting
// truth — see settings.integrations.tsx). Never returns
// encrypted_refresh_token or anything else that could reveal token
// material; never decrypts it either, since this endpoint has no need to.
//
// The actual response-shaping logic (status/error-code allowlisting,
// digit-only ID normalization, connected-requires-a-selection) lives in
// buildGoogleAdsStatusPayload() (lib/google-ads-api.ts) — a pure function
// so it's directly unit-testable without a live Supabase connection.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { buildGoogleAdsStatusPayload, type GoogleAdsConnectionRowForStatus } from "./lib/google-ads-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

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

  // Explicitly typed for the same reason meta-connection-status.ts casts
  // its query result — supabaseAdmin has no <Database> generic anywhere in
  // this codebase, so .select() can't infer a row shape. Note the select
  // list deliberately never includes encrypted_refresh_token.
  const { data: row, error } = (await supabaseAdmin
    .from("google_ads_connections")
    .select("status, selected_customer_id, login_customer_id, accessible_customer_ids, last_synced_at, last_error_code")
    .eq("organization_id", orgId)
    .maybeSingle()) as unknown as { data: GoogleAdsConnectionRowForStatus | null; error: any };

  if (error) {
    console.error("[google-ads-connection-status] lookup failed", { code: error.code });
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to load Google Ads connection status" }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify(buildGoogleAdsStatusPayload(row)) };
};
