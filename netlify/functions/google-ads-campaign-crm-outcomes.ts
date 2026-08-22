// netlify/functions/google-ads-campaign-crm-outcomes.ts
//
// Phase 3 — Google Ads product phase: read-only campaign -> CRM outcomes
// rollup for the Campaign Detail Sheet. Answers "how many of this
// campaign's Google Ads leads turned into qualified leads / appointments /
// won deals / won value inside RenoMeta" — never mutates anything, never
// calls a Google Ads API at all (this endpoint is pure Supabase reads).
//
// Attribution (Step 6): each CRM lead is associated with a campaign
// through its EXACT google_ads_lead_submissions row — campaign_id
// preferred, campaign_name used only as a documented fallback for rows
// where campaign_id is null (e.g. the local dev test-injection harness,
// which never supplies a campaign ID — see google-ads-lead-test-inject.ts).
// Never attributes by "this contact's other leads" or "the latest Google
// submission" — only the submission(s) that actually match this exact
// campaign identify which lead_ids are "this campaign's leads".
//
// Deal linkage reuses the EXACT same canonical relationship rule
// established by resolveGoogleAdsConversionMilestone() (lib/google-ads-
// conversion-events.ts): deals.lead_id === lead.id (direct FK, exact
// equality), never attributed via contact alone.
//
// Appointment linkage (Google Ads Campaign Outcomes Hardening pass) uses
// a DELIBERATELY STRICTER, campaign-reporting-specific rule — see
// lib/google-ads-campaign-attribution.ts's resolveCampaignAttributedAppointmentIds()
// for the full rationale and rule definition. In short: an exact
// entity_type='lead' link always wins; a contact-only appointment is only
// attributed when that contact maps to EXACTLY ONE Google-Ads-attributed
// lead across the whole org+customer (never just this campaign) — a
// shared contact with Google-attributed leads in multiple campaigns (or
// even multiple leads within this same campaign) makes a contact-only
// appointment ambiguous, and it is then attributed to NO campaign at all.
// This is intentionally stricter than resolveGoogleAdsConversionMilestone()'s
// own single-lead contact fallback, which remains unchanged — that
// resolver is always evaluated in the context of one already-validated
// lead, where a broader fallback is safe; aggregating many leads at once
// for campaign reporting is not the same problem, and is never solved by
// reusing that same broader rule.
//
// Never returns raw_fields, gclid, or any other row beyond the small
// sanitized outcome counts below. Never accepts organization_id or
// google_ads_customer_id from the browser — both are always resolved
// server-side from the authenticated org's own google_ads_connections row.
// Never returns a fabricated currencyCode for wonValue — see the Won
// value section below.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { preflightGoogleAdsConnection, type GoogleAdsConnectionRowForSummary } from "./lib/google-ads-api";
import { resolveCampaignAttributedAppointmentIds } from "./lib/google-ads-campaign-attribution";
import { resolveCampaignAttributedLeadIds } from "./lib/google-ads-campaign-lead-ids";

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

interface SubmissionRow {
  id: string;
  lead_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
}

interface LeadRow {
  id: string;
  status: string | null;
  contact_id: string | null;
}

interface AppointmentRow {
  id: string;
  entity_type: string | null;
  entity_id: string | null;
  contact_id: string | null;
}

