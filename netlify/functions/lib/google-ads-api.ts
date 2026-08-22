// netlify/functions/lib/google-ads-api.ts
//
// Minimal Google Ads REST API client for account discovery, used by
// google-ads-oauth-callback.ts right after the OAuth token exchange. Single
// source for the API version string so it's never scattered/hardcoded
// across multiple files — override via GOOGLE_ADS_API_VERSION if Google
// deprecates the default before this is revisited.
//
// Scope of discovery (documented limitation — see discoverGoogleAdsAccounts
// below): ListAccessibleCustomers only returns accounts directly accessible
// to the authenticated Google identity. For each of those, this fetches
// DIRECT children only (customer_client WHERE level <= 1) — it does not
// recurse further down multi-level manager hierarchies. Deeper recursive
// discovery is straightforward to add later (walk any discovered manager's
// own customer_client the same way, with a visited-ID set and a depth cap)
// but is left as follow-up work per the task that introduced this file.
//
// Never logs the developer token or access token. Google error bodies are
// logged only as safe status codes, never the raw body (which can include
// account names/emails).

export const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v25";

const REQUEST_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface GoogleAdsCustomerClient {
  customerId: string;
  descriptiveName: string | null;
  isManager: boolean;
  level: number;
  currencyCode: string | null;
  timeZone: string | null;
  status: string | null;
  isTestAccount: boolean;
  // The directly-accessible account whose customer_client query surfaced
  // this row — null for level-0 rows (the directly-accessible account
  // describing itself).
  loginCustomerId: string | null;
}

// customers/6883911388 -> "6883911388". Returns null if the resource name
// doesn't match the expected shape rather than throwing on unexpected input.
function customerIdFromResourceName(resourceName: string | null | undefined): string | null {
  if (!resourceName) return null;
  const match = /^customers\/(\d+)$/.exec(resourceName.trim());
  return match ? match[1] : null;
}

// Digit-only normalization shared by every endpoint that accepts or returns
// a Google Ads customer ID (status/accounts/select-account) — strips
// hyphens and any other non-digit character (e.g. the "123-456-7890"
// display format), returning null for anything that normalizes to empty.
export function normalizeGoogleAdsCustomerId(id: string | null | undefined): string | null {
  if (!id) return null;
  const digits = id.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

export class GoogleAdsApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "GoogleAdsApiError";
  }
}

// Thrown by searchGoogleAds() when a single search would require following
// more pages/rows than the server-side safety limit allows — a deliberate,
// controlled failure rather than silently returning partial/truncated
// totals to the caller (which would be worse than an explicit error for
// anything computing a sum, like campaign-performance totals).
export class GoogleAdsResultLimitExceededError extends Error {
  constructor() {
    super("Google Ads result limit exceeded");
    this.name = "GoogleAdsResultLimitExceededError";
  }
}

// GET customers:listAccessibleCustomers — accounts directly accessible to
// the authenticated Google identity (see module doc comment for the
// "directly accessible" caveat).
export async function listAccessibleCustomers(accessToken: string, developerToken: string): Promise<string[]> {
  const res = await fetchWithTimeout(
    `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": developerToken,
      },
    },
  );
  if (!res.ok) {
    throw new GoogleAdsApiError("listAccessibleCustomers failed", res.status);
  }
  const json: any = await res.json().catch(() => ({}));
  const resourceNames: string[] = Array.isArray(json.resourceNames) ? json.resourceNames : [];
  const ids = resourceNames.map(customerIdFromResourceName).filter((id): id is string => !!id);
  return Array.from(new Set(ids));
}

// POST customers/{customerId}/googleAds:search with a customer_client GAQL
// query — discovers the queried customer itself (level 0) plus its direct
// children (level 1). loginCustomerId defaults to customerId itself, which
// is required when the queried account is (or may be) a manager account.
export async function fetchCustomerClients(
  accessToken: string,
  developerToken: string,
  customerId: string,
  loginCustomerId: string = customerId,
): Promise<GoogleAdsCustomerClient[]> {
  const query = `
    SELECT
      customer_client.id,
      customer_client.client_customer,
      customer_client.descriptive_name,
      customer_client.manager,
      customer_client.level,
      customer_client.currency_code,
      customer_client.time_zone,
      customer_client.status,
      customer_client.test_account
    FROM customer_client
    WHERE customer_client.level <= 1
  `.trim();

  const res = await fetchWithTimeout(
    `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": developerToken,
        "login-customer-id": loginCustomerId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) {
    throw new GoogleAdsApiError("customer_client search failed", res.status);
  }
  const json: any = await res.json().catch(() => ({}));
  const results: any[] = Array.isArray(json.results) ? json.results : [];

  return results
    .map((row): GoogleAdsCustomerClient | null => {
      const cc = row?.customerClient;
      if (!cc) return null;
      const childId = customerIdFromResourceName(cc.clientCustomer) ?? (cc.id != null ? String(cc.id) : null);
      if (!childId) return null;
      const level = Number(cc.level) || 0;
      return {
        customerId: childId,
        descriptiveName: cc.descriptiveName ?? null,
        isManager: !!cc.manager,
        level,
        currencyCode: cc.currencyCode ?? null,
        timeZone: cc.timeZone ?? null,
        status: cc.status ?? null,
        isTestAccount: !!cc.testAccount,
        loginCustomerId: level === 0 ? null : customerId,
      };
    })
    .filter((c): c is GoogleAdsCustomerClient => c !== null);
}

