// netlify/functions/google-ads-ad-group-crm-outcomes.ts
//
// Ad Group-Level CRM Outcomes phase: read-only ad-group -> CRM outcomes
// rollup for the Ad Group Detail view, mirroring
// google-ads-campaign-crm-outcomes.ts exactly but scoped one level deeper.
// Answers "how many of THIS AD GROUP's Google Ads leads turned into
// qualified leads / appointments / won deals / won value inside RenoMeta"
// — never mutates anything, and makes ZERO calls to
// googleads.googleapis.com (Step 27): this endpoint only reads data
// RenoMeta already ingested into Supabase, so CRM reporting here is fully
// independent of Google Ads API availability.
//
// Attribution (Step 3/4/15): a CRM lead belongs to this ad group ONLY when
// a google_ads_lead_submissions row has lead_id NOT NULL and
// ad_group_id = the requested adGroupId (exact match, never derived from
// ad group name, contact, or "latest submission"). Unlike campaign
// attribution, there is NO name-fallback path here — a submission row with
// ad_group_id IS NULL is never attributed to any ad group. See
// lib/google-ads-ad-group-lead-ids.ts's resolveAdGroupAttributedLeadIds()
// for the exact rule and the campaign_id cross-check.
//
// Deal linkage reuses the EXACT same canonical relationship rule as
// campaign outcomes: deals.lead_id === lead.id (direct FK, exact
// equality), never attributed via contact alone.
//
// Appointment linkage reuses google-ads-campaign-attribution.ts's
// resolveCampaignAttributedAppointmentIds() AS-IS, completely unmodified —
// that function was already generic (it only ever operates on a caller-
// supplied "attributed lead" list + appointments + a global per-contact
// Google-attributed-lead count map; it has no campaign-specific logic
// baked in), so it is reused directly here with this ad group's attributed
// leads in place of a campaign's. The ambiguity count
// (googleAttributedLeadCountByContact) is still computed across EVERY
// submission for this org+customer — never narrowed to just this ad
// group — exactly matching the campaign endpoint's "evaluate ambiguity
// globally across the advertiser" rule (Step 8).
//
// Never returns raw_fields, gclid, PII, raw lead/appointment/deal rows, or
// any Google Ads token. Never accepts organization_id or
// google_ads_customer_id from the browser — both are always resolved
// server-side from the authenticated org's own google_ads_connections row.
// Never returns a fabricated currencyCode for wonValue — same currency-
// silent policy as campaign outcomes (see formatPlainMoneyValue() on the
// frontend).

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { preflightGoogleAdsConnection, type GoogleAdsConnectionRowForSummary } from "./lib/google-ads-api";
import { resolveCampaignAttributedAppointmentIds } from "./lib/google-ads-campaign-attribution";
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

function digitsOnly(value: unknown): string {
  return typeof value === "string" && /^\d+$/.test(value.trim()) ? value.trim() : "";
}

