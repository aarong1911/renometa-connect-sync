// src/components/projects/InvoiceDetailModal.tsx
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Loader2, Printer, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useOrganization } from "@/lib/organization";

type InvoiceItem = {
  id: string; description: string; quantity: number; unit_price: number; amount: number;
};

type InvoiceDetail = {
  id: string; invoice_number: string; status: string;
  issue_date: string | null; due_date: string | null;
  subtotal: number; tax_amount: number; total_amount: number; amount_paid: number;
  notes: string | null;
  project?: { name: string; address: string | null };
  client?: { full_name: string; email: string | null; phone: string | null };
};

type Props = {
  invoiceId: string | null;
  open: boolean;
  onClose: () => void;
};

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}
function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

const STATUS_STYLE: Record<string, string> = {
  paid:    "bg-green-100 text-green-700 border-green-200",
  overdue: "bg-red-100 text-red-700 border-red-200",
  sent:    "bg-blue-100 text-blue-700 border-blue-200",
  draft:   "bg-gray-100 text-gray-600 border-gray-200",
};

export function InvoiceDetailModal({ invoiceId, open, onClose }: Props) {
  const org = useOrganization();
  const printRef = useRef<HTMLDivElement>(null);
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [items,   setItems]   = useState<InvoiceItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !invoiceId) return;
    setLoading(true);
    Promise.all([
      supabase.from("invoices").select(`
        id, invoice_number, status, issue_date, due_date,
        subtotal, tax_amount, total_amount, amount_paid, notes,
        projects!project_id(name, address),
        contacts!client_id(full_name, email, phone)
      `).eq("id", invoiceId).maybeSingle(),
      supabase.from("invoice_items").select("*").eq("invoice_id", invoiceId).order("id"),
    ]).then(([{ data: inv }, { data: lineItems }]) => {
      if (inv) {
        const d = inv as any;
        setInvoice({
          ...d,
          project: d.projects  ? { name: d.projects.name,      address: d.projects.address }                               : undefined,
          client:  d.contacts  ? { full_name: d.contacts.full_name, email: d.contacts.email, phone: d.contacts.phone }     : undefined,
        });
      }
      setItems((lineItems ?? []) as InvoiceItem[]);
      setLoading(false);
    });
  }, [invoiceId, open]);

  const handlePrint = () => {
    if (!printRef.current || !invoice) return;
    const win = window.open("", "_blank", "width=900,height=700");
    if (!win) return;
    const logoHtml = org.logoUrl ? `<img src="${org.logoUrl}" style="height:48px;object-fit:contain;margin-bottom:4px;" />` : "";
    const itemRows = items.map(i => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${i.description}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${i.quantity}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${fmt(i.unit_price)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;">${fmt(i.amount)}</td>
      </tr>`).join("");
    win.document.write(`<!DOCTYPE html><html><head><title>Invoice ${invoice.invoice_number}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; padding: 48px; max-width: 900px; margin: 0 auto; }
  table { width: 100%; border-collapse: collapse; }
  @media print { body { padding: 24px; } }
</style></head><body>
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:40px;">
  <div>
    ${logoHtml}
    <div style="font-size:20px;font-weight:700;">${org.companyName || "Company"}</div>
    ${org.primaryPhone ? `<div style="font-size:13px;color:#6b7280;margin-top:2px;">${org.primaryPhone}</div>` : ""}
    ${org.address ? `<div style="font-size:13px;color:#6b7280;">${org.address}</div>` : ""}
  </div>
  <div style="text-align:right;">
    <div style="font-size:32px;font-weight:800;color:#111;letter-spacing:-1px;">INVOICE</div>
    <div style="font-size:15px;color:#6b7280;margin-top:4px;">#${invoice.invoice_number}</div>
    <div style="display:inline-block;margin-top:8px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${invoice.status === "paid" ? "#dcfce7" : invoice.status === "overdue" ? "#fee2e2" : "#dbeafe"};color:${invoice.status === "paid" ? "#15803d" : invoice.status === "overdue" ? "#b91c1c" : "#1d4ed8"};">${invoice.status.toUpperCase()}</div>
  </div>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-bottom:40px;">
  <div>
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;font-weight:600;margin-bottom:6px;">Bill To</div>
    <div style="font-weight:600;">${invoice.client?.full_name ?? "—"}</div>
    ${invoice.client?.email ? `<div style="font-size:13px;color:#6b7280;">${invoice.client.email}</div>` : ""}
    ${invoice.client?.phone ? `<div style="font-size:13px;color:#6b7280;">${invoice.client.phone}</div>` : ""}
  </div>
  <div>
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;font-weight:600;margin-bottom:6px;">Project</div>
    <div style="font-weight:600;">${invoice.project?.name ?? "—"}</div>
    ${invoice.project?.address ? `<div style="font-size:13px;color:#6b7280;">${invoice.project.address}</div>` : ""}
  </div>
  <div>
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;font-weight:600;margin-bottom:6px;">Dates</div>
    <div style="font-size:13px;">Issued: <span style="font-weight:600;">${fmtDate(invoice.issue_date)}</span></div>
    <div style="font-size:13px;">Due: <span style="font-weight:600;">${fmtDate(invoice.due_date)}</span></div>
  </div>
</div>
<table style="margin-bottom:24px;">
  <thead>
    <tr style="background:#f9fafb;">
      <th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#6b7280;letter-spacing:0.05em;">Description</th>
      <th style="padding:10px 12px;text-align:center;font-size:12px;text-transform:uppercase;color:#6b7280;letter-spacing:0.05em;width:80px;">Qty</th>
      <th style="padding:10px 12px;text-align:right;font-size:12px;text-transform:uppercase;color:#6b7280;letter-spacing:0.05em;width:120px;">Unit Price</th>
      <th style="padding:10px 12px;text-align:right;font-size:12px;text-transform:uppercase;color:#6b7280;letter-spacing:0.05em;width:120px;">Amount</th>
    </tr>
  </thead>
  <tbody>${itemRows || `<tr><td colspan="4" style="padding:20px 12px;text-align:center;color:#9ca3af;font-size:13px;">No line items</td></tr>`}</tbody>
</table>
<div style="display:flex;justify-content:flex-end;">
  <div style="width:260px;">
    <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;"><span style="color:#6b7280;">Subtotal</span><span>${fmt(invoice.subtotal)}</span></div>
    ${invoice.tax_amount > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;"><span style="color:#6b7280;">Tax</span><span>${fmt(invoice.tax_amount)}</span></div>` : ""}
    <div style="display:flex;justify-content:space-between;padding:10px 0;font-size:18px;font-weight:700;border-top:2px solid #111;margin-top:4px;"><span>Total</span><span>${fmt(invoice.total_amount)}</span></div>
    ${invoice.amount_paid > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;color:#16a34a;"><span>Paid</span><span>${fmt(invoice.amount_paid)}</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:15px;font-weight:700;color:#16a34a;"><span>Balance Due</span><span>${fmt(invoice.total_amount - invoice.amount_paid)}</span></div>` : ""}
  </div>
</div>
${invoice.notes ? `<div style="margin-top:32px;padding:16px;background:#f9fafb;border-radius:8px;font-size:13px;color:#374151;"><strong>Notes:</strong><br/>${invoice.notes}</div>` : ""}
</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 500);
  };

  const balance = invoice ? invoice.total_amount - invoice.amount_paid : 0;
  const statusStyle = STATUS_STYLE[invoice?.status ?? "draft"] ?? STATUS_STYLE.draft;

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="px-6 pt-5 pb-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base font-semibold">Invoice Details</DialogTitle>
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={handlePrint} disabled={loading || !invoice}>
              <Printer className="h-3.5 w-3.5" />Download / Print
            </Button>
          </div>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : !invoice ? (
          <div className="py-12 text-center text-sm text-muted-foreground">Invoice not found</div>
        ) : (
          <div ref={printRef} className="px-6 pb-6 space-y-6">
            {/* Header */}
            <div className="flex items-start justify-between gap-4 pt-4">
              <div className="flex items-center gap-3">
                {org.logoUrl && <img src={org.logoUrl} alt={org.companyName} className="h-10 w-auto object-contain" />}
                <div>
                  <p className="font-semibold text-base">{org.companyName}</p>
                  {org.primaryPhone && <p className="text-xs text-muted-foreground">{org.primaryPhone}</p>}
                </div>
              </div>
              <div className="text-right">
                <p className="text-3xl font-black tracking-tight text-foreground">INVOICE</p>
                <p className="text-sm text-muted-foreground mt-0.5">#{invoice.invoice_number}</p>
                <Badge variant="outline" className={`mt-2 text-[11px] ${statusStyle}`}>
                  {invoice.status.toUpperCase()}
                </Badge>
              </div>
            </div>

            <Separator />

            {/* Bill to / project / dates */}
            <div className="grid grid-cols-3 gap-6">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">Bill To</p>
                <p className="font-semibold text-sm">{invoice.client?.full_name ?? "—"}</p>
                {invoice.client?.email && <p className="text-xs text-muted-foreground mt-0.5">{invoice.client.email}</p>}
                {invoice.client?.phone && <p className="text-xs text-muted-foreground">{invoice.client.phone}</p>}
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">Project</p>
                <p className="font-semibold text-sm">{invoice.project?.name ?? "—"}</p>
                {invoice.project?.address && <p className="text-xs text-muted-foreground mt-0.5">{invoice.project.address}</p>}
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">Dates</p>
                <p className="text-xs">Issued: <span className="font-semibold">{fmtDate(invoice.issue_date)}</span></p>
                <p className="text-xs mt-1">Due: <span className="font-semibold">{fmtDate(invoice.due_date)}</span></p>
              </div>
            </div>

            <Separator />

            {/* Line items */}
            <div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-secondary/60 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <th className="py-2.5 pl-3 pr-4 text-left rounded-l-lg">Description</th>
                    <th className="py-2.5 px-4 text-center w-16">Qty</th>
                    <th className="py-2.5 px-4 text-right w-28">Unit Price</th>
                    <th className="py-2.5 pl-4 pr-3 text-right w-28 rounded-r-lg">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr><td colSpan={4} className="py-6 text-center text-sm text-muted-foreground">No line items</td></tr>
                  ) : items.map(item => (
                    <tr key={item.id} className="border-b border-border last:border-0">
                      <td className="py-3 pl-3 pr-4">{item.description}</td>
                      <td className="py-3 px-4 text-center text-muted-foreground">{item.quantity}</td>
                      <td className="py-3 px-4 text-right text-muted-foreground tabular-nums">{fmt(item.unit_price)}</td>
                      <td className="py-3 pl-4 pr-3 text-right font-medium tabular-nums">{fmt(item.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="flex justify-end">
              <div className="w-56 space-y-1.5">
                {[
                  { label: "Subtotal", val: fmt(invoice.subtotal), cls: "text-muted-foreground text-sm" },
                  ...(invoice.tax_amount > 0 ? [{ label: "Tax", val: fmt(invoice.tax_amount), cls: "text-muted-foreground text-sm" }] : []),
                ].map(row => (
                  <div key={row.label} className="flex justify-between">
                    <span className={row.cls}>{row.label}</span>
                    <span className={`tabular-nums ${row.cls}`}>{row.val}</span>
                  </div>
                ))}
                <div className="flex justify-between border-t-2 border-foreground pt-2">
                  <span className="font-bold text-base">Total</span>
                  <span className="font-bold text-base tabular-nums">{fmt(invoice.total_amount)}</span>
                </div>
                {invoice.amount_paid > 0 && (
                  <>
                    <div className="flex justify-between text-green-600 text-sm">
                      <span>Paid</span>
                      <span className="tabular-nums">{fmt(invoice.amount_paid)}</span>
                    </div>
                    <div className="flex justify-between border-t border-border pt-1.5">
                      <span className={`font-semibold ${balance > 0 ? "text-amber-600" : "text-green-600"}`}>Balance Due</span>
                      <span className={`font-semibold tabular-nums ${balance > 0 ? "text-amber-600" : "text-green-600"}`}>{fmt(balance)}</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Notes */}
            {invoice.notes && (
              <>
                <Separator />
                <div className="rounded-lg bg-secondary/40 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5">Notes</p>
                  <p className="text-sm text-foreground whitespace-pre-wrap">{invoice.notes}</p>
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
