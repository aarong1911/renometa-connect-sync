// netlify/functions/lib/meta-ads-api.ts
//
// Meta Ads-specific discovery, canonicalization, and selection logic — the
// Meta counterpart to google-ads-api.ts's discoverGoogleAdsAccounts /
// deriveGoogleAdsSelectionState / validateSelectableAdvertiser. Built on
// top of the generic transport in meta-graph-api.ts.

import { metaGraphPaginate, metaGraphRequest, MetaGraphApiError } from "./meta-graph-api";

// ── Canonical ad-account ID convention ──────────────────────────────────
// meta_connections.ad_account_id is already persisted WITHOUT the "act_"
// prefix (see meta-oauth-callback.ts: `preferred.id.startsWith("act_") ?
// preferred.id.slice(4) : preferred.id`, and meta-create-ad-campaign.ts's
// `actId` re-add). This module preserves that exact existing convention —
// every MetaAdAccountSummary.id below is numeric-only; toMetaAdAccountGraphId
// re-adds "act_" only where a Graph object path requires it.

export function canonicalMetaAdAccountId(id: string): string {
  return id.startsWith("act_") ? id.slice(4) : id;
}

export function toMetaAdAccountGraphId(canonicalId: string): string {
  return canonicalId.startsWith("act_") ? canonicalId : `act_${canonicalId}`;
}

export interface MetaBusinessSummary {
  id: string;
  name: string | null;
}

export interface MetaAdAccountSummary {
  id: string; // canonical — see above
  name: string | null;
  accountStatus: number | null;
  currency: string | null;
  timezoneName: string | null;
  businessId: string | null;
  businessName: string | null;
}

interface RawAdAccountFields {
  id: string;
  name?: string;
  account_status?: number;
  currency?: string;
  timezone_name?: string;
  business?: { id?: string; name?: string };
}

const AD_ACCOUNT_FIELDS = "id,name,account_status,currency,timezone_name,business{id,name}";

function normalizeAdAccount(raw: RawAdAccountFields): MetaAdAccountSummary {
  return {
    id: canonicalMetaAdAccountId(raw.id),
    name: typeof raw.name === "string" ? raw.name : null,
    accountStatus: typeof raw.account_status === "number" ? raw.account_status : null,
    currency: typeof raw.currency === "string" ? raw.currency : null,
    timezoneName: typeof raw.timezone_name === "string" ? raw.timezone_name : null,
    businessId: raw.business?.id ?? null,
    businessName: raw.business?.name ?? null,
  };
}

export interface MetaAdsDiscoveryResult {
  businesses: MetaBusinessSummary[];
  adAccounts: MetaAdAccountSummary[];
}

