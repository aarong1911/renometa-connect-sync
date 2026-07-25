// src/lib/estimate-totals.ts
//
// Single source of truth for "what is this estimate's effective total,"
// shared by src/routes/estimates.tsx and the Command Center's Estimates
// card (src/routes/index.tsx). Before this file existed, both places
// duplicated the same "sum line items when present, otherwise fall back to
// the stored total" logic independently, which is exactly how the two
// pages could silently drift apart if only one copy got updated.
//
// Real-world reason the fallback exists at all: `estimates.subtotal` /
// `tax_total` / `total` are stored columns that get written when the
// estimate is saved, but they are NOT recomputed automatically if a caller
// only touches `estimate_items` — so a stored total can go stale relative
// to its own line items. Recomputing from items whenever items exist is
// the more trustworthy value; the stored columns are only trusted when
// there are no items to sum (e.g. a quick estimate with no itemized
// breakdown, or a caller that hasn't loaded item rows at all).

const TAX_RATE = 0.08;

export type EstimateTotalsInput = { subtotal: number; tax_total: number; total: number };
export type EstimateLineItemLike = { total: number };

/**
 * Returns the effective (subtotal, tax_total, total) for an estimate.
 * - If `items` is non-empty, recomputes from the real line-item totals —
 *   this is always the more trustworthy number when available.
 * - If `items` is empty (either the estimate genuinely has none, or the
 *   caller hasn't loaded item rows — see callers for which case applies),
 *   returns `stored` unchanged.
 */
export function computeEffectiveEstimateTotals(
  stored: EstimateTotalsInput,
  items: EstimateLineItemLike[],
): EstimateTotalsInput {
  if (items.length === 0) return stored;
  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  const tax_total = subtotal * TAX_RATE;
  return { subtotal, tax_total, total: subtotal + tax_total };
}
