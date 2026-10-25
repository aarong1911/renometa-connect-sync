// src/lib/pricing/pricing-engine.ts
//
// Pricing Intelligence v1 (P1) — the PURE, deterministic pricing engine.
//
// It turns ALREADY-AUTHORIZED historical evidence into a staff-facing price SUGGESTION with a range, a confidence level
// and the evidence behind it. It is a calculator, not an agent:
//   - no database, no network, no model, no randomness, no wall clock (the caller injects `now`);
//   - same inputs -> byte-identical output;
//   - it NEVER writes anything and NEVER decides authority.
//
// TRUST CONTRACT (important for P2): this module has NO concept of an organization. The caller (a later, trusted,
// org-scoped evidence reader) must supply only evidence that belongs to the current organization. Nothing here can look
// anything up, so there is no path for cross-organization pricing history to enter through this module.
//
// v1 SCOPE: suggestions are STAFF-ONLY. There is no AI/market fallback: `pricingSource` is "org_history" or "none".
// There is no regional multiplier: `locationAdjustment` is always null (location text may be carried for later).
//
// EVIDENCE RULES (a line must pass ALL to count):
//   - unit price > 0 (a reviewed $0 / no-charge line is NOT price evidence);
//   - not a heading, not an optional line, not a discount;
//   - not an unpriced placeholder (metadata.price_pending === true) and not an AI placeholder (metadata.ai_proposed === true);
//   - estimate lines: status approved/converted (strong, weight 1.0) or sent/viewed (secondary, weight 0.6); DRAFT, ready,
//     rejected, expired, cancelled, archived and anything else are excluded;
//   - change-order items: parent change order status "approved" (strong); every other status is excluded;
//   - dated within the last 36 months (and not in the future).
//
// ALGORITHM (per requested item):
//   1. keep eligible evidence; 2. match by tier (exact > alias > token > fuzzy) with compatible unit AND item type;
//   3. pool = the best tier present (lower tiers are never mixed in); if the request has no unit, the dominant historical
//      unit is used and reported; 4. scope: same project type if it has >= 3 samples, else org-wide history;
//   5. outliers: no trimming below 4 samples, else Tukey IQR fences (never below max(3, ceil(n/2)) kept);
//   6. weight = strength x recency (half-life 18 months); suggested price = weighted median, range = weighted P25..P75;
//   7. confidence from sample count, tier, scope, recency and spread. Same-project-type evidence boosts confidence
//      (needed for "high") but is NEVER required: org-wide history of the same item can still reach "medium".

import { matchLineItem, MATCH_TIER_RANK, normalizeUnit, type CanonicalUnit, type MatchTier } from "./line-item-normalizer";

// ── Tunable constants (changing any of these is a deliberate, tested decision) ──

export const EVIDENCE_WINDOW_MONTHS = 36;
export const RECENCY_HALF_LIFE_MONTHS = 18;
export const SECONDARY_EVIDENCE_WEIGHT = 0.6;
/** Same-project-type evidence is preferred once it has at least this many samples. */
export const MIN_SAME_PROJECT_TYPE_SAMPLES = 3;
/** Below this many samples nothing is trimmed. */
export const MIN_SAMPLES_FOR_TRIMMING = 4;
const AVG_DAYS_PER_MONTH = 30.4375;

export const STRONG_ESTIMATE_STATUSES: ReadonlySet<string> = new Set(["approved", "converted"]);
export const SECONDARY_ESTIMATE_STATUSES: ReadonlySet<string> = new Set(["sent", "viewed"]);
export const STRONG_CHANGE_ORDER_STATUSES: ReadonlySet<string> = new Set(["approved"]);

// ── Input contract (all of it is already-authorized evidence supplied by a trusted caller) ──

export type EvidenceSource = "estimate_line" | "change_order_item";

export type HistoricalLine = {
  source: EvidenceSource;
  name: string;
  itemType: string | null;
  unit: string | null;
  quantity?: number | null;
  unitPrice: number;
  isHeading?: boolean;
  optional?: boolean;
  /** estimate_items.metadata (only price_pending / ai_proposed are read). */
  metadata?: unknown;
  /** Parent estimate status (estimate lines). */
  estimateStatus?: string | null;
  /** Parent change-order status (change-order items). */
  changeOrderStatus?: string | null;
  /** The date the evidence is attributed to (e.g. approved_at, else sent_at, else created_at). ISO string or Date. */
  documentDate: string | Date;
  /** projects.project_type of the originating job, when known. */
  projectType?: string | null;
  /** Free-text location of the originating job. Carried for later phases; unused for pricing in v1. */
  location?: string | null;
};

