// src/lib/google-ads-format.ts
//
// Shared frontend types + display formatting for the Google Ads
// integration — used by both settings.integrations.tsx (card + status
// polling) and integration-config-drawer.tsx (account-selection UI), so
// the two never drift on the shape of what the backend endpoints return.

export type GoogleAdsSafeStatus =
  | "disconnected"
  | "connected"
  | "needs_account_selection"
  | "needs_account_sync"
  | "error";

export interface GoogleAdsConnectionStatusResponse {
  connected: boolean;
  status: GoogleAdsSafeStatus;
  selectedCustomerId: string | null;
  loginCustomerId: string | null;
  accessibleCustomerIds: string[];
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
}

export interface GoogleAdsSafeAccount {
  customerId: string;
  descriptiveName: string | null;
  manager: boolean;
  testAccount: boolean | null;
  status: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  loginCustomerId: string | null;
  level: number | null;
}

// "3055292074" -> "305-529-2074" (Google's own display convention). Falls
// back to the raw digits for anything that isn't exactly 10 digits, rather
// than guessing at a different grouping.
export function formatGoogleAdsCustomerId(id: string | null | undefined): string {
  if (!id) return "";
  const digits = id.replace(/\D/g, "");
  if (digits.length !== 10) return digits;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// ── Campaign-performance types + formatting ────────────────────────────
// Mirrors netlify/functions/google-ads-campaign-performance.ts's response
// shape exactly (see GoogleAdsCampaignPerformance /
// GoogleAdsCampaignPerformanceSummary in lib/google-ads-api.ts on the
// backend) — used by src/lib/google-ads-client.ts and the Marketing →
// Google Ads tab so the two never drift.

export type GoogleAdsCampaignPerformanceDateRange = "LAST_30_DAYS";

export interface GoogleAdsCampaignPerformanceRow {
  campaignId: string;
  name: string;
  status: string | null;
  advertisingChannelType: string | null;
  // impressions/clicks/costMicros are base-10 integer STRINGS, never
  // numbers — a large account can exceed Number.MAX_SAFE_INTEGER in
  // micros, so these are never coerced through Number() wholesale.
  impressions: string;
  clicks: string;
  costMicros: string;
  conversions: number;
  conversionValue: number;
}

export interface GoogleAdsCampaignPerformanceSummary {
  campaigns: number;
  impressions: string;
  clicks: string;
  costMicros: string;
  conversions: number;
  conversionValue: number;
}

export interface GoogleAdsCampaignPerformanceResponse {
  connected: true;
  customerId: string;
  loginCustomerId: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  dateRange: GoogleAdsCampaignPerformanceDateRange;
  summary: GoogleAdsCampaignPerformanceSummary;
  campaigns: GoogleAdsCampaignPerformanceRow[];
}

// A currencyCode is only ever missing if the connected account's own
// Google Ads data omitted it (shouldn't happen for a real account) — this
// fallback exists purely so Intl.NumberFormat has a valid ISO 4217 code to
// construct with; it is never used to override a real currencyCode the API
// actually returned (ILL, USD, etc. all pass through untouched).
function resolveCurrencyCode(currencyCode: string | null | undefined): string {
  return currencyCode && /^[A-Z]{3}$/.test(currencyCode) ? currencyCode : "USD";
}

// Converts a base-10 integer STRING of Google Ads "micros" (1e-6 of a
// currency unit) into a JS number of actual currency units, without ever
// passing the full (potentially unsafe-precision) string through Number()
// directly. For any realistic spend amount this never matters (micros stay
// well under Number.MAX_SAFE_INTEGER for any account spending less than
// ~9 billion currency units), but the BigInt-based split below keeps the
// conversion exact even in that theoretical edge case rather than silently
// truncating.
export function costMicrosToAmount(costMicros: string | null | undefined): number {
  let micros: bigint;
  try {
    micros = BigInt(costMicros && /^\d+$/.test(costMicros) ? costMicros : "0");
  } catch {
    micros = 0n;
  }
  if (micros <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(micros) / 1_000_000;
  }
  const whole = micros / 1_000_000n;
  const remainderMicros = micros % 1_000_000n;
  return Number(whole) + Number(remainderMicros) / 1_000_000;
}

// Locale-aware currency formatting for an already-in-currency-units amount
// (e.g. metrics.conversions_value, which Google Ads returns in actual
// currency units, NOT micros — never route that field through
// costMicrosToAmount). Never hardcodes a currency symbol; Intl derives the
// correct symbol/placement from the ISO code (e.g. "ILS" -> "₪").
export function formatGoogleAdsCurrency(amount: number, currencyCode: string | null | undefined): string {
  const currency = resolveCurrencyCode(currencyCode);
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(safeAmount);
  } catch {
    // Only reachable for a malformed/unrecognized ISO code — falls back to
    // a plain, still-correct-magnitude "CODE 0.00" rendering.
    return `${currency} ${safeAmount.toFixed(2)}`;
  }
}

