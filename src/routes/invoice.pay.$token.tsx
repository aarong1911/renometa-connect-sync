// src/routes/invoice.pay.$token.tsx
//
// Phase 13.7 — public, unauthenticated, token-scoped customer-facing
// invoice/payment page. No AppShell (registered in __root.tsx's
// PORTAL_ROUTES so it bypasses the auth redirect the same way /portal and
// /proposal do). Talks only to public-invoice.ts (GET) and
// invoice-create-payment.ts (POST) — never touches Supabase directly, since
// an anonymous customer has no session. All amounts shown are exactly what
// the server returned; nothing is computed client-side.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { Loader2, AlertCircle, CheckCircle2, CreditCard, Phone, Globe, Mail } from "lucide-react";

export const Route = createFileRoute("/invoice/pay/$token")({ component: PublicInvoicePage });

type LineItem = { description: string; quantity: number; unitPrice: number; amount: number };
type PublicInvoice = {
  invoiceNumber: string; status: string; issueDate: string | null; dueDate: string | null;
  customerName: string | null; projectName: string | null;
  lineItems: LineItem[]; subtotal: number; taxAmount: number; total: number; amountPaid: number; creditsTotal: number; remainingBalance: number;
  business: { name: string; logoUrl: string | null; phone: string | null; email: string | null; website: string | null };
};

function fmtMoney(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}
function fmtDate(d: string | null) {
  if (!d) return "—";
  // Date-only string — parse the calendar date directly, don't let a UTC
  // instant parse shift it a day in the customer's local timezone.
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return d;
  return new Date(y, m - 1, day).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  sent: { label: "Awaiting Payment", className: "bg-amber-100 text-amber-800" },
  viewed: { label: "Awaiting Payment", className: "bg-amber-100 text-amber-800" },
  partial: { label: "Partially Paid", className: "bg-blue-100 text-blue-800" },
  paid: { label: "Paid", className: "bg-emerald-100 text-emerald-800" },
  overdue: { label: "Overdue", className: "bg-red-100 text-red-800" },
};

