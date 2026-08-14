// src/components/financials/PaymentHistory.tsx
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Undo2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { formatDateOnly } from "@/lib/format";
import { ReversalReasonDialog } from "@/components/financials/ReversalReasonDialog";

type PaymentRow = {
  id: string;
  amount: number;
  paymentMethod: string;
  status: string;
  provider: string;
  paidAt: string;
  reference: string | null;
  source: string;
  reversesPaymentId: string | null;
  reversalReason: string | null;
  isReversed: boolean;
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

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("You must be signed in to do this");
  return { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` };
}

/** Real payment rows from the invoice_payments ledger only — hides itself when there are none, rather than showing an empty section. */
export function PaymentHistory({ invoiceId, refreshKey, onReversed }: { invoiceId: string; refreshKey?: number; onReversed?: () => void }) {
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);
  const [reversingId, setReversingId] = useState<string | null>(null);

  const load = () => {
    supabase
      .from("invoice_payments")
      .select("id, amount, payment_method, status, provider, paid_at, reference, source, reverses_payment_id, reversal_reason")
      .eq("invoice_id", invoiceId)
      .order("paid_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) { setPayments([]); return; }
        const reversedIds = new Set((data ?? []).map((r: any) => r.reverses_payment_id).filter(Boolean));
        setPayments((data ?? []).map((r: any) => ({
          id: r.id, amount: Number(r.amount ?? 0), paymentMethod: r.payment_method,
          status: r.status, provider: r.provider, paidAt: r.paid_at, reference: r.reference, source: r.source,
          reversesPaymentId: r.reverses_payment_id ?? null, reversalReason: r.reversal_reason ?? null,
          isReversed: reversedIds.has(r.id),
        })));
      });
  };

  useEffect(() => { load(); }, [invoiceId, refreshKey]);

  const handleReverse = async (paymentId: string, reason: string) => {
    try {
      const headers = await authHeader();
      const res = await fetch("/.netlify/functions/invoice-payment-reverse", {
        method: "POST", headers, body: JSON.stringify({ paymentId, reason }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not reverse this payment");
      if (body.accountingWarning) toast.warning(body.accountingWarning);
      else toast.success("Payment reversed");
      setReversingId(null);
      load();
      onReversed?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reverse this payment");
    }
  };

  if (!payments || payments.length === 0) return null;
  const reversingPayment = payments.find((p) => p.id === reversingId) ?? null;

  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Payment History</p>
      <div className="space-y-1.5">
        {payments.map((p) => {
          const isReversal = Boolean(p.reversesPaymentId);
          const canReverse = p.status === "succeeded" && p.provider === "manual" && !isReversal && !p.isReversed;
          return (
            <div key={p.id} className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <div className="font-medium">
                    {fmtDate(p.paidAt)}
                    {isReversal && <Badge variant="outline" className="ml-1.5 text-[10px]">Reversal</Badge>}
                    {p.isReversed && <Badge variant="outline" className="ml-1.5 text-[10px]">Reversed</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod}
                    {p.provider === "stripe" ? " · Stripe" : ""}
                    {p.reference ? ` · ${p.reference}` : ""}
                    {p.status === "refunded" ? " · Refunded" : ""}
                    {p.source === "legacy_import" ? " · Imported" : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <p className={`font-semibold tabular-nums ${isReversal ? "text-destructive" : "text-success"}`}>
                    {isReversal ? "−" : ""}{money(p.amount)}
                  </p>
                  {canReverse && (
                    <button title="Reverse this payment" onClick={() => setReversingId(p.id)} className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-destructive">
                      <Undo2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              {p.reversalReason && <p className="mt-1 text-[11px] text-muted-foreground">Reason: {p.reversalReason}</p>}
            </div>
          );
        })}
      </div>

      <ReversalReasonDialog
        open={Boolean(reversingPayment)} onClose={() => setReversingId(null)}
        title="Reverse Payment" confirmLabel="Reverse payment"
        description={reversingPayment ? `This posts a reversing entry for the ${money(reversingPayment.amount)} payment made ${fmtDate(reversingPayment.paidAt)}. This is an accounting correction, not a refund — no money actually moves.` : ""}
        onConfirm={(reason) => reversingPayment ? handleReverse(reversingPayment.id, reason) : Promise.resolve()}
      />
    </div>
  );
}