// Spend specifically — costMicros (string) -> currency-formatted string.
export function formatGoogleAdsSpend(costMicros: string | null | undefined, currencyCode: string | null | undefined): string {
  return formatGoogleAdsCurrency(costMicrosToAmount(costMicros), currencyCode);
}

// ── Lead-form ingestion types ────────────────────────────────────────────
// Mirrors netlify/functions/google-ads-lead-sync-status.ts and
// google-ads-lead-sync.ts's response shapes.

export interface GoogleAdsLeadSyncStatusResponse {
  connected: boolean;
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
  last30DaysCount: number;
}

export interface GoogleAdsLeadSyncResultResponse {
  connected: true;
  fetched: number;
  newSubmissions: number;
  existingSubmissions: number;
  // Step 6B — optional/backward-safe: how many locally-stored failed rows
  // were retried this run (independent of the current Google fetch batch)
  // and how many of those recovered. Not yet surfaced in the Google Ads
  // Leads card UI (Step 11) — typed here so callers that DO want them can
  // read them without an `any` cast, without requiring every existing
  // caller to handle them.
  retriedFailed?: number;
  recoveredFailed?: number;
  crmCreated: number;
  crmMatched: number;
  failed: number;
  lastSyncedAt: string;
}

// Locale-formatted integer count (impressions/clicks) from a base-10
// integer string, via BigInt so a very large count is never coerced
// through an intermediate unsafe Number().
export function formatGoogleAdsCount(value: string | null | undefined): string {
  let n: bigint;
  try {
    n = BigInt(value && /^\d+$/.test(value) ? value : "0");
  } catch {
    n = 0n;
  }
  try {
    return new Intl.NumberFormat().format(n);
  } catch {
    return n.toString();
  }
}

// Click-through rate (Google Ads product phase — Campaign Detail Sheet).
// Derived client-side from clicks/impressions already present on every
// campaign row — never a new backend metric. impressions/clicks are
// base-10 digit strings (never assumed numeric); Number() parsing here is
// safe for a ratio/percentage display (unlike a financial sum, losing
// precision at astronomical impression counts has no visible effect on a
// 2-decimal percentage). impressions === 0 -> "—" (never "0.00%" or a
// divide-by-zero NaN), matching this app's existing zero-state convention
// for campaigns with no serving activity yet.
export function formatGoogleAdsCtr(clicks: string | null | undefined, impressions: string | null | undefined): string {
  const impr = impressions && /^\d+$/.test(impressions) ? Number(impressions) : 0;
  if (impr <= 0) return "—";
  const clk = clicks && /^\d+$/.test(clicks) ? Number(clicks) : 0;
  return `${((clk / impr) * 100).toFixed(2)}%`;
}

// Plain, currency-SILENT number formatting for a CRM monetary value
// (Google Ads Campaign Outcomes Hardening pass — Won value). RenoMeta's
// general-purpose formatMoney() (lib/format.ts) hardcodes a "$" (USD)
// symbol, which would misrepresent a deal's value the moment it's shown
// next to a non-USD Google Ads account (this org's advertiser reports
// currencyCode: "ILS") — there is still no confirmed organization-wide
// canonical currency field for CRM deals, so this formatter deliberately
// never prints ANY currency symbol/code, and never infers one from the
// Google Ads account's own currencyCode (a real but unrelated advertiser
// setting, not proof of what currency deals.value is actually in).
// Matches formatMoney's own precision convention (maximumFractionDigits:
// 0) so a value reads consistently with the rest of the app, just without
// a symbol. Returns "—" for null/undefined/non-finite input rather than
// "NaN" or throwing.
export function formatPlainMoneyValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

// ── Dev-only test-harness types (Phase 3, Step 6C.1) ─────────────────────
// Mirrors netlify/functions/google-ads-lead-test-inject.ts's response
// shape. The endpoint itself refuses to run outside local dev — these
// types exist purely so the frontend (also dev-gated) doesn't need `any`.

export interface GoogleAdsTestLeadInjectInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  submissionId: string;
  campaignName: string;
  gclid: string;
}

export interface GoogleAdsTestLeadInjectResponse {
  ok: boolean;
  duplicate: boolean;
  contactCreated: boolean;
  contactMatched: boolean;
  leadCreated: boolean;
  contactId: string | null;
  leadId: string | null;
  submissionId: string;
  ingestionStatus: "created" | "matched" | "duplicate" | "failed";
}

// ── Conversion attribution foundation types (Phase 3, Step 7A) ──────────
// Mirrors netlify/functions/google-ads-conversion-status.ts and
// google-ads-conversion-event-create.ts's response shapes. Deliberately no
// gclid field on the status/summary response — gclid is never surfaced in
// the normal Conversion Feedback UI, only in the dev-only
// controlled-verification create response (see marketing.tsx's dev test
// trigger) where it is explicitly needed to prove per-lead attribution.

export type GoogleAdsConversionEventType = "qualified_lead" | "appointment_booked" | "deal_won";

export type GoogleAdsConversionExportStatus = "pending" | "ready" | "exported" | "failed" | "ineligible";

export interface GoogleAdsConversionStatusResponse {
  ok: true;
  counts: Record<GoogleAdsConversionExportStatus, number>;
  total: number;
}

// Production input shape (Phase 3, Step 7A.1 hardening) — mirrors the
// hardened google-ads-conversion-event-create.ts exactly. No eventAt,
// conversionValue, or currencyCode: those are now always derived
// server-side from validated CRM state (leads.status/appointments/deals),
// never trusted from the browser. dealId/appointmentId are only required
// for their matching eventType.
export interface GoogleAdsConversionEventCreateInput {
  leadId: string;
  eventType: GoogleAdsConversionEventType;
  dealId?: string | null;
  appointmentId?: string | null;
}

export interface GoogleAdsConversionEventCreateResponse {
  ok: true;
  created: boolean;
  eventId: string;
  eventType: GoogleAdsConversionEventType;
  exportStatus: GoogleAdsConversionExportStatus;
  gclid: string | null;
}

// Dev-only test-harness input shape (Phase 3, Step 7A.1) — mirrors
// google-ads-conversion-event-test-create.ts, which is the ONLY endpoint
// that still accepts eventAt/conversionValue/currencyCode directly from
// the caller. Never used by the hardened production endpoint or its
// client function above. The endpoint itself refuses to run outside a
// real local `netlify dev` session regardless of what calls it.
export interface GoogleAdsConversionEventTestCreateInput {
  leadId: string;
  eventType: GoogleAdsConversionEventType;
  eventAt: string;
  dealId?: string | null;
  appointmentId?: string | null;
  conversionValue?: number | null;
  currencyCode?: string | null;
}

// ── Conversion-action discovery + mapping (Phase 3, Step 7B.1) ──────────
// Mirrors netlify/functions/google-ads-conversion-actions.ts,
// google-ads-conversion-mappings-list.ts, and
// google-ads-conversion-mapping-save.ts's response shapes. Discovery +
// mapping only — no field here is ever used to construct or trigger a
// Google Ads conversion upload call (that's Step 7B.2, not implemented).

export interface GoogleAdsConversionAction {
  id: string;
  resourceName: string | null;
  name: string;
  status: string | null;
  type: string | null;
  category: string | null;
  primaryForGoal: boolean | null;
}

export interface GoogleAdsConversionActionsResponse {
  connected: true;
  customerId: string;
  loginCustomerId: string | null;
  actions: GoogleAdsConversionAction[];
}

export interface GoogleAdsConversionMappingRow {
  eventType: GoogleAdsConversionEventType;
  conversionActionId: string;
  enabled: boolean;
}

export interface GoogleAdsConversionMappingsListResponse {
  mappings: GoogleAdsConversionMappingRow[];
}

export interface GoogleAdsConversionMappingSaveInput {
  eventType: GoogleAdsConversionEventType;
  conversionActionId: string;
  enabled: boolean;
}

export interface GoogleAdsConversionMappingSaveResponse {
  ok: true;
  eventType: GoogleAdsConversionEventType;
  conversionActionId: string;
  enabled: boolean;
  // Advisory only — see GOOGLE_ADS_CLICK_UPLOAD_COMPATIBLE_TYPE on the
  // backend. true means this action's Google `type` is not the type
  // known to be importable via offline click-conversion uploads; the
  // mapping is still saved regardless.
  typeCompatibilityWarning: boolean;
  googleName: string;
  googleCategory: string | null;
  googleType: string | null;
}

