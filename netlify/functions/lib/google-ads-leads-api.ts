// netlify/functions/lib/google-ads-leads-api.ts
//
// Google Ads lead-form submission (lead_form_submission_data) query
// building + row parsing — used by google-ads-lead-sync.ts. Kept separate
// from google-ads-api.ts (account/campaign reporting) since this is a
// distinct resource with its own query shape and attribution fields, but
// deliberately REUSES that file's GOOGLE_ADS_API_VERSION, searchGoogleAds(),
// and GoogleAdsApiError rather than a second copy of any of them — there is
// exactly one Google Ads API version and one googleAds:search caller in
// this codebase.
//
// lead_form_submission_data has been a stable Google Ads API resource
// since v9 and remains present through the configured GOOGLE_ADS_API_VERSION
// (see google-ads-api.ts) — this was verified against Google's public API
// reference at implementation time, not against a live call (no live
// Google Ads API call is made outside the actual sync function). If a
// future API version ever drops/renames a field this query selects, the
// first real sync attempt will surface it as a normal Google 400 response,
// which google-ads-lead-sync.ts already normalizes to a safe
// "google_ads_api_error" rather than crashing.

// customers/{id}/campaigns/{id} -> "{id}" (last path segment). Generic
// enough for campaign/asset/ad_group resource names; ad_group_ad resource
// names are a composite ("{ad_group_id}~{ad_id}") and are returned as-is
// rather than guessed apart further.
function lastResourceSegment(resourceName: string | null | undefined): string | null {
  if (!resourceName) return null;
  const parts = resourceName.split("/");
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : null;
}

// Builds the fixed, server-owned GAQL query for lead_form_submission_data.
// `sinceUtc`, when provided, adds an incremental WHERE clause — never
// accepted from the browser (see google-ads-lead-sync.ts, which computes
// this server-side from the stored lead_last_synced_at, never a request
// parameter).
export function buildGoogleAdsLeadFormSubmissionQuery(sinceUtc: Date | null): string {
  const fields = [
    "lead_form_submission_data.id",
    "lead_form_submission_data.resource_name",
    "lead_form_submission_data.submission_date_time",
    "lead_form_submission_data.gclid",
    "lead_form_submission_data.campaign",
    "lead_form_submission_data.asset",
    "lead_form_submission_data.ad_group",
    "lead_form_submission_data.ad_group_ad",
    "lead_form_submission_data.lead_form_submission_fields",
    "lead_form_submission_data.custom_lead_form_submission_fields",
    "campaign.id",
    "campaign.name",
  ].join(", ");

  let query = `SELECT ${fields} FROM lead_form_submission_data`;
  if (sinceUtc) {
    query += ` WHERE lead_form_submission_data.submission_date_time >= '${formatGoogleAdsDateTimeLiteral(sinceUtc)}'`;
  }
  return query;
}

// 'YYYY-MM-DD HH:MM:SS' in UTC — Postgres/GAQL-parseable datetime literal
// format, avoiding local-timezone ambiguity.
function formatGoogleAdsDateTimeLiteral(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export interface GoogleAdsLeadFormSubmissionRow {
  submissionId: string;
  resourceName: string | null;
  submissionDateTime: string | null;
  gclid: string | null;
  campaignResourceName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  assetResourceName: string | null;
  assetId: string | null;
  adGroupResourceName: string | null;
  adGroupId: string | null;
  adGroupAdResourceName: string | null;
  adGroupAdId: string | null;
  // Raw, unmodified arrays as Google returned them — preserved verbatim by
  // the caller into raw_fields/raw_custom_fields (Part B7: never discard
  // unknown fields), independent of whatever normalizeGoogleAdsLeadFields()
  // extracts from them.
  rawFields: unknown[];
  rawCustomFields: unknown[];
}

// Parses one googleAds:search result row for the lead-form-submission
// query above. Returns null for a row with no usable submission ID — that
// ID is the entire idempotency key (see the DB unique constraint on
// google_ads_lead_submissions), so a row without one cannot be safely
// ingested at all. Never assumes ad_group/ad_group_ad/asset are present
// (Part B3) — all attribution fields are independently nullable.
export function parseGoogleAdsLeadFormSubmissionRow(row: unknown): GoogleAdsLeadFormSubmissionRow | null {
  const r = row as any;
  const lfsd = r?.leadFormSubmissionData;
  if (!lfsd) return null;

  const submissionId = lfsd.id != null ? String(lfsd.id) : null;
  if (!submissionId) return null;

  const campaignResourceName = typeof lfsd.campaign === "string" ? lfsd.campaign : null;
  const assetResourceName = typeof lfsd.asset === "string" ? lfsd.asset : null;
  const adGroupResourceName = typeof lfsd.adGroup === "string" ? lfsd.adGroup : null;
  const adGroupAdResourceName = typeof lfsd.adGroupAd === "string" ? lfsd.adGroupAd : null;

  const campaign = r?.campaign;
  const campaignId = campaign?.id != null ? String(campaign.id) : lastResourceSegment(campaignResourceName);
  const campaignName = typeof campaign?.name === "string" ? campaign.name : null;

  return {
    submissionId,
    resourceName: typeof lfsd.resourceName === "string" ? lfsd.resourceName : null,
    submissionDateTime: typeof lfsd.submissionDateTime === "string" ? lfsd.submissionDateTime : null,
    gclid: typeof lfsd.gclid === "string" ? lfsd.gclid : null,
    campaignResourceName,
    campaignId,
    campaignName,
    assetResourceName,
    assetId: lastResourceSegment(assetResourceName),
    adGroupResourceName,
    adGroupId: lastResourceSegment(adGroupResourceName),
    adGroupAdResourceName,
    adGroupAdId: lastResourceSegment(adGroupAdResourceName),
    rawFields: Array.isArray(lfsd.leadFormSubmissionFields) ? lfsd.leadFormSubmissionFields : [],
    rawCustomFields: Array.isArray(lfsd.customLeadFormSubmissionFields) ? lfsd.customLeadFormSubmissionFields : [],
  };
}
