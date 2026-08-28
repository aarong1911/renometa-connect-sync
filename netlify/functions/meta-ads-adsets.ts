// netlify/functions/meta-ads-adsets.ts
//
// Read-only Meta Ads ad-set list + bulk ad-set-level Insights —
// Phase 1A / Step 2 (Step 8). Selected ad account resolved server-side via
// resolveMetaAdsContext(). An optional `campaignId` query param FILTERS
// the result but never establishes authorization on its own — it is
// numerically validated and then proven to belong to the selected account
// (via verifyMetaObjectBelongsToAccount, a single lightweight call) before
// ever being used in a Graph query. Every list/Insights call is always
// scoped to the org's own `/act_<selected>/...` edge — a campaignId from
// another advertiser can never produce data, because it fails the
// ownership check before any Graph filter is ever built from it.
//
// GET ?dateRange=LAST_30_DAYS&campaignId=123456789

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveMetaAdsContext } from "./lib/meta-ads-context";
import { metaAdsCorsHeaders } from "./lib/meta-ads-cors";
import { parseMetaAdsDateRange, metaAdsDateRangeToGraphQuery, metaAdsDateRangeToResponseShape } from "./lib/meta-ads-date-range";
import {
  META_ADSET_FIELDS,
  metaInsightsFieldsForLevel,
  normalizeMetaAdSet,
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

const MAX_ADSETS = 250;
const PAGE_LIMIT = 25;
const MAX_PAGES = Math.ceil(MAX_ADSETS / PAGE_LIMIT); // 10

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
  let filtering: Array<{ field: string; operator: string; value: string }> | undefined;

  if (requestedCampaignId) {
    if (!isValidMetaObjectId(requestedCampaignId)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "campaignId must be numeric" }) };
    }
    const belongs = await verifyMetaObjectBelongsToAccount(ctx.accessToken, requestedCampaignId, ctx.selectedAdAccountId);
    if (!belongs) {
      // Never reveals whether the campaign exists at all under a different
      // advertiser — same response whether it's malformed, missing, or
      // simply belongs to someone else.
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Campaign not found for this ad account" }) };
    }
    filtering = [{ field: "campaign.id", operator: "EQUAL", value: requestedCampaignId }];
  }

  const actId = toMetaAdAccountGraphId(ctx.selectedAdAccountId);

  try {
    const adSetsPage = await metaGraphPaginate<any>({
      path: `/${actId}/adsets`,
      accessToken: ctx.accessToken,
      query: {
        fields: META_ADSET_FIELDS,
        ...(filtering ? { filtering: JSON.stringify(filtering) } : {}),
      },
      pageLimit: PAGE_LIMIT,
      maxPages: MAX_PAGES,
    });
    const adSets = adSetsPage.items.map(normalizeMetaAdSet);

    const insightsPage = await metaGraphPaginate<any>({
      path: `/${actId}/insights`,
      accessToken: ctx.accessToken,
      query: {
        level: "adset",
        fields: metaInsightsFieldsForLevel("adset"),
        ...(filtering ? { filtering: JSON.stringify(filtering) } : {}),
        ...metaAdsDateRangeToGraphQuery(dateRange),
      },
      pageLimit: PAGE_LIMIT,
      maxPages: MAX_PAGES,
    });
    const insightsRows: MetaAdsInsightsRowWithEntity[] = insightsPage.items.map((row: any) => ({
      entityId: typeof row.adset_id === "string" ? row.adset_id : null,
      ...normalizeInsightsRow(row),
    }));

    const merged = mergeInsightsByEntity(adSets, insightsRows);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        connected: true,
        dateRange: metaAdsDateRangeToResponseShape(dateRange),
        adSets: merged,
        truncated: adSetsPage.truncated || insightsPage.truncated,
      }),
    };
  } catch (e) {
    if (e instanceof MetaGraphApiError) {
      console.error("[meta-ads-adsets] Graph API error", e.toSafeJSON());
      const { statusCode, body } = classifyMetaGraphApiError(e);
      return { statusCode, headers, body: JSON.stringify(body) };
    }
    console.error("[meta-ads-adsets] unexpected error", e instanceof Error ? e.message : e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not load Meta Ads ad sets right now" }) };
  }
};
