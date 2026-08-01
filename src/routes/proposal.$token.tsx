// src/routes/proposal.$token.tsx
//
// Phase 10.4 — public, unauthenticated, token-scoped customer-facing
// proposal page. No AppShell (registered in __root.tsx's PORTAL_ROUTES so
// it bypasses the auth redirect the same way /portal does). Talks only to
// proposal-data.ts (GET) / proposal-action.ts (POST) — never touches
// Supabase directly, since an anonymous customer has no session.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Loader2, AlertCircle, CheckCircle2, ThumbsDown, MessageSquareWarning,
  Phone, Globe, ChevronDown, ChevronUp, ShieldCheck, Printer,
} from "lucide-react";

// Print stylesheet — hides interactive chrome (header, action panel,
// scope toggle button) and lets the content flow naturally onto printed
// pages; injected once since this route has no shared <head> to edit.
const PRINT_STYLES = `
@media print {
  .proposal-no-print { display: none !important; }
  body { background: #fff !important; }
  .proposal-card { box-shadow: none !important; border: 1px solid #e5e7eb !important; break-inside: avoid; }
}
`;

export const Route = createFileRoute("/proposal/$token")({
  component: ProposalPage,
});

type ProposalItem = {
  id: string; position: number; itemType: string | null; category: string | null;
  name: string; description: string | null; quantity: number; unit: string | null;
  unitPrice: number; lineTotal: number; optional: boolean; selectedByCustomer: boolean; isHeading: boolean;
};

type ProposalData = {
  estimate: {
    number: string | null; title: string; status: string; versionNumber: number; currency: string;
    subtotal: number; discountTotal: number; taxTotal: number; taxRate: number; total: number;
    depositType: string | null; depositAmount: number; balanceDue: number;
    validUntil: string | null; scope: string | null; exclusions: string | null; assumptions: string | null;
    customerNote: string | null; terms: string | null; customerName: string; customerAddress: string | null;
  };
  items: ProposalItem[];
  org: { name: string; phone: string | null; logo: string | null; primaryColor: string; address: string | null; website: string | null };
};

