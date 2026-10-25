// src/lib/pricing/staff-pricing.ts
//
// Pricing Intelligence v1 (P3) — the STAFF-ONLY pricing payload and its display view-model. PURE: no I/O, no model, no
// database, no imports from server-only code, so the browser Run Inspector and the server share one definition.
//
// ── STAFF-ONLY ───────────────────────────────────────────────────────────
//
// This payload is persisted on the execution record (agent_executions.input_summary.pricingIntelligence) and rendered ONLY by
// the staff Run Inspector. It is never part of a customer-facing reply, never placed in a model prompt, and never returned to
// a customer channel. It is built exclusively from the output of the read-only get_pricing_suggestions action, so its numbers
// have the same provenance as that tool result (see netlify/functions/lib/ai/pricing-provenance.ts for the check that every
// figure here really came from the same run's tool output).
//
// It carries NO database ids, NO customer / contact / project names, NO vendor data, NO internal cost and NO historical
// free text: only the requested item's own name, aggregate prices/ranges, counts and dates.
//
// REVIEWED-PRICE SUPPRESSION: when the current estimate already has a priced line (or a deliberately reviewed $0 line) for a
// requested item, NO competing suggestion is surfaced for it — only the neutral message "Existing reviewed price retained."

export const STAFF_PRICING_SUGGESTED_ONLY = "Suggested only — not applied.";
export const STAFF_PRICING_NO_HISTORY = "No reliable pricing found.";
export const STAFF_PRICING_QUANTITY_REQUIRED = "Quantity required to calculate total.";
export const STAFF_PRICING_REVIEWED_RETAINED = "Existing reviewed price retained.";
export const STAFF_PRICING_NOTE =
  "Staff only. Suggested from this organization's own past estimates and change orders — advisory, not applied, not a quote, and never to be shared with the customer.";
export const STAFF_PRICING_UNAVAILABLE_NOTE = "Pricing suggestions were not available for this run.";

export type StaffPricingStatus = "suggested" | "no_history" | "reviewed_retained";

export type StaffPricingEvidence = {
  sampleCount: number;
  medianUnitPrice: number | null;
  minDate: string | null;
  maxDate: string | null;
  sameProjectTypeCount: number;
  matchTier: string | null;
  /** Price Book (P4) results: which kind of evidence this is, whether the entry was reviewed, and whether it targets the project type. */
  kind?: "org_history" | "price_book";
  reviewed?: boolean;
  projectTypeSpecific?: boolean;
};

export type StaffPricingSuggestion = {
  itemName: string;
  status: StaffPricingStatus;
  /** The neutral line shown to staff for this item. */
  message: string;
  suggestedUnitPrice: number | null;
  suggestedTotal: number | null;
  lowEstimate: number | null;
  highEstimate: number | null;
  confidence: "high" | "medium" | "low" | "none";
  pricingSource: "price_book" | "org_history" | "none";
  evidence: StaffPricingEvidence;
  assumptions: string[];
  missingInputs: string[];
  /** True when the current estimate already has a reviewed/manual price for this item (the suggestion is suppressed). */
  alreadyPricedOnEstimate: boolean;
};

export type StaffPricingIntelligence = {
  staffOnly: true;
  /** false when the tool could not run; there are then no suggestions. */
  available: boolean;
  /** The execution this payload belongs to (provenance: figures are only valid for this run). */
  runId: string;
  requestedItems: number;
  suggestions: StaffPricingSuggestion[];
  note: string;
};

/** The subset of get_pricing_suggestions' output this module reads (structural; no import of server code). */
export type PricingToolOutputLike = {
  suggestions?: Array<{
    itemName?: unknown;
    suggestedUnitPrice?: unknown;
    suggestedTotal?: unknown;
    lowEstimate?: unknown;
    highEstimate?: unknown;
    confidence?: unknown;
    pricingSource?: unknown;
    evidence?: Record<string, unknown>;
    assumptions?: unknown;
    missingInputs?: unknown;
  }>;
  currentEstimateLines?: unknown[];
};

