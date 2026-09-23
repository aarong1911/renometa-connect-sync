// netlify/functions/lib/google-ads-config.ts
//
// Netlify Function env-footprint reduction (2026-09). GOOGLE_ADS_CLIENT_ID,
// GOOGLE_ADS_CLIENT_SECRET, and GOOGLE_ADS_DEVELOPER_TOKEN were previously
// read directly via process.env in 13+ separate handler files plus the
// shared refresh-token helper — every one of those reads counted toward
// this deployment's site-wide Netlify env, which Netlify injects into
// EVERY Function's Lambda environment regardless of which specific
// function actually uses a given var. Moving these three onto the same
// app_config_secrets + getAppConfig(s) resolver pattern already used for
// META_APP_ID/META_APP_SECRET and TWILIO_ACCOUNT_SID/AUTH_TOKEN/PHONE_NUMBER
// (see app-config-store.ts) lets them be removed from Netlify's Function
// env entirely once seeded, with zero production behavior change in the
// meantime — getAppConfig() checks process.env first, so this is
// backward-compatible for as long as the Netlify vars remain set.
//
// This is a credentials resolver ONLY — it never talks to Google itself
// (see google-ads-oauth-token.ts for the actual refresh-token exchange,
// and google-ads-api.ts for the Ads API calls). Never logs a client
// secret or developer token value.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppConfigs } from "./app-config-store";

export interface GoogleAdsCredentials {
  clientId: string;
  clientSecret: string;
  developerToken: string;
}

/**
 * Resolves all three Google Ads app-level credentials in one batched
 * app_config_secrets read (or process.env override). Returns null if any
 * are missing — callers already treat "not configured" uniformly (a
 * server_configuration-style error), so this never partially resolves.
 */
export async function getGoogleAdsCredentials(supabaseAdmin: SupabaseClient): Promise<GoogleAdsCredentials | null> {
  const config = await getAppConfigs(supabaseAdmin, [
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_DEVELOPER_TOKEN",
  ]);
  const clientId = config.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = config.GOOGLE_ADS_CLIENT_SECRET;
  const developerToken = config.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!clientId || !clientSecret || !developerToken) return null;
  return { clientId, clientSecret, developerToken };
}

/** Only the developer token — for the many read-path handlers that already
 * have an access token in hand (from a stored/refreshed connection) and
 * need just this one header value, without paying for a full 3-key batch
 * read when 1 suffices. Still a single getAppConfigs() cache-backed call. */
export async function getGoogleAdsDeveloperToken(supabaseAdmin: SupabaseClient): Promise<string | null> {
  const config = await getAppConfigs(supabaseAdmin, ["GOOGLE_ADS_DEVELOPER_TOKEN"]);
  return config.GOOGLE_ADS_DEVELOPER_TOKEN ?? null;
}
