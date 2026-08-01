// src/lib/estimate-calculations.ts
//
// Phase 10.4 — the ONE shared estimate calculation engine. Used by the
// estimate editor (browser), the server-side recalculation the send/
// approval paths run before persisting (never trusting a browser-supplied
// total alone), and anywhere else a total needs to be derived. Having a
// single implementation is what makes "recalculate server-side before
// persistence" possible — a second, drifted copy of this math would defeat
// the point.
//
// Rounding convention: all intermediate math is done in plain floating
// point (JS numbers), which is adequate for quantity × unit-price at
// typical estimate scale, but every value that is DISPLAYED or PERSISTED
// is rounded to 2 decimal places via round2() — this is what prevents the
// classic 19.99 * 3 = 59.96999999999999 display bug. Values are never
// rounded mid-calculation (only at the boundaries), so rounding error
// cannot compound across many line items.

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export type CalcLineItem = {
  quantity: number;
  unitPrice: number;
  taxable: boolean;
  optional: boolean;
  selectedByCustomer: boolean;
  isHeading: boolean;
  discountType?: "percent" | "fixed" | null;
  discountValue?: number | null;
};

export type CalcLineResult = {
  lineSubtotal: number;
  lineDiscount: number;
  taxableAmount: number;
  lineTotal: number;
};

/** A heading row or a deselected optional item contributes nothing to any total. */
function lineIsCounted(item: CalcLineItem): boolean {
  if (item.isHeading) return false;
  if (item.optional && !item.selectedByCustomer) return false;
  return true;
}

export function calculateLine(item: CalcLineItem): CalcLineResult {
  if (!lineIsCounted(item)) {
    return { lineSubtotal: 0, lineDiscount: 0, taxableAmount: 0, lineTotal: 0 };
  }
  const qty = Math.max(0, item.quantity || 0);
  const price = Math.max(0, item.unitPrice || 0);
  const lineSubtotal = qty * price;

  let lineDiscount = 0;
  if (item.discountType === "percent" && item.discountValue) {
    lineDiscount = lineSubtotal * (Math.min(100, Math.max(0, item.discountValue)) / 100);
  } else if (item.discountType === "fixed" && item.discountValue) {
    lineDiscount = Math.min(lineSubtotal, Math.max(0, item.discountValue));
  }

  const lineTotal = Math.max(0, lineSubtotal - lineDiscount);
  const taxableAmount = item.taxable ? lineTotal : 0;

  return {
    lineSubtotal: round2(lineSubtotal),
    lineDiscount: round2(lineDiscount),
    taxableAmount: round2(taxableAmount),
    lineTotal: round2(lineTotal),
  };
}

export type CalcEstimateInput = {
  items: CalcLineItem[];
  discountType?: "percent" | "fixed" | null;
  discountValue?: number | null;
  taxRate?: number | null; // e.g. 8.25 for 8.25%
  additionalFees?: number | null;
  depositType?: "percent" | "fixed" | null;
  depositValue?: number | null;
};

export type CalcEstimateResult = {
  subtotal: number;
  discountTotal: number;
  taxableSubtotal: number;
  taxTotal: number;
  additionalFees: number;
  total: number;
  depositAmount: number;
  balanceDue: number;
};

/**
 * Full estimate-level calculation — the single canonical implementation.
 * Never trust a browser-supplied `total`/`taxTotal`/etc.; always recompute
 * from `items` (+ estimate-level discount/tax/deposit inputs) here before
 * persisting or before accepting a customer approval.
 */
export function calculateEstimate(input: CalcEstimateInput): CalcEstimateResult {
  const lines = input.items.map(calculateLine);
  const subtotal = round2(lines.reduce((s, l) => s + l.lineSubtotal, 0));
  const lineDiscounts = round2(lines.reduce((s, l) => s + l.lineDiscount, 0));
  const preDiscountTaxable = round2(lines.reduce((s, l) => s + l.taxableAmount, 0));
  const afterLineDiscounts = round2(subtotal - lineDiscounts);

  let estimateDiscount = 0;
  if (input.discountType === "percent" && input.discountValue) {
    estimateDiscount = afterLineDiscounts * (Math.min(100, Math.max(0, input.discountValue)) / 100);
  } else if (input.discountType === "fixed" && input.discountValue) {
    estimateDiscount = Math.min(afterLineDiscounts, Math.max(0, input.discountValue));
  }
  estimateDiscount = round2(estimateDiscount);

  const discountTotal = round2(lineDiscounts + estimateDiscount);

  // Estimate-level discount is applied proportionally to the taxable
  // portion so a taxable/non-taxable mix isn't distorted by a flat
  // estimate-level discount landing entirely on one side.
  const estimateDiscountOnTaxable = afterLineDiscounts > 0
    ? round2(estimateDiscount * (preDiscountTaxable / afterLineDiscounts))
    : 0;
  const taxableSubtotal = Math.max(0, round2(preDiscountTaxable - estimateDiscountOnTaxable));

  const taxRate = Math.max(0, input.taxRate || 0);
  const taxTotal = round2(taxableSubtotal * (taxRate / 100));

  const additionalFees = round2(Math.max(0, input.additionalFees || 0));
  const total = Math.max(0, round2(afterLineDiscounts - estimateDiscount + taxTotal + additionalFees));

  let depositAmount = 0;
  if (input.depositType === "percent" && input.depositValue) {
    depositAmount = total * (Math.min(100, Math.max(0, input.depositValue)) / 100);
  } else if (input.depositType === "fixed" && input.depositValue) {
    depositAmount = Math.min(total, Math.max(0, input.depositValue));
  }
  depositAmount = round2(depositAmount);
  const balanceDue = Math.max(0, round2(total - depositAmount));

  return {
    subtotal, discountTotal, taxableSubtotal, taxTotal, additionalFees, total,
    depositAmount, balanceDue,
  };
}
