// netlify/functions/google-ads-disconnect.ts
//
// Reconnect + Disconnect phase — authenticated, org-scoped Google Ads
// disconnect. Marks the org's connection as disconnected and clears the
// account-selection fields, WITHOUT deleting the row or any historical
// data anywhere else in the schema.
//
// encrypted_refresh_token is intentionally left in place, unchanged: the
// column is `bytea not null` (see supabase/migrations/
// 20260830_google_ads_oauth_foundation.sql) specifically so no code path
// can ever write a null token, and this endpoint does not weaken that
// constraint with a new migration just to support disconnect. Instead,
// disconnect relies on preflightGoogleAdsConnection() — which every
// Google Ads endpoint that calls the live API already checks first — to
// reject ANY row whose status isn't "connected" (see the "disconnected"
// branch added there in this same pass) before the stored token is ever
// decrypted or used. A stored-but-inert token is safe; a token that's
// still usable despite the user disconnecting would not be.
//
// Never deletes or modifies: google_ads_lead_submissions,
// google_ads_conversion_events, google_ads_conversion_mappings, leads,
// contacts, or any other historical/CRM data. Those all remain scoped by
// their own (organization_id, google_ads_customer_id) columns, untouched
// by this endpoint.
//
// Never returns: encrypted_refresh_token, any token, or any other
// connection-row field beyond the minimal { connected, status } shape.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

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

  const { data: connection, error: connErr } = await supabaseAdmin
    .from("google_ads_connections")
    .select("id")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (connErr) {
    console.error("[google-ads-disconnect] connection_lookup_failed", { code: connErr.code });
    return { statusCode: 500, headers, body: JSON.stringify({ error: "server_configuration" }) };
  }
  if (!connection) {
    // Nothing to disconnect — treat as an idempotent success rather than
    // an error, since the end state the caller wants (no active Google
    // Ads connection for this org) is already true.
    return { statusCode: 200, headers, body: JSON.stringify({ connected: false, status: "disconnected" }) };
  }

  const { error: updateErr } = await supabaseAdmin
    .from("google_ads_connections")
    .update({
      status: "disconnected",
      selected_customer_id: null,
      login_customer_id: null,
      accessible_customer_ids: [],
      last_error_code: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connection.id)
    .eq("organization_id", orgId);

  if (updateErr) {
    console.error("[google-ads-disconnect] update_failed", { code: updateErr.code });
    return { statusCode: 500, headers, body: JSON.stringify({ error: "server_configuration" }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ connected: false, status: "disconnected" }) };
};
