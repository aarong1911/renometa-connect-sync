// src/components/financials/PaymentHistory.tsx
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { formatDateOnly } from "@/lib/format";

type PaymentRow = {
  id: string;
  amount: number;
  paymentMethod: string;
  status: string;
  paidAt: string;
  reference: string | null;
  source: string;
};

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash", check: "Check", card: "Card", ach: "ACH", bank_transfer: "Bank transfer", other: "Other",
};

function money(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}
// paid_at is timestamptz, but for a manually recorded payment it's a
// BUSINESS PAYMENT DATE picked from a plain <input type="date"> — the
// intended calendar day, not a real event instant. formatDateOnly reads
// only paid_at's leading YYYY-MM-DD and ignores whatever time-of-day/
// offset it carries, so "Aug 8" always renders as "Aug 8" regardless of
// viewer timezone (was rendering "Aug 7" via `new Date(s).toLocaleDateString()`,
// which shifted the stored UTC-midnight instant back a day in EDT).
function fmtDate(s: string): string {
  return formatDateOnly(s, "—");
}

/** Real payment rows from the invoice_payments ledger only — hides itself when there are none, rather than showing an empty section. */
export function PaymentHistory({ invoiceId, refreshKey }: { invoiceId: string; refreshKey?: number }) {
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("invoice_payments")
      .select("id, amount, payment_method, status, paid_at, reference, source")
      .eq("invoice_id", invoiceId)
      .order("paid_at", { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) { setPayments([]); return; }
        setPayments((data ?? []).map((r: any) => ({
          id: r.id, amount: Number(r.amount ?? 0), paymentMethod: r.payment_method,
          status: r.status, paidAt: r.paid_at, reference: r.reference, source: r.source,
        })));
      });
    return () => { cancelled = true; };
  }, [invoiceId, refreshKey]);

  if (!payments || payments.length === 0) return null;

  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Payment History</p>
      <div className="space-y-1.5">
        {payments.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm">
            <div className="min-w-0">
              <p className="font-medium">{fmtDate(p.paidAt)}</p>
              <p className="text-xs text-muted-foreground">
                {METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod}
                {p.reference ? ` · ${p.reference}` : ""}
                {p.status === "refunded" ? " · Refunded" : ""}
                {p.source === "legacy_import" ? " · Imported" : ""}
              </p>
            </div>
            <p className={`shrink-0 font-semibold tabular-nums ${p.status === "refunded" ? "text-destructive" : "text-success"}`}>
              {p.status === "refunded" ? "-" : ""}{money(p.amount)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
