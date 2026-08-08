// src/routes/change-order.$token.tsx
//
// Phase 13.3B — public, unauthenticated, token-scoped customer-facing
// Change Order approval page. Mirrors proposal.$token.tsx's shape exactly
// (no AppShell — registered in __root.tsx's PORTAL_ROUTES; talks only to
// change-order-data.ts (GET) / change-order-action.ts (POST), never
// Supabase directly). This is a focused single-purpose page, not a preview
// of the future full Portal navigation (Part 23).
//
// UX fix round: a successful approve/reject correctly revokes the token
// server-side (never weakened) -- but this page must not immediately
// re-fetch change-order-data afterward, since that would now 410 against
// the just-revoked token and show "Change Order Not Found" right after a
// successful action. Instead, the confirmation screen is built entirely
// from data already in hand: the immutable snapshot loaded before the
// action (`data`) plus the approve/reject RPC's own response (`outcome`)
// -- no second network request. Reopening the same link later (a fresh
// page load, no local `outcome` state) still correctly 410s, but with a
// customer-friendly "already completed" message instead of exposing the
// raw "revoked" wording.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Loader2, AlertCircle, CheckCircle2, ThumbsDown, Phone, Globe, ShieldCheck, Printer, Clock3,
} from "lucide-react";

const PRINT_STYLES = `
@media print {
  .co-no-print { display: none !important; }
  body { background: #fff !important; }
  .co-card { box-shadow: none !important; border: 1px solid #e5e7eb !important; break-inside: avoid; }
}
`;

export const Route = createFileRoute("/change-order/$token")({
  component: ChangeOrderApprovalPage,
});

type ChangeOrderItem = {
  id: string; position: number; itemType: string; name: string; description: string | null;
  quantity: number; unit: string | null; unitPrice: number; lineTotal: number; taxable: boolean;
};

type ChangeOrderPayload = {
  changeOrder: {
    number: string; version: number; title: string; scope: string | null; customerMessage: string | null;
    status: string; currency: string; subtotal: number; discountAmount: number; markupAmount: number;
    taxAmount: number; totalAmount: number; scheduleImpactDays: number; proposedStartDate: string | null;
    proposedCompletionDate: string | null; approvalDueAt: string | null; projectName: string | null; projectAddress: string | null;
  };
  items: ChangeOrderItem[];
  org: { name: string; phone: string | null; logo: string | null; primaryColor: string; address: string | null; website: string | null };
};

type ActionOutcome =
  | { kind: "approved"; totalAmount: number }
  | { kind: "rejected" };