function PublicInvoicePage() {
  const { token } = Route.useParams();
  const search = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const isProcessingRedirect = search?.get("payment") === "processing";

  const [data, setData] = useState<PublicInvoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [polling, setPolling] = useState(isProcessingRedirect);

  const load = useCallback(() => {
    fetch(`/.netlify/functions/public-invoice?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || "This invoice link is invalid or no longer available.");
        return body as PublicInvoice;
      })
      .then((body) => { setData(body); setError(null); })
      .catch((err) => setError(err instanceof Error ? err.message : "This invoice link is invalid or no longer available."))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // After a Checkout redirect, the webhook is the actual authority — this
  // just polls the read endpoint briefly so the page reflects the server's
  // confirmed state once it lands, rather than claiming success itself.
  useEffect(() => {
    if (!polling) return;
    let attempts = 0;
    const interval = setInterval(() => {
      attempts += 1;
      fetch(`/.netlify/functions/public-invoice?token=${encodeURIComponent(token)}`)
        .then((res) => res.json())
        .then((body: PublicInvoice) => {
          if (body.remainingBalance <= 0 || attempts >= 10) {
            setData(body);
            setPolling(false);
            clearInterval(interval);
          } else {
            setData(body);
          }
        })
        .catch(() => {});
      if (attempts >= 10) { setPolling(false); clearInterval(interval); }
    }, 3000);
    return () => clearInterval(interval);
  }, [polling, token]);

  const handlePay = async () => {
    setPaying(true);
    setPayError(null);
    try {
      const res = await fetch("/.netlify/functions/invoice-create-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not start the payment.");
      window.location.href = body.checkoutUrl;
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "Could not start the payment.");
      setPaying(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="max-w-sm rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <AlertCircle className="mx-auto mb-3 h-8 w-8 text-red-500" />
          <p className="text-sm font-medium text-slate-900">{error || "This invoice link is invalid or no longer available."}</p>
          <p className="mt-2 text-xs text-slate-500">Please contact your contractor for a new link.</p>
        </div>
      </div>
    );
  }

  const statusMeta = STATUS_LABEL[data.status] ?? { label: data.status, className: "bg-slate-100 text-slate-700" };
  const isPaidInFull = data.remainingBalance <= 0;

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-xl">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
          {data.business.logoUrl ? (
            // Phase 13.7F — sized to actually show a wide horizontal
            // wordmark (helmet + business name), not just enough room for
            // an icon. object-contain + no forced width means the full
            // logo scales proportionally and never crops; max-width caps
            // it responsively on narrow viewports instead of colliding
            // with the status badge.
            <img
              src={data.business.logoUrl}
              alt={`${data.business.name} logo`}
              className="h-auto w-auto object-contain"
              style={{ maxHeight: 48, maxWidth: "min(220px, 70vw)" }}
            />
          ) : (
            <span className="text-lg font-semibold text-slate-900">{data.business.name}</span>
          )}
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusMeta.className}`}>{statusMeta.label}</span>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-6 py-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">Invoice</p>
                <p className="text-lg font-semibold text-slate-900">{data.invoiceNumber}</p>
              </div>
              <div className="text-right text-xs text-slate-500">
                <p>Issued {fmtDate(data.issueDate)}</p>
                <p>Due {fmtDate(data.dueDate)}</p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">Bill To</p>
                <p className="font-medium text-slate-900">{data.customerName || "—"}</p>
              </div>
              {data.projectName && (
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">Project</p>
                  <p className="font-medium text-slate-900">{data.projectName}</p>
                </div>
              )}
            </div>
          </div>

          <div className="px-6 py-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="pb-2 font-medium">Description</th>
                  <th className="pb-2 text-right font-medium">Qty</th>
                  <th className="pb-2 text-right font-medium">Rate</th>
                  <th className="pb-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.lineItems.map((item, i) => (
                  <tr key={i}>
                    <td className="py-2 pr-2 text-slate-700">{item.description}</td>
                    <td className="py-2 text-right text-slate-500">{item.quantity}</td>
                    <td className="py-2 text-right text-slate-500">{fmtMoney(item.unitPrice)}</td>
                    <td className="py-2 text-right font-medium text-slate-900">{fmtMoney(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-4 space-y-1.5 border-t border-slate-100 pt-4 text-sm">
              <div className="flex justify-between text-slate-600"><span>Subtotal</span><span>{fmtMoney(data.subtotal)}</span></div>
              {data.taxAmount > 0 && <div className="flex justify-between text-slate-600"><span>Tax</span><span>{fmtMoney(data.taxAmount)}</span></div>}
              <div className="flex justify-between text-base font-semibold text-slate-900"><span>Total</span><span>{fmtMoney(data.total)}</span></div>
              <div className="flex justify-between text-slate-600"><span>Paid</span><span>{fmtMoney(data.amountPaid)}</span></div>
              {data.creditsTotal > 0 && (
                <div className="flex justify-between text-emerald-700"><span>Credits</span><span>−{fmtMoney(data.creditsTotal)}</span></div>
              )}
              <div className="flex justify-between border-t border-slate-100 pt-1.5 text-base font-semibold text-slate-900">
                <span>Amount Due</span><span>{fmtMoney(data.remainingBalance)}</span>
              </div>
            </div>
          </div>

          <div className="border-t border-slate-100 px-6 py-5">
            {isPaidInFull ? (
              <div className="flex items-center justify-center gap-2 rounded-lg bg-emerald-50 py-3 text-sm font-medium text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                {polling ? "Payment processing…" : "Payment received — this invoice is paid in full."}
              </div>
            ) : (
              <>
                <button
                  onClick={handlePay}
                  disabled={paying}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
                >
                  {paying ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                  {paying ? "Redirecting to secure payment…" : `Pay ${fmtMoney(data.remainingBalance)}`}
                </button>
                {payError && <p className="mt-2 text-center text-xs text-red-600">{payError}</p>}
                <p className="mt-2 text-center text-xs text-slate-400">Payments are processed securely by Stripe.</p>
              </>
            )}
          </div>
        </div>

        {(data.business.phone || data.business.email || data.business.website) && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-slate-500">
            {data.business.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{data.business.phone}</span>}
            {data.business.email && <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{data.business.email}</span>}
            {data.business.website && <span className="flex items-center gap-1"><Globe className="h-3 w-3" />{data.business.website}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
