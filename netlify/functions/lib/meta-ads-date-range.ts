// netlify/functions/lib/meta-ads-date-range.ts
//
// Controlled, validated date-range parsing for Meta Ads reporting
// endpoints (Phase 1A / Step 2, Step 3). Presets map directly to Meta's
// own `date_preset` enum values so Meta computes the actual calendar
// boundaries using the AD ACCOUNT's own reporting timezone — this file
// deliberately never computes since/until dates itself for a preset (doing
// so in a Netlify function would use server/UTC time, not the account's
// timezone, which the task explicitly requires respecting). Only a custom
// range computes explicit since/until, and Meta interprets those calendar
// dates in the ad account's own timezone too (documented Marketing API
// behavior — not independently re-verified against a live response this
// session).

export const META_DATE_PRESETS = [
  "TODAY",
  "YESTERDAY",
  "LAST_7_DAYS",
  "LAST_14_DAYS",
  "LAST_30_DAYS",
  "THIS_MONTH",
  "LAST_MONTH",
] as const;
export type MetaDatePresetKey = (typeof META_DATE_PRESETS)[number];

const PRESET_TO_META_DATE_PRESET: Record<MetaDatePresetKey, string> = {
  TODAY: "today",
  YESTERDAY: "yesterday",
  LAST_7_DAYS: "last_7d",
  LAST_14_DAYS: "last_14d",
  LAST_30_DAYS: "last_30d",
  THIS_MONTH: "this_month",
  LAST_MONTH: "last_month",
};

const MAX_CUSTOM_RANGE_DAYS = 366;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // Round-trip check rejects e.g. "2026-02-30" (JS Date normalizes it
  // forward to March 2 rather than throwing).
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export type MetaAdsDateRange = { type: "preset"; preset: MetaDatePresetKey } | { type: "custom"; since: string; until: string };

export type ParseMetaAdsDateRangeResult = { ok: true; value: MetaAdsDateRange } | { ok: false; error: string };

export function parseMetaAdsDateRange(query: {
  dateRange?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}): ParseMetaAdsDateRangeResult {
  const startDate = query.startDate?.trim();
  const endDate = query.endDate?.trim();

  if (startDate || endDate) {
    if (!startDate || !endDate) {
      return { ok: false, error: "Both startDate and endDate are required for a custom date range" };
    }
    if (!isValidCalendarDate(startDate) || !isValidCalendarDate(endDate)) {
      return { ok: false, error: "startDate and endDate must be valid YYYY-MM-DD calendar dates" };
    }
    const [sy, sm, sd] = startDate.split("-").map(Number);
    const [ey, em, ed] = endDate.split("-").map(Number);
    const startMs = Date.UTC(sy, sm - 1, sd);
    const endMs = Date.UTC(ey, em - 1, ed);
    if (endMs < startMs) {
      return { ok: false, error: "endDate must not be before startDate" };
    }
    const rangeDays = Math.round((endMs - startMs) / 86_400_000) + 1;
    if (rangeDays > MAX_CUSTOM_RANGE_DAYS) {
      return { ok: false, error: `Date range must not exceed ${MAX_CUSTOM_RANGE_DAYS} days` };
    }
    return { ok: true, value: { type: "custom", since: startDate, until: endDate } };
  }

  const presetInput = (query.dateRange?.trim() || "LAST_30_DAYS").toUpperCase();
  if (!(META_DATE_PRESETS as readonly string[]).includes(presetInput)) {
    return { ok: false, error: `dateRange must be one of: ${META_DATE_PRESETS.join(", ")}` };
  }
  return { ok: true, value: { type: "preset", preset: presetInput as MetaDatePresetKey } };
}

// Converts a validated MetaAdsDateRange into the exact Graph API query
// param(s) to attach to an Insights request.
export function metaAdsDateRangeToGraphQuery(range: MetaAdsDateRange): Record<string, string> {
  if (range.type === "preset") {
    return { date_preset: PRESET_TO_META_DATE_PRESET[range.preset] };
  }
  return { time_range: JSON.stringify({ since: range.since, until: range.until }) };
}

// Safe, honest echo for the API response envelope — never fabricates
// resolved since/until dates for a preset (Meta computes those internally
// using the ad account's own timezone; reproducing that here without an
// extra API round trip isn't reliable, and a wrong guess would be worse
// than omitting it).
export function metaAdsDateRangeToResponseShape(range: MetaAdsDateRange): { preset: string | null; since: string | null; until: string | null } {
  if (range.type === "preset") {
    return { preset: range.preset, since: null, until: null };
  }
  return { preset: null, since: range.since, until: range.until };
}
