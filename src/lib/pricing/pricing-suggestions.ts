// src/lib/pricing/pricing-suggestions.ts
//
// Pricing Intelligence P4 — evidence PRECEDENCE: Price Book, then Organization history, then nothing. PURE and deterministic.
//
//   1. Price Book match            -> pricingSource "price_book"   (never blended with history)
//   2. Organization history        -> pricingSource "org_history"  (the P1 engine, unchanged)
//   3. neither                     -> pricingSource "none"
//
// No AI / market fallback exists or can be added here. A price book result NEVER averages in historical samples: the entry's
// sell price is the suggestion, full stop.
//
// RANGE CONTRACT (Option B): when an entry has no configured low/high, lowEstimate / highEstimate are null — they are NOT filled
// with the sell price. A range is shown to staff only when the organization actually configured one, so the UI never implies a
// range that does not exist. A single configured bound is passed through on its own (lowEstimate only, or highEstimate only).
// suggestedUnitPrice is ALWAYS the entry's sell_unit_price. With a known quantity suggestedTotal = sell x quantity (and the
// configured bounds scale likewise); with no quantity the totals are null and "quantity" is reported as a missing input.

import { normalizeUnit, unitStorageForm } from "./line-item-normalizer";
import { matchPriceBook, priceBookConfidence, type PriceBookItem } from "./price-book";
import { suggestPricingForItem, type HistoricalLine, type PricingContext, type PricingRequestItem, type PricingSuggestion } from "./pricing-engine";

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const EMPTY_PRICE_BOOK_EVIDENCE = {
  sampleCount: 0, medianUnitPrice: null, minDate: null, maxDate: null, sameProjectTypeCount: 0,
  scope: null, outliersRemoved: 0, strongSampleCount: 0, secondarySampleCount: 0, changeOrderSampleCount: 0,
} as const;

export function suggestPricingFromPriceBookItem(
  request: PricingRequestItem,
  match: { item: PriceBookItem; tier: "exact" | "alias" | "token" | "fuzzy"; projectTypeSpecific: boolean },
  projectType: string | null,
): PricingSuggestion {
  const { item, tier, projectTypeSpecific } = match;
  const quantity = typeof request.quantity === "number" && Number.isFinite(request.quantity) && request.quantity > 0 ? request.quantity : null;
  const requestUnitGiven = typeof request.unit === "string" && request.unit.trim() !== "";
  const projectTypeKnown = !!projectType && projectType.trim() !== "";

  const missingInputs: string[] = [];
  const assumptions: string[] = [];
  if (quantity === null) missingInputs.push("quantity");
  if (!requestUnitGiven) {
    missingInputs.push("unit");
    assumptions.push(`No unit was specified; the price book's unit ("${unitStorageForm(normalizeUnit(item.unit))}") was used.`);
  }
  if (!projectTypeKnown) {
    missingInputs.push("project_type");
    assumptions.push("The project type is unknown, so a generic price book entry was used.");
  } else if (!projectTypeSpecific) {
    assumptions.push("No price book entry targets this project type, so a generic entry was used.");
  }
  if (tier === "alias") assumptions.push("Matched a price book entry by an alternate name.");
  else if (tier === "token") assumptions.push("Matched a price book entry with a similar (not identical) name.");
  else if (tier === "fuzzy") assumptions.push("Only a loosely similar price book entry was found; treat this as a rough guide.");
  if (!item.reviewed) assumptions.push("This price book entry has not been marked reviewed.");

  const sell = round2(item.sellUnitPrice);
  const low = item.lowUnitPrice === null ? null : round2(item.lowUnitPrice);
  const high = item.highUnitPrice === null ? null : round2(item.highUnitPrice);

  return {
    itemName: request.name,
    itemType: item.itemType ?? request.itemType ?? null,
    unit: unitStorageForm(normalizeUnit(item.unit)),
    quantity,
    suggestedUnitPrice: sell,
    suggestedTotal: quantity !== null ? round2(sell * quantity) : null,
    lowEstimate: low,
    highEstimate: high,
    lowTotal: quantity !== null && low !== null ? round2(low * quantity) : null,
    highTotal: quantity !== null && high !== null ? round2(high * quantity) : null,
    confidence: priceBookConfidence({ tier, reviewed: item.reviewed, projectTypeSpecific, projectTypeKnown }),
    pricingSource: "price_book",
    evidence: { ...EMPTY_PRICE_BOOK_EVIDENCE, matchTier: tier, kind: "price_book", reviewed: item.reviewed, projectTypeSpecific },
    assumptions,
    missingInputs,
    locationAdjustment: null,
  };
}

/**
 * One requested item: price book first; otherwise organization history (the unchanged P1 engine); otherwise "none".
 * If several price book entries match equally and nothing can be chosen, NO price book price is suggested: history (if any) is
 * used and the ambiguity is stated, never resolved arbitrarily.
 */
export function suggestPricingWithPriceBookForItem(
  item: PricingRequestItem,
  priceBook: readonly PriceBookItem[],
  evidence: readonly HistoricalLine[],
  context: PricingContext,
): PricingSuggestion {
  const projectType = context.projectType?.trim() ? context.projectType.trim().toLowerCase() : null;
  const result = matchPriceBook({ name: item.name, itemType: item.itemType, unit: item.unit }, priceBook, projectType);

  if (result.kind === "match") return suggestPricingFromPriceBookItem(item, result.match, projectType);

  const history = suggestPricingForItem(item, evidence, context);
  const tagged: PricingSuggestion = history.pricingSource === "org_history" ? { ...history, evidence: { ...history.evidence, kind: "org_history" } } : history;
  if (result.kind === "ambiguous") {
    return { ...tagged, assumptions: [...tagged.assumptions, "Several price book entries match this item equally, so none was chosen. Review the price book for duplicates."] };
  }
  return tagged;
}

export function suggestPricingWithPriceBook(
  items: readonly PricingRequestItem[],
  priceBook: readonly PriceBookItem[],
  evidence: readonly HistoricalLine[],
  context: PricingContext,
): PricingSuggestion[] {
  return items.map((item) => suggestPricingWithPriceBookForItem(item, priceBook, evidence, context));
}