// Discovers every ad account the connected token can access via THREE
// routes, since no single route reliably catches every manager/business
// arrangement: directly (/me/adaccounts), plus each accessible Business's
// owned AND client (shared) ad accounts. Deduplicated by canonical numeric
// ad-account ID — the first source to discover a given account wins for
// any field, later sources only fill in gaps left null. A single
// business/edge failing (e.g. missing permission for client_ad_accounts on
// one business) never fails the whole discovery.
export async function discoverMetaAdsAccounts(accessToken: string): Promise<MetaAdsDiscoveryResult> {
  const businessesPage = await metaGraphPaginate<{ id: string; name?: string }>({
    path: "/me/businesses",
    accessToken,
    query: { fields: "id,name" },
  });
  const businesses: MetaBusinessSummary[] = businessesPage.items.map((b) => ({
    id: b.id,
    name: typeof b.name === "string" ? b.name : null,
  }));

  const byId = new Map<string, MetaAdAccountSummary>();
  function merge(account: MetaAdAccountSummary): void {
    const existing = byId.get(account.id);
    if (!existing) {
      byId.set(account.id, account);
      return;
    }
    byId.set(account.id, {
      id: existing.id,
      name: existing.name ?? account.name,
      accountStatus: existing.accountStatus ?? account.accountStatus,
      currency: existing.currency ?? account.currency,
      timezoneName: existing.timezoneName ?? account.timezoneName,
      businessId: existing.businessId ?? account.businessId,
      businessName: existing.businessName ?? account.businessName,
    });
  }

  try {
    const direct = await metaGraphPaginate<RawAdAccountFields>({
      path: "/me/adaccounts",
      accessToken,
      query: { fields: AD_ACCOUNT_FIELDS },
    });
    for (const raw of direct.items) merge(normalizeAdAccount(raw));
  } catch {
    // /me/adaccounts can legitimately fail for a token with only
    // business-scoped access and no personal ad accounts — the business
    // discovery loop below still has a chance to find accounts.
  }

  for (const business of businesses) {
    for (const edge of ["owned_ad_accounts", "client_ad_accounts"] as const) {
      try {
        const page = await metaGraphPaginate<RawAdAccountFields>({
          path: `/${business.id}/${edge}`,
          accessToken,
          query: { fields: AD_ACCOUNT_FIELDS },
        });
        for (const raw of page.items) {
          const normalized = normalizeAdAccount(raw);
          merge({
            ...normalized,
            businessId: normalized.businessId ?? business.id,
            businessName: normalized.businessName ?? business.name,
          });
        }
      } catch {
        // Missing permission for this business/edge — skip, don't fail
        // the whole discovery.
      }
    }
  }

  return { businesses, adAccounts: Array.from(byId.values()) };
}

// ── Selection-state derivation — pure, no I/O ───────────────────────────

export type MetaAdsSelectionState = "connected" | "needs_account_selection" | "needs_account_sync";

export interface MetaAdsSelectionDerivation {
  state: MetaAdsSelectionState;
  /** The account to report as selected this run — null unless state is "connected". */
  selectedAdAccountId: string | null;
  /** True only for the "first connection, exactly one account, nothing previously selected" case — the ONE scenario this module ever recommends auto-persisting. */
  shouldPersistAutoSelection: boolean;
  /** True when a previously-selected account exists but is no longer in the accessible set — the caller should surface this without destructively clearing the stored value. */
  previousSelectionStale: boolean;
}

// Mirrors deriveGoogleAdsSelectionState's rules, adapted for Meta:
//   - an existing, still-accessible selection is always kept (never
//     silently switched to a different account)
//   - a stale existing selection (no longer accessible) is reported via
//     previousSelectionStale rather than acted on — the caller decides
//     whether/when to clear persisted data; this function never mutates
//     anything itself
//   - auto-selection is recommended ONLY when there is no prior selection
//     AND exactly one account is accessible
//   - zero accessible accounts -> needs_account_sync
//   - more than one accessible account with no valid existing selection ->
//     needs_account_selection (explicit choice required)
export function deriveMetaAdsSelectionState(
  accounts: MetaAdAccountSummary[],
  previouslySelectedAdAccountId: string | null,
): MetaAdsSelectionDerivation {
  if (previouslySelectedAdAccountId) {
    const stillAccessible = accounts.some((a) => a.id === previouslySelectedAdAccountId);
    if (stillAccessible) {
      return {
        state: "connected",
        selectedAdAccountId: previouslySelectedAdAccountId,
        shouldPersistAutoSelection: false,
        previousSelectionStale: false,
      };
    }
    return {
      state: accounts.length > 0 ? "needs_account_selection" : "needs_account_sync",
      selectedAdAccountId: null,
      shouldPersistAutoSelection: false,
      previousSelectionStale: true,
    };
  }

  if (accounts.length === 0) {
    return { state: "needs_account_sync", selectedAdAccountId: null, shouldPersistAutoSelection: false, previousSelectionStale: false };
  }
  if (accounts.length === 1) {
    return { state: "connected", selectedAdAccountId: accounts[0].id, shouldPersistAutoSelection: true, previousSelectionStale: false };
  }
  return { state: "needs_account_selection", selectedAdAccountId: null, shouldPersistAutoSelection: false, previousSelectionStale: false };
}