// The complete allowlist of internal error codes any Google Ads endpoint in
// this feature may persist to `google_ads_connections.last_error_code` /
// `lead_last_error_code` or return to the client. Any other value (a raw
// Google error code, an exception message, etc.) must never reach the
// client — status endpoints filter through this set and substitute null
// for anything not in it. Keep this list in sync with every place in the
// Google Ads feature that persists an error code (google-ads-oauth-callback.ts,
// google-ads-accounts.ts, google-ads-account-summary.ts,
// google-ads-campaign-performance.ts, google-ads-lead-sync.ts).
export const GOOGLE_ADS_SAFE_ERROR_CODES = new Set([
  "no_accessible_customers",
  "no_advertiser_accounts_found",
  "account_discovery_failed",
  "reconnect_required",
  "server_configuration",
  "network_error",
  "google_ads_api_error",
  "result_limit_exceeded",
  "account_mismatch",
]);

export type GoogleAdsConnectionStatus = "connected" | "needs_account_selection" | "needs_account_sync";

export interface GoogleAdsSelectionState {
  status: GoogleAdsConnectionStatus;
  selectedCustomerId: string | null;
  loginCustomerId: string | null;
  lastErrorCode: string | null;
}

// Pure derivation of connection status + selection fields from a discovered
// account list — no I/O, no knowledge of any prior/existing connection.
// Deliberately does NOT fall back to a previously-selected customer when
// this run's discovery is ambiguous or empty: selection fields are either
// freshly and unambiguously derived, or explicitly null. A manager account
// is never eligible for selection — only non-manager (advertiser) rows are
// considered.
export function deriveGoogleAdsSelectionState(accounts: GoogleAdsCustomerClient[]): GoogleAdsSelectionState {
  const advertisers = accounts.filter((a) => !a.isManager);

  if (advertisers.length === 1) {
    return {
      status: "connected",
      selectedCustomerId: advertisers[0].customerId,
      loginCustomerId: advertisers[0].loginCustomerId,
      lastErrorCode: null,
    };
  }

  if (advertisers.length > 1) {
    return { status: "needs_account_selection", selectedCustomerId: null, loginCustomerId: null, lastErrorCode: null };
  }

  // Zero advertisers — only managers were discovered, or nothing at all.
  return {
    status: "needs_account_sync",
    selectedCustomerId: null,
    loginCustomerId: null,
    lastErrorCode: "no_advertiser_accounts_found",
  };
}

// ── Safe client-facing status payload — pure derivation from a DB row ──────
// Extracted from google-ads-connection-status.ts so its actual logic
// (never the encrypted refresh token, connected-requires-a-selection,
// status/error-code allowlisting, digit-only ID normalization) is directly
// unit-testable without needing a live Supabase connection.

export type GoogleAdsSafeConnectionStatus = "disconnected" | "connected" | "needs_account_selection" | "needs_account_sync" | "error";

export interface GoogleAdsConnectionStatusPayload {
  connected: boolean;
  status: GoogleAdsSafeConnectionStatus;
  selectedCustomerId: string | null;
  loginCustomerId: string | null;
  accessibleCustomerIds: string[];
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
}

// Shape of the columns google-ads-connection-status.ts actually selects —
// deliberately does NOT include encrypted_refresh_token, so even a future
// accidental `select("*")` upstream couldn't leak it through this function
// (it simply isn't a field this type or the code below ever reads).
export interface GoogleAdsConnectionRowForStatus {
  status: string;
  selected_customer_id: string | null;
  login_customer_id: string | null;
  accessible_customer_ids: unknown;
  last_synced_at: string | null;
  last_error_code: string | null;
}

// Reconnect + Disconnect phase fix — "disconnected" was missing from this
// allowlist despite being a real value in GoogleAdsSafeConnectionStatus and
// the DB's own status CHECK constraint. Before this fix, a disconnected
// connection row would silently fall through to the "error" bucket below,
// making the Integrations card show "Connection error" instead of a proper
// disconnected state after a user-initiated disconnect.
const SAFE_CONNECTION_STATUSES = new Set<GoogleAdsSafeConnectionStatus>([
  "connected",
  "needs_account_selection",
  "needs_account_sync",
  "error",
  "disconnected",
]);

export function buildGoogleAdsStatusPayload(row: GoogleAdsConnectionRowForStatus | null): GoogleAdsConnectionStatusPayload {
  if (!row) {
    return {
      connected: false,
      status: "disconnected",
      selectedCustomerId: null,
      loginCustomerId: null,
      accessibleCustomerIds: [],
      lastSyncedAt: null,
      lastErrorCode: null,
    };
  }

  const status = SAFE_CONNECTION_STATUSES.has(row.status as GoogleAdsSafeConnectionStatus)
    ? (row.status as GoogleAdsSafeConnectionStatus)
    : "error";
  const selectedCustomerId = normalizeGoogleAdsCustomerId(row.selected_customer_id);
  const loginCustomerId = normalizeGoogleAdsCustomerId(row.login_customer_id);
  const accessibleCustomerIds = Array.isArray(row.accessible_customer_ids)
    ? Array.from(
        new Set(
          (row.accessible_customer_ids as unknown[])
            .map((id) => normalizeGoogleAdsCustomerId(typeof id === "string" ? id : String(id)))
            .filter((id): id is string => !!id),
        ),
      )
    : [];
  const lastErrorCode = row.last_error_code && GOOGLE_ADS_SAFE_ERROR_CODES.has(row.last_error_code) ? row.last_error_code : null;

  // "connected" requires BOTH the status literally being "connected" AND a
  // nonempty selected advertiser — a connected-but-unselected row (should
  // never happen given the callback/select-account invariants) is not
  // trusted blindly here.
  const connected = status === "connected" && !!selectedCustomerId;

  return { connected, status, selectedCustomerId, loginCustomerId, accessibleCustomerIds, lastSyncedAt: row.last_synced_at ?? null, lastErrorCode };
}

// ── Advertiser-selection validation — pure derivation from a live
// discovery result ──────────────────────────────────────────────────────
// Extracted from google-ads-select-account.ts so the exact rule ("must be
// found in THIS run's live discovery, must not be a manager") is directly
// unit-testable. Never trusts the request body or stored
// accessible_customer_ids — the caller is responsible for passing in a
// freshly-discovered `accounts` array.

