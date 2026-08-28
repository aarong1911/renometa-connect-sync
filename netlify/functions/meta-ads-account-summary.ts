// netlify/functions/meta-ads-account-summary.ts
//
// Read-only Meta Ads account summary — Phase 1A / Step 2 (Step 6).
// Authenticated RenoMeta user only; the selected ad account is resolved
// entirely server-side via resolveMetaAdsContext(). No ad account ID is
// ever accepted from the browser.
//
// GET ?dateRange=LAST_30_DAYS (or startDate=YYYY-MM-DD&endDate=YYYY-MM-DD)
//
// Never returns access_token, encrypted token, app secret, OAuth state, or
// nonce.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveMetaAdsContext } from "./lib/meta-ads-context";
import { metaAdsCorsHeaders } from "./lib/meta-ads-cors";
import { parseMetaAdsDateRange, metaAdsDateRangeToGraphQuery, metaAdsDateRangeToResponseShape } from "./lib/meta-ads-date-range";
import {
  fetchMetaAdAccountSummary,
  normalizeInsightsRow,
  metaAdsContextErrorResponse,
  classifyMetaGraphApiError,
  toMetaAdAccountGraphId,
  metaInsightsFieldsForLevel,
} from "./lib/meta-ads-api";
import { metaGraphRequest, MetaGraphApiError } from "./lib/meta-graph-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export const handler: Handler = async (event) => {
  const headers = metaAdsCorsHeaders(event, "GET, OPTIONS");
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const ctx = await resolveMetaAdsContext(supabaseAdmin, event.headers.authorization);
  if (!ctx.ok) {
    if (ctx.errorCode === "unauthorized") {
      const { statusCode, body } = metaAdsContextErrorResponse(ctx.errorCode);
      return { statusCode, headers, body: JSON.stringify(body) };
    }
    // not_connected / no_ad_account_selected / token_decrypt_failed all
    // resolve to a structured "not ready yet" response rather than a hard
    // error — same convention as meta-ads-accounts.ts.
    const { body } = metaAdsContextErrorResponse(ctx.errorCode);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ connected: false, selectionState: ctx.errorCode, ...body }),
    };
  }

  const params = event.queryStringParameters ?? {};
  const parsedRange = parseMetaAdsDateRange({ dateRange: params.dateRange, startDate: params.startDate, endDate: params.endDate });
  if (!parsedRange.ok) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: parsedRange.error }) };
  }
  const dateRange = parsedRange.value;

  try {
    // Single lightweight call — proves continued token access AND supplies
    // fresh account metadata (Step 15). Never re-runs full Business/ad
    // account discovery for a reporting request.
    const adAccount = await fetchMetaAdAccountSummary(ctx.accessToken, ctx.selectedAdAccountId);

    const insightsJson = await metaGraphRequest<{ data?: any[] }>({
      path: `/${toMetaAdAccountGraphId(ctx.selectedAdAccountId)}/insights`,
      accessToken: ctx.accessToken,
      query: {
        level: "account",
        fields: metaInsightsFieldsForLevel("account"),
        ...metaAdsDateRangeToGraphQuery(dateRange),
      },
    });
    const summary = normalizeInsightsRow(insightsJson.data?.[0]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        connected: true,
        selectionState: "connected",
        dateRange: metaAdsDateRangeToResponseShape(dateRange),
        adAccount,
        summary,
      }),
    };
  } catch (e) {
    if (e instanceof MetaGraphApiError) {
      console.error("[meta-ads-account-summary] Graph API error", e.toSafeJSON());
      const { statusCode, body } = classifyMetaGraphApiError(e);
      return { statusCode, headers, body: JSON.stringify(body) };
    }
    console.error("[meta-ads-account-summary] unexpected error", e instanceof Error ? e.message : e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not load Meta Ads account summary right now" }) };
  }
};