// ── Selection validation — pure, no I/O ─────────────────────────────────

export type MetaAdAccountValidationResult =
  | { ok: true; account: MetaAdAccountSummary }
  | { ok: false; reason: "not_found" };

// Never trusts the request body or a previously-stored ad_account_id — the
// caller must pass a freshly-discovered `accounts` array (see
// discoverMetaAdsAccounts above), same discipline as
// validateSelectableAdvertiser for Google Ads.
export function validateSelectableMetaAdAccount(
  accounts: MetaAdAccountSummary[],
  submittedAdAccountId: string,
): MetaAdAccountValidationResult {
  const canonical = canonicalMetaAdAccountId(submittedAdAccountId);
  const match = accounts.find((a) => a.id === canonical);
  if (!match) return { ok: false, reason: "not_found" };
  return { ok: true, account: match };
}

// ═════════════════════════════════════════════════════════════════════════
// Phase 1A / Step 2 — read-only campaign/ad set/ad hierarchy + Insights.
// Everything below is additive to Step 1's discovery/selection exports
// above (unchanged).
// ═════════════════════════════════════════════════════════════════════════

// ── Single-account live-access validation (Step 15) ─────────────────────
// A single, lightweight call — NOT a full re-discovery of every accessible
// Business/ad account — used by reporting endpoints right after
// resolveMetaAdsContext() to confirm the persisted selection is both still
// reachable with the current token AND to get fresh metadata (name,
// currency, timezone) in the same round trip. resolveMetaAdsContext()
// itself only trusts the persisted DB row; this is what actually proves
// continued access for a reporting request. A thrown MetaGraphApiError
// here (e.g. the token was revoked, or the account was removed) is the
// signal reporting endpoints map via classifyMetaGraphApiError() below —
// never silently falls back to a different account.
export async function fetchMetaAdAccountSummary(
  accessToken: string,
  canonicalAdAccountId: string,
): Promise<MetaAdAccountSummary> {
  const raw = await metaGraphRequest<RawAdAccountFields>({
    path: `/${toMetaAdAccountGraphId(canonicalAdAccountId)}`,
    accessToken,
    query: { fields: AD_ACCOUNT_FIELDS },
  });
  return normalizeAdAccount(raw);
}

// ── Object-ID validation + cross-account isolation (Step 14) ────────────

const NUMERIC_ID_RE = /^\d+$/;

export function isValidMetaObjectId(id: string): boolean {
  return NUMERIC_ID_RE.test(id);
}

// Confirms a campaign/ad-set/ad ID actually belongs to the SELECTED
// (canonical, numeric, no "act_" prefix) ad account, using the org's own
// token as the only source of truth — never trusts the ID's mere numeric
// shape, and never accepts a caller-supplied `act_<other-account>` as an
// override. Meta returns `account_id` bare (no "act_" prefix) on every
// campaign/adset/ad object, so no re-canonicalization is needed for the
// comparison. A network/permission/not-found failure is treated the same
// as "does not belong" — fail closed, never fail open.
export async function verifyMetaObjectBelongsToAccount(
  accessToken: string,
  objectId: string,
  canonicalAdAccountId: string,
): Promise<boolean> {
  if (!isValidMetaObjectId(objectId)) return false;
  try {
    const result = await metaGraphRequest<{ account_id?: string }>({
      path: `/${objectId}`,
      accessToken,
      query: { fields: "account_id" },
    });
    return typeof result.account_id === "string" && result.account_id === canonicalAdAccountId;
  } catch {
    return false;
  }
}

// ── Field constants — query-cost control (Step 12) ──────────────────────
// Every list/insights call routes through one of these constants; no
// endpoint in this feature ever requests `fields=*` or an ad-hoc field
// string assembled inline.

export const META_CAMPAIGN_FIELDS =
  "id,name,status,effective_status,objective,buying_type,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,created_time,updated_time";