export type PricingRequestItem = {
  name: string;
  description?: string | null;
  itemType?: string | null;
  /** Omit when unknown: the dominant unit in matching history is used and reported. */
  unit?: string | null;
  /** Optional hint; with no quantity only a unit price is suggested. */
  quantity?: number | null;
};

export type PricingContext = {
  projectType?: string | null;
  /** Carried through; no regional multiplier is applied in v1. */
  location?: string | null;
  /** Injected clock (ISO string or Date). The engine never reads the wall clock. */
  now: string | Date;
};

export type Confidence = "high" | "medium" | "low" | "none";

export type PricingEvidenceSummary = {
  sampleCount: number;
  medianUnitPrice: number | null;
  minDate: string | null;
  maxDate: string | null;
  sameProjectTypeCount: number;
  matchTier: MatchTier | null;
  /** Extras for staff display / debugging. */
  scope: "same_project_type" | "org_wide" | null;
  outliersRemoved: number;
  strongSampleCount: number;
  secondarySampleCount: number;
  changeOrderSampleCount: number;
};

export type PricingSuggestion = {
  itemName: string;
  itemType: string | null;
  unit: string | null;
  quantity: number | null;
  suggestedUnitPrice: number | null;
  suggestedTotal: number | null;
  /** Unit-price range (weighted P25 .. P75 of the cleaned samples). */
  lowEstimate: number | null;
  highEstimate: number | null;
  /** The same range as totals, when a quantity is known. */
  lowTotal: number | null;
  highTotal: number | null;
  confidence: Confidence;
  pricingSource: "org_history" | "none";
  evidence: PricingEvidenceSummary;
  assumptions: string[];
  missingInputs: string[];
  locationAdjustment: null;
};

// ── Small numeric helpers ────────────────────────────────────────────────

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

function toDate(v: string | Date): Date | null {
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Quartile by linear interpolation on a sorted ascending array. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return quantile(s, 0.5);
}

/** Weighted quantile: smallest value whose cumulative weight reaches q of the total (ties broken by value order). */
function weightedQuantile(samples: ReadonlyArray<{ value: number; weight: number }>, q: number): number {
  const sorted = [...samples].sort((a, b) => a.value - b.value || a.weight - b.weight);
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return sorted[0].value;
  const target = total * q;
  let cumulative = 0;
  for (const s of sorted) {
    cumulative += s.weight;
    if (cumulative >= target - 1e-12) return s.value;
  }
  return sorted[sorted.length - 1].value;
}

// ── Eligibility ──────────────────────────────────────────────────────────

export type Eligibility =
  | { eligible: true; strength: "strong" | "secondary"; weightBase: number; date: Date }
  | { eligible: false; reason: string };

function metaFlag(metadata: unknown, key: string): boolean {
  return !!metadata && typeof metadata === "object" && (metadata as Record<string, unknown>)[key] === true;
}

/** Decides whether ONE historical line may be used as price evidence. Pure. */
export function evaluateEligibility(line: HistoricalLine, now: Date): Eligibility {
  const price = Number(line.unitPrice);
  if (!Number.isFinite(price) || price <= 0) return { eligible: false, reason: "unit_price_not_positive" };
  if (line.isHeading) return { eligible: false, reason: "heading" };
  if (line.optional) return { eligible: false, reason: "optional_line" };
  if ((line.itemType ?? "").toLowerCase() === "discount") return { eligible: false, reason: "discount" };
  if (metaFlag(line.metadata, "price_pending")) return { eligible: false, reason: "price_pending" };
  if (metaFlag(line.metadata, "ai_proposed")) return { eligible: false, reason: "ai_placeholder" };

  const date = toDate(line.documentDate);
  if (!date) return { eligible: false, reason: "invalid_date" };
  if (date.getTime() > now.getTime()) return { eligible: false, reason: "future_dated" };
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - EVIDENCE_WINDOW_MONTHS);
  if (date.getTime() < cutoff.getTime()) return { eligible: false, reason: "older_than_window" };

  if (line.source === "change_order_item") {
    return STRONG_CHANGE_ORDER_STATUSES.has(line.changeOrderStatus ?? "")
      ? { eligible: true, strength: "strong", weightBase: 1, date }
      : { eligible: false, reason: "change_order_not_approved" };
  }
  const status = (line.estimateStatus ?? "").toLowerCase();
  if (STRONG_ESTIMATE_STATUSES.has(status)) return { eligible: true, strength: "strong", weightBase: 1, date };
  if (SECONDARY_ESTIMATE_STATUSES.has(status)) return { eligible: true, strength: "secondary", weightBase: SECONDARY_EVIDENCE_WEIGHT, date };
  return { eligible: false, reason: "estimate_status_not_evidence" };
}

