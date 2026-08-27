// netlify/functions/lib/meta-graph-api.ts
//
// Centralized, low-level Meta Graph API client for Phase 1A (read-only Meta
// Ads discovery/reporting). Mirrors the role google-ads-api.ts plays for
// Google Ads: single source for the API version string, a typed error, a
// bounded-retry request function, and cursor pagination — so new Meta Ads
// code never hand-rolls a fetch() call the way the existing WhatsApp/
// Messenger/Instagram/meta-create-ad-campaign.ts code does (those are left
// untouched in this task; see the Phase 1A Step 1 audit for the full
// inventory of pre-existing hardcoded v21.0 call sites).
//
// Never logs or throws the access token, the request URL (which carries the
// token as a query param), or META_APP_SECRET.

const META_GRAPH_BASE = "https://graph.facebook.com";

// Single source for the Graph API version — override via
// META_GRAPH_API_VERSION if Meta deprecates v21.0 before this is revisited.
// Deliberately NOT exposed to the browser (read only in Netlify Functions,
// server-side). Pre-existing WhatsApp/Messenger/Instagram/meta-oauth-*.ts
// code still hardcodes "v21.0" inline — this constant is not yet wired into
// those files; see the Step 1 audit for the full call-site inventory.
export const META_GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION?.trim() || "v21.0";

const DEFAULT_TIMEOUT_MS = 15_000;

// Bounded exponential backoff — 2 retries beyond the first attempt (3 total
// attempts), only for conditions explicitly classified as retryable below.
// Chosen to fail fast rather than let a Netlify function hang: worst case
// (all three attempts hit the full timeout) is ~3 * DEFAULT_TIMEOUT_MS plus
// ~1.2s of backoff, comfortably under Netlify's function time limit.
const RETRY_BACKOFF_MS = [300, 900];
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MetaGraphErrorPayload {
  httpStatus: number;
  metaMessage: string | null;
  metaType: string | null;
  metaCode: number | null;
  metaErrorSubcode: number | null;
  fbTraceId: string | null;
  isTransient: boolean;
}

// Typed error for any non-2xx response OR a 2xx response whose body still
// contains a Graph API `error` object (Meta does this for some endpoints).
// Deliberately never carries the request URL (which contains access_token)
// or the raw access token — only what Meta itself reports.
export class MetaGraphApiError extends Error {
  readonly httpStatus: number;
  readonly metaMessage: string | null;
  readonly metaType: string | null;
  readonly metaCode: number | null;
  readonly metaErrorSubcode: number | null;
  readonly fbTraceId: string | null;
  readonly isTransient: boolean;

  constructor(payload: MetaGraphErrorPayload) {
    super(payload.metaMessage || `Meta Graph API request failed (HTTP ${payload.httpStatus})`);
    this.name = "MetaGraphApiError";
    this.httpStatus = payload.httpStatus;
    this.metaMessage = payload.metaMessage;
    this.metaType = payload.metaType;
    this.metaCode = payload.metaCode;
    this.metaErrorSubcode = payload.metaErrorSubcode;
    this.fbTraceId = payload.fbTraceId;
    this.isTransient = payload.isTransient;
  }

  // Safe to log or return to an authenticated caller — no URL, no token.
  toSafeJSON(): Record<string, unknown> {
    return {
      httpStatus: this.httpStatus,
      metaMessage: this.metaMessage,
      metaType: this.metaType,
      metaCode: this.metaCode,
      metaErrorSubcode: this.metaErrorSubcode,
      fbTraceId: this.fbTraceId,
      isTransient: this.isTransient,
    };
  }
}

// Only HTTP 429, HTTP 5xx, or an error body Meta itself marks
// `is_transient: true` are retried. OAuth/token-invalid errors (e.g. type
// "OAuthException", subcode 190), permission errors, malformed requests,
// unsupported fields, and object-not-found/access errors all arrive as 4xx
// with is_transient absent/false, so they fall through untouched here —
// retrying them would waste time on a failure that will never succeed.
function isRetryable(httpStatus: number, errorObj: any): boolean {
  if (httpStatus === 429) return true;
  if (httpStatus >= 500) return true;
  if (errorObj && errorObj.is_transient === true) return true;
  return false;
}

