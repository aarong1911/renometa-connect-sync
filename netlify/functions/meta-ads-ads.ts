// netlify/functions/meta-ads-ads.ts
//
// Read-only Meta Ads ad list + bulk ad-level Insights — Phase 1A / Step 2
// (Step 9). Selected ad account resolved server-side via
// resolveMetaAdsContext(). Optional `campaignId` and/or `adSetId` query
// params FILTER the result but never establish authorization on their
// own — each is numerically validated and proven to belong to the
// selected account (verifyMetaObjectBelongsToAccount) before being used in
// a Graph filter. Every list/Insights call is always scoped to
// `/act_<selected>/...` — an ID from another advertiser can never produce
// data.
//
// GET ?dateRange=LAST_30_DAYS&campaignId=123&adSetId=456

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveMetaAdsContext } from "./lib/meta-ads-context";
import { metaAdsCorsHeaders } from "./lib/meta-ads-cors";
import { parseMetaAdsDateRange, metaAdsDateRangeToGraphQuery, metaAdsDateRangeToResponseShape } from "./lib/meta-ads-date-range";
import {
  META_AD_FIELDS,
  metaInsightsFieldsForLevel,
  normalizeMetaAd,
  normalizeInsightsRow,
  mergeInsightsByEntity,
  metaAdsContextErrorResponse,
  classifyMetaGraphApiError,
  toMetaAdAccountGraphId,
  isValidMetaObjectId,
  verifyMetaObjectBelongsToAccount,
  type MetaAdsInsightsRowWithEntity,
} from "./lib/meta-ads-api";
import { metaGraphPaginate, MetaGraphApiError } from "./lib/meta-graph-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const MAX_ADS = 500;
const PAGE_LIMIT = 25;
const MAX_PAGES = Math.ceil(MAX_ADS / PAGE_LIMIT); // 20

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
    const { body } = metaAdsContextErrorResponse(ctx.errorCode);
    return { statusCode: 200, headers, body: JSON.stringify({ connected: false, selectionState: ctx.errorCode, ...body }) };
  }

  const params = event.queryStringParameters ?? {};
  const parsedRange = parseMetaAdsDateRange({ dateRange: params.dateRange, startDate: params.startDate, endDate: params.endDate });
  if (!parsedRange.ok) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: parsedRange.error }) };
  }
  const dateRange = parsedRange.value;

  const requestedCampaignId = params.campaignId?.trim();
  const requestedAdSetId = params.adSetId?.trim();
  const filtering: Array<{ field: string; operator: string; value: string }> = [];

  if (requestedCampaignId) {
    if (!isValidMetaObjectId(requestedCampaignId)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "campaignId must be numeric" }) };
    }
    const belongs = await verifyMetaObjectBelongsToAccount(ctx.accessToken, requestedCampaignId, ctx.selectedAdAccountId);
    if (!belongs) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Campaign not found for this ad account" }) };
    }
    filtering.push({ field: "campaign.id", operator: "EQUAL", value: requestedCampaignId });
  }

  if (requestedAdSetId) {
    if (!isValidMetaObjectId(requestedAdSetId)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "adSetId must be numeric" }) };
    }
    const belongs = await verifyMetaObjectBelongsToAccount(ctx.accessToken, requestedAdSetId, ctx.selectedAdAccountId);
    if (!belongs) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Ad set not found for this ad account" }) };
    }
    filtering.push({ field: "adset.id", operator: "EQUAL", value: requestedAdSetId });
  }

  const actId = toMetaAdAccountGraphId(ctx.selectedAdAccountId);
  const filteringParam = filtering.length > 0 ? JSON.stringify(filtering) : undefined;

  try {
    const adsPage = await metaGraphPaginate<any>({
      path: `/${actId}/ads`,
      accessToken: ctx.accessToken,
      query: {
        fields: META_AD_FIELDS,
        ...(filteringParam ? { filtering: filteringParam } : {}),
      },
      pageLimit: PAGE_LIMIT,
      maxPages: MAX_PAGES,
    });
    const ads = adsPage.items.map(normalizeMetaAd);

    const insightsPage = await metaGraphPaginate<any>({
      path: `/${actId}/insights`,
      accessToken: ctx.accessToken,
      query: {
        level: "ad",
        fields: metaInsightsFieldsForLevel("ad"),
        ...(filteringParam ? { filtering: filteringParam } : {}),
        ...metaAdsDateRangeToGraphQuery(dateRange),
      },
      pageLimit: PAGE_LIMIT,
      maxPages: MAX_PAGES,
    });
    const insightsRows: MetaAdsInsightsRowWithEntity[] = insightsPage.items.map((row: any) => ({
      entityId: typeof row.ad_id === "string" ? row.ad_id : null,
      ...normalizeInsightsRow(row),
    }));

    const merged = mergeInsightsByEntity(ads, insightsRows);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        connected: true,
        dateRange: metaAdsDateRangeToResponseShape(dateRange),
        ads: merged,
        truncated: adsPage.truncated || insightsPage.truncated,
      }),
    };
  } catch (e) {
    if (e instanceof MetaGraphApiError) {
      console.error("[meta-ads-ads] Graph API error", e.toSafeJSON());
      const { statusCode, body } = classifyMetaGraphApiError(e);
      return { statusCode, headers, body: JSON.stringify(body) };
    }
    console.error("[meta-ads-ads] unexpected error", e instanceof Error ? e.message : e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not load Meta Ads ads right now" }) };
  }
};