/** weight = 0.5 ^ (ageMonths / half-life). */
export function recencyWeight(date: Date, now: Date): number {
  const ageMonths = Math.max(0, (now.getTime() - date.getTime()) / (AVG_DAYS_PER_MONTH * 86_400_000));
  return Math.pow(0.5, ageMonths / RECENCY_HALF_LIFE_MONTHS);
}

// ── Outliers ─────────────────────────────────────────────────────────────

type Sample = { value: number; weight: number; date: Date; strength: "strong" | "secondary"; source: EvidenceSource; sameType: boolean; unit: CanonicalUnit };

/** Tukey IQR trimming. Never trims below MIN_SAMPLES_FOR_TRIMMING samples, and never keeps fewer than max(3, ceil(n/2)). */
export function trimOutliers<T extends { value: number }>(samples: readonly T[]): { kept: T[]; removed: number } {
  if (samples.length < MIN_SAMPLES_FOR_TRIMMING) return { kept: [...samples], removed: 0 };
  const sorted = samples.map((s) => s.value).sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const kept = samples.filter((s) => s.value >= lo - 1e-9 && s.value <= hi + 1e-9);
  const floor = Math.max(3, Math.ceil(samples.length / 2));
  if (kept.length < floor) return { kept: [...samples], removed: 0 };
  return { kept, removed: samples.length - kept.length };
}

// ── Confidence ───────────────────────────────────────────────────────────

export function computeConfidence(input: {
  sampleCount: number;
  matchTier: MatchTier | null;
  projectTypeKnown: boolean;
  scope: "same_project_type" | "org_wide" | null;
  sameProjectTypeShare: number;
  recentWeightShare: number;
  spreadRatio: number | null;
}): Confidence {
  const { sampleCount, matchTier } = input;
  if (sampleCount === 0 || !matchTier) return "none";
  if (matchTier === "fuzzy") return "low";
  if (sampleCount < 4) return "low";

  const spread = input.spreadRatio ?? 0;
  const high =
    sampleCount >= 8 &&
    (matchTier === "exact" || matchTier === "alias") &&
    input.projectTypeKnown &&
    input.scope === "same_project_type" &&
    input.sameProjectTypeShare >= 0.6 &&
    input.recentWeightShare >= 0.5 &&
    spread <= 0.25;
  if (high) return "high";

  // Same-project-type evidence BOOSTS confidence (it is required for "high") but is never required for "medium":
  // project_type coverage is sparse in real data, so org-wide history of the right item is still useful evidence.
  const stale = input.recentWeightShare < 0.25;
  if (stale || spread > 0.6) return "low";
  return "medium";
}

// ── The engine ───────────────────────────────────────────────────────────

const EMPTY_EVIDENCE: PricingEvidenceSummary = {
  sampleCount: 0, medianUnitPrice: null, minDate: null, maxDate: null, sameProjectTypeCount: 0, matchTier: null,
  scope: null, outliersRemoved: 0, strongSampleCount: 0, secondarySampleCount: 0, changeOrderSampleCount: 0,
};

function unitLabel(u: CanonicalUnit): string {
  return u.startsWith("other:") ? u.slice(6) : u === "lump_sum" ? "lump sum" : u;
}