function fmtMoney(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}
function fmtDate(d: string | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

const RESPONDED_STATUSES = ["approved", "rejected", "changes_requested", "expired"];

function ProposalPage() {
  const { token } = Route.useParams();

  const [data, setData] = useState<ProposalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "approve" | "reject" | "changes">("view");
  const [scopeOpen, setScopeOpen] = useState(false);

  // approve form
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [signature, setSignature] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  // reject / changes form
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState("other");

  const load = () => {
    fetch(`/.netlify/functions/proposal-data?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); return; }
        setData(d);
        setCustomerName(d.estimate.customerName || "");
      })
      .catch(() => setError("Failed to load this proposal."))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  const doAction = async (action: string, payload: any) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/.netlify/functions/proposal-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action, payload }),
      });
      const d = await res.json();
      if (!res.ok || d.error) { setActionError(d.error || "Something went wrong."); return; }
      load();
      setMode("view");
    } catch {
      setActionError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const toggleOptional = (itemId: string, selected: boolean) => {
    if (!data || RESPONDED_STATUSES.includes(data.estimate.status)) return;
    doAction("select_optional", { itemId, selected });
  };

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
    </div>
  );

  if (error || !data) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 px-4">
      <div className="max-w-sm text-center space-y-3">
        <div className="h-16 w-16 mx-auto rounded-full bg-red-50 flex items-center justify-center">
          <AlertCircle className="h-8 w-8 text-red-500" />
        </div>
        <h1 className="text-xl font-semibold text-gray-900">Proposal Not Found</h1>
        <p className="text-sm text-gray-500">{error || "This link is invalid or has expired."}</p>
      </div>
    </div>
  );

  const { estimate: est, items, org } = data;
  const color = org.primaryColor || "#3B82F6";
  const isActionable = ["sent", "viewed", "changes_requested"].includes(est.status);
  const optionalItems = items.filter(i => i.optional && !i.isHeading);
  const visibleTotal = est.total;

  return (
    <div className="min-h-screen bg-gray-50 font-sans pb-16">
      <style dangerouslySetInnerHTML={{ __html: PRINT_STYLES }} />
      <header className="proposal-no-print bg-white border-b border-gray-100 sticky top-0 z-40">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {org.logo
              ? <img src={org.logo} alt={org.name} className="h-9 w-auto object-contain" />
              : <div className="h-9 w-9 rounded-lg flex items-center justify-center text-white text-sm font-bold" style={{ background: color }}>{org.name[0]}</div>}
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
            <StatusPill status={est.status} />
          </div>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        <div className="proposal-card rounded-xl bg-white border border-gray-100 shadow-sm p-5">
          {/* Org identity — shown only in print, where the sticky header above is hidden */}
          <div className="hidden print:flex items-center gap-3 mb-4 pb-4 border-b border-gray-100">
            {org.logo && <img src={org.logo} alt={org.name} className="h-8 w-auto object-contain" />}
            <p className="text-base font-semibold text-gray-900">{org.name}</p>
          </div>
          <div className="flex items-start justify-between gap-3">
            <div>
              {est.number && <p className="text-xs text-gray-400">Proposal #{est.number} · v{est.versionNumber}</p>}
              <h1 className="text-xl font-semibold text-gray-900 mt-0.5">{est.title}</h1>
              <p className="text-sm text-gray-500 mt-1">Prepared for {est.customerName}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-2xl font-bold text-gray-900">{fmtMoney(visibleTotal)}</p>
              {est.validUntil && <p className="text-xs text-gray-400 mt-0.5">Valid until {fmtDate(est.validUntil)}</p>}
            </div>
          </div>

          {est.customerNote && (
            <div className="mt-4 rounded-lg bg-gray-50 border border-gray-100 p-3 text-sm text-gray-600">
              {est.customerNote}
            </div>
          )}

          {(est.scope || est.exclusions || est.assumptions) && (
            <div className="mt-4">
              <button onClick={() => setScopeOpen(o => !o)} className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700">
                Scope & details {scopeOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              {scopeOpen && (
                <div className="mt-2 space-y-2 text-sm text-gray-600">
                  {est.scope && <div><p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Scope of work</p><p className="whitespace-pre-wrap">{est.scope}</p></div>}
                  {est.exclusions && <div><p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Exclusions</p><p className="whitespace-pre-wrap">{est.exclusions}</p></div>}
                  {est.assumptions && <div><p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Assumptions</p><p className="whitespace-pre-wrap">{est.assumptions}</p></div>}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Line items */}
        <div className="proposal-card rounded-xl bg-white border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-50"><p className="text-sm font-semibold text-gray-900">Line items</p></div>
          <div className="divide-y divide-gray-50">
            {items.filter(i => !i.isHeading).map(item => (
              <div key={item.id} className="px-5 py-3.5 flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  {item.optional && (
                    <input
                      type="checkbox"
                      checked={item.selectedByCustomer}
                      disabled={!isActionable || busy}
                      onChange={e => toggleOptional(item.id, e.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-gray-300 disabled:opacity-50"
                    />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">{item.name}{item.optional && <span className="ml-2 text-[10px] uppercase tracking-wide text-blue-500 font-semibold">Optional</span>}</p>
                    {item.description && <p className="text-xs text-gray-400 mt-0.5">{item.description}</p>}
                    <p className="text-xs text-gray-400 mt-0.5">{item.quantity} {item.unit || ""} × {fmtMoney(item.unitPrice)}</p>
                  </div>
                </div>
                <p className={`text-sm font-semibold shrink-0 ${item.optional && !item.selectedByCustomer ? "text-gray-300 line-through" : "text-gray-900"}`}>{fmtMoney(item.lineTotal)}</p>
              </div>
            ))}
          </div>
          <div className="px-5 py-4 border-t border-gray-100 space-y-1.5 bg-gray-50/50">
            <Row label="Subtotal" value={fmtMoney(est.subtotal)} />
            {est.discountTotal > 0 && <Row label="Discount" value={`−${fmtMoney(est.discountTotal)}`} />}
            {est.taxTotal > 0 && <Row label={`Tax (${est.taxRate}%)`} value={fmtMoney(est.taxTotal)} />}
            <Row label="Total" value={fmtMoney(est.total)} bold />
            {est.depositAmount > 0 && <Row label="Deposit due" value={fmtMoney(est.depositAmount)} />}
            {est.balanceDue > 0 && est.depositAmount > 0 && <Row label="Balance due" value={fmtMoney(est.balanceDue)} />}
          </div>
        </div>

        {est.terms && (
          <div className="rounded-xl bg-white border border-gray-100 shadow-sm p-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Terms</p>
            <p className="text-sm text-gray-600 whitespace-pre-wrap">{est.terms}</p>
          </div>
        )}

        {/* Response state */}
        {est.status === "approved" && (
          <StatusBanner icon={<CheckCircle2 className="h-5 w-5" />} tone="emerald" title="Proposal approved" body="Thank you — your contractor has been notified and will follow up shortly." />
        )}
        {est.status === "rejected" && (
          <StatusBanner icon={<ThumbsDown className="h-5 w-5" />} tone="rose" title="Proposal declined" body="You've declined this proposal. Reach out if you'd like to discuss further." />
        )}
        {est.status === "changes_requested" && !isActionable /* only after re-load if still changes_requested and inactionable — normally stays actionable */ && (
          <StatusBanner icon={<MessageSquareWarning className="h-5 w-5" />} tone="amber" title="Changes requested" body="Your contractor has been notified." />
        )}
        {est.status === "expired" && (
          <StatusBanner icon={<AlertCircle className="h-5 w-5" />} tone="slate" title="This proposal has expired" body="Contact your contractor for an updated proposal." />
        )}

        {/* Action panel — never printed, approval must happen on-screen */}
        {isActionable && (
          <div className="proposal-no-print rounded-xl bg-white border border-gray-100 shadow-sm p-5">
            {mode === "view" && (
              <div className="flex flex-col sm:flex-row gap-2.5">
                <button onClick={() => setMode("approve")} className="flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90" style={{ background: color }}>
                  Approve Proposal
                </button>
                <button onClick={() => setMode("changes")} className="flex-1 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50">
                  Request Changes
                </button>
                <button onClick={() => setMode("reject")} className="flex-1 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50">
                  Decline
                </button>
              </div>
            )}

            {mode === "approve" && (
              <div className="space-y-3">
                <p className="text-sm font-semibold text-gray-900 flex items-center gap-1.5"><ShieldCheck className="h-4 w-4" style={{ color }} />Approve this proposal</p>
                <input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="Your full name" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                <input value={customerEmail} onChange={e => setCustomerEmail(e.target.value)} placeholder="Your email" type="email" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                <input value={signature} onChange={e => setSignature(e.target.value)} placeholder="Type your name as signature" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-serif italic" />
                <label className="flex items-start gap-2 text-xs text-gray-500">
                  <input type="checkbox" checked={acceptedTerms} onChange={e => setAcceptedTerms(e.target.checked)} className="mt-0.5 h-3.5 w-3.5 rounded border-gray-300" />
                  I have reviewed this proposal and agree to the total of {fmtMoney(est.total)}{est.terms ? " and the terms above." : "."}
                </label>
                {actionError && <p className="text-xs text-rose-600">{actionError}</p>}
                <div className="flex gap-2 pt-1">
                  <button disabled={busy || !customerName.trim() || !customerEmail.trim() || !signature.trim() || !acceptedTerms}
                    onClick={() => doAction("approve", { customerName, customerEmail, acceptedTerms, signature })}
                    className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 transition-opacity hover:opacity-90" style={{ background: color }}>
                    {busy ? "Submitting…" : "Confirm Approval"}
                  </button>
                  <button onClick={() => setMode("view")} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-50">Cancel</button>
                </div>
              </div>
            )}

            {mode === "changes" && (
              <div className="space-y-3">
                <p className="text-sm font-semibold text-gray-900">What would you like changed?</p>
                <select value={category} onChange={e => setCategory(e.target.value)} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
                  {[["scope", "Scope of work"], ["price", "Price"], ["timeline", "Timeline"], ["materials", "Materials"], ["terms", "Terms"], ["other", "Other"]].map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
                <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} placeholder="Describe what you'd like changed…" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm resize-none" />
                {actionError && <p className="text-xs text-rose-600">{actionError}</p>}
                <div className="flex gap-2">
                  <button disabled={busy || !reason.trim()} onClick={() => doAction("request_changes", { message: reason, category })}
                    className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 transition-opacity hover:opacity-90" style={{ background: color }}>
                    {busy ? "Submitting…" : "Send Request"}
                  </button>
                  <button onClick={() => setMode("view")} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-50">Cancel</button>
                </div>
              </div>
            )}

            {mode === "reject" && (
              <div className="space-y-3">
                <p className="text-sm font-semibold text-gray-900">Decline this proposal</p>
                <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} placeholder="Optional — let them know why (helps them improve future proposals)" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm resize-none" />
                {actionError && <p className="text-xs text-rose-600">{actionError}</p>}
                <div className="flex gap-2">
                  <button disabled={busy} onClick={() => doAction("reject", { reason })}
                    className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 hover:bg-rose-700">
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
    <div className={`flex items-center justify-between text-sm ${bold ? "font-bold text-gray-900 text-base pt-1" : "text-gray-500"}`}>
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
    <div className={`rounded-xl border p-4 flex items-start gap-3 ${tones[tone]}`}>
      {icon}
      <div><p className="text-sm font-semibold">{title}</p><p className="text-xs mt-0.5 opacity-80">{body}</p></div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const cfg: Record<string, { label: string; cls: string }> = {
    sent: { label: "Awaiting response", cls: "bg-blue-50 text-blue-600" },
    viewed: { label: "Awaiting response", cls: "bg-violet-50 text-violet-600" },
    changes_requested: { label: "Changes requested", cls: "bg-amber-50 text-amber-600" },
    approved: { label: "Approved", cls: "bg-emerald-50 text-emerald-600" },
    rejected: { label: "Declined", cls: "bg-rose-50 text-rose-600" },
    expired: { label: "Expired", cls: "bg-gray-100 text-gray-500" },
  };
  const c = cfg[status] ?? { label: status, cls: "bg-gray-100 text-gray-500" };
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${c.cls}`}>{c.label}</span>;
}