export type GoogleAdsAccountValidationResult =
  | { ok: true; account: GoogleAdsCustomerClient }
  | { ok: false; reason: "not_found" | "manager_not_selectable" };

export function validateSelectableAdvertiser(
  accounts: GoogleAdsCustomerClient[],
  submittedCustomerId: string,
): GoogleAdsAccountValidationResult {
  const match = accounts.find((a) => a.customerId === submittedCustomerId);
  if (!match) return { ok: false, reason: "not_found" };
  if (match.isManager) return { ok: false, reason: "manager_not_selectable" };
  return { ok: true, account: match };
}

// Safety limits for searchGoogleAds()'s page-following loop — chosen to
// comfortably cover any realistic campaign-report result set while making
// a runaway/misbehaving query fail loudly (GoogleAdsResultLimitExceededError)
// instead of looping indefinitely or silently truncating totals. A single
// account-summary call (LIMIT 1, no nextPageToken) never comes close to
// either limit, so existing callers are unaffected.
const MAX_SEARCH_PAGES = 20;
const MAX_SEARCH_ROWS = 5000;

// ── Generic GAQL search — reusable low-level Google Ads REST call ─────────
// POST customers/{customerId}/googleAds:search with an ARBITRARY GAQL
// query (unlike fetchCustomerClients above, which is hardcoded to the
// customer_client query). Used by google-ads-account-summary.ts and
// google-ads-campaign-performance.ts — the one place any future caller
// should route a googleAds:search call through rather than hand-rolling
// the fetch again.
//
// Follows Google's own `nextPageToken` until either the response omits one
// (all results collected) or a safety limit is hit. The page token used
// here always originates from Google's PREVIOUS response in this same
// call — a caller can never supply one, so there is no way for
// browser-controlled input to influence pagination.
export async function searchGoogleAds(
  accessToken: string,
  developerToken: string,
  customerId: string,
  query: string,
  loginCustomerId?: string | null,
): Promise<any[]> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": developerToken,
    "Content-Type": "application/json",
  };
  // Only ever sent when a login customer ID is actually known — a direct
  // (non-child) advertiser has none, and Google's API does not require the
  // header in that case.
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

  const url = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:search`;
  const allResults: any[] = [];
  let pageToken: string | undefined;
  let pageCount = 0;

  do {
    pageCount++;
    if (pageCount > MAX_SEARCH_PAGES) {
      throw new GoogleAdsResultLimitExceededError();
    }

    const body: Record<string, unknown> = pageToken ? { query, pageToken } : { query };
    const res = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      throw new GoogleAdsApiError("googleAds:search failed", res.status);
    }
    const json: any = await res.json().catch(() => ({}));
    const pageResults: any[] = Array.isArray(json.results) ? json.results : [];
    allResults.push(...pageResults);

    if (allResults.length > MAX_SEARCH_ROWS) {
      throw new GoogleAdsResultLimitExceededError();
    }

    pageToken = typeof json.nextPageToken === "string" && json.nextPageToken.length > 0 ? json.nextPageToken : undefined;
  } while (pageToken);

  return allResults;
}

// ── Account-summary parsing — pure derivation from a googleAds:search
// result row ────────────────────────────────────────────────────────────
// Extracted so the exact parsing/validation rule (Google REST camelCase
// fields, 64-bit ID-as-string handling, and the returned customer ID must
// match what was actually requested) is directly unit-testable.

// Shared with google-ads-campaign-performance.ts, which needs the
// advertiser's currency/timezone even when the campaign query itself
// returns zero rows — read-only, LIMIT 1 against the `customer` resource,
// which always describes the queried customer itself (no WHERE clause
// needed/possible). Originally local to google-ads-account-summary.ts;
// exported here as the single source so the two endpoints can never drift.
export const GOOGLE_ADS_ACCOUNT_SUMMARY_QUERY =
  "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.test_account, customer.manager, customer.status FROM customer LIMIT 1";

export interface GoogleAdsAccountSummary {
  customerId: string;
  descriptiveName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  testAccount: boolean | null;
  manager: boolean;
  status: string | null;
  loginCustomerId: string | null;
}

export type GoogleAdsAccountSummaryParseResult =
  | { ok: true; account: GoogleAdsAccountSummary }
  | { ok: false; reason: "no_rows" | "customer_id_mismatch" };

export function parseGoogleAdsAccountSummary(
  results: any[],
  expectedCustomerId: string,
  loginCustomerId: string | null,
): GoogleAdsAccountSummaryParseResult {
  const row = Array.isArray(results) ? results[0] : undefined;
  const c = row?.customer;
  if (!c) return { ok: false, reason: "no_rows" };

  // Google returns 64-bit customer.id as a JSON string already, but this
  // coerces defensively in case a numeric value is ever returned instead.
  const rawId = c.id != null ? String(c.id) : null;
  const customerId = normalizeGoogleAdsCustomerId(rawId);
  if (!customerId || customerId !== expectedCustomerId) {
    // Fail safe — never return a row that doesn't match what was actually
    // requested, even if Google returned something.
    return { ok: false, reason: "customer_id_mismatch" };
  }

  return {
    ok: true,
    account: {
      customerId,
      descriptiveName: typeof c.descriptiveName === "string" ? c.descriptiveName : null,
      currencyCode: typeof c.currencyCode === "string" ? c.currencyCode : null,
      timeZone: typeof c.timeZone === "string" ? c.timeZone : null,
      testAccount: typeof c.testAccount === "boolean" ? c.testAccount : null,
      manager: !!c.manager,
      status: typeof c.status === "string" ? c.status : null,
      loginCustomerId,
    },
  };
}

// ── Connection-row preflight — pure derivation from a DB row ──────────────
// Extracted so google-ads-account-summary.ts's pre-Google-API validation
// (connection exists, is "connected", has a refresh token, has a valid
// selected customer ID) is directly unit-testable without a live Supabase
// connection or network call. Deliberately does NOT read
// encrypted_refresh_token's VALUE — only whether it's present — so this
// function never needs the actual secret to do its job.

export type GoogleAdsAccountSummaryErrorCode =
  | "google_ads_not_connected"
  | "account_selection_required"
  | "account_sync_required"
  | "reconnect_required";

export type GoogleAdsConnectionPreflightResult =
  | { ok: true; selectedCustomerId: string; loginCustomerId: string | null }
  | { ok: false; errorCode: GoogleAdsAccountSummaryErrorCode };

export interface GoogleAdsConnectionRowForSummary {
  status: string;
  encrypted_refresh_token: string | null;
  selected_customer_id: string | null;
  login_customer_id: string | null;
}

export function preflightGoogleAdsConnection(row: GoogleAdsConnectionRowForSummary | null): GoogleAdsConnectionPreflightResult {
  if (!row) return { ok: false, errorCode: "google_ads_not_connected" };

  if (row.status !== "connected") {
    if (row.status === "needs_account_selection") return { ok: false, errorCode: "account_selection_required" };
    // Reconnect + Disconnect phase — a user-initiated disconnect is
    // reported with the SAME code as "no connection row at all"
    // (google_ads_not_connected), since that's exactly what it means from
    // every Google Ads endpoint's perspective: this org currently has no
    // usable Google Ads access, full stop. This is what makes disconnect a
    // real, centrally-enforced block rather than a cosmetic status label —
    // every endpoint below already calls this same function first, so
    // nothing needs to be patched per-endpoint.
    if (row.status === "disconnected") return { ok: false, errorCode: "google_ads_not_connected" };
    // needs_account_sync, error, or any unrecognized value — all need a
    // sync/retry before a read can be attempted.
    return { ok: false, errorCode: "account_sync_required" };
  }

  if (!row.encrypted_refresh_token) return { ok: false, errorCode: "reconnect_required" };

  const selectedCustomerId = normalizeGoogleAdsCustomerId(row.selected_customer_id);
  if (!selectedCustomerId) return { ok: false, errorCode: "account_selection_required" };

  const loginCustomerId = normalizeGoogleAdsCustomerId(row.login_customer_id);
  return { ok: true, selectedCustomerId, loginCustomerId };
}

// ── Campaign-performance parsing — pure derivation from googleAds:search
// result rows ──────────────────────────────────────────────────────────
// Extracted so the exact numeric-safety policy is directly unit-testable:
//
// - impressions/clicks/costMicros are Google Ads "integer" metrics that
//   can legitimately exceed Number.MAX_SAFE_INTEGER for large accounts —
//   parsed and summed using BigInt internally, always serialized back to
//   decimal STRINGS in the public response so JavaScript never silently
//   loses precision on a large 64-bit value.
// - Documented policy for a malformed integer metric (negative, non-integer,
//   unparseable, or missing): normalized to 0. Impressions/clicks/cost are
//   defined by Google as non-negative counts, so a negative or fractional
//   value indicates a parsing anomaly rather than real data — silently
//   treating it as absent (0) is safer than either crashing the whole
//   response or forwarding a nonsensical negative number.
// - conversions/conversionValue are decimal metrics (fractional due to
//   attribution modeling) — parsed as finite numbers; NaN/Infinity/-Infinity
//   or anything unparseable normalizes to 0. Never returned as BigInt.

export interface GoogleAdsCampaignPerformance {
  campaignId: string;
  name: string;
  status: string | null;
  advertisingChannelType: string | null;
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

function parseNonNegativeIntegerMetric(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return 0n;
    return BigInt(value);
  }
  if (typeof value === "string") {
    // Digits only — rejects negative signs, decimals, empty strings, and
    // any other non-numeric content per the documented policy above.
    if (!/^\d+$/.test(value)) return 0n;
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function parseFiniteMetricNumber(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

// Parses + deduplicates/aggregates googleAds:search result rows for the
// campaign-performance query. If the same campaign ID appears in more than
// one row (not expected for this query, but never trusted blindly),
// integer metrics are summed via BigInt, conversions/conversionValue are
// summed as finite numbers, and name/status/advertisingChannelType are
// kept from the FIRST valid row for that campaign — later duplicate rows
// never overwrite already-captured metadata. Row order (Google's own
// impressions-descending sort) is preserved via first-occurrence position;
// rows are never re-sorted here.
export function parseGoogleAdsCampaignPerformance(results: any[]): GoogleAdsCampaignPerformance[] {
  interface Accumulator {
    name: string;
    status: string | null;
    advertisingChannelType: string | null;
    impressions: bigint;
    clicks: bigint;
    costMicros: bigint;
    conversions: number;
    conversionValue: number;
  }

  const byId = new Map<string, Accumulator>();
  const order: string[] = [];

  for (const row of Array.isArray(results) ? results : []) {
    const campaign = row?.campaign;
    if (!campaign) continue;

    const rawId = campaign.id != null ? String(campaign.id) : null;
    const campaignId = normalizeGoogleAdsCustomerId(rawId); // same digit-only rule applies to campaign IDs
    if (!campaignId) continue; // no usable ID — can't dedupe/aggregate, skip defensively

    const rawName = typeof campaign.name === "string" ? campaign.name.trim() : "";
    const name = rawName.length > 0 ? rawName : "Unnamed campaign";
    const status = typeof campaign.status === "string" ? campaign.status : null;
    const advertisingChannelType = typeof campaign.advertisingChannelType === "string" ? campaign.advertisingChannelType : null;

    const metrics = row?.metrics;
    const impressions = parseNonNegativeIntegerMetric(metrics?.impressions);
    const clicks = parseNonNegativeIntegerMetric(metrics?.clicks);
    const costMicros = parseNonNegativeIntegerMetric(metrics?.costMicros);
    const conversions = parseFiniteMetricNumber(metrics?.conversions);
    const conversionValue = parseFiniteMetricNumber(metrics?.conversionsValue);

    const existing = byId.get(campaignId);
    if (existing) {
      existing.impressions += impressions;
      existing.clicks += clicks;
      existing.costMicros += costMicros;
      existing.conversions += conversions;
      existing.conversionValue += conversionValue;
    } else {
      byId.set(campaignId, { name, status, advertisingChannelType, impressions, clicks, costMicros, conversions, conversionValue });
      order.push(campaignId);
    }
  }

  return order.map((campaignId) => {
    const agg = byId.get(campaignId)!;
    return {
      campaignId,
      name: agg.name,
      status: agg.status,
      advertisingChannelType: agg.advertisingChannelType,
      impressions: agg.impressions.toString(),
      clicks: agg.clicks.toString(),
      costMicros: agg.costMicros.toString(),
      conversions: Number.isFinite(agg.conversions) ? agg.conversions : 0,
      conversionValue: Number.isFinite(agg.conversionValue) ? agg.conversionValue : 0,
    };
  });
}

// Totals across every parsed campaign row — same BigInt-internal,
// string-serialized policy as the per-campaign values above.
export function summarizeGoogleAdsCampaignPerformance(campaigns: GoogleAdsCampaignPerformance[]): GoogleAdsCampaignPerformanceSummary {
  let impressions = 0n;
  let clicks = 0n;
  let costMicros = 0n;
  let conversions = 0;
  let conversionValue = 0;

  for (const c of campaigns) {
    impressions += BigInt(c.impressions);
    clicks += BigInt(c.clicks);
    costMicros += BigInt(c.costMicros);
    conversions += c.conversions;
    conversionValue += c.conversionValue;
  }

  return {
    campaigns: campaigns.length,
    impressions: impressions.toString(),
    clicks: clicks.toString(),
    costMicros: costMicros.toString(),
    conversions: Number.isFinite(conversions) ? conversions : 0,
    conversionValue: Number.isFinite(conversionValue) ? conversionValue : 0,
  };
}

// ── Conversion-action discovery (Phase 3, Step 7B.1) ────────────────────
// Read-only — this file makes no conversion-upload/mutate call anywhere.
// Fields chosen are the well-established, stable conversion_action fields
// (id/resource_name/name/status/type/category/primary_for_goal). A
// `conversion_action.include_in_conversions_metric` field was considered
// per the originating task's suggestion but deliberately OMITTED here:
// this repo has no prior googleAds:search call against the
// conversion_action resource to verify against, and guessing at a field
// name risks a full query failure (Google Ads REST rejects an entire GAQL
// query if any single selected field is invalid) — safer to omit an
// unverified field than to guess. Add it later once a live response has
// confirmed the exact field name for the pinned GOOGLE_ADS_API_VERSION.
//
// Filtered to ENABLED only (Google's conversion_action.status enum is
// ENABLED/REMOVED/HIDDEN — "Misconfigured" is a Google Ads UI-level setup
// warning about missing linked assets/tags, not a distinct API status, so
// a freshly created action still showing "Misconfigured" in the Google
// Ads UI is expected to come back here as status ENABLED).
export const GOOGLE_ADS_CONVERSION_ACTIONS_QUERY = `
  SELECT
    conversion_action.id,
    conversion_action.resource_name,
    conversion_action.name,
    conversion_action.status,
    conversion_action.type,
    conversion_action.category,
    conversion_action.primary_for_goal
  FROM conversion_action
  WHERE conversion_action.status = 'ENABLED'