function fmtMoney(n: number) {
  const sign = n < 0 ? "-" : "";
  return `${sign}${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(n || 0))}`;
}
function fmtDate(d: string | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

const ACTIONABLE_STATUSES = ["sent", "viewed"];

function ChangeOrderApprovalPage() {
  const { token } = Route.useParams();

  const [data, setData] = useState<ChangeOrderPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "approve" | "reject">("view");
  // Set only from a successful approve/reject response in THIS page
  // session -- never re-derived from a follow-up fetch, since the token
  // is revoked the instant that response arrives.
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [signature, setSignature] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");

  const load = () => {
    fetch(`/.netlify/functions/change-order-data?token=${encodeURIComponent(token)}`)
      .then(async (r) => ({ status: r.status, body: await r.json() }))
      .then(({ status, body }) => {
        if (body.error) { setErrorStatus(status); setError(body.error); return; }
        setData(body);
      })
      .catch(() => setError("Failed to load this Change Order."))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  const doAction = async (action: "approve" | "reject", payload: Record<string, unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/.netlify/functions/change-order-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action, payload }),
      });
      const d = await res.json();
      if (!res.ok || d.error) { setActionError(d.error || "Something went wrong."); return; }

      // Build the confirmation screen from data already on this page --
      // the just-loaded immutable snapshot (`data`) plus this response
      // (`d.result`) -- and never call load() again; the token this page
      // was opened with is now revoked server-side.
      if (action === "approve") {
        setOutcome({ kind: "approved", totalAmount: Number(d.result?.totalAmount ?? data?.changeOrder.totalAmount ?? 0) });
      } else {
        setOutcome({ kind: "rejected" });
      }
      setMode("view");
    } catch {
      setActionError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
    </div>
  );

  // Local confirmation state always wins over any load error -- a
  // revoked-token 410 from a stray re-render must never override a
  // successful action's own confirmation screen.
  if (outcome) {
    const co = data?.changeOrder;
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
        <div className="co-card w-full max-w-sm rounded-xl border border-gray-100 bg-white p-6 text-center shadow-sm">
          {outcome.kind === "approved" ? (
            <>
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50">
                <CheckCircle2 className="h-7 w-7 text-emerald-600" />
              </div>
              <h1 className="mt-4 text-xl font-semibold text-gray-900">Approved</h1>
              <p className="mt-1 text-sm text-gray-500">Your approval has been recorded.</p>
              {co && (
                <div className="mt-5 space-y-2 rounded-lg border border-gray-100 bg-gray-50 p-4 text-left">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-gray-400">Change Order</p>
                    <p className="text-sm font-medium text-gray-900">{co.number} · {co.title}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-gray-400">Approved amount</p>
                    <p className="text-base font-semibold text-gray-900">{fmtMoney(outcome.totalAmount)}</p>
                  </div>
                </div>
              )}
              <p className="mt-4 text-[11px] text-gray-400">Electronic approval recorded.</p>
            </>
          ) : (
            <>
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-gray-100">
                <ThumbsDown className="h-7 w-7 text-gray-500" />
              </div>
              <h1 className="mt-4 text-xl font-semibold text-gray-900">Response Recorded</h1>
              <p className="mt-1 text-sm text-gray-500">This Change Order was declined.</p>
              <p className="mt-4 text-sm text-gray-500">Your response has been recorded and the contractor has been notified.</p>
            </>
          )}
          <p className="mt-6 text-xs text-gray-400">You can safely close this page.</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    const isCompleted = errorStatus === 410;
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 px-4">
        <div className="max-w-sm text-center space-y-3">
          <div className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full ${isCompleted ? "bg-gray-100" : "bg-red-50"}`}>
            {isCompleted ? <Clock3 className="h-8 w-8 text-gray-500" /> : <AlertCircle className="h-8 w-8 text-red-500" />}
          </div>
          <h1 className="text-xl font-semibold text-gray-900">
            {isCompleted ? "This Change Order Has Already Been Completed" : "Change Order Not Found"}
          </h1>
          <p className="text-sm text-gray-500">
            {isCompleted
              ? "This approval link is no longer active. The Change Order may already have been approved, declined, replaced, or cancelled."
              : (error || "This link is invalid or has expired.")}
          </p>
        </div>
      </div>
    );
  }

  const { changeOrder: co, items, org } = data;
  const color = org.primaryColor || "#3B82F6";
  const isActionable = ACTIONABLE_STATUSES.includes(co.status);

  return (
    <div className="min-h-screen bg-gray-50 font-sans pb-16">
      <style dangerouslySetInnerHTML={{ __html: PRINT_STYLES }} />
      <header className="co-no-print sticky top-0 z-40 border-b border-gray-100 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            {org.logo
              ? <img src={org.logo} alt={org.name} className="h-9 w-auto object-contain" />
              : <div className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold text-white" style={{ background: color }}>{org.name[0]}</div>}
            <div>
              <p className="text-sm font-semibold text-gray-900">{org.name}</p>
              <div className="flex items-center gap-2 text-xs text-gray-400">
                {org.phone && <a href={`tel:${org.phone}`} className="flex items-center gap-1 hover:text-gray-600"><Phone className="h-3 w-3" />{org.phone}</a>}
                {org.website && <a href={org.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:text-gray-600"><Globe className="h-3 w-3" />Website</a>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => window.print()} className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50" aria-label="Print or save as PDF">
              <Printer className="h-3.5 w-3.5" />Print
            </button>
            <StatusPill status={co.status} />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-5 px-4 py-6">
        <div className="co-card rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs text-gray-400">Change Order {co.number} · v{co.version}{co.projectName ? ` · ${co.projectName}` : ""}</p>
              <h1 className="mt-0.5 text-xl font-semibold text-gray-900">{co.title}</h1>
              {co.scope && <p className="mt-1 text-sm text-gray-500">{co.scope}</p>}
            </div>
            <div className="shrink-0 text-right">
              <p className={`text-2xl font-bold ${co.totalAmount < 0 ? "text-rose-600" : "text-gray-900"}`}>{fmtMoney(co.totalAmount)}</p>
              {co.approvalDueAt && <p className="mt-0.5 text-xs text-gray-400">Respond by {fmtDate(co.approvalDueAt)}</p>}
            </div>
          </div>
          {co.customerMessage && (
            <div className="mt-4 rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm text-gray-600">{co.customerMessage}</div>
          )}
          {co.scheduleImpactDays !== 0 && (
            <p className="mt-3 text-sm text-gray-500">
              Schedule impact: {co.scheduleImpactDays > 0 ? "+" : ""}{co.scheduleImpactDays} days
              {co.proposedCompletionDate ? ` · new target completion ${fmtDate(co.proposedCompletionDate)}` : ""}
            </p>
          )}
        </div>

        <div className="co-card overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm">
          <div className="border-b border-gray-50 px-5 py-3"><p className="text-sm font-semibold text-gray-900">Line items</p></div>
          <div className="divide-y divide-gray-50">
            {items.map((item) => (
              <div key={item.id} className="flex items-start justify-between gap-4 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">{item.name}</p>
                  {item.description && <p className="mt-0.5 text-xs text-gray-400">{item.description}</p>}
                  <p className="mt-0.5 text-xs text-gray-400">{item.quantity} {item.unit || ""} × {fmtMoney(item.unitPrice)}</p>
                </div>
                <p className={`shrink-0 text-sm font-semibold ${item.lineTotal < 0 ? "text-rose-600" : "text-gray-900"}`}>{fmtMoney(item.lineTotal)}</p>
              </div>
            ))}
          </div>
          <div className="space-y-1.5 border-t border-gray-100 bg-gray-50/50 px-5 py-4">
            <Row label="Subtotal" value={fmtMoney(co.subtotal)} />
            {co.discountAmount !== 0 && <Row label="Discount" value={`-${fmtMoney(co.discountAmount)}`} />}
            {co.markupAmount !== 0 && <Row label="Markup" value={fmtMoney(co.markupAmount)} />}
            {co.taxAmount !== 0 && <Row label="Tax" value={fmtMoney(co.taxAmount)} />}
            <Row label="Total" value={fmtMoney(co.totalAmount)} bold />
          </div>
        </div>

        {co.status === "approved" && (
          <StatusBanner icon={<CheckCircle2 className="h-5 w-5" />} tone="emerald" title="Change Order approved" body="Thank you — your contractor has been notified and will proceed accordingly." />
        )}
        {co.status === "rejected" && (
          <StatusBanner icon={<ThumbsDown className="h-5 w-5" />} tone="rose" title="Change Order declined" body="You've declined this Change Order. Reach out if you'd like to discuss further." />
        )}

        {isActionable && (
          <div className="co-no-print rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
            {mode === "view" && (
              <div className="flex flex-col gap-2.5 sm:flex-row">
                <button onClick={() => setMode("approve")} className="flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90" style={{ background: color }}>
                  Approve Change Order
                </button>
                <button onClick={() => setMode("reject")} className="flex-1 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50">
                  Decline
                </button>
              </div>
            )}

            {mode === "approve" && (
              <div className="space-y-3">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-gray-900"><ShieldCheck className="h-4 w-4" style={{ color }} />Approve this Change Order</p>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your full name" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Your email" type="email" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                <input value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="Type your name as signature (optional)" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-serif italic" />
                <label className="flex items-start gap-2 text-xs text-gray-500">
                  <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5 h-3.5 w-3.5 rounded border-gray-300" />
                  I approve this Change Order and authorize the contractor to perform the described work for the stated amount and schedule impact.
                </label>
                <p className="text-[11px] text-gray-400">Electronic approval recorded.</p>
                {actionError && <p className="text-xs text-rose-600">{actionError}</p>}
                <div className="flex gap-2 pt-1">
                  <button
                    disabled={busy || !name.trim() || !email.trim() || !acknowledged}
                    onClick={() => doAction("approve", {
                      name, email, signatureName: signature.trim() || undefined,
                      acknowledgment: "I approve this Change Order and authorize the contractor to perform the described work for the stated amount and schedule impact.",
                    })}
                    className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40" style={{ background: color }}
                  >
                    {busy ? "Submitting…" : "Confirm Approval"}
                  </button>
                  <button onClick={() => setMode("view")} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-50">Cancel</button>
                </div>
              </div>
            )}

            {mode === "reject" && (
              <div className="space-y-3">
                <p className="text-sm font-semibold text-gray-900">Decline this Change Order</p>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your full name" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Your email (optional)" type="email" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Optional — let them know why" className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                {actionError && <p className="text-xs text-rose-600">{actionError}</p>}
                <div className="flex gap-2">
                  <button disabled={busy || !name.trim()} onClick={() => doAction("reject", { name, email, reason })}
                    className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-40">
                    {busy ? "Submitting…" : "Confirm Decline"}
                  </button>
                  <button onClick={() => setMode("view")} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-50">Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex items-center justify-between text-sm ${bold ? "pt-1 text-base font-bold text-gray-900" : "text-gray-500"}`}>
      <span>{label}</span><span className={bold ? "text-gray-900" : "text-gray-700"}>{value}</span>
    </div>
  );
}