export const META_ADSET_FIELDS =
  "id,campaign_id,name,status,effective_status,optimization_goal,billing_event,bid_strategy,daily_budget,lifetime_budget,start_time,end_time,created_time,updated_time,targeting{geo_locations{countries},age_min,age_max}";

export const META_AD_FIELDS =
  "id,campaign_id,adset_id,name,status,effective_status,created_time,updated_time,creative{id,name,thumbnail_url}";

const META_INSIGHTS_BASE_FIELDS = ["spend", "impressions", "reach", "clicks", "ctr", "cpc", "cpm", "actions", "cost_per_action_type"];

export type MetaInsightsLevel = "account" | "campaign" | "adset" | "ad";

export const META_INSIGHTS_LEVELS: readonly MetaInsightsLevel[] = ["account", "campaign", "adset", "ad"];

// Level-specific field lists — the level's own ID/name fields are added
// explicitly (never assumed implicit) so merge-by-ID always has something
// to key on, regardless of Meta's default field behavior for a given level.
export function metaInsightsFieldsForLevel(level: MetaInsightsLevel): string {
  switch (level) {
    case "account":
      return META_INSIGHTS_BASE_FIELDS.join(",");
    case "campaign":
      return ["campaign_id", "campaign_name", ...META_INSIGHTS_BASE_FIELDS].join(",");
    case "adset":
      return ["adset_id", "adset_name", "campaign_id", ...META_INSIGHTS_BASE_FIELDS].join(",");
    case "ad":
      return ["ad_id", "ad_name", "adset_id", "campaign_id", ...META_INSIGHTS_BASE_FIELDS].join(",");
  }
}

// ── Normalized domain types (Step 2) ─────────────────────────────────────

export interface MetaAdsCampaign {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string | null;
  objective: string | null;
  buyingType: string | null;
  /** Minor currency unit (e.g. cents for USD) — Meta's own wire format for this field. NOT the same unit as MetaAdsInsights.spend below (major unit, e.g. dollars). */
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  budgetRemaining: number | null;
  startTime: string | null;
  stopTime: string | null;
  createdTime: string | null;
  updatedTime: string | null;
}

export interface MetaAdsAdSet {
  id: string;
  campaignId: string | null;
  name: string;
  status: string;
  effectiveStatus: string | null;
  optimizationGoal: string | null;
  billingEvent: string | null;
  bidStrategy: string | null;
  /** Minor currency unit — see MetaAdsCampaign.dailyBudget note. */
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  endTime: string | null;
  createdTime: string | null;
  updatedTime: string | null;
  /** Coarse, safe summary (geo countries + age range) only — never custom-audience membership, interest/behavior targeting IDs, or exclusions. */
  targetingSummary: string | null;
}

export interface MetaAdsAd {
  id: string;
  campaignId: string | null;
  adSetId: string | null;
  name: string;
  status: string;
  effectiveStatus: string | null;
  createdTime: string | null;
  updatedTime: string | null;
  creativeId: string | null;
  creativeName: string | null;
  thumbnailUrl: string | null;
}

export interface MetaAdsInsights {
  /** Major currency unit (e.g. dollars for USD) — Meta's own wire format for Insights. NOT the same unit as campaign/ad-set budget fields above (minor unit). */
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  leads: number;
  costPerLead: number | null;
  /** Raw recognized lead-ish action counts, keyed by Meta action_type — for transparency only; exactly one entry ever contributes to `leads` (see extractLeadCount). */
  leadActionBreakdown: Record<string, number>;
}

export type MetaAdsPerformanceSummary = MetaAdsInsights;

// ── Numeric normalization (Step 5) ───────────────────────────────────────

// Meta frequently returns metrics as strings. Returns null for anything
// that isn't a finite number after parsing — callers decide whether null
// means "0" (additive counters) or "unavailable" (ratios) per Step 5.
// Never returns NaN or Infinity.
export function safeNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function safeCounter(value: unknown): number {
  return safeNumber(value) ?? 0;
}

