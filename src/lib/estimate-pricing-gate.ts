// src/lib/estimate-pricing-gate.ts
//
// Estimate Assistant safety hardening — the ONE definition of "this line item
// is still unpriced" for the customer-facing send boundary.
//
// BACKGROUND: the estimate editor's blank-price state is `unit_price = 0`.
// AI-proposed draft lines (estimate-handlers.ts) use that same state PLUS an
// explicit `metadata.price_pending = true` marker, so an unpriced placeholder
// can be told apart from a deliberate, legitimate $0 line (e.g. "included at
// no charge"). The gate keys on the MARKER, never on a bare `unit_price = 0`:
// a real $0 price that nobody marked pending must stay sendable.
//
// The marker is cleared by the editor the moment the owner touches a line's
// price (estimates.tsx), so "I looked at this and $0 is correct" is expressible.
//
// Pure, no imports: safe in the browser editor, in netlify/functions
// (estimate-send.ts, the authoritative boundary), and in tests.

export type PricingGateItem = {
  name?: string | null;
  unit_price?: number | string | null;
  is_heading?: boolean | null;
  metadata?: unknown;
};

/** The exact customer-safe error shown/returned when a send is blocked. */
export const UNPRICED_ESTIMATE_ERROR = "Complete pricing for all estimate items before sending this estimate.";

/** Short UI explanation next to a disabled Send control. */
export const UNPRICED_ESTIMATE_HINT = "Complete pricing for all estimate items before sending.";

/** True only for a non-heading row carrying the `price_pending` marker whose
 * price is still unset (<= 0). A marker left on a row that now has a real
 * positive price is stale and does not block. */
export function isPricePendingItem(item: PricingGateItem): boolean {
  if (item.is_heading) return false;
  const meta = item.metadata && typeof item.metadata === "object" ? (item.metadata as Record<string, unknown>) : undefined;
  if (meta?.price_pending !== true) return false;
  const price = Number(item.unit_price ?? 0);
  return !(Number.isFinite(price) && price > 0);
}

export function findPricePendingItems<T extends PricingGateItem>(items: readonly T[] | null | undefined): T[] {
  return (items ?? []).filter(isPricePendingItem);
}

export function hasPricePendingItems(items: readonly PricingGateItem[] | null | undefined): boolean {
  return findPricePendingItems(items).length > 0;
}
