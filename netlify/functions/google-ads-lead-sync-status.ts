// netlify/functions/google-ads-lead-sync-status.ts
//
// Read-only, authenticated status check for Google Ads lead-form
// ingestion — mirrors google-ads-connection-status.ts's shape/precedent,
// but for the lead-sync-specific columns added by
// 20260901_google_ads_lead_ingestion.sql (lead_last_synced_at/
// lead_last_error_code) plus a simple last-30-days submission count. Pure
// DB reads only — no Google API call, no token decrypt/refresh, so this is
// safe to call on every Marketing → Google Ads tab load without spending a
// live API request.
//
// Never returns encrypted_refresh_token or any other connection-row field
// beyond what's explicitly selected below.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { GOOGLE_ADS_SAFE_ERROR_CODES } from "./lib/google-ads-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const LAST_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface ConnectionRow {
  status: string;
  lead_last_synced_at: string | null;
  lead_last_error_code: string | null;
}

function disconnectedResponse(headers: Record<string, string>) {
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ connected: false, lastSyncedAt: null, lastErrorCode: null, last30DaysCount: 0 }),
  };
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
    .select("status, lead_last_synced_at, lead_last_error_code")
    .eq("organization_id", orgId)
    .maybeSingle()) as unknown as { data: ConnectionRow | null; error: any };

  if (connErr) {
    console.error("[google-ads-lead-sync-status] lookup failed", { code: connErr.code });
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to load Google Ads lead sync status" }) };
  }
  if (!connection || connection.status !== "connected") {
    return disconnectedResponse(headers);
  }

  const since = new Date(Date.now() - LAST_30_DAYS_MS).toISOString();
  const { count, error: countErr } = await supabaseAdmin
    .from("google_ads_lead_submissions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .gte("submission_date_time", since);

  if (countErr) {
    console.error("[google-ads-lead-sync-status] count failed", { code: countErr.code });
  }

  const lastErrorCode = connection.lead_last_error_code && GOOGLE_ADS_SAFE_ERROR_CODES.has(connection.lead_last_error_code)
    ? connection.lead_last_error_code
    : null;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      connected: true,
      lastSyncedAt: connection.lead_last_synced_at ?? null,
      lastErrorCode,
      last30DaysCount: countErr ? 0 : (count ?? 0),
    }),
  };
};