// ── Lead action normalization (Step 4, 19) ───────────────────────────────
//
// Priority order — most-specific-first. NEVER summed together:
//   1. onsite_conversion.lead_grouped — Meta's canonical, de-duplicated
//      count of Instant Forms / on-Meta Lead Ads submissions. Preferred
//      whenever present.
//   2. lead — a coarser/older action type that in some API versions
//      overlaps with (double-reports) #1 for the same underlying
//      submissions. Used only when #1 is absent.
//   3. offsite_conversion.fb_pixel_lead — a DIFFERENT signal entirely (a
//      website Pixel "Lead" event, not an Instant Form submission). Used
//      only as a last resort, on the assumption a given campaign/ad
//      predominantly drives one lead mechanism or the other, not both
//      simultaneously being double-reported.
//
// link_click / landing_page_view are deliberately NOT treated as lead
// signals — they represent traffic/engagement, not a conversion, and
// including them here would inflate `leads` with non-conversions.
//
// This priority list reflects Meta's long-documented action_type
// vocabulary; it was not re-verified against a live Insights response in
// this session (no live Meta call was made while building this file) —
// revisit if real account data surfaces an unrecognized/renamed action
// type carrying real lead volume.
const LEAD_ACTION_PRIORITY = ["onsite_conversion.lead_grouped", "lead", "offsite_conversion.fb_pixel_lead"] as const;

interface RawAction {
  action_type?: string;
  value?: string | number;
}

interface ExtractedLeadCount {
  leads: number;
  /** Meta's own cost_per_action_type value for the CHOSEN action type, if present — preferred over spend/leads division since Meta's own attribution-window-aware value is more precise. Null if absent (caller falls back to spend/leads). */
  costPerActionValue: number | null;
  leadActionBreakdown: Record<string, number>;
}

export function extractLeadCount(
  actions: RawAction[] | undefined,
  costPerActionType: RawAction[] | undefined,
): ExtractedLeadCount {
  const breakdown: Record<string, number> = {};
  for (const a of actions ?? []) {
    if (!a || typeof a.action_type !== "string") continue;
    if (!(LEAD_ACTION_PRIORITY as readonly string[]).includes(a.action_type)) continue;
    const v = safeNumber(a.value);
    if (v !== null) breakdown[a.action_type] = v;
  }

  let leads = 0;
  let chosenActionType: string | null = null;
  for (const candidate of LEAD_ACTION_PRIORITY) {
    if (candidate in breakdown) {
      leads = breakdown[candidate];
      chosenActionType = candidate;
      break; // never sum a second candidate on top of this one
    }
  }

  let costPerActionValue: number | null = null;
  if (chosenActionType) {
    const cpaEntry = (costPerActionType ?? []).find((c) => c?.action_type === chosenActionType);
    costPerActionValue = cpaEntry ? safeNumber(cpaEntry.value) : null;
  }

  return { leads, costPerActionValue, leadActionBreakdown: breakdown };
}

// ── Insights row normalization (Step 5) ──────────────────────────────────
//
// ctr/cpc/cpm are NEVER recomputed from spend/impressions/clicks here —
// Meta's own provided ratio value is used as-is (parsed safely), or null
// if Meta didn't return the field. This eliminates any possibility of a
// division-by-zero/NaN/Infinity at the per-row level entirely, at the cost
// of returning null (not a locally-computed 0) when Meta omits a ratio
// for a genuinely zero-activity period — treated as "ratio unavailable",
// matching Step 5's "null for ratios ... when meaningful denominator/value
// is unavailable" rule.

interface RawInsightsRow {
  spend?: string | number;
  impressions?: string | number;
  reach?: string | number;
  clicks?: string | number;
  ctr?: string | number;
  cpc?: string | number;
  cpm?: string | number;
  actions?: RawAction[];
  cost_per_action_type?: RawAction[];
}

