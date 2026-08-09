// src/lib/payment-method.ts
//
// Phase 13.7B — shared display formatter for invoice_payments.payment_method
// canonical values (the check-constraint vocabulary in supabase/migrations/
// 20260818_invoice_payments_ledger.sql: cash/check/card/ach/bank_transfer/
// other). Pure string-in/string-out, no Node or browser-only APIs, so it's
// safe to import from either a Netlify function or a React component —
// but it is NOT currently imported by any server function: the existing
// receipt-email formatting in stripe-webhook.ts is left exactly as-is
// (Phase 13.7A verified it correctly renders "Card" for the tested Stripe
// payment) rather than risk regressing working, already-emailed text for
// DRYness alone.

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  ach: "ACH",
  bank_transfer: "Bank Transfer",
  check: "Check",
  wire: "Wire",
  other: "Other",
  // Raw Stripe payment_method_types values, in case one ever reaches the UI
  // unmapped (the webhook's own mapPaymentMethod() already normalizes these
  // to "ach"/"card"/"other" before storage — these exist as a defensive
  // fallback, not the primary path).
  us_bank_account: "ACH / Bank Account",
  acss_debit: "ACH / Bank Account",
  sepa_debit: "Bank Transfer",
};

/** Humanizes a canonical (or unexpected) payment_method value for display. Never collapses an unrecognized non-empty value to "Other" — e.g. "wire_transfer" -> "Wire Transfer" — since that would misrepresent data that was genuinely recorded, just under a value this list doesn't know about yet. */
export function formatPaymentMethod(method: string | null | undefined): string {
  const key = method?.trim().toLowerCase();
  if (!key) return "Unknown";
  if (PAYMENT_METHOD_LABELS[key]) return PAYMENT_METHOD_LABELS[key];
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Humanizes an invoice_payments.provider value ("manual"/"stripe"/"square"/"other") for a "Processed by …" line — a distinct concept from payment_method (Part 6: provider = who processed it, payment_method = how). */
export function formatPaymentProvider(provider: string | null | undefined): string {
  const key = provider?.trim().toLowerCase();
  if (!key) return "Manual";
  if (key === "manual") return "Manual";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Canonical filter set for the Payments workspace — the invoice_payments.payment_method check-constraint vocabulary, in the order they should appear as filter chips. */
export const PAYMENT_METHOD_FILTERS = ["cash", "card", "ach", "bank_transfer", "check", "wire", "other"] as const;
