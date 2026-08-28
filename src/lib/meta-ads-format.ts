// src/lib/meta-ads-format.ts
//
// Display formatting for the Meta Ads reporting UI (Phase 1A / Step 3) —
// mirrors google-ads-format.ts's conventions (Intl-based currency
// formatting, never a hardcoded "$", "—" for unavailable ratios/costs,
// never NaN/Infinity) rather than reinventing them.

// Locale-aware currency formatting. Meta Insights' `spend`/`cpc`/`cpm` and
// the account's `costPerLead` are already in the account's MAJOR currency
// unit (e.g. dollars for USD, NOT cents) — see the unit-convention note in
// netlify/functions/lib/meta-ads-api.ts. `amount === null` means the
// metric itself is unavailable (never a fabricated 0) and always renders
// as "—", matching Step 9's null-formatting rule.
export function formatMetaAdsCurrency(amount: number | null, currencyCode: string | null | undefined): string {
  if (amount === null || !Number.isFinite(amount)) return "—";
  const currency = currencyCode && /^[A-Za-z]{3}$/.test(currencyCode) ? currencyCode.toUpperCase() : "USD";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    // Only reachable for a malformed/unrecognized ISO code.
    return `${currency} ${amount.toFixed(2)}`;
  }
}

// Locale-formatted integer count (impressions/reach/clicks/leads) — these
// are always non-negative additive counters normalized to 0 (never null)
// by the backend, so this never needs a "—" branch.
export function formatMetaAdsCount(value: number): string {
  const n = Number.isFinite(value) ? value : 0;
  try {
    return new Intl.NumberFormat().format(n);
  } catch {
    return String(n);
  }
}

// Meta's `ctr` is already a percentage-scale number (e.g. 2.35 means
// 2.35%), never a 0-1 fraction — never re-multiplied by 100 here.
export function formatMetaAdsPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}%`;
}

// ── Enum label normalization (Step 14, 17) ───────────────────────────────
// One generic word-splitting title-caser covers both objective and
// optimization-goal enums without a giant lookup table: "OFFSITE_CONVERSIONS"
// -> "Offsite Conversions", "LEAD_GENERATION" -> "Lead Generation",
// "LANDING_PAGE_VIEWS" -> "Landing Page Views". Never mutates the
// underlying data — display-only.
function titleCaseEnum(raw: string): string {
  return raw
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const OBJECTIVE_LABELS: Record<string, string> = {
  OUTCOME_LEADS: "Leads",
  OUTCOME_SALES: "Sales",
  OUTCOME_TRAFFIC: "Traffic",
  OUTCOME_ENGAGEMENT: "Engagement",
  OUTCOME_AWARENESS: "Awareness",
  OUTCOME_APP_PROMOTION: "App Promotion",
};

export function formatMetaAdsObjective(objective: string | null): string {
  if (!objective) return "—";
  return OBJECTIVE_LABELS[objective] ?? titleCaseEnum(objective.replace(/^OUTCOME_/, ""));
}

export function formatMetaAdsOptimizationGoal(goal: string | null): string {
  if (!goal) return "—";
  return titleCaseEnum(goal);
}