function StatusBanner({ icon, tone, title, body }: { icon: React.ReactNode; tone: "emerald" | "rose" | "amber" | "slate"; title: string; body: string }) {
  const tones: Record<string, string> = {
    emerald: "bg-emerald-50 border-emerald-100 text-emerald-700",
    rose: "bg-rose-50 border-rose-100 text-rose-700",
    amber: "bg-amber-50 border-amber-100 text-amber-700",
    slate: "bg-gray-50 border-gray-100 text-gray-600",
  };
  return (
    <div className={`flex items-start gap-3 rounded-xl border p-4 ${tones[tone]}`}>
      {icon}
      <div><p className="text-sm font-semibold">{title}</p><p className="mt-0.5 text-xs opacity-80">{body}</p></div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const cfg: Record<string, { label: string; cls: string }> = {
    sent: { label: "Awaiting response", cls: "bg-blue-50 text-blue-600" },
    viewed: { label: "Awaiting response", cls: "bg-violet-50 text-violet-600" },
    approved: { label: "Approved", cls: "bg-emerald-50 text-emerald-600" },
    rejected: { label: "Declined", cls: "bg-rose-50 text-rose-600" },
  };
  const c = cfg[status] ?? { label: status, cls: "bg-gray-100 text-gray-500" };
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${c.cls}`}>{c.label}</span>;
}
