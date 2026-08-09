// src/lib/invoice-status.ts
//
// Phase 13.4 follow-up — the single canonical home for invoice lifecycle
// semantics and status styling. Previously each surface (main Financials,
// Project Financials invoice list, Invoice Details modal) rolled its own
// "is this paid/overdue" check and its own badge colors, which is how
// Project Financials ended up rendering "Sent" in amber (its own ad hoc
// !isPaid-and-not-overdue fallback) while every other surface used blue.
//
// Financial *calculations* (sums, KPIs, trend buckets, contracted revenue)
// stay in src/lib/financials.ts, which imports the primitives below rather
// than redefining them — no circular dependency, this module never imports
// from financials.ts.

export type InvoiceStatus = "draft" | "sent" | "viewed" | "partial" | "paid" | "overdue" | "void" | "cancelled";

const KNOWN_STATUSES: readonly InvoiceStatus[] = ["draft", "sent", "viewed", "partial", "paid", "overdue", "void", "cancelled"];

/** Unknown/missing status values are treated as "draft" — the safest default (never counted as a receivable). */
export function normalizeInvoiceStatus(status: string | null | undefined): InvoiceStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(status ?? "") ? (status as InvoiceStatus) : "draft";
}

/** A draft is a working document, not yet a receivable. */
export function isIssuedInvoice(status: string | null | undefined): boolean {
  const s = normalizeInvoiceStatus(status);
  return s !== "draft" && s !== "void" && s !== "cancelled";
}

/** Never true for a draft/paid/void/cancelled invoice, regardless of due_date. */
export function isInvoiceOverdue(status: string | null | undefined, dueDate: string | null | undefined, now: Date = new Date()): boolean {
  const s = normalizeInvoiceStatus(status);
  if (s === "draft" || s === "paid" || s === "void" || s === "cancelled") return false;
  if (!dueDate) return false;
  return new Date(dueDate) < now;
}

export function getInvoiceBalance(totalAmount: number, amountPaid: number): number {
  return Math.max(0, totalAmount - amountPaid);
}

/** The stored `status` column never becomes "overdue" on its own — this is what every surface should actually render, derived at read time. */
export function getInvoiceDisplayStatus(status: string | null | undefined, dueDate: string | null | undefined, now: Date = new Date()): InvoiceStatus {
  if (isInvoiceOverdue(status, dueDate, now)) return "overdue";
  return normalizeInvoiceStatus(status);
}

export type InvoiceStatusStyle = { badge: string; dot: string; label: string };

/** One shared color/label map — draft=neutral, sent/viewed=blue, partial=amber, paid=green, overdue=red, void/cancelled=muted. */
export const INVOICE_STATUS_STYLE: Record<InvoiceStatus, InvoiceStatusStyle> = {
  draft:     { badge: "text-muted-foreground bg-secondary ring-border",                                       dot: "bg-muted-foreground", label: "Draft" },
  sent:      { badge: "text-info-soft-foreground bg-info-soft ring-info-soft",                                 dot: "bg-info",             label: "Sent" },
  viewed:    { badge: "text-info-soft-foreground bg-info-soft ring-info-soft",                                 dot: "bg-info",             label: "Viewed" },
  partial:   { badge: "text-warning-soft-foreground bg-warning-soft ring-warning-soft",                        dot: "bg-warning",          label: "Partial" },
  paid:      { badge: "text-success-soft-foreground bg-success-soft ring-success-soft",                        dot: "bg-success",          label: "Paid" },
  overdue:   { badge: "text-destructive-soft-foreground bg-destructive-soft ring-destructive-soft",            dot: "bg-destructive",      label: "Overdue" },
  void:      { badge: "text-muted-foreground bg-secondary ring-border line-through",                           dot: "bg-muted-foreground", label: "Void" },
  cancelled: { badge: "text-muted-foreground bg-secondary ring-border line-through",                           dot: "bg-muted-foreground", label: "Cancelled" },
};

export function getInvoiceStatusStyle(status: string | null | undefined, dueDate: string | null | undefined = null, now: Date = new Date()): InvoiceStatusStyle {
  return INVOICE_STATUS_STYLE[getInvoiceDisplayStatus(status, dueDate, now)];
}