// Expected exact conversion-action names created manually in Google Ads
// for each RenoMeta event type (per the Step 7B.1 task) — used ONLY to
// derive a SUGGESTED, non-persisted default selection in the mapping UI.
// Never auto-saved: the user must explicitly click "Save Mappings" for
// any suggestion to actually reach google_ads_conversion_mappings.
export const EXPECTED_GOOGLE_ADS_CONVERSION_ACTION_NAMES: Record<GoogleAdsConversionEventType, string> = {
  qualified_lead: "RenoMeta - Qualified Lead",
  appointment_booked: "RenoMeta - Appointment Booked",
  deal_won: "RenoMeta - Deal Won",
};

export type GoogleAdsSuggestedMappingResult =
  | { status: "suggested"; action: GoogleAdsConversionAction }
  | { status: "missing" }
  | { status: "ambiguous"; actions: GoogleAdsConversionAction[] };

// Pure, UI-only derivation — exact (case-sensitive) name match against the
// live discovered actions list. Zero matches -> "missing" (never
// fabricates an ID); 2+ matches -> "ambiguous" (never auto-selects one).
export function deriveSuggestedGoogleAdsConversionMapping(
  eventType: GoogleAdsConversionEventType,
  actions: GoogleAdsConversionAction[],
): GoogleAdsSuggestedMappingResult {
  const expectedName = EXPECTED_GOOGLE_ADS_CONVERSION_ACTION_NAMES[eventType];
  const matches = actions.filter((a) => a.name === expectedName);
  if (matches.length === 0) return { status: "missing" };
  if (matches.length > 1) return { status: "ambiguous", actions: matches };
  return { status: "suggested", action: matches[0] };
}

// ── Local conversion events + export (Phase 3, Step 7B.2) ───────────────
// Mirrors netlify/functions/google-ads-conversion-events-list.ts and
// google-ads-conversion-export.ts's response shapes. Upload/export only —
// customers:uploadClickConversions itself is never called from the
// browser; this endpoint is a trusted server-side call the UI merely
// triggers by eventId.

export interface GoogleAdsConversionEventListRow {
  id: string;
  eventType: GoogleAdsConversionEventType;
  leadId: string | null;
  contactId: string | null;
  eventAt: string;
  gclid: string | null;
  exportStatus: GoogleAdsConversionExportStatus;
  exportedAt: string | null;
  conversionValue: number | null;
  currencyCode: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  // True if EITHER the canonical raw_fields test-fixture marker or the
  // secondary known-fixture-gclid-prefix guard trips (see
  // isSyntheticGoogleAdsConversionEvent on the backend) — the UI uses this
  // to hide the Upload/Retry action entirely for a synthetic row, never
  // relying on export_status alone (which is already 'ineligible' for
  // these, but this flag is what drives the "Test fixture — never
  // uploaded" label).
  syntheticFixture: boolean;
}

export interface GoogleAdsConversionEventsListResponse {
  events: GoogleAdsConversionEventListRow[];
}

export interface GoogleAdsConversionExportResponse {
  ok: true;
  eventId: string;
  exportStatus: "exported";
  googleUploadResourceName: string | null;
}

// ── Campaign CRM outcomes (Google Ads product phase) ────────────────────
// Mirrors netlify/functions/google-ads-campaign-crm-outcomes.ts's response
// shape. Read-only rollup of RenoMeta CRM outcomes (leads/qualified/
// appointments/won deals/won value) attributed to one Google Ads
// campaign — never a Google Ads API call, never exposes raw DB rows.

export interface GoogleAdsCampaignCrmOutcomes {
  leads: number;
  qualifiedLeads: number;
  appointments: number;
  wonDeals: number;
  // Sum of deals.value for won deals attributed to this campaign — always
  // labeled "Won value" in the UI, never "Revenue" (no confirmed
  // organization-wide canonical currency field exists yet — see
  // netlify/functions/google-ads-campaign-crm-outcomes.ts).
  wonValue: number;
}

export type GoogleAdsCampaignAttributionMode = "campaign_id" | "campaign_name_fallback" | null;

export interface GoogleAdsCampaignCrmOutcomesResponse {
  campaignId: string | null;
  campaignName: string | null;
  outcomes: GoogleAdsCampaignCrmOutcomes;
  attributionMode: GoogleAdsCampaignAttributionMode;
}