`.trim();

export interface GoogleAdsConversionAction {
  id: string;
  resourceName: string | null;
  name: string;
  status: string | null;
  type: string | null;
  category: string | null;
  primaryForGoal: boolean | null;
}

// Parses googleAds:search result rows for the conversion_action resource.
// A row missing a usable numeric id or a name is skipped rather than
// included with a blank/undefined identity — neither can be meaningfully
// displayed or matched against in the mapping UI.
export function parseGoogleAdsConversionActions(results: any[]): GoogleAdsConversionAction[] {
  const out: GoogleAdsConversionAction[] = [];
  for (const row of Array.isArray(results) ? results : []) {
    const ca = row?.conversionAction;
    if (!ca) continue;
    const rawId = ca.id != null ? String(ca.id) : null;
    if (!rawId || !/^\d+$/.test(rawId)) continue;
    const name = typeof ca.name === "string" ? ca.name.trim() : "";
    if (!name) continue;
    out.push({
      id: rawId,
      resourceName: typeof ca.resourceName === "string" ? ca.resourceName : null,
      name,
      status: typeof ca.status === "string" ? ca.status : null,
      type: typeof ca.type === "string" ? ca.type : null,
      category: typeof ca.category === "string" ? ca.category : null,
      primaryForGoal: typeof ca.primaryForGoal === "boolean" ? ca.primaryForGoal : null,
    });
  }
  return out;
}

// The one Google Ads conversion-action `type` value documented as
// importable via offline CLICK conversion uploads (customers:
// uploadClickConversions, not yet called anywhere in this codebase — see
// Step 7B.2). A conversion action created directly in the Google Ads UI
// as a website/app tag-based goal typically has a different `type`
// (e.g. a tag-tracked "GOOGLE_ADS"-style value) and would need to be
// recreated with an "Import" source to become click-upload-compatible.
// This is intentionally advisory only (see
// google-ads-conversion-mapping-save.ts) — never used to silently block a
// mapping save, since the exact set of importable types is not something
// this repo has verified against a live response yet.
export const GOOGLE_ADS_CLICK_UPLOAD_COMPATIBLE_TYPE = "UPLOAD_CLICKS";

export interface DiscoveryResult {
  accounts: GoogleAdsCustomerClient[];
  // Customer IDs where the customer_client lookup itself failed (network,
  // permission, or API error) — surfaced so the caller can decide whether
  // the overall discovery still counts as a success (some accounts found)
  // or a full failure (nothing found, all lookups errored).
  failedCustomerIds: string[];
}

// Orchestrates discovery across every directly-accessible customer: for
// each one, fetch itself + direct children (see fetchCustomerClients),
// dedupe by customer ID across all roots via a visited-ID set. Does not
// recurse into discovered children's own hierarchies (see module doc
// comment) — bounded to depth 1 per root, so no unbounded recursion risk.
// ── Shared read-error classification (Ad Group/Keyword/Search Term
// drill-down phase) ──────────────────────────────────────────────────────
// Extracted from the pattern already used identically (but only ever
// inline/local) in google-ads-campaign-performance.ts and
// google-ads-lead-sync.ts — a thrown GoogleAdsResultLimitExceededError,
// GoogleAdsApiError, or anything else (network/timeout) each map to one of
// the fixed safe error codes above. Exported here so the three new
// drill-down endpoints (ad groups, keywords, search terms) share one
// implementation instead of each re-deriving it; existing callers are left
// exactly as they are (untouched, still using their own local copy) to
// avoid any behavior-change risk to already-shipped endpoints.
export function classifyGoogleAdsSearchError(e: unknown): { errorCode: string; logSuffix: string; logExtra?: Record<string, unknown> } {
  if (e instanceof GoogleAdsResultLimitExceededError) {
    return { errorCode: "result_limit_exceeded", logSuffix: "result_limit_exceeded" };
  }
  if (e instanceof GoogleAdsApiError) {
    return { errorCode: "google_ads_api_error", logSuffix: "google_ads_api_error", logExtra: { status: e.status } };
  }
  return { errorCode: "network_error", logSuffix: "network_error" };
}

// ── Ad Group drill-down (Google Ads Campaign -> Ad Groups -> Keywords /
// Search Terms phase) — read-only. Queries the `ad_group` MAIN resource
// (not a stats-only "view") specifically so a configured-but-zero-serving
// ad group still comes back as its own row with zeroed metrics, exactly
// mirroring how CAMPAIGN_PERFORMANCE_QUERY already behaves for campaigns
// (Step 13's zero-metric entity requirement) — a single query serves both
// "which ad groups are configured" and "how did they perform" without a
// second structural-only query.
export function buildGoogleAdsAdGroupPerformanceQuery(campaignId: string): string {
  return `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group.name,
      ad_group.status,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM ad_group
    WHERE campaign.id = ${campaignId}
      AND segments.date DURING LAST_30_DAYS
    ORDER BY metrics.impressions DESC
  `.trim();
}

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

// Same dedupe/aggregate-by-ID + BigInt-internal-string-serialized numeric
// policy as parseGoogleAdsCampaignPerformance above — a single ad_group
// GAQL row is expected per ad group for this query shape, but a repeat ID
// is still summed defensively rather than trusted blindly or overwritten.
export function parseGoogleAdsAdGroupPerformance(results: any[]): GoogleAdsAdGroupPerformanceRow[] {
  interface Accumulator {
    name: string;
    status: string | null;
    impressions: bigint;
    clicks: bigint;
    costMicros: bigint;
    conversions: number;
    conversionValue: number;
  }

  const byId = new Map<string, Accumulator>();
  const order: string[] = [];

  for (const row of Array.isArray(results) ? results : []) {
    const adGroup = row?.adGroup;
    if (!adGroup) continue;

    const rawId = adGroup.id != null ? String(adGroup.id) : null;
    const adGroupId = normalizeGoogleAdsCustomerId(rawId);
    if (!adGroupId) continue;

    const rawName = typeof adGroup.name === "string" ? adGroup.name.trim() : "";
    const name = rawName.length > 0 ? rawName : "Unnamed ad group";
    const status = typeof adGroup.status === "string" ? adGroup.status : null;

    const metrics = row?.metrics;
    const impressions = parseNonNegativeIntegerMetric(metrics?.impressions);
    const clicks = parseNonNegativeIntegerMetric(metrics?.clicks);
    const costMicros = parseNonNegativeIntegerMetric(metrics?.costMicros);
    const conversions = parseFiniteMetricNumber(metrics?.conversions);
    const conversionValue = parseFiniteMetricNumber(metrics?.conversionsValue);

    const existing = byId.get(adGroupId);
    if (existing) {
      existing.impressions += impressions;
      existing.clicks += clicks;
      existing.costMicros += costMicros;
      existing.conversions += conversions;
      existing.conversionValue += conversionValue;
    } else {
      byId.set(adGroupId, { name, status, impressions, clicks, costMicros, conversions, conversionValue });
      order.push(adGroupId);
    }
  }

  return order.map((adGroupId) => {
    const agg = byId.get(adGroupId)!;
    return {
      adGroupId,
      name: agg.name,
      status: agg.status,
      impressions: agg.impressions.toString(),
      clicks: agg.clicks.toString(),
      costMicros: agg.costMicros.toString(),
      conversions: Number.isFinite(agg.conversions) ? agg.conversions : 0,
      conversionValue: Number.isFinite(agg.conversionValue) ? agg.conversionValue : 0,
    };
  });
}

// ── Keyword drill-down — TWO separate read-only queries (Keyword
// Drill-Down Live Fix pass), not one combined query.
//
// The original single-query version (`ad_group_criterion` + metrics +
// `segments.date` + `ad_group_criterion.negative = false`, all in one GAQL
// statement) failed live against the real v25 API for the current test
// account — a configured, genuinely zero-serving keyword under
// Leads-Search-1 -> Ad group 1 never came back at all, while the
// structurally-identical single-query shape for Ad Groups (`ad_group` main
// resource) and the stats-only Search Terms view both worked correctly.
// Per this task's explicit instruction, the exact live HTTP status/Google
// error code/message could not be captured this session — no `netlify dev`
// browser session is available in this sandboxed environment (the same
// limitation noted in every prior task in this engagement) — so this is a
// STRUCTURAL fix, not a guess at one specific broken field: it eliminates
// the entire combined-query failure surface by never asking Google to
// jointly resolve criterion structure + metrics + date segmentation +
// negative-status filtering in a single statement, splitting instead into:
//
//   1. A pure STRUCTURE query — no metrics, no segments.date, no
//      `negative = false` filter (that filter is applied AFTER parsing
//      instead, per Step 5, in case it was itself part of the original
//      incompatibility) — so a configured KEYWORD-type criterion is
//      guaranteed to come back regardless of any date/metrics-segment
//      quirk, exactly as Ad Groups already does via its own main-resource
//      query.
//   2. A separate METRICS query — same WHERE scope + type=KEYWORD, with
//      `segments.date DURING LAST_30_DAYS` isolated to ONLY this query, so
//      if metrics genuinely don't exist for a criterion in the window
//      (the completely normal, expected case here), that absence can never
//      suppress the structural row.
//
// Results are merged server-side by criterion_id (Step 9) — every keyword
// Query A proves exists gets a row in the final output, zero-filled from
// Query B when no matching metrics row exists. If the user re-runs the
// live test and this still fails, the exact Google error text should be
// captured directly from the Netlify function console output for this
// endpoint and a further precision fix made from that.
export function buildGoogleAdsKeywordStructureQuery(campaignId: string, adGroupId: string): string {
  return `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group.name,
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      ad_group_criterion.negative
    FROM ad_group_criterion
    WHERE campaign.id = ${campaignId}
      AND ad_group.id = ${adGroupId}
      AND ad_group_criterion.type = 'KEYWORD'
  `.trim();
}

export function buildGoogleAdsKeywordMetricsQuery(campaignId: string, adGroupId: string): string {
  return `
    SELECT
      ad_group_criterion.criterion_id,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM ad_group_criterion
    WHERE campaign.id = ${campaignId}
      AND ad_group.id = ${adGroupId}
      AND ad_group_criterion.type = 'KEYWORD'
      AND segments.date DURING LAST_30_DAYS
  `.trim();
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

interface GoogleAdsKeywordStructureRow {
  criterionId: string;
  text: string;
  matchType: string | null;
  status: string | null;
  negative: boolean;
}

// Query A's parser — structural only, no metrics field ever read (a
// structure-query result row has no `metrics` object at all). Negative
// criteria are parsed (not silently dropped here) so the negative filter
// itself can be applied as an explicit, auditable step in
// mergeGoogleAdsKeywordPerformance() below, per Step 5's "filter negatives
// server-side after parsing" instruction — never exposed further than that
// filter, and never surfaced in any UI.
function parseGoogleAdsKeywordStructureRows(results: any[]): GoogleAdsKeywordStructureRow[] {
  const out: GoogleAdsKeywordStructureRow[] = [];
  for (const row of Array.isArray(results) ? results : []) {
    const criterion = row?.adGroupCriterion;
    if (!criterion) continue;

    const rawId = criterion.criterionId != null ? String(criterion.criterionId) : null;
    const criterionId = normalizeGoogleAdsCustomerId(rawId);
    if (!criterionId) continue;

    const rawText = typeof criterion.keyword?.text === "string" ? criterion.keyword.text.trim() : "";
    if (!rawText) continue; // no usable keyword text — skip rather than show a blank row

    out.push({
      criterionId,
      text: rawText,
      matchType: typeof criterion.keyword?.matchType === "string" ? criterion.keyword.matchType : null,
      status: typeof criterion.status === "string" ? criterion.status : null,
      negative: criterion.negative === true,
    });
  }
  return out;
}

// Query B's parser — keyed by criterion_id, aggregated defensively in case
// date segmentation ever produces more than one metrics row per criterion
// (Step 10's "no duplicates" requirement) — summed the same BigInt-internal
// way as every other metrics parser in this file.
function parseGoogleAdsKeywordMetricsRows(results: any[]): Map<string, {
  impressions: bigint; clicks: bigint; costMicros: bigint; conversions: number; conversionValue: number;
}> {
  const byId = new Map<string, { impressions: bigint; clicks: bigint; costMicros: bigint; conversions: number; conversionValue: number }>();
  for (const row of Array.isArray(results) ? results : []) {
    const criterion = row?.adGroupCriterion;
    const rawId = criterion?.criterionId != null ? String(criterion.criterionId) : null;
    const criterionId = normalizeGoogleAdsCustomerId(rawId);
    if (!criterionId) continue;

    const metrics = row?.metrics;
    const impressions = parseNonNegativeIntegerMetric(metrics?.impressions);
    const clicks = parseNonNegativeIntegerMetric(metrics?.clicks);
    const costMicros = parseNonNegativeIntegerMetric(metrics?.costMicros);
    const conversions = parseFiniteMetricNumber(metrics?.conversions);
    const conversionValue = parseFiniteMetricNumber(metrics?.conversionsValue);

    const existing = byId.get(criterionId);
    if (existing) {
      existing.impressions += impressions;
      existing.clicks += clicks;
      existing.costMicros += costMicros;
      existing.conversions += conversions;
      existing.conversionValue += conversionValue;
    } else {
      byId.set(criterionId, { impressions, clicks, costMicros, conversions, conversionValue });
    }
  }
  return byId;
}

// Merges Query A (structure — the source of truth for which keywords
// exist) with Query B (metrics — zero-filled when absent, per Step 4/9).
// Negative criteria are dropped here (Step 5) rather than in either raw
// query, so removing/relocating the `negative = false` GAQL filter can
// never regress this product requirement. Final sort is clicks DESC, then
// impressions DESC, then keyword text ASC (Step 11) — the text tiebreaker
// is new versus the original single-query version, added specifically so
// multiple zero-metric keywords (clicks=0, impressions=0 for all of them)
// still render in a stable, deterministic order instead of whatever order
// Query A's own (unordered) GAQL response happened to return them in.
export function mergeGoogleAdsKeywordPerformance(
  structureResults: any[],
  metricsResults: any[],
): GoogleAdsKeywordPerformanceRow[] {
  const structure = parseGoogleAdsKeywordStructureRows(structureResults);
  const metricsById = parseGoogleAdsKeywordMetricsRows(metricsResults);

  const rows: GoogleAdsKeywordPerformanceRow[] = structure
    .filter((k) => !k.negative)
    .map((k) => {
      const m = metricsById.get(k.criterionId);
      return {
        criterionId: k.criterionId,
        text: k.text,
        matchType: k.matchType,
        status: k.status,
        impressions: (m?.impressions ?? 0n).toString(),
        clicks: (m?.clicks ?? 0n).toString(),
        costMicros: (m?.costMicros ?? 0n).toString(),
        conversions: m && Number.isFinite(m.conversions) ? m.conversions : 0,
        conversionValue: m && Number.isFinite(m.conversionValue) ? m.conversionValue : 0,
      };
    });

  // Compared as BigInt throughout (never coerced to Number) so a very
  // large click/impression count can never lose precision or produce a
  // wrong sign in the comparator.
  rows.sort((a, b) => {
    const ac = BigInt(a.clicks), bc = BigInt(b.clicks);
    if (ac !== bc) return ac < bc ? 1 : -1;
    const ai = BigInt(a.impressions), bi = BigInt(b.impressions);
    if (ai !== bi) return ai < bi ? 1 : -1;
    return a.text.localeCompare(b.text);
  });

  return rows;
}

// ── Search Term drill-down — `search_term_view` is a genuine stats-only
// view (unlike ad_group/ad_group_criterion above): a search term is an
// observed query, not something anyone configures, so there is no
// "configured entity" row to preserve for a zero-serving window — an empty
// result here is normal and expected (Step 24), not a sign of a query
// strategy problem. `search_term_view.status` (SearchTermTargetingStatus)
// was deliberately left OUT of this query: this codebase has no prior
// verified live response against this exact resource/version, and Google
// Ads REST rejects an ENTIRE query if any single selected field name is
// wrong — same conservative precedent already set for
// conversion_action.include_in_conversions_metric (see
// GOOGLE_ADS_CONVERSION_ACTIONS_QUERY above). Add it later once confirmed
// live.
export function buildGoogleAdsSearchTermPerformanceQuery(campaignId: string, adGroupId: string): string {
  return `
    SELECT
      campaign.id,
      ad_group.id,
      search_term_view.search_term,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM search_term_view
    WHERE campaign.id = ${campaignId}
      AND ad_group.id = ${adGroupId}
      AND segments.date DURING LAST_30_DAYS
    ORDER BY metrics.clicks DESC, metrics.impressions DESC
  `.trim();
}

export interface GoogleAdsSearchTermPerformanceRow {
  searchTerm: string;
  impressions: string;
  clicks: string;
  costMicros: string;
  conversions: number;
  conversionValue: number;
}

// Deduped/aggregated by the search term TEXT itself (search terms have no
// numeric ID) — the same GAQL row shape can otherwise repeat the same term
// text more than once, e.g. if segmented by multiple dates internally
// before this reporting window aggregation.
export function parseGoogleAdsSearchTermPerformance(results: any[]): GoogleAdsSearchTermPerformanceRow[] {
  interface Accumulator {
    impressions: bigint;
    clicks: bigint;
    costMicros: bigint;
    conversions: number;
    conversionValue: number;
  }

  const byTerm = new Map<string, Accumulator>();
  const order: string[] = [];

  for (const row of Array.isArray(results) ? results : []) {
    const view = row?.searchTermView;
    const rawTerm = typeof view?.searchTerm === "string" ? view.searchTerm.trim() : "";
    if (!rawTerm) continue;

    const metrics = row?.metrics;
    const impressions = parseNonNegativeIntegerMetric(metrics?.impressions);
    const clicks = parseNonNegativeIntegerMetric(metrics?.clicks);
    const costMicros = parseNonNegativeIntegerMetric(metrics?.costMicros);
    const conversions = parseFiniteMetricNumber(metrics?.conversions);
    const conversionValue = parseFiniteMetricNumber(metrics?.conversionsValue);

    const existing = byTerm.get(rawTerm);
    if (existing) {
      existing.impressions += impressions;
      existing.clicks += clicks;
      existing.costMicros += costMicros;
      existing.conversions += conversions;
      existing.conversionValue += conversionValue;
    } else {
      byTerm.set(rawTerm, { impressions, clicks, costMicros, conversions, conversionValue });
      order.push(rawTerm);
    }
  }

  return order.map((searchTerm) => {
    const agg = byTerm.get(searchTerm)!;
    return {
      searchTerm,
      impressions: agg.impressions.toString(),
      clicks: agg.clicks.toString(),
      costMicros: agg.costMicros.toString(),
      conversions: Number.isFinite(agg.conversions) ? agg.conversions : 0,
      conversionValue: Number.isFinite(agg.conversionValue) ? agg.conversionValue : 0,
    };
  });
}

export async function discoverGoogleAdsAccounts(
  accessToken: string,
  developerToken: string,
  directCustomerIds: string[],
): Promise<DiscoveryResult> {
  const visited = new Set<string>();
  const accounts: GoogleAdsCustomerClient[] = [];
  const failedCustomerIds: string[] = [];

  for (const customerId of directCustomerIds) {
    try {
      const clients = await fetchCustomerClients(accessToken, developerToken, customerId, customerId);
      for (const client of clients) {
        if (visited.has(client.customerId)) continue;
        visited.add(client.customerId);
        accounts.push(client);
      }
    } catch {
      failedCustomerIds.push(customerId);
    }
  }

  return { accounts, failedCustomerIds };
}
