// netlify/functions/lib/meta-ads-cors.ts
//
// Explicit CORS allowlist for the new Meta Ads discovery/selection
// endpoints (meta-ads-accounts.ts, meta-ads-select-account.ts) — same
// allowlist/reflect-if-present pattern as google-ads-cors.ts. Existing
// Meta endpoints (meta-connection-status.ts, meta-create-ad-campaign.ts,
// meta-oauth-*.ts) use a plain wildcard "*" and are left untouched; new
// Phase 1A endpoints carry more sensitive account-linkage detail and are
// held to the stricter, already-established Google Ads standard instead.
//
// Never wildcard — these are authenticated, bearer-token endpoints.

import type { Handler } from "@netlify/functions";

const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://localhost:9999",
  "https://connect.renometa.com",
]);

export function metaAdsCorsHeaders(event: Parameters<Handler>[0], methods: string): Record<string, string> {
  const requestOrigin = event.headers.origin ?? event.headers.Origin;
  const origin = requestOrigin && ALLOWED_ORIGINS.has(requestOrigin) ? requestOrigin : "";
  return {
    "Content-Type": "application/json",
    ...(origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": methods,
  };
}