const EMPTY_EVIDENCE: StaffPricingEvidence = { sampleCount: 0, medianUnitPrice: null, minDate: null, maxDate: null, sameProjectTypeCount: 0, matchTier: null };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 12) : []);
const CONFIDENCES = new Set(["high", "medium", "low", "none"]);

/** A current-estimate line state that means "a reviewed/manual price already exists" (so no competing suggestion is shown). */
export function isReviewedPriceState(state: unknown): boolean {
  return state === "priced" || state === "reviewed_zero";
}

/** An unavailable payload (the tool could not run). Staff see a neutral note; there are no figures. */
export function unavailableStaffPricing(runId: string, requestedItems: number): StaffPricingIntelligence {
  return { staffOnly: true, available: false, runId, requestedItems, suggestions: [], note: STAFF_PRICING_UNAVAILABLE_NOTE };
}

/**
 * Builds the staff-only payload from get_pricing_suggestions' output. Copies ONLY whitelisted fields; anything else in the
 * tool output is dropped. Pure and deterministic.
 */
export function buildStaffPricingIntelligence(input: { runId: string; requestedItems: number; toolOutput: PricingToolOutputLike }): StaffPricingIntelligence {
  const { runId, requestedItems, toolOutput } = input;
  const lines = Array.isArray(toolOutput.currentEstimateLines) ? toolOutput.currentEstimateLines : [];
  const suggestions: StaffPricingSuggestion[] = (toolOutput.suggestions ?? []).map((s, i) => {
    const itemName = str(s.itemName) ?? "Item";
    if (isReviewedPriceState(lines[i])) {
      // Suppress: never show a competing price for a line that already has a reviewed/manual one.
      return {
        itemName, status: "reviewed_retained", message: STAFF_PRICING_REVIEWED_RETAINED,
        suggestedUnitPrice: null, suggestedTotal: null, lowEstimate: null, highEstimate: null,
        confidence: "none", pricingSource: "none", evidence: { ...EMPTY_EVIDENCE }, assumptions: [], missingInputs: [],
        alreadyPricedOnEstimate: true,
      };
    }
    const confidence = CONFIDENCES.has(String(s.confidence)) ? (s.confidence as StaffPricingSuggestion["confidence"]) : "none";
    const unitPrice = num(s.suggestedUnitPrice);
    const source = s.pricingSource === "price_book" ? "price_book" : s.pricingSource === "org_history" ? "org_history" : null;
    const noHistory = confidence === "none" || source === null || unitPrice === null;
    const ev = s.evidence ?? {};
    return {
      itemName,
      status: noHistory ? "no_history" : "suggested",
      message: noHistory ? STAFF_PRICING_NO_HISTORY : STAFF_PRICING_SUGGESTED_ONLY,
      suggestedUnitPrice: noHistory ? null : unitPrice,
      suggestedTotal: noHistory ? null : num(s.suggestedTotal),
      lowEstimate: noHistory ? null : num(s.lowEstimate),
      highEstimate: noHistory ? null : num(s.highEstimate),
      confidence: noHistory ? "none" : confidence,
      pricingSource: noHistory || source === null ? "none" : source,
      evidence: noHistory
        ? { ...EMPTY_EVIDENCE }
        : {
            sampleCount: num(ev.sampleCount) ?? 0,
            medianUnitPrice: num(ev.medianUnitPrice),
            minDate: str(ev.minDate),
            maxDate: str(ev.maxDate),
            sameProjectTypeCount: num(ev.sameProjectTypeCount) ?? 0,
            matchTier: str(ev.matchTier),
            ...(ev.kind === "price_book" || ev.kind === "org_history" ? { kind: ev.kind } : {}),
            ...(typeof ev.reviewed === "boolean" ? { reviewed: ev.reviewed } : {}),
            ...(typeof ev.projectTypeSpecific === "boolean" ? { projectTypeSpecific: ev.projectTypeSpecific } : {}),
          },
      assumptions: strings(s.assumptions),
      missingInputs: strings(s.missingInputs),
      alreadyPricedOnEstimate: false,
    };
  });
  return { staffOnly: true, available: true, runId, requestedItems, suggestions, note: STAFF_PRICING_NOTE };
}