export const handler: Handler = async (event) => {
  const headers = googleAdsCorsHeaders(event, "POST, OPTIONS");
  const logError = (phase: string, extra?: Record<string, unknown>) =>
    console.error(`[google-ads-ad-group-crm-outcomes] ${phase}`, extra ?? {});

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

  // Preflight only — this endpoint never decrypts the refresh token or
  // calls Google (Step 27). preflightGoogleAdsConnection() still needs the
  // encrypted_refresh_token COLUMN selected (to confirm one is present),
  // it is simply never read/decrypted/used past this check.
  const { data: connection, error: connErr } = (await supabaseAdmin
    .from("google_ads_connections")
    .select("id, status, encrypted_refresh_token, selected_customer_id, login_customer_id")
    .eq("organization_id", orgId)
    .maybeSingle()) as unknown as { data: ConnectionRow | null; error: any };

  if (connErr) {
    logError("connection_lookup_failed", { code: connErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const preflight = preflightGoogleAdsConnection(connection);
  if (!preflight.ok) {
    const statusCode = preflight.errorCode === "google_ads_not_connected" ? 404 : 409;
    return errorResponse(headers, statusCode, preflight.errorCode);
  }
  const { selectedCustomerId } = preflight;

  // ── 1. This ad group's provider submissions, scoped to the org's
  // selected advertiser only — same "fetch every submission for (org,
  // customer), filter in code" approach as the campaign endpoint, so no
  // caller-supplied string is ever interpolated into a PostgREST filter
  // expression.
  const { data: submissions, error: subErr } = await supabaseAdmin
    .from("google_ads_lead_submissions")
    .select("id, lead_id, campaign_id, ad_group_id")
    .eq("organization_id", orgId)
    .eq("google_ads_customer_id", selectedCustomerId)
    .not("lead_id", "is", null);

  if (subErr) {
    logError("submissions_lookup_failed", { code: subErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const leadIds = resolveAdGroupAttributedLeadIds(
    (submissions ?? []) as AdGroupSubmissionRow[],
    campaignId,
    adGroupId,
  );

  if (leadIds.length === 0) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        campaignId,
        adGroupId,
        outcomes: { leads: 0, qualifiedLeads: 0, appointments: 0, wonDeals: 0, wonValue: 0 },
      }),
    };
  }

  // ── 2. Leads — CRM lead rows, not raw submission rows; leadIds is
  // already deduplicated, so this count can never double-count a repeated
  // Google submission.
  const { data: leadRows, error: leadErr } = await supabaseAdmin
    .from("leads")
    .select("id, status, contact_id")
    .eq("org_id", orgId)
    .in("id", leadIds);

  if (leadErr) {
    logError("leads_lookup_failed", { code: leadErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }
  const leads = (leadRows ?? []) as LeadRow[];
  const qualifiedLeads = leads.filter((l) => l.status === "qualified").length;

  // ── 3. Appointments — reuses resolveCampaignAttributedAppointmentIds()
  // unmodified (see module doc comment). The ambiguity map is computed
  // from EVERY Google-attributed lead for this org+customer, never just
  // this ad group's, exactly mirroring the campaign endpoint's global
  // ambiguity evaluation (Step 8).
  const leadIdSet = new Set(leads.map((l) => l.id));
  const contactIds = [...new Set(leads.map((l) => l.contact_id).filter((c): c is string => !!c))];

  let appointments = 0;
  if (leadIdSet.size > 0 || contactIds.length > 0) {
    const allGoogleAttributedLeadIds = [...new Set(
      ((submissions ?? []) as AdGroupSubmissionRow[]).map((s) => s.lead_id).filter((id): id is string => !!id),
    )];

    const { data: allGoogleLeadRows, error: allLeadsErr } = await supabaseAdmin
      .from("leads")
      .select("id, contact_id")
      .eq("org_id", orgId)
      .in("id", allGoogleAttributedLeadIds);

    if (allLeadsErr) {
      logError("all_google_leads_lookup_failed", { code: allLeadsErr.code });
      return errorResponse(headers, 500, "server_configuration");
    }

    const googleAttributedLeadCountByContact = new Map<string, number>();
    for (const row of (allGoogleLeadRows ?? []) as { id: string; contact_id: string | null }[]) {
      if (!row.contact_id) continue;
      googleAttributedLeadCountByContact.set(row.contact_id, (googleAttributedLeadCountByContact.get(row.contact_id) ?? 0) + 1);
    }

    const orParts: string[] = [];
    if (leadIdSet.size > 0) orParts.push(`and(entity_type.eq.lead,entity_id.in.(${[...leadIdSet].join(",")}))`);
    if (contactIds.length > 0) orParts.push(`contact_id.in.(${contactIds.join(",")})`);

    const { data: apptRows, error: apptErr } = await supabaseAdmin
      .from("appointments")
      .select("id, entity_type, entity_id, contact_id")
      .eq("org_id", orgId)
      .or(orParts.join(","));

    if (apptErr) {
      logError("appointments_lookup_failed", { code: apptErr.code });
      return errorResponse(headers, 500, "server_configuration");
    }

    const matchedAppointmentIds = resolveCampaignAttributedAppointmentIds(
      (apptRows ?? []) as AppointmentRow[],
      leads.map((l) => ({ id: l.id, contact_id: l.contact_id })),
      googleAttributedLeadCountByContact,
    );
    appointments = matchedAppointmentIds.size;
  }

  // ── 4. Won deals + won value — exact deals.lead_id linkage only, never
  // attributed via contact alone. Canonical monetary value is ALWAYS
  // deals.value for a 'won' deal — never estimates, never Google's own
  // conversion_value.
  const { data: dealRows, error: dealErr } = await supabaseAdmin
    .from("deals")
    .select("id, lead_id, status, value")
    .eq("org_id", orgId)
    .in("lead_id", leadIds)
    .eq("status", "won");

  if (dealErr) {
    logError("deals_lookup_failed", { code: dealErr.code });
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
      campaignId,
      adGroupId,
      outcomes: {
        leads: leads.length,
        qualifiedLeads,
        appointments,
        wonDeals,
        wonValue,
      },
    }),
  };
};
