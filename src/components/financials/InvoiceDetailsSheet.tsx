import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { supabase } from "@/lib/supabase";
import { CalendarDays, FolderKanban, Loader2, Mail, Phone, Printer, ReceiptText, UserRound } from "lucide-react";

interface Props { invoiceId: string | null; open: boolean; onClose: () => void; }
interface Item { id: string; description: string; quantity: number; unit_price: number; amount: number; }
interface Detail {
  id: string; invoice_number: string; status: string; issue_date: string | null; due_date: string | null;
  subtotal: number; tax_amount: number; total_amount: number; amount_paid: number; notes: string | null;
  client_id: string | null; client?: { full_name: string; email: string | null; phone: string | null; avatar_key?: string | null };
  project?: { name: string; address: string | null };
}
const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
const date = (v: string | null) => v ? new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

export function InvoiceDetailsSheet({ invoiceId, open, onClose }: Props) {
  const [invoice, setInvoice] = useState<Detail | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !invoiceId) return;
    setLoading(true);
    Promise.all([
      supabase.from("invoices").select(`id, invoice_number, status, issue_date, due_date, subtotal, tax_amount, total_amount, amount_paid, notes, client_id, projects!project_id(name,address), contacts!client_id(full_name,email,phone,avatar_key)`).eq("id", invoiceId).maybeSingle(),
      supabase.from("invoice_items").select("id,description,quantity,unit_price,amount").eq("invoice_id", invoiceId).order("id"),
    ]).then(([invoiceResult, itemsResult]) => {
      const row: any = invoiceResult.data;
      setInvoice(row ? { ...row, client: row.contacts ?? undefined, project: row.projects ?? undefined } : null);
      setItems((itemsResult.data ?? []) as Item[]);
      setLoading(false);
    });
  }, [invoiceId, open]);

  const balance = invoice ? invoice.total_amount - invoice.amount_paid : 0;
  return (
    <Sheet open={open} onOpenChange={(value) => !value && onClose()}>
      <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-6 py-5 text-left">
          <div className="flex items-start justify-between gap-4 pr-8">
            <div>
              <SheetTitle className="flex items-center gap-2 text-lg"><ReceiptText className="h-5 w-5" /> Invoice {invoice?.invoice_number ?? ""}</SheetTitle>
              <SheetDescription>Invoice, customer, project, and payment details.</SheetDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!invoice}><Printer className="mr-1.5 h-4 w-4" />Print</Button>
          </div>
        </SheetHeader>
        {loading ? <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div> : !invoice ? <div className="py-20 text-center text-sm text-muted-foreground">Invoice not found.</div> : (
          <div className="space-y-6 px-6 py-6">
            <div className="flex items-center justify-between rounded-xl border bg-card p-4">
              <div><p className="text-xs uppercase tracking-wider text-muted-foreground">Total</p><p className="mt-1 text-2xl font-semibold tabular-nums">{money(invoice.total_amount)}</p></div>
              <Badge variant="outline" className="capitalize">{invoice.status}</Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <section className="rounded-xl border p-4">
                <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><UserRound className="h-4 w-4" />Customer</p>
                <div className="flex items-center gap-3"><ContactAvatar id={invoice.client_id} name={invoice.client?.full_name ?? "Unknown customer"} avatarKey={invoice.client?.avatar_key} size="md" /><div><p className="font-semibold">{invoice.client?.full_name ?? "No customer assigned"}</p>{invoice.client?.email && <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><Mail className="h-3.5 w-3.5" />{invoice.client.email}</p>}{invoice.client?.phone && <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><Phone className="h-3.5 w-3.5" />{invoice.client.phone}</p>}</div></div>
              </section>
              <section className="rounded-xl border p-4"><p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><FolderKanban className="h-4 w-4" />Project</p><p className="font-semibold">{invoice.project?.name ?? "No project assigned"}</p>{invoice.project?.address && <p className="mt-1 text-xs text-muted-foreground">{invoice.project.address}</p>}</section>
            </div>
            <section className="rounded-xl border p-4"><p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><CalendarDays className="h-4 w-4" />Dates</p><div className="grid grid-cols-2 gap-4 text-sm"><div><p className="text-muted-foreground">Issued</p><p className="mt-1 font-medium">{date(invoice.issue_date)}</p></div><div><p className="text-muted-foreground">Due</p><p className="mt-1 font-medium">{date(invoice.due_date)}</p></div></div></section>
            <section><p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Line items</p><div className="overflow-hidden rounded-xl border"><div className="grid grid-cols-[1fr_52px_100px] bg-secondary/50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><span>Description</span><span className="text-center">Qty</span><span className="text-right">Amount</span></div>{items.length ? items.map(item => <div key={item.id} className="grid grid-cols-[1fr_52px_100px] border-t px-4 py-3 text-sm"><span>{item.description}</span><span className="text-center text-muted-foreground">{item.quantity}</span><span className="text-right font-medium tabular-nums">{money(item.amount)}</span></div>) : <div className="border-t px-4 py-6 text-center text-sm text-muted-foreground">No line items.</div>}</div></section>
            <div className="ml-auto w-full max-w-xs space-y-2 text-sm"><div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span>{money(invoice.subtotal)}</span></div>{invoice.tax_amount > 0 && <div className="flex justify-between text-muted-foreground"><span>Tax</span><span>{money(invoice.tax_amount)}</span></div>}<Separator /><div className="flex justify-between font-semibold"><span>Total</span><span>{money(invoice.total_amount)}</span></div><div className="flex justify-between text-success"><span>Paid</span><span>{money(invoice.amount_paid)}</span></div><div className="flex justify-between text-base font-semibold"><span>Balance due</span><span>{money(balance)}</span></div></div>
            {invoice.notes && <section className="rounded-xl bg-secondary/50 p-4"><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Notes</p><p className="mt-2 whitespace-pre-wrap text-sm">{invoice.notes}</p></section>}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