export function normalizeInsightsRow(raw: RawInsightsRow | undefined | null): MetaAdsInsights {
  const spend = safeCounter(raw?.spend);
  const impressions = safeCounter(raw?.impressions);
  const reach = safeCounter(raw?.reach);
  const clicks = safeCounter(raw?.clicks);
  const ctr = safeNumber(raw?.ctr);
  const cpc = safeNumber(raw?.cpc);
  const cpm = safeNumber(raw?.cpm);

  const { leads, costPerActionValue, leadActionBreakdown } = extractLeadCount(raw?.actions, raw?.cost_per_action_type);
  const costPerLead = costPerActionValue !== null ? costPerActionValue : leads > 0 ? spend / leads : null;

  return { spend, impressions, reach, clicks, ctr, cpc, cpm, leads, costPerLead, leadActionBreakdown };
}

// ── Hierarchy merge (Step 11, 18) ────────────────────────────────────────

export interface MetaAdsInsightsRowWithEntity extends MetaAdsInsights {
  entityId: string | null;
}

// Merges a bulk Insights result (fetched ONCE per level, e.g.
// /act_X/insights?level=campaign) onto a list of entities by exact ID —
// never a per-entity Insights call (see module doc / Step 11). An entity
// with no matching insights row gets a zero/null-filled summary via
// normalizeInsightsRow(undefined) rather than being omitted. An insights
// row whose entityId doesn't match ANY entity in the list is simply never
// looked up (Map.get returns undefined for it) — it can never attach to
// the wrong entity.
export function mergeInsightsByEntity<T extends { id: string }>(
  entities: T[],
  insightsRows: MetaAdsInsightsRowWithEntity[],
): Array<T & { insights: MetaAdsInsights }> {
  const byId = new Map<string, MetaAdsInsights>();
  for (const row of insightsRows) {
    if (row.entityId) byId.set(row.entityId, row);
  }
  const zeroFilled = normalizeInsightsRow(undefined);
  return entities.map((e) => ({ ...e, insights: byId.get(e.id) ?? zeroFilled }));
}

// Sums additive metrics across multiple already-normalized rows and
// RECOMPUTES ctr/cpc/cpm from the summed base metrics — ratios are never
// averaged (mathematically wrong) or carried over from a single row.
// `reach` is summed as a best-effort approximation (Meta's own
// account/campaign list views do the same); true deduplicated reach
// across multiple entities is not something the per-entity Insights API
// can provide without a separate combined query, which this helper does
// not attempt.
export function aggregatePerformanceSummary(rows: MetaAdsInsights[]): MetaAdsPerformanceSummary {
  let spend = 0, impressions = 0, reach = 0, clicks = 0, leads = 0;
  const leadActionBreakdown: Record<string, number> = {};

  for (const r of rows) {
    spend += r.spend;
    impressions += r.impressions;
    reach += r.reach;
    clicks += r.clicks;
    leads += r.leads;
    for (const [k, v] of Object.entries(r.leadActionBreakdown)) {
      leadActionBreakdown[k] = (leadActionBreakdown[k] ?? 0) + v;
    }
  }

  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null;
  const cpc = clicks > 0 ? spend / clicks : null;
  const cpm = impressions > 0 ? (spend / impressions) * 1000 : null;
  const costPerLead = leads > 0 ? spend / leads : null;

  return { spend, impressions, reach, clicks, ctr, cpc, cpm, leads, costPerLead, leadActionBreakdown };
}

// ── Campaign / Ad Set / Ad normalization (Step 2) ────────────────────────

interface RawCampaign {
  id: string;
  name?: string;
  status?: string;
  effective_status?: string;
  objective?: string;
  buying_type?: string;
  daily_budget?: string | number;
  lifetime_budget?: string | number;
  budget_remaining?: string | number;
  start_time?: string;
  stop_time?: string;
  created_time?: string;
  updated_time?: string;
}