export interface MetaGraphRequestOptions {
  /** Graph object path, e.g. "/me", "/me/businesses", "/act_123/campaigns". Leading slash optional. */
  path: string;
  accessToken: string;
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined | null>;
  /** Only used when method is "POST" — serialized as JSON. Not exercised by any Phase 1A caller yet. */
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

// Generic, bounded-retry Meta Graph API call. GET is the only method any
// Phase 1A caller actually uses; POST is supported structurally (per the
// architecture request) without refactoring any existing write flow
// (meta-create-ad-campaign.ts) to use it in this task.
export async function metaGraphRequest<T = any>(opts: MetaGraphRequestOptions): Promise<T> {
  const { path, accessToken, method = "GET", query, body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  if (!accessToken) throw new Error("metaGraphRequest: accessToken is required");

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${META_GRAPH_BASE}/${META_GRAPH_API_VERSION}${normalizedPath}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  // Attached server-side, always — never accepted as part of `query` from a
  // caller, so a caller can never accidentally (or maliciously) override it.
  url.searchParams.set("access_token", accessToken);

  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method,
        signal: controller.signal,
        ...(method === "POST"
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }
          : {}),
      });

      let json: any = {};
      try {
        json = await res.json();
      } catch {
        // Non-JSON body — fall through with an empty object; res.ok / the
        // status code below still drives the error/success decision.
      }

      const errorObj = json?.error;
      if (!res.ok || errorObj) {
        const payload: MetaGraphErrorPayload = {
          httpStatus: res.status,
          metaMessage: typeof errorObj?.message === "string" ? errorObj.message : null,
          metaType: typeof errorObj?.type === "string" ? errorObj.type : null,
          metaCode: typeof errorObj?.code === "number" ? errorObj.code : null,
          metaErrorSubcode: typeof errorObj?.error_subcode === "number" ? errorObj.error_subcode : null,
          fbTraceId: typeof errorObj?.fbtrace_id === "string" ? errorObj.fbtrace_id : null,
          isTransient: errorObj?.is_transient === true,
        };
        const err = new MetaGraphApiError(payload);
        if (isRetryable(res.status, errorObj) && attempt < MAX_ATTEMPTS - 1) {
          lastError = err;
          await sleep(RETRY_BACKOFF_MS[attempt]);
          continue;
        }
        throw err;
      }

      return json as T;
    } catch (e) {
      if (e instanceof MetaGraphApiError) throw e;
      // Network error / timeout (AbortError) — retryable up to the same
      // attempt budget as an HTTP 5xx, since both represent "the request
      // never got a real answer" rather than a definitive rejection.
      if (attempt < MAX_ATTEMPTS - 1) {
        lastError = e;
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      throw new MetaGraphApiError({
        httpStatus: 0,
        metaMessage: "Network error contacting the Meta Graph API",
        metaType: null,
        metaCode: null,
        metaErrorSubcode: null,
        fbTraceId: null,
        isTransient: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // Unreachable in practice (the loop always returns or throws), but keeps
  // the function's return type honest for TypeScript.
  throw lastError instanceof Error ? lastError : new Error("metaGraphRequest failed");
}

export interface MetaGraphPageResult<T> {
  items: T[];
  /** true if maxPages was reached before Meta's own cursor was exhausted — more results may exist. */
  truncated: boolean;
}

const DEFAULT_PAGE_LIMIT = 25;
const DEFAULT_MAX_PAGES = 5;

// Cursor-based pagination. Deliberately does NOT follow the raw
// `paging.next` URL Meta returns (which embeds the access token in its
// query string) — instead extracts `paging.cursors.after` and issues the
// next page through metaGraphRequest above, so access_token attachment
// always goes through the one controlled code path. Bounded by maxPages —
// never an unbounded while-loop.
export async function metaGraphPaginate<T = any>(opts: {
  path: string;
  accessToken: string;
  query?: Record<string, string | number | undefined | null>;
  pageLimit?: number;
  maxPages?: number;
}): Promise<MetaGraphPageResult<T>> {
  const { path, accessToken, query, pageLimit = DEFAULT_PAGE_LIMIT, maxPages = DEFAULT_MAX_PAGES } = opts;
  const items: T[] = [];
  let after: string | undefined;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const json: any = await metaGraphRequest({
      path,
      accessToken,
      query: { ...query, limit: pageLimit, ...(after ? { after } : {}) },
    });

    const data: T[] = Array.isArray(json?.data) ? json.data : [];
    items.push(...data);

    const nextAfter = json?.paging?.cursors?.after;
    if (typeof nextAfter !== "string" || !nextAfter || data.length === 0) {
      after = undefined;
      break;
    }
    after = nextAfter;
    if (page === maxPages - 1) truncated = true;
  }

  return { items, truncated };
}
