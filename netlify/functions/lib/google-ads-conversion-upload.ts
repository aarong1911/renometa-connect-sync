// netlify/functions/lib/google-ads-conversion-upload.ts
//
// Phase 3, Step 7B.2: the ONLY place in this codebase that calls Google
// Ads' offline click-conversion upload endpoint
// (customers:uploadClickConversions). Every caller (currently just
// google-ads-conversion-export.ts) must go through
// uploadSingleGoogleAdsClickConversion() rather than hand-rolling the
// fetch — this keeps the request shape, partialFailure handling, and
// response parsing in exactly one place.
//
// Reuses fetchWithTimeout()/GOOGLE_ADS_API_VERSION from google-ads-api.ts
// — no second Google Ads HTTP client exists.
//
// Never logs or exposes: the access token, developer token, or a raw
// Google response body beyond the specific safe fields parsed here.

import { fetchWithTimeout, GOOGLE_ADS_API_VERSION } from "./google-ads-api";

// ── Conversion date/time formatting ──────────────────────────────────────
// Google's documented conversionDateTime format for offline click
// conversions is "yyyy-MM-dd HH:mm:ss+|-HH:mm" (e.g.
// "2019-01-01 12:32:45-08:00") — a literal space between date and time,
// and an explicit numeric UTC offset (not a bare "Z").
//
// Deterministic policy: ALWAYS formatted in UTC, using the explicit
// "+00:00" offset. event_at is a timestamptz (an absolute instant) — this
// preserves that instant exactly. This repo has no confirmed per-advertiser
// timezone wired into the conversion-event pipeline (Google Ads accounts
// do have their own timeZone, e.g. via GoogleAdsAccountSummary.timeZone,
// but nothing in the Step 7A/7A.1 event model ties a specific advertiser
// timezone to a given event) — converting to an invented "local" time
// would be guessing, not deriving from a canonical source. A UTC offset is
// valid per Google's documented format (it accepts any real UTC offset,
// not just US timezones), so this is the simplest standards-compliant
// choice that never fabricates a timezone.
export function formatGoogleAdsConversionDateTime(eventAtIso: string): string {
  const d = new Date(eventAtIso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const MM = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const HH = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}+00:00`;
}

// customers/{customerId}/conversionActions/{conversionActionId} — always
// built server-side from the selected advertiser + the saved mapping's own
// conversion_action_id, never accepted as a resource name from a caller.
export function buildGoogleAdsConversionActionResourceName(customerId: string, conversionActionId: string): string {
  return `customers/${customerId}/conversionActions/${conversionActionId}`;
}

export interface GoogleAdsClickConversionInput {
  gclid: string;
  conversionActionResourceName: string;
  conversionDateTime: string;
  // Only ever set together (see the value/currency rule in
  // google-ads-conversion-export.ts) — never one without the other.
  conversionValue?: number;
  currencyCode?: string;
}

// Builds the exact JSON body Google expects for ONE click conversion.
// Optional fields are omitted entirely (never sent as null/undefined) —
// Google Ads REST rejects/mishandles explicit nulls on optional fields for
// some resources, and omission is unambiguous either way.
export function buildGoogleAdsClickConversionPayload(input: GoogleAdsClickConversionInput): Record<string, unknown> {
  const conversion: Record<string, unknown> = {
    gclid: input.gclid,
    conversionAction: input.conversionActionResourceName,
    conversionDateTime: input.conversionDateTime,
  };
  if (input.conversionValue !== undefined) conversion.conversionValue = input.conversionValue;
  if (input.currencyCode !== undefined) conversion.currencyCode = input.currencyCode;
  return conversion;
}

export interface GoogleAdsClickConversionUploadResult {
  gclid: string;
  conversionAction: string | null;
}

export type GoogleAdsUploadClickConversionsOutcome =
  | { ok: true; result: GoogleAdsClickConversionUploadResult }
  | { ok: false; reason: "partial_failure"; errorCode: string | null; errorMessage: string | null }
  | { ok: false; reason: "http_error"; status: number }
  | { ok: false; reason: "network_error" };

// Step 10: single-event upload — exactly ONE click conversion per call, so
// index 0 in Google's response always maps 1:1 to the one local event
// being exported. partialFailure is still sent as true (matching Google's
// documented request shape for this endpoint) even with a batch of one —
// with one conversion, ANY failure surfaces as partialFailureError on the
// response rather than an HTTP error, so that field must always be
// checked even when res.ok is true (see Step 9).
export async function uploadSingleGoogleAdsClickConversion(
  accessToken: string,
  developerToken: string,
  customerId: string,
  loginCustomerId: string | null,
  conversion: GoogleAdsClickConversionInput,
): Promise<GoogleAdsUploadClickConversionsOutcome> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": developerToken,
    "Content-Type": "application/json",
  };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

  const body = {
    conversions: [buildGoogleAdsClickConversionPayload(conversion)],
    partialFailure: true,
  };

  const url = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}:uploadClickConversions`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    return { ok: false, reason: "network_error" };
  }

  if (!res.ok) {
    return { ok: false, reason: "http_error", status: res.status };
  }

  const json: any = await res.json().catch(() => ({}));
  return parseGoogleAdsUploadClickConversionsResponse(json, conversion.gclid);
}

// Extracted as its own pure function so the partial-failure/success parsing
// (Step 9) is directly unit-testable against a mocked response body,
// without making a real network call — this is what Test H/I in the Step
// 7B.2 controlled test plan exercise.
//
// HTTP 200 alone is NEVER treated as success — `partialFailureError`
// (Google's documented mechanism for surfacing a per-conversion failure
// inside an otherwise-200 response when partialFailure=true) is always
// checked first. Only a response with no partialFailureError AND a
// results[0] row counts as a confirmed success.
export function parseGoogleAdsUploadClickConversionsResponse(json: any, requestedGclid: string): GoogleAdsUploadClickConversionsOutcome {
  if (json?.partialFailureError) {
    const details = Array.isArray(json.partialFailureError.details) ? json.partialFailureError.details : [];
    let errorCode: string | null = null;
    let errorMessage: string | null = typeof json.partialFailureError.message === "string" ? json.partialFailureError.message : null;
    for (const d of details) {
      const errors = d?.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0];
        if (first?.errorCode && typeof first.errorCode === "object") {
          // Google's ErrorCode is a oneof struct, e.g. { "conversionUploadError": "INVALID_CONVERSION_ACTION" }
          const key = Object.keys(first.errorCode)[0];
          errorCode = key ? `${key}:${first.errorCode[key]}` : null;
        }
        errorMessage = typeof first?.message === "string" ? first.message : errorMessage;
        break;
      }
    }
    return { ok: false, reason: "partial_failure", errorCode, errorMessage };
  }

  const results = Array.isArray(json?.results) ? json.results : [];
  const row = results[0];
  if (!row) {
    // HTTP success, no partialFailureError, but also no results row —
    // never assumed to be success; Google's contract is that a real
    // success always echoes the uploaded conversion back in results[].
    return { ok: false, reason: "partial_failure", errorCode: "no_result_row", errorMessage: null };
  }

  return {
    ok: true,
    result: {
      gclid: typeof row.gclid === "string" ? row.gclid : requestedGclid,
      conversionAction: typeof row.conversionAction === "string" ? row.conversionAction : null,
    },
  };
}