export function suggestPricingForItem(item: PricingRequestItem, evidence: readonly HistoricalLine[], context: PricingContext): PricingSuggestion {
  const now = toDate(context.now);
  if (!now) throw new Error("pricing-engine: context.now must be a valid date");
  const projectType = context.projectType?.trim() ? context.projectType.trim().toLowerCase() : null;
  const quantity = typeof item.quantity === "number" && Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : null;
  const requestUnitGiven = typeof item.unit === "string" && item.unit.trim() !== "";

  const assumptions: string[] = [];
  const missingInputs: string[] = [];
  if (quantity === null) missingInputs.push("quantity");
  if (!projectType) missingInputs.push("project_type");
  if (context.location && context.location.trim()) assumptions.push("A location was noted, but no regional price adjustment is applied in this version.");

  const base = {
    itemName: item.name,
    itemType: item.itemType ?? null,
    unit: requestUnitGiven ? unitLabel(normalizeUnit(item.unit)) : null,
    quantity,
    locationAdjustment: null as null,
  };
  const none = (extraAssumption?: string): PricingSuggestion => ({
    ...base,
    suggestedUnitPrice: null, suggestedTotal: null, lowEstimate: null, highEstimate: null, lowTotal: null, highTotal: null,
    confidence: "none", pricingSource: "none", evidence: { ...EMPTY_EVIDENCE },
    assumptions: [...assumptions, ...(extraAssumption ? [extraAssumption] : [])],
    missingInputs: requestUnitGiven ? missingInputs : [...missingInputs, "unit"],
  });

  // 1. eligibility
  type Eligible = { line: HistoricalLine; strength: "strong" | "secondary"; weightBase: number; date: Date };
  const eligible: Eligible[] = [];
  for (const line of evidence) {
    const e = evaluateEligibility(line, now);
    if (e.eligible) eligible.push({ line, strength: e.strength, weightBase: e.weightBase, date: e.date });
  }
  if (eligible.length === 0) return none("No usable pricing history was found.");

  // 2. matching (units must be compatible unless the request left the unit open)
  type Matched = Eligible & { tier: MatchTier };
  const matched: Matched[] = [];
  for (const e of eligible) {
    const tier = matchLineItem(
      { name: item.name, itemType: item.itemType, unit: requestUnitGiven ? item.unit : null },
      { name: e.line.name, itemType: e.line.itemType, unit: e.line.unit },
      { ignoreUnit: !requestUnitGiven },
    );
    if (tier) matched.push({ ...e, tier });
  }
  if (matched.length === 0) return none("No similar line items were found in this organization's history.");

  // 3. best tier only (never dilute a better tier with worse ones). Exact and alias form one pool.
  const bestRank = Math.max(...matched.map((m) => MATCH_TIER_RANK[m.tier]));
  const poolTierRanks = bestRank >= MATCH_TIER_RANK.alias ? [MATCH_TIER_RANK.exact, MATCH_TIER_RANK.alias] : [bestRank];
  let pool = matched.filter((m) => poolTierRanks.includes(MATCH_TIER_RANK[m.tier]));
  const matchTier: MatchTier = pool.some((m) => m.tier === "alias") ? "alias" : pool[0].tier;

  // 3b. open unit: pick the dominant historical unit (count, then alphabetical) and say so
  let chosenUnit: CanonicalUnit;
  if (requestUnitGiven) {
    chosenUnit = normalizeUnit(item.unit);
  } else {
    const counts = new Map<CanonicalUnit, number>();
    for (const m of pool) counts.set(normalizeUnit(m.line.unit), (counts.get(normalizeUnit(m.line.unit)) ?? 0) + 1);
    chosenUnit = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    pool = pool.filter((m) => normalizeUnit(m.line.unit) === chosenUnit);
    assumptions.push(`No unit was specified; the most common unit in matching history ("${unitLabel(chosenUnit)}") was used.`);
    missingInputs.push("unit");
  }

  // 4. scope preference
  const sameTypeAll = projectType ? pool.filter((m) => (m.line.projectType ?? "").trim().toLowerCase() === projectType) : [];
  let scope: "same_project_type" | "org_wide";
  if (projectType && sameTypeAll.length >= MIN_SAME_PROJECT_TYPE_SAMPLES) {
    scope = "same_project_type";
    pool = sameTypeAll;
  } else {
    scope = "org_wide";
    if (projectType) assumptions.push(`Fewer than ${MIN_SAME_PROJECT_TYPE_SAMPLES} comparable ${projectType.replace(/_/g, " ")} jobs were found, so broader history from this organization was used.`);
  }

  // 5. samples (+ outlier trimming)
  const samples: Sample[] = pool
    .map((m) => ({
      value: Number(m.line.unitPrice),
      weight: m.weightBase * recencyWeight(m.date, now),
      date: m.date,
      strength: m.strength,
      source: m.line.source,
      sameType: !!projectType && (m.line.projectType ?? "").trim().toLowerCase() === projectType,
      unit: normalizeUnit(m.line.unit),
    }))
    // Deterministic order independent of the input order.
    .sort((a, b) => a.value - b.value || a.date.getTime() - b.date.getTime() || a.weight - b.weight);
  const { kept, removed } = trimOutliers(samples);
  if (removed > 0) assumptions.push(`${removed} unusually high/low historical price${removed === 1 ? " was" : "s were"} excluded as outliers.`);

  // 6. price, range, summary
  const values = kept.map((s) => s.value);
  const unitPrice = round2(weightedQuantile(kept, 0.5));
  const low = round2(weightedQuantile(kept, 0.25));
  const high = round2(weightedQuantile(kept, 0.75));
  const plainMedian = median(values);
  const dates = kept.map((s) => s.date.getTime());
  const sortedValues = [...values].sort((a, b) => a - b);
  const iqr = kept.length >= 2 ? quantile(sortedValues, 0.75) - quantile(sortedValues, 0.25) : 0;
  const spreadRatio = plainMedian && plainMedian > 0 ? iqr / plainMedian : null;
  const totalWeight = kept.reduce((s, x) => s + x.weight, 0);
  const recentCutoff = new Date(now.getTime());
  recentCutoff.setUTCMonth(recentCutoff.getUTCMonth() - RECENCY_HALF_LIFE_MONTHS);
  const recentWeight = kept.filter((s) => s.date.getTime() >= recentCutoff.getTime()).reduce((s, x) => s + x.weight, 0);
  const sameTypeCount = kept.filter((s) => s.sameType).length;

  const confidence = computeConfidence({
    sampleCount: kept.length,
    matchTier,
    projectTypeKnown: !!projectType,
    scope,
    sameProjectTypeShare: kept.length > 0 ? sameTypeCount / kept.length : 0,
    recentWeightShare: totalWeight > 0 ? recentWeight / totalWeight : 0,
    spreadRatio,
  });

  if (matchTier === "fuzzy") assumptions.push("Only loosely similar line items were found; treat this as a rough guide.");
  else if (matchTier === "token") assumptions.push("Matched on similar (not identical) line item names.");
  if (!projectType) assumptions.push("The project type is unknown, so history from all job types was used.");
  if (kept.some((s) => s.source === "change_order_item")) assumptions.push("Includes approved change-order pricing.");

  return {
    ...base,
    unit: unitLabel(chosenUnit),
    suggestedUnitPrice: unitPrice,
    suggestedTotal: quantity !== null ? round2(unitPrice * quantity) : null,
    lowEstimate: low,
    highEstimate: high,
    lowTotal: quantity !== null ? round2(low * quantity) : null,
    highTotal: quantity !== null ? round2(high * quantity) : null,
    confidence,
    pricingSource: "org_history",
    evidence: {
      sampleCount: kept.length,
      medianUnitPrice: plainMedian === null ? null : round2(plainMedian),
      minDate: isoDay(new Date(Math.min(...dates))),
      maxDate: isoDay(new Date(Math.max(...dates))),
      sameProjectTypeCount: sameTypeCount,
      matchTier,
      scope,
      outliersRemoved: removed,
      strongSampleCount: kept.filter((s) => s.strength === "strong").length,
      secondarySampleCount: kept.filter((s) => s.strength === "secondary").length,
      changeOrderSampleCount: kept.filter((s) => s.source === "change_order_item").length,
    },
    assumptions,
    missingInputs,
  };
}

/** Suggests pricing for several requested items against the same evidence. Order of results == order of requests. */
export function suggestPricing(items: readonly PricingRequestItem[], evidence: readonly HistoricalLine[], context: PricingContext): PricingSuggestion[] {
  return items.map((item) => suggestPricingForItem(item, evidence, context));
}