interface DealRow {
  id: string;
  lead_id: string | null;
  status: string;
  value: number | string | null;
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
    console.error("[google-ads-campaign-crm-outcomes] connection_lookup_failed", { code: connErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const preflight = preflightGoogleAdsConnection(connection);
  if (!preflight.ok) {
    const statusCode = preflight.errorCode === "google_ads_not_connected" ? 404 : 409;
    return errorResponse(headers, statusCode, preflight.errorCode);
  }
  const { selectedCustomerId } = preflight;

  // ── 1. Find this campaign's provider submissions, scoped to this org's
  // selected advertiser only. Fetches every submission for (org, customer)
  // rather than pushing the campaign_id/campaign_name OR-condition into
  // PostgREST's filter syntax — avoids interpolating caller-supplied
  // strings into a `.or()` filter expression, and the per-org row count
  // here is small.
  const { data: submissions, error: subErr } = await supabaseAdmin
    .from("google_ads_lead_submissions")
    .select("id, lead_id, campaign_id, campaign_name")
    .eq("organization_id", orgId)
    .eq("google_ads_customer_id", selectedCustomerId)
    .not("lead_id", "is", null);

  if (subErr) {
    console.error("[google-ads-campaign-crm-outcomes] submissions_lookup_failed", { code: subErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  // campaign_id match is authoritative; campaign_name is ONLY consulted
  // for a row that has no campaign_id at all (Step 6/18) — never as an
  // override for a row that already has a real, different campaign_id.
  // Shared with google-ads-campaign-leads.ts (the Leads-page deep-link
  // filter endpoint) via resolveCampaignAttributedLeadIds() so both
  // endpoints resolve the exact same lead_id set from the exact same rule.
  const { leadIds, attributionMode } = resolveCampaignAttributedLeadIds(
    (submissions ?? []) as SubmissionRow[],
    campaignId,
    campaignName,
  );

  if (leadIds.length === 0) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        campaignId: campaignId || null,
        campaignName: campaignName || null,
        outcomes: { leads: 0, qualifiedLeads: 0, appointments: 0, wonDeals: 0, wonValue: 0 },
        attributionMode,
      }),
    };
  }

  // ── 2. Leads (Step 8/9) — CRM lead rows, not raw submission rows;
  // leadIds is already a Set, so this count can never double-count a
  // repeated Google submission or an already-deduped provider row.
  const { data: leadRows, error: leadErr } = await supabaseAdmin
    .from("leads")
    .select("id, status, contact_id")
    .eq("org_id", orgId)
    .in("id", leadIds);

  if (leadErr) {
    console.error("[google-ads-campaign-crm-outcomes] leads_lookup_failed", { code: leadErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }
  const leads = (leadRows ?? []) as LeadRow[];
  const qualifiedLeads = leads.filter((l) => l.status === "qualified").length;

  // ── 3. Appointments — campaign-reporting-safe attribution (see the
  // module doc comment and lib/google-ads-campaign-attribution.ts).
  const leadIdSet = new Set(leads.map((l) => l.id));
  const contactIds = [...new Set(leads.map((l) => l.contact_id).filter((c): c is string => !!c))];

  let appointments = 0;
  if (leadIdSet.size > 0 || contactIds.length > 0) {
    // 3a. The global Google-attributed-lead count per contact — computed
    // from EVERY submission for this org+customer (already fetched above
    // as `submissions`), never limited to just this campaign's own leads.
    // This is what lets the helper tell an unambiguous contact (exactly
    // one Google-attributed lead, period) apart from an ambiguous one
    // (2+ Google-attributed leads, in this campaign or any other).
    const allGoogleAttributedLeadIds = [...new Set(
      ((submissions ?? []) as SubmissionRow[]).map((s) => s.lead_id).filter((id): id is string => !!id),
    )];

    const { data: allGoogleLeadRows, error: allLeadsErr } = await supabaseAdmin
      .from("leads")
      .select("id, contact_id")
      .eq("org_id", orgId)
      .in("id", allGoogleAttributedLeadIds);

    if (allLeadsErr) {
      console.error("[google-ads-campaign-crm-outcomes] all_google_leads_lookup_failed", { code: allLeadsErr.code });
      return errorResponse(headers, 500, "server_configuration");
    }

    const googleAttributedLeadCountByContact = new Map<string, number>();
    for (const row of (allGoogleLeadRows ?? []) as { id: string; contact_id: string | null }[]) {
      if (!row.contact_id) continue;
      googleAttributedLeadCountByContact.set(row.contact_id, (googleAttributedLeadCountByContact.get(row.contact_id) ?? 0) + 1);
    }

    // 3b. Candidate appointments — same fetch scope as before (exact
    // entity link to a campaign lead, OR a shared contact_id) — the
    // STRICTER rule is applied afterward in resolveCampaignAttributedAppointmentIds(),
    // not by narrowing this query.
    const orParts: string[] = [];
    if (leadIdSet.size > 0) orParts.push(`and(entity_type.eq.lead,entity_id.in.(${[...leadIdSet].join(",")}))`);
    if (contactIds.length > 0) orParts.push(`contact_id.in.(${contactIds.join(",")})`);

    const { data: apptRows, error: apptErr } = await supabaseAdmin
      .from("appointments")
      .select("id, entity_type, entity_id, contact_id")
      .eq("org_id", orgId)
      .or(orParts.join(","));

    if (apptErr) {
      console.error("[google-ads-campaign-crm-outcomes] appointments_lookup_failed", { code: apptErr.code });
      return errorResponse(headers, 500, "server_configuration");
    }

    const matchedAppointmentIds = resolveCampaignAttributedAppointmentIds(
      (apptRows ?? []) as AppointmentRow[],
      leads.map((l) => ({ id: l.id, contact_id: l.contact_id })),
      googleAttributedLeadCountByContact,
    );
    appointments = matchedAppointmentIds.size;
  }

  // ── 4. Won deals + won value (Step 11/12) — exact deals.lead_id linkage
  // only, never attributed via contact alone. Canonical monetary value is
  // ALWAYS deals.value for a 'won' deal — never estimates, never Google's
  // own conversion_value.
  const { data: dealRows, error: dealErr } = await supabaseAdmin
    .from("deals")
    .select("id, lead_id, status, value")
    .eq("org_id", orgId)
    .in("lead_id", leadIds)
    .eq("status", "won");

  if (dealErr) {
    console.error("[google-ads-campaign-crm-outcomes] deals_lookup_failed", { code: dealErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }
  const wonDealRows = (dealRows ?? []) as DealRow[];
  const wonDeals = wonDealRows.length;
  const wonValue = wonDealRows.reduce((sum, d) => {
    const n = d.value === null || d.value === undefined ? 0 : Number(d.value);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      campaignId: campaignId || null,
      campaignName: campaignName || null,
      outcomes: {
        leads: leads.length,
        qualifiedLeads,
        appointments,
        wonDeals,
        wonValue,
      },
      attributionMode,
    }),
  };
};
