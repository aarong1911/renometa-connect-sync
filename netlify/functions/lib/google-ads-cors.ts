// netlify/functions/lib/google-ads-cors.ts
//
// Shared explicit CORS allowlist for the Google Ads status/discovery/
// selection endpoints (google-ads-connection-status.ts, google-ads-accounts.ts,
// google-ads-select-account.ts) — same allowlist and reflect-if-present
// pattern google-ads-oauth-start.ts already uses inline, extracted here so
// three new authenticated endpoints don't each carry their own copy.
// google-ads-oauth-start.ts and google-ads-oauth-callback.ts are left with
// their own inline copies untouched (no reason to touch a working file).
//
// Never wildcard — these are authenticated, bearer-token endpoints.

import type { Handler } from "@netlify/functions";

const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://localhost:9999",
  "https://connect.renometa.com",
]);

export function googleAdsCorsHeaders(event: Parameters<Handler>[0], methods: string): Record<string, string> {
  const requestOrigin = event.headers.origin ?? event.headers.Origin;
  const origin = requestOrigin && ALLOWED_ORIGINS.has(requestOrigin) ? requestOrigin : "";
  return {
    "Content-Type": "application/json",
    ...(origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": methods,
  };
}