export function normalizeMetaCampaign(raw: RawCampaign): MetaAdsCampaign {
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : "",
    status: typeof raw.status === "string" ? raw.status : "UNKNOWN",
    effectiveStatus: typeof raw.effective_status === "string" ? raw.effective_status : null,
    objective: typeof raw.objective === "string" ? raw.objective : null,
    buyingType: typeof raw.buying_type === "string" ? raw.buying_type : null,
    dailyBudget: safeNumber(raw.daily_budget),
    lifetimeBudget: safeNumber(raw.lifetime_budget),
    budgetRemaining: safeNumber(raw.budget_remaining),
    startTime: typeof raw.start_time === "string" ? raw.start_time : null,
    stopTime: typeof raw.stop_time === "string" ? raw.stop_time : null,
    createdTime: typeof raw.created_time === "string" ? raw.created_time : null,
    updatedTime: typeof raw.updated_time === "string" ? raw.updated_time : null,
  };
}

interface RawTargeting {
  geo_locations?: { countries?: string[] };
  age_min?: number;
  age_max?: number;
}

// Deliberately minimal — geo countries + age range only. Never surfaces
// custom_audiences, flexible_spec/interest or behavior targeting IDs,
// exclusions, or any other portion of Meta's targeting object, per Step 8
// ("do not expose unnecessarily sensitive custom-audience details").
function buildTargetingSummary(t: RawTargeting | undefined): string | null {
  if (!t) return null;
  const parts: string[] = [];
  const countries = t.geo_locations?.countries;
  if (Array.isArray(countries) && countries.length > 0) {
    parts.push(`Countries: ${countries.filter((c): c is string => typeof c === "string").join(", ")}`);
  }
  if (typeof t.age_min === "number" || typeof t.age_max === "number") {
    parts.push(`Age ${t.age_min ?? 13}-${t.age_max ?? 65}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

interface RawAdSet {
  id: string;
  campaign_id?: string;
  name?: string;
  status?: string;
  effective_status?: string;
  optimization_goal?: string;
  billing_event?: string;
  bid_strategy?: string;
  daily_budget?: string | number;
  lifetime_budget?: string | number;
  start_time?: string;
  end_time?: string;
  created_time?: string;
  updated_time?: string;
  targeting?: RawTargeting;
}

export function normalizeMetaAdSet(raw: RawAdSet): MetaAdsAdSet {
  return {
    id: raw.id,
    campaignId: typeof raw.campaign_id === "string" ? raw.campaign_id : null,
    name: typeof raw.name === "string" ? raw.name : "",
    status: typeof raw.status === "string" ? raw.status : "UNKNOWN",
    effectiveStatus: typeof raw.effective_status === "string" ? raw.effective_status : null,
    optimizationGoal: typeof raw.optimization_goal === "string" ? raw.optimization_goal : null,
    billingEvent: typeof raw.billing_event === "string" ? raw.billing_event : null,
    bidStrategy: typeof raw.bid_strategy === "string" ? raw.bid_strategy : null,
    dailyBudget: safeNumber(raw.daily_budget),
    lifetimeBudget: safeNumber(raw.lifetime_budget),
    startTime: typeof raw.start_time === "string" ? raw.start_time : null,
    endTime: typeof raw.end_time === "string" ? raw.end_time : null,
    createdTime: typeof raw.created_time === "string" ? raw.created_time : null,
    updatedTime: typeof raw.updated_time === "string" ? raw.updated_time : null,
    targetingSummary: buildTargetingSummary(raw.targeting),
  };
}

interface RawAd {
  id: string;
  campaign_id?: string;
  adset_id?: string;
  name?: string;
  status?: string;
  effective_status?: string;
  created_time?: string;
  updated_time?: string;
  creative?: { id?: string; name?: string; thumbnail_url?: string };
}

export function normalizeMetaAd(raw: RawAd): MetaAdsAd {
  return {
    id: raw.id,
    campaignId: typeof raw.campaign_id === "string" ? raw.campaign_id : null,
    adSetId: typeof raw.adset_id === "string" ? raw.adset_id : null,
    name: typeof raw.name === "string" ? raw.name : "",
    status: typeof raw.status === "string" ? raw.status : "UNKNOWN",
    effectiveStatus: typeof raw.effective_status === "string" ? raw.effective_status : null,
    createdTime: typeof raw.created_time === "string" ? raw.created_time : null,
    updatedTime: typeof raw.updated_time === "string" ? raw.updated_time : null,
    creativeId: raw.creative?.id ?? null,
    creativeName: raw.creative?.name ?? null,
    thumbnailUrl: raw.creative?.thumbnail_url ?? null,
  };
}

// ── Error mapping (Step 16) ───────────────────────────────────────────────

export type MetaAdsSafeErrorCode =
  | "unauthorized"
  | "not_connected"
  | "no_ad_account_selected"
  | "reconnect_required"
  | "permission_required"
  | "account_unavailable"
  | "temporarily_unavailable"
  | "invalid_request";

export interface MetaAdsErrorResponse {
  statusCode: number;
  body: { error: string; errorCode: MetaAdsSafeErrorCode };
}

// Maps a resolveMetaAdsContext()/loadMetaAdsConnection() failure to a
// stable, safe response. `not_connected` and `no_ad_account_selected` are
// 200s (not errors) — they're normal, expected states the UI branches on,
// same convention as meta-ads-accounts.ts's `connected: false` response.
export function metaAdsContextErrorResponse(
  errorCode: "unauthorized" | "not_connected" | "no_ad_account_selected" | "token_decrypt_failed",
): MetaAdsErrorResponse {
  switch (errorCode) {
    case "unauthorized":
      return { statusCode: 401, body: { error: "Unauthorized", errorCode: "unauthorized" } };
    case "not_connected":
      return { statusCode: 200, body: { error: "Meta Ads is not connected", errorCode: "not_connected" } };
    case "no_ad_account_selected":
      return { statusCode: 200, body: { error: "Select a Meta ad account to continue", errorCode: "no_ad_account_selected" } };
    case "token_decrypt_failed":
      return { statusCode: 500, body: { error: "Could not read your Meta Ads credentials — try reconnecting", errorCode: "reconnect_required" } };
  }
}

// Maps a MetaGraphApiError from a LIVE reporting call to a safe response.
// The exact numeric Meta codes/subcodes below are Meta's long-documented,
// stable values (OAuthException/190 for invalid-or-expired tokens, 200/10
// for permission errors, 100/803 for missing/inaccessible objects) — they
// were NOT independently re-verified against a live Graph response in this
// session (no live Meta call was made while building this file). Treat as
// a best-effort classification; revisit if real traffic surfaces a
// miscategorized case. Never includes e.metaMessage's raw text, the
// request URL, or any token in the response body — only the fixed,
// pre-written strings above.
export function classifyMetaGraphApiError(e: MetaGraphApiError): MetaAdsErrorResponse {
  if (e.metaType === "OAuthException" || e.metaCode === 190) {
    return { statusCode: 409, body: { error: "Your Meta Ads authorization has expired — please reconnect", errorCode: "reconnect_required" } };
  }
  if (e.metaCode === 200 || e.metaCode === 10) {
    return { statusCode: 403, body: { error: "This Meta Ads connection no longer has permission to read this data", errorCode: "permission_required" } };
  }
  if (e.httpStatus === 400 && (e.metaCode === 100 || e.metaCode === 803)) {
    return { statusCode: 409, body: { error: "The selected Meta ad account is no longer available", errorCode: "account_unavailable" } };
  }
  if (e.httpStatus === 429 || e.isTransient) {
    return { statusCode: 503, body: { error: "Meta is temporarily unavailable — please try again shortly", errorCode: "temporarily_unavailable" } };
  }
  return { statusCode: 502, body: { error: "Could not read Meta Ads data right now — please try again", errorCode: "temporarily_unavailable" } };
}
