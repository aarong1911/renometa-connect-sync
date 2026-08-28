// netlify/functions/meta-ads-insights.ts
//
// Generic read-only Meta Insights endpoint — Phase 1A / Step 2 (Step 10).
// Selected ad account resolved server-side via resolveMetaAdsContext().
// `level` is restricted to a strict enum and never passed through to Meta
// unchecked. Optional single-ID filters (campaignId/adSetId/adId) are
// numerically validated and proven to belong to the selected account
// before being used — same discipline as meta-ads-adsets.ts/meta-ads-ads.ts.
//
// GET ?level=campaign&dateRange=LAST_30_DAYS&campaignId=123

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveMetaAdsContext } from "./lib/meta-ads-context";
import { metaAdsCorsHeaders } from "./lib/meta-ads-cors";
import { parseMetaAdsDateRange, metaAdsDateRangeToGraphQuery, metaAdsDateRangeToResponseShape } from "./lib/meta-ads-date-range";
import {
  META_INSIGHTS_LEVELS,
  metaInsightsFieldsForLevel,
  normalizeInsightsRow,
  metaAdsContextErrorResponse,
  classifyMetaGraphApiError,
  toMetaAdAccountGraphId,
  isValidMetaObjectId,
  verifyMetaObjectBelongsToAccount,
  type MetaInsightsLevel,
} from "./lib/meta-ads-api";
import { metaGraphPaginate, MetaGraphApiError } from "./lib/meta-graph-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const ENTITY_ID_FIELD: Record<Exclude<MetaInsightsLevel, "account">, string> = {
  campaign: "campaign_id",
  adset: "adset_id",
  ad: "ad_id",
};

const PAGE_LIMIT = 25;
const MAX_PAGES = 20; // shared bound — same ceiling as the ads endpoint, the most granular level

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

  const levelInput = (params.level?.trim() || "account") as MetaInsightsLevel;
  if (!(META_INSIGHTS_LEVELS as readonly string[]).includes(levelInput)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `level must be one of: ${META_INSIGHTS_LEVELS.join(", ")}` }) };
  }

  const parsedRange = parseMetaAdsDateRange({ dateRange: params.dateRange, startDate: params.startDate, endDate: params.endDate });
  if (!parsedRange.ok) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: parsedRange.error }) };
  }
  const dateRange = parsedRange.value;

  const hasAnyFilter = !!(params.campaignId || params.adSetId || params.adId);
  if (levelInput === "account" && hasAnyFilter) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "campaignId/adSetId/adId filters are not applicable at level=account" }) };
  }

  const filtering: Array<{ field: string; operator: string; value: string }> = [];
  for (const [param, field] of [
    ["campaignId", "campaign.id"],
    ["adSetId", "adset.id"],
    ["adId", "ad.id"],
  ] as const) {
    const raw = params[param]?.trim();
    if (!raw) continue;
    if (!isValidMetaObjectId(raw)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `${param} must be numeric` }) };
    }
    const belongs = await verifyMetaObjectBelongsToAccount(ctx.accessToken, raw, ctx.selectedAdAccountId);
    if (!belongs) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: `Object not found for ${param} under this ad account` }) };
    }
    filtering.push({ field, operator: "EQUAL", value: raw });
  }

  const actId = toMetaAdAccountGraphId(ctx.selectedAdAccountId);

  try {
    const insightsPage = await metaGraphPaginate<any>({
      path: `/${actId}/insights`,
      accessToken: ctx.accessToken,
      query: {
        level: levelInput,
        fields: metaInsightsFieldsForLevel(levelInput),
        ...(filtering.length > 0 ? { filtering: JSON.stringify(filtering) } : {}),
        ...metaAdsDateRangeToGraphQuery(dateRange),
      },
      pageLimit: PAGE_LIMIT,
      maxPages: MAX_PAGES,
    });

    const entityIdField = levelInput === "account" ? null : ENTITY_ID_FIELD[levelInput];
    const rows = insightsPage.items.length > 0
      ? insightsPage.items.map((row: any) => ({
          entityId: entityIdField && typeof row[entityIdField] === "string" ? row[entityIdField] : null,
          ...normalizeInsightsRow(row),
        }))
      : // No activity in the window at all — return a single zero-filled
        // row rather than an empty array, so callers don't need to special-
        // case "no data" vs "an error occurred" for the common empty case.
        [{ entityId: null, ...normalizeInsightsRow(undefined) }];

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        connected: true,
        level: levelInput,
        dateRange: metaAdsDateRangeToResponseShape(dateRange),
        rows,
        truncated: insightsPage.truncated,
      }),
    };
  } catch (e) {
    if (e instanceof MetaGraphApiError) {
      console.error("[meta-ads-insights] Graph API error", e.toSafeJSON());
      const { statusCode, body } = classifyMetaGraphApiError(e);
      return { statusCode, headers, body: JSON.stringify(body) };
    }
    console.error("[meta-ads-insights] unexpected error", e instanceof Error ? e.message : e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not load Meta Ads Insights right now" }) };
  }
};
