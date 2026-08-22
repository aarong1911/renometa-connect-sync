// netlify/functions/google-ads-ad-group-leads.ts
//
// Ad Group -> CRM Leads Deep Link phase: read-only endpoint that resolves
// the exact set of CRM lead IDs attributed to one Google Ads ad group, for
// the Leads page's Ad Group-context filter (the "View CRM Leads" CTA on
// the Ad Group Detail view). Mirrors google-ads-campaign-leads.ts exactly,
// one level deeper — reuses the EXACT same ad_group_id attribution rule as
// google-ads-ad-group-crm-outcomes.ts, via the shared
// resolveAdGroupAttributedLeadIds() helper
// (lib/google-ads-ad-group-lead-ids.ts). Never re-implements or loosens
// that rule, and never falls back to ad_group_name (there is no such
// column, and none is fabricated here).
//
// Never mutates anything, never calls a Google Ads API (pure Supabase
// reads) — preflightGoogleAdsConnection() only validates the stored
// connection row; it never decrypts/uses the refresh token or refreshes an
// access token. Never accepts organization_id or google_ads_customer_id
// from the browser — both are always resolved server-side from the
// authenticated org's own google_ads_connections row. Returns only a bare
// list of lead IDs — no PII, no GCLID, no raw submission rows. The Leads
// page already holds full lead data client-side via its own store and only
// needs the ID set to filter against.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { preflightGoogleAdsConnection, type GoogleAdsConnectionRowForSummary } from "./lib/google-ads-api";
import { resolveAdGroupAttributedLeadIds, type AdGroupSubmissionRow } from "./lib/google-ads-ad-group-lead-ids";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

interface ConnectionRow extends GoogleAdsConnectionRowForSummary {
  id: string;
}

interface RequestBody {
  campaignId?: unknown;
  adGroupId?: unknown;
}

function errorResponse(headers: Record<string, string>, statusCode: number, errorCode: string) {
  return { statusCode, headers, body: JSON.stringify({ error: errorCode }) };
}

function digitsOnly(value: unknown): string {
  return typeof value === "string" && /^\d+$/.test(value.trim()) ? value.trim() : "";
}

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

  const campaignId = digitsOnly(reqBody.campaignId);
  const adGroupId = digitsOnly(reqBody.adGroupId);
  if (!campaignId || !adGroupId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "campaignId and adGroupId must both be digit-only strings" }) };
  }

  const { data: connection, error: connErr } = (await supabaseAdmin
    .from("google_ads_connections")
    .select("id, status, encrypted_refresh_token, selected_customer_id, login_customer_id")
    .eq("organization_id", orgId)
    .maybeSingle()) as unknown as { data: ConnectionRow | null; error: any };

  if (connErr) {
    console.error("[google-ads-ad-group-leads] connection_lookup_failed", { code: connErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const preflight = preflightGoogleAdsConnection(connection);
  if (!preflight.ok) {
    const statusCode = preflight.errorCode === "google_ads_not_connected" ? 404 : 409;
    return errorResponse(headers, statusCode, preflight.errorCode);
  }
  const { selectedCustomerId } = preflight;

  const { data: submissions, error: subErr } = await supabaseAdmin
    .from("google_ads_lead_submissions")
    .select("lead_id, campaign_id, ad_group_id")
    .eq("organization_id", orgId)
    .eq("google_ads_customer_id", selectedCustomerId)
    .not("lead_id", "is", null);

  if (subErr) {
    console.error("[google-ads-ad-group-leads] submissions_lookup_failed", { code: subErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const leadIds = resolveAdGroupAttributedLeadIds(
    (submissions ?? []) as AdGroupSubmissionRow[],
    campaignId,
    adGroupId,
  );

  // Confirm every resolved lead ID actually belongs to this org before
  // returning it — submissions rows are already org-scoped by the query
  // above, but this is a cheap, explicit same-org guard rather than
  // trusting that scoping alone (same pattern as google-ads-campaign-leads.ts).
  let scopedLeadIds = leadIds;
  if (leadIds.length > 0) {
    const { data: leadRows, error: leadErr } = await supabaseAdmin
      .from("leads")
      .select("id")
      .eq("org_id", orgId)
      .in("id", leadIds);

    if (leadErr) {
      console.error("[google-ads-ad-group-leads] leads_lookup_failed", { code: leadErr.code });
      return errorResponse(headers, 500, "server_configuration");
    }
    scopedLeadIds = ((leadRows ?? []) as { id: string }[]).map((r) => r.id);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ leadIds: scopedLeadIds }),
  };
};
