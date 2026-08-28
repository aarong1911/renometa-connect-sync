// netlify/functions/meta-ads-campaigns.ts
//
// Read-only Meta Ads campaign list + bulk campaign-level Insights —
// Phase 1A / Step 2 (Step 7). Selected ad account resolved server-side via
// resolveMetaAdsContext(); campaigns and their Insights are each fetched
// in ONE bulk call (bounded pagination) and merged by campaign_id — never
// one Insights call per campaign row (Step 11).
//
// GET ?dateRange=LAST_30_DAYS&status=ACTIVE,PAUSED

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveMetaAdsContext } from "./lib/meta-ads-context";
import { metaAdsCorsHeaders } from "./lib/meta-ads-cors";
import { parseMetaAdsDateRange, metaAdsDateRangeToGraphQuery, metaAdsDateRangeToResponseShape } from "./lib/meta-ads-date-range";
import {
  META_CAMPAIGN_FIELDS,
  metaInsightsFieldsForLevel,
  normalizeMetaCampaign,
  normalizeInsightsRow,
  mergeInsightsByEntity,
  metaAdsContextErrorResponse,
  classifyMetaGraphApiError,
  toMetaAdAccountGraphId,
  type MetaAdsInsightsRowWithEntity,
} from "./lib/meta-ads-api";
import { metaGraphPaginate, MetaGraphApiError } from "./lib/meta-graph-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Meta's full effective_status enum (campaign-relevant subset) — a status
// filter value outside this set is rejected with 400 rather than passed
// through to Meta verbatim.
const KNOWN_EFFECTIVE_STATUSES = new Set([
  "ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "PENDING_REVIEW", "DISAPPROVED",
  "PREAPPROVED", "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ADSET_PAUSED",
  "IN_PROCESS", "WITH_ISSUES",
]);

const MAX_CAMPAIGNS = 100;
const PAGE_LIMIT = 25;
const MAX_PAGES = Math.ceil(MAX_CAMPAIGNS / PAGE_LIMIT); // 4

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

  let statusFilter: string[] | undefined;
  if (params.status) {
    const requested = params.status.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const invalid = requested.filter((s) => !KNOWN_EFFECTIVE_STATUSES.has(s));
    if (invalid.length > 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown status value(s): ${invalid.join(", ")}` }) };
    }
    statusFilter = requested;
  }

  const actId = toMetaAdAccountGraphId(ctx.selectedAdAccountId);

  try {
    const campaignsPage = await metaGraphPaginate<any>({
      path: `/${actId}/campaigns`,
      accessToken: ctx.accessToken,
      query: {
        fields: META_CAMPAIGN_FIELDS,
        ...(statusFilter ? { effective_status: JSON.stringify(statusFilter) } : {}),
      },
      pageLimit: PAGE_LIMIT,
      maxPages: MAX_PAGES,
    });
    const campaigns = campaignsPage.items.map(normalizeMetaCampaign);

    // ONE bulk Insights call for every campaign under this account for the
    // requested window — never a per-campaign call (Step 11).
    const insightsPage = await metaGraphPaginate<any>({
      path: `/${actId}/insights`,
      accessToken: ctx.accessToken,
      query: {
        level: "campaign",
        fields: metaInsightsFieldsForLevel("campaign"),
        ...metaAdsDateRangeToGraphQuery(dateRange),
      },
      pageLimit: PAGE_LIMIT,
      maxPages: MAX_PAGES,
    });
    const insightsRows: MetaAdsInsightsRowWithEntity[] = insightsPage.items.map((row: any) => ({
      entityId: typeof row.campaign_id === "string" ? row.campaign_id : null,
      ...normalizeInsightsRow(row),
    }));

    const merged = mergeInsightsByEntity(campaigns, insightsRows);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        connected: true,
        dateRange: metaAdsDateRangeToResponseShape(dateRange),
        campaigns: merged,
        truncated: campaignsPage.truncated || insightsPage.truncated,
      }),
    };
  } catch (e) {
    if (e instanceof MetaGraphApiError) {
      console.error("[meta-ads-campaigns] Graph API error", e.toSafeJSON());
      const { statusCode, body } = classifyMetaGraphApiError(e);
      return { statusCode, headers, body: JSON.stringify(body) };
    }
    console.error("[meta-ads-campaigns] unexpected error", e instanceof Error ? e.message : e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not load Meta Ads campaigns right now" }) };
  }
};