/**
 * A deterministic, NON-NUMERIC summary of a pricing run for the assistant's context on a STAFF pricing-guidance turn: how many
 * requested lines have organization-history suggestions, how many have none, how many kept a reviewed price, and which inputs
 * the pricing run reported missing. It contains NO price, range, total or sample figure — those stay on the staff panel — so
 * nothing in it can be repeated as a price. Pure.
 */
export function describeStaffPricingOutcomeForAssistant(payload: StaffPricingIntelligence): string {
  if (!payload.available) {
    return "Staff asked for pricing guidance, but the pricing lookup could not run just now. Say so briefly and that the lookup can be retried. Do not claim there is no pricing source and do not ask staff to supply every price.";
  }
  const n = payload.suggestions.length;
  const suggested = payload.suggestions.filter((s) => s.status === "suggested").length;
  const none = payload.suggestions.filter((s) => s.status === "no_history").length;
  const kept = payload.suggestions.filter((s) => s.status === "reviewed_retained").length;
  const missing = [...new Set(payload.suggestions.flatMap((s) => s.missingInputs))].map((m) => MISSING_LABELS[m] ?? m);
  return [
    "Pricing Intelligence has ALREADY run for this staff request; its results are attached to the run for staff only (never state or hint at any price in your reply).",
    `${suggested} of ${n} requested lines have price suggestions (from the price book or this organization's history), ${none} have no reliable pricing, and ${kept} already have a reviewed price that was kept.`,
    missing.length > 0 ? `Inputs the pricing run reports as missing: ${missing.join(", ")}.` : "The pricing run reports no missing inputs.",
    "Reply briefly that the suggestions are in this run's Pricing Intelligence panel. Do NOT ask staff to supply prices or pricing sources, and do NOT say a price book is missing; you may ask only for the missing inputs listed above, if any.",
  ].join(" ");
}

// ── Display view-model (used by the Run Inspector; also unit-tested) ─────────

export type StaffPricingRow = {
  itemName: string;
  status: StaffPricingStatus;
  message: string;
  /** "$325.00" or null (suppressed / no history). */
  price: string | null;
  /** "$300.00 – $350.00", "From $300.00", "Up to $350.00", or null when no range is configured / supported. */
  range: string | null;
  total: string | null;
  confidence: string | null;
  /** Organization-history evidence only (null for a Price Book result). */
  sampleCount: number | null;
  sameProjectTypeCount: number | null;
  /** "Price Book" | "Organization history" | null. */
  source: string | null;
  /** Price Book results only: "Project-type-specific entry" | "Generic entry", else null. */
  scopeLabel: string | null;
  /** How the item was matched (Price Book results): "Exact name" | "Alias" | "Similar name" | "Loose match"; else null. */
  matchBasis: string | null;
  /** Price Book results: "Reviewed" | "Not reviewed"; else null. */
  reviewState: string | null;
  /** "Quantity required to calculate total." when a unit price is known but no total can be computed. */
  quantityNote: string | null;
  assumptions: string[];
  missingInputs: string[];
};

