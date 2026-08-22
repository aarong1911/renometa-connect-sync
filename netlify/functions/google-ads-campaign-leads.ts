// netlify/functions/google-ads-campaign-leads.ts
//
// Google Ads Campaign -> CRM Leads Deep Link phase: read-only endpoint
// that resolves the exact set of CRM lead IDs attributed to one Google
// Ads campaign, for the Leads page's campaign-context filter (the "View
// CRM Leads" CTA on the Campaign Detail Sheet). Reuses the EXACT same
// campaign_id/campaign_name attribution rule as
// google-ads-campaign-crm-outcomes.ts, via the shared
// resolveCampaignAttributedLeadIds() helper (lib/google-ads-campaign-lead-ids.ts)
// — this endpoint never re-implements or loosens that rule.
//
// Never mutates anything, never calls a Google Ads API (pure Supabase
// reads). Never accepts organization_id or google_ads_customer_id from the
// browser — both are always resolved server-side from the authenticated
// org's own google_ads_connections row, exactly like every other Google
// Ads endpoint in this codebase. Returns only a bare list of lead IDs (no
// lead PII, no raw submission rows) — the Leads page already holds full
// lead data client-side via its own store and only needs the ID set to
// filter against.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { preflightGoogleAdsConnection, type GoogleAdsConnectionRowForSummary } from "./lib/google-ads-api";
import { resolveCampaignAttributedLeadIds, type CampaignSubmissionRow } from "./lib/google-ads-campaign-lead-ids";

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
  campaignName?: unknown;
}

function errorResponse(headers: Record<string, string>, statusCode: number, errorCode: string) {
  return { statusCode, headers, body: JSON.stringify({ error: errorCode }) };
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

  const campaignId = typeof reqBody.campaignId === "string" ? reqBody.campaignId.trim() : "";
  const campaignName = typeof reqBody.campaignName === "string" ? reqBody.campaignName.trim() : "";
  if (!campaignId && !campaignName) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "campaignId or campaignName is required" }) };
  }

  const { data: connection, error: connErr } = (await supabaseAdmin
    .from("google_ads_connections")
    .select("id, status, encrypted_refresh_token, selected_customer_id, login_customer_id")
    .eq("organization_id", orgId)
    .maybeSingle()) as unknown as { data: ConnectionRow | null; error: any };

  if (connErr) {
    console.error("[google-ads-campaign-leads] connection_lookup_failed", { code: connErr.code });
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
    .select("lead_id, campaign_id, campaign_name")
    .eq("organization_id", orgId)
    .eq("google_ads_customer_id", selectedCustomerId)
    .not("lead_id", "is", null);

  if (subErr) {
    console.error("[google-ads-campaign-leads] submissions_lookup_failed", { code: subErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const { leadIds, attributionMode } = resolveCampaignAttributedLeadIds(
    (submissions ?? []) as CampaignSubmissionRow[],
    campaignId,
    campaignName,
  );

  // Confirm every resolved lead ID actually belongs to this org before
  // returning it — submissions rows are already org-scoped by the query
  // above, but this is a cheap, explicit same-org guard rather than
  // trusting that scoping alone (Step 14).
  let scopedLeadIds = leadIds;
  if (leadIds.length > 0) {
    const { data: leadRows, error: leadErr } = await supabaseAdmin
      .from("leads")
      .select("id")
      .eq("org_id", orgId)
      .in("id", leadIds);

    if (leadErr) {
      console.error("[google-ads-campaign-leads] leads_lookup_failed", { code: leadErr.code });
      return errorResponse(headers, 500, "server_configuration");
    }
    scopedLeadIds = ((leadRows ?? []) as { id: string }[]).map((r) => r.id);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      campaignId: campaignId || null,
      campaignName: campaignName || null,
      leadIds: scopedLeadIds,
      attributionMode,
    }),
  };
};