// Campaign -> CRM Leads Deep Link phase — the Leads page's campaign
// context filter reuses the EXACT same attribution rule as the outcomes
// response above (see netlify/functions/google-ads-campaign-leads.ts),
// just returning the bare lead_id set instead of aggregate counts.
export interface GoogleAdsCampaignLeadIdsResponse {
  campaignId: string | null;
  campaignName: string | null;
  leadIds: string[];
  attributionMode: GoogleAdsCampaignAttributionMode;
}

// ── Ad Group / Keyword / Search Term drill-down (Campaign -> Ad Groups ->
// Keywords/Search Terms phase) ──────────────────────────────────────────
// Mirrors netlify/functions/google-ads-campaign-ad-groups.ts,
// google-ads-ad-group-keywords.ts, and google-ads-ad-group-search-terms.ts
// exactly. Metric string fields (impressions/clicks/costMicros) follow the
// same BigInt-safe string-serialization convention as
// GoogleAdsCampaignPerformanceRow above — never parsed as a plain JS number
// here either; use formatGoogleAdsCount()/formatGoogleAdsCtr()/
// formatGoogleAdsSpend() the same way the Campaign table already does.

export interface GoogleAdsAdGroupPerformanceRow {
  adGroupId: string;
  name: string;
  status: string | null;
  impressions: string;
  clicks: string;
  costMicros: string;
  conversions: number;
  conversionValue: number;
}

export interface GoogleAdsCampaignAdGroupsResponse {
  connected: true;
  customerId: string;
  campaignId: string;
  currencyCode: string | null;
  dateRange: GoogleAdsCampaignPerformanceDateRange;
  adGroups: GoogleAdsAdGroupPerformanceRow[];
}

export interface GoogleAdsKeywordPerformanceRow {
  criterionId: string;
  text: string;
  matchType: string | null;
  status: string | null;
  impressions: string;
  clicks: string;
  costMicros: string;
  conversions: number;
  conversionValue: number;
}

export interface GoogleAdsAdGroupKeywordsResponse {
  connected: true;
  campaignId: string;
  adGroupId: string;
  currencyCode: string | null;
  dateRange: GoogleAdsCampaignPerformanceDateRange;
  keywords: GoogleAdsKeywordPerformanceRow[];
}

export interface GoogleAdsSearchTermPerformanceRow {
  searchTerm: string;
  impressions: string;
  clicks: string;
  costMicros: string;
  conversions: number;
  conversionValue: number;
}

export interface GoogleAdsAdGroupSearchTermsResponse {
  connected: true;
  campaignId: string;
  adGroupId: string;
  currencyCode: string | null;
  dateRange: GoogleAdsCampaignPerformanceDateRange;
  searchTerms: GoogleAdsSearchTermPerformanceRow[];
}

// ── Ad Group -> CRM Leads Deep Link phase ───────────────────────────────
// Mirrors netlify/functions/google-ads-ad-group-leads.ts exactly — the
// smallest honest response shape (no campaignId/adGroupId echo needed,
// unlike the campaign version, since this endpoint has no name-fallback
// mode to report and the Leads page already knows both IDs from its own
// URL search params).
export interface GoogleAdsAdGroupLeadIdsResponse {
  leadIds: string[];
}

// ── Ad Group-Level CRM Outcomes phase ───────────────────────────────────
// Mirrors netlify/functions/google-ads-ad-group-crm-outcomes.ts exactly —
// same "smallest honest response shape" policy as campaign outcomes (no
// attributionMode field at all, since ad group attribution has no name-
// fallback path to report — see that endpoint's doc comment).
export interface GoogleAdsAdGroupCrmOutcomesResponse {
  campaignId: string;
  adGroupId: string;
  outcomes: GoogleAdsCampaignCrmOutcomes;
}

// Humanizes Google's KeywordMatchType enum for display — EXACT/PHRASE/BROAD
// are the only values Google returns for a positive keyword criterion
// (negative-match variants don't apply here since keywords are already
// filtered to negative-only-excluded server-side, after parsing). Anything
// unrecognized is shown as-is rather than hidden, matching the never-
// fabricate convention used elsewhere in this module.
export function humanizeGoogleAdsKeywordMatchType(matchType: string | null | undefined): string {
  switch (matchType) {
    case "EXACT": return "Exact";
    case "PHRASE": return "Phrase";
    case "BROAD": return "Broad";
    default: return matchType ?? "—";
  }
}
