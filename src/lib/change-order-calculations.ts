// src/lib/change-order-calculations.ts
//
// Phase 13.3B -- Change Order totals engine. Deliberately NOT a reuse of
// estimate-calculations.ts: that engine clamps quantity/unitPrice/total to
// non-negative (Math.max(0, ...)) at every step, which is correct for an
// estimate but directly conflicts with the Change Order requirement that a
// line item (credit) or an entire Change Order total may be negative. This
// module follows the same order-of-operations and round2() convention as
// estimate-calculations.ts, but never floors a value at zero.

import { round2 } from "./estimate-calculations";

export { round2 };

export type CalcChangeOrderLineItem = {
  quantity: number;
  unitPrice: number;
  taxable: boolean;
};

export type CalcChangeOrderLineResult = {
  lineSubtotal: number;
  taxableAmount: number;
};

export function calculateChangeOrderLine(item: CalcChangeOrderLineItem): CalcChangeOrderLineResult {
  const qty = item.quantity || 0;
  const price = item.unitPrice || 0;
  const lineSubtotal = round2(qty * price);
  const taxableAmount = item.taxable ? lineSubtotal : 0;
  return { lineSubtotal, taxableAmount };
}

export type DiscountOrMarkupType = "percentage" | "fixed";

export type CalcChangeOrderInput = {
  items: CalcChangeOrderLineItem[];
  discountType?: DiscountOrMarkupType | null;
  discountValue?: number | null;
  markupType?: DiscountOrMarkupType | null;
  markupValue?: number | null;
  taxRate?: number | null; // e.g. 8.25 for 8.25%
};

export type CalcChangeOrderResult = {
  subtotal: number;
  discountAmount: number;
  markupAmount: number;
  taxableSubtotal: number;
  taxAmount: number;
  total: number;
};

/**
 * Canonical order: sum line subtotals -> apply discount -> apply markup ->
 * compute taxable base (discount/markup allocated proportionally to the
 * taxable share, mirroring estimate-calculations.ts) -> apply tax -> total.
 * Never floors at zero -- subtotal, discountAmount, markupAmount, and total
 * may all be negative (a Change Order that is entirely a credit).
 */
export function calculateChangeOrderTotals(input: CalcChangeOrderInput): CalcChangeOrderResult {
  const lines = input.items.map(calculateChangeOrderLine);
  const subtotal = round2(lines.reduce((s, l) => s + l.lineSubtotal, 0));
  const preAdjustmentTaxable = round2(lines.reduce((s, l) => s + l.taxableAmount, 0));

  let discountAmount = 0;
  if (input.discountType === "percentage" && input.discountValue) {
    discountAmount = subtotal * (input.discountValue / 100);
  } else if (input.discountType === "fixed" && input.discountValue) {
    discountAmount = input.discountValue;
  }
  discountAmount = round2(discountAmount);

  const afterDiscount = round2(subtotal - discountAmount);

  let markupAmount = 0;
  if (input.markupType === "percentage" && input.markupValue) {
    markupAmount = afterDiscount * (input.markupValue / 100);
  } else if (input.markupType === "fixed" && input.markupValue) {
    markupAmount = input.markupValue;
  }
  markupAmount = round2(markupAmount);

  const afterMarkup = round2(afterDiscount + markupAmount);

  // Discount and markup are allocated proportionally onto the taxable share
  // of the subtotal so a mix of taxable/non-taxable lines isn't distorted.
  const adjustmentRatio = subtotal !== 0 ? (afterMarkup - subtotal) / subtotal : 0;
  const taxableSubtotal = round2(preAdjustmentTaxable + preAdjustmentTaxable * adjustmentRatio);

  const taxRate = input.taxRate || 0;
  const taxAmount = round2(taxableSubtotal * (taxRate / 100));

  const total = round2(afterMarkup + taxAmount);

  return { subtotal, discountAmount, markupAmount, taxableSubtotal, taxAmount, total };
}