const money = (n: number | null): string | null => (n === null ? null : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const MISSING_LABELS: Record<string, string> = { quantity: "quantity", unit: "unit", project_type: "project type" };
const MATCH_BASIS_LABELS: Record<string, string> = { exact: "Exact name", alias: "Alias", token: "Similar name", fuzzy: "Loose match" };

/** Defensive: the payload is jsonb read back from the database, so it is validated rather than cast. Returns null when absent/invalid. */
export function readStaffPricingIntelligence(raw: unknown): StaffPricingIntelligence | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.staffOnly !== true || !Array.isArray(r.suggestions)) return null;
  const suggestions: StaffPricingSuggestion[] = [];
  for (const s of r.suggestions) {
    if (!s || typeof s !== "object") continue;
    const x = s as Record<string, unknown>;
    const status = x.status === "suggested" || x.status === "no_history" || x.status === "reviewed_retained" ? x.status : null;
    if (!status) continue;
    const ev = x.evidence && typeof x.evidence === "object" ? (x.evidence as Record<string, unknown>) : {};
    suggestions.push({
      itemName: str(x.itemName) ?? "Item", status,
      message: str(x.message) ?? (status === "suggested" ? STAFF_PRICING_SUGGESTED_ONLY : status === "reviewed_retained" ? STAFF_PRICING_REVIEWED_RETAINED : STAFF_PRICING_NO_HISTORY),
      suggestedUnitPrice: num(x.suggestedUnitPrice), suggestedTotal: num(x.suggestedTotal), lowEstimate: num(x.lowEstimate), highEstimate: num(x.highEstimate),
      confidence: CONFIDENCES.has(String(x.confidence)) ? (x.confidence as StaffPricingSuggestion["confidence"]) : "none",
      pricingSource: x.pricingSource === "org_history" || x.pricingSource === "price_book" ? x.pricingSource : "none",
      evidence: {
        sampleCount: num(ev.sampleCount) ?? 0, medianUnitPrice: num(ev.medianUnitPrice), minDate: str(ev.minDate), maxDate: str(ev.maxDate),
        sameProjectTypeCount: num(ev.sameProjectTypeCount) ?? 0, matchTier: str(ev.matchTier),
        ...(ev.kind === "price_book" || ev.kind === "org_history" ? { kind: ev.kind } : {}),
        ...(typeof ev.reviewed === "boolean" ? { reviewed: ev.reviewed } : {}),
        ...(typeof ev.projectTypeSpecific === "boolean" ? { projectTypeSpecific: ev.projectTypeSpecific } : {}),
      },
      assumptions: strings(x.assumptions), missingInputs: strings(x.missingInputs), alreadyPricedOnEstimate: x.alreadyPricedOnEstimate === true,
    });
  }
  return {
    staffOnly: true, available: r.available !== false, runId: str(r.runId) ?? "", requestedItems: num(r.requestedItems) ?? suggestions.length,
    suggestions, note: str(r.note) ?? STAFF_PRICING_NOTE,
  };
}

/** Turns the payload into plain display rows. Suppressed / no-history rows carry no figures at all. */
export function describeStaffPricing(payload: StaffPricingIntelligence): { rows: StaffPricingRow[]; note: string; available: boolean } {
  const rows: StaffPricingRow[] = payload.suggestions.map((s) => {
    if (s.status !== "suggested") {
      return {
        itemName: s.itemName, status: s.status, message: s.message, price: null, range: null, total: null, confidence: null, sampleCount: null,
        sameProjectTypeCount: null, source: null, scopeLabel: null, matchBasis: null, reviewState: null, quantityNote: null, assumptions: [], missingInputs: [],
      };
    }
    const lo = money(s.lowEstimate);
    const hi = money(s.highEstimate);
    const isBook = s.pricingSource === "price_book";
    return {
      itemName: s.itemName, status: s.status, message: s.message,
      price: money(s.suggestedUnitPrice),
      range: lo && hi ? `${lo} – ${hi}` : lo ? `From ${lo}` : hi ? `Up to ${hi}` : null,
      total: money(s.suggestedTotal),
      confidence: s.confidence,
      sampleCount: isBook ? null : s.evidence.sampleCount,
      sameProjectTypeCount: isBook ? null : s.evidence.sameProjectTypeCount,
      source: isBook ? "Price Book" : s.pricingSource === "org_history" ? "Organization history" : null,
      scopeLabel: isBook ? (s.evidence.projectTypeSpecific ? "Project-type-specific entry" : "Generic entry") : null,
      matchBasis: isBook ? (MATCH_BASIS_LABELS[s.evidence.matchTier ?? ""] ?? null) : null,
      reviewState: isBook ? (s.evidence.reviewed ? "Reviewed" : "Not reviewed") : null,
      quantityNote: s.suggestedUnitPrice !== null && s.suggestedTotal === null && s.missingInputs.includes("quantity") ? STAFF_PRICING_QUANTITY_REQUIRED : null,
      assumptions: s.assumptions,
      missingInputs: s.missingInputs.map((m) => MISSING_LABELS[m] ?? m),
    };
  });
  return { rows, note: payload.note, available: payload.available };
}
