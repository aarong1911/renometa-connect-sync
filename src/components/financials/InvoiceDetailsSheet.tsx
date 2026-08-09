import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { InvoiceStatusBadge } from "@/components/financials/InvoiceStatusBadge";
import { RecordPaymentDialog } from "@/components/financials/RecordPaymentDialog";
import { PaymentHistory } from "@/components/financials/PaymentHistory";
import { supabase } from "@/lib/supabase";
import { isIssuedInvoice, getInvoiceBalance } from "@/lib/invoice-status";
import { formatDateOnly } from "@/lib/format";
import { ProjectDetailSheet } from "@/routes/projects.index";
import { ContactDrawer, type CompanyOption } from "@/routes/contacts";
import { mapProjectRow, type Project as StoreProject } from "@/lib/projects-store";
import { useCompanies } from "@/lib/companies-store";
import { deleteContact } from "@/lib/contacts-store";
import type { Contact } from "@/lib/mock-data";
import { tagColorClasses } from "@/lib/tag-utils";
import { CalendarDays, ChevronRight, CircleDollarSign, FolderKanban, Loader2, Mail, Phone, Printer, ReceiptText, UserRound } from "lucide-react";

interface Props {
  invoiceId: string | null;
  open: boolean;
  onClose: () => void;
  /** Called after a Record Payment succeeds so the caller (main Financials) can patch its invoice list/KPIs immediately — same contract as InvoiceDetailModal's onUpdated. */
  onUpdated?: (patch: { id: string; status?: string; amountPaid?: number }) => void;
}
interface Item { id: string; description: string; quantity: number; unit_price: number; amount: number; }
interface Detail {
  id: string; invoice_number: string; status: string; issue_date: string | null; due_date: string | null;
  subtotal: number; tax_amount: number; total_amount: number; amount_paid: number; notes: string | null;
  client_id: string | null; project_id: string | null;
  client?: { full_name: string; email: string | null; phone: string | null; avatar_key?: string | null };
  project?: { name: string; address: string | null };
}
const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
// issue_date/due_date are DATE-ONLY SQL columns — see src/lib/format.ts's
// formatDateOnly for why this must not go through `new Date(v).toLocaleDateString()`.
const date = (v: string | null) => formatDateOnly(v, "—");

export function InvoiceDetailsSheet({ invoiceId, open, onClose, onUpdated }: Props) {
  const navigate = useNavigate();
  const companies: CompanyOption[] = useCompanies().map((c) => ({ id: c.id, name: c.name, slug: c.slug }));
  const [invoice, setInvoice] = useState<Detail | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const [paymentHistoryKey, setPaymentHistoryKey] = useState(0);

  // Contextual linked-record drawers (Part 13-18) — layered directly over
  // this same Sheet (Sheet-over-Sheet: Radix stacks the newest Portal on
  // top and dismisses independently), same principle already used for
  // ProjectDetailSheet-over-Deal-drawer (deal-detail-drawer.tsx). Fetched
  // via the invoice's own explicit project_id/client_id — never matched by
  // name/email/phone.
  const [linkedProject, setLinkedProject] = useState<StoreProject | null>(null);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  const [loadingProject, setLoadingProject] = useState(false);
  const [linkedContact, setLinkedContact] = useState<Contact | null>(null);
  const [contactDrawerContact, setContactDrawerContact] = useState<Contact | null>(null);
  const [loadingContact, setLoadingContact] = useState(false);

  useEffect(() => {
    if (!open || !invoiceId) return;
    setLoading(true);
    Promise.all([
      supabase.from("invoices").select(`id, invoice_number, status, issue_date, due_date, subtotal, tax_amount, total_amount, amount_paid, notes, client_id, project_id, projects!project_id(name,address), contacts!client_id(full_name,email,phone,avatar_key)`).eq("id", invoiceId).maybeSingle(),
      supabase.from("invoice_items").select("id,description,quantity,unit_price,amount").eq("invoice_id", invoiceId).order("id"),
    ]).then(([invoiceResult, itemsResult]) => {
      const row: any = invoiceResult.data;
      setInvoice(row ? { ...row, client: row.contacts ?? undefined, project: row.projects ?? undefined } : null);
      setItems((itemsResult.data ?? []) as Item[]);
      setLoading(false);
    });
  }, [invoiceId, open]);

  const openLinkedProject = async () => {
    if (!invoice?.project_id) return;
    setLoadingProject(true);
    try {
      const { data, error } = await supabase
        .from("projects")
        .select("*, contacts!client_id(full_name), owner_profile:profiles!owner_id(first_name,last_name,email)")
        .eq("id", invoice.project_id)
        .maybeSingle();
      if (error) throw error;
      if (!data) { toast.error("Could not load this Project"); return; }
      setLinkedProject(mapProjectRow(data));
      setProjectDrawerOpen(true);
    } catch {
      toast.error("Could not load this Project");
    } finally {
      setLoadingProject(false);
    }
  };

  const openLinkedContact = async () => {
    if (!invoice?.client_id) return;
    setLoadingContact(true);
    try {
      const { data, error } = await supabase.from("contacts").select("*").eq("id", invoice.client_id).maybeSingle();
      if (error) throw error;
      if (!data) { toast.error("Could not load this customer"); return; }
      const contact = mapContactRowLocal(data);
      setLinkedContact(contact);
      setContactDrawerContact(contact);
    } catch {
      toast.error("Could not load this customer");
    } finally {
      setLoadingContact(false);
    }
  };

  // Part 23 — the reusable ContactDrawer has no onSaved/onUpdated callback
  // of its own, so a lightweight re-fetch on close is how the Customer card
  // avoids staying stale after an edit, without depending on ContactDrawer
  // internals or duplicating its save logic.
  const handleContactDrawerOpenChange = (isOpen: boolean) => {
    if (isOpen) return;
    setContactDrawerContact(null);
    if (linkedContact) {
      supabase.from("contacts").select("*").eq("id", linkedContact.id).maybeSingle().then(({ data }) => {
        if (data) setLinkedContact(mapContactRowLocal(data));
      });
    }
  };

  const handleRecordPaymentResult = (result: { status: string; amountPaid: number }) => {
    if (!invoice) return;
    setInvoice((prev) => prev ? { ...prev, status: result.status, amount_paid: result.amountPaid } : prev);
    onUpdated?.({ id: invoice.id, status: result.status, amountPaid: result.amountPaid });
    setPaymentHistoryKey((k) => k + 1);
  };

  const balance = invoice ? getInvoiceBalance(invoice.total_amount, invoice.amount_paid) : 0;
  const canRecordPayment = Boolean(invoice) && isIssuedInvoice(invoice?.status) && invoice?.status !== "paid" && balance > 0;

  return (
    <Sheet open={open} onOpenChange={(value) => !value && onClose()}>
      <SheetContent showCloseButton={false} className="w-full overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-6 py-5 text-left">
          <div className="flex items-start justify-between gap-4">
            <div>
              <SheetTitle className="flex items-center gap-2 text-lg"><ReceiptText className="h-5 w-5" /> Invoice {invoice?.invoice_number ?? ""}</SheetTitle>
              <SheetDescription>Invoice, customer, project, and payment details.</SheetDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {canRecordPayment && (
                <Button size="sm" onClick={() => setRecordPaymentOpen(true)}>
                  <CircleDollarSign className="mr-1.5 h-4 w-4" />Record Payment
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!invoice}><Printer className="mr-1.5 h-4 w-4" />Print</Button>
            </div>
          </div>
        </SheetHeader>
        {loading ? <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div> : !invoice ? <div className="py-20 text-center text-sm text-muted-foreground">Invoice not found.</div> : (
          <div className="space-y-6 px-6 py-6">
            <div className="flex items-center justify-between rounded-xl border bg-card p-4">
              <div><p className="text-xs uppercase tracking-wider text-muted-foreground">Total</p><p className="mt-1 text-2xl font-semibold tabular-nums">{money(invoice.total_amount)}</p></div>
              <InvoiceStatusBadge status={invoice.status} dueDate={invoice.due_date} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <LinkedRecordCard
                icon={UserRound}
                label="Customer"
                interactive={Boolean(invoice.client_id)}
                loading={loadingContact}
                onClick={openLinkedContact}
              >
                <div className="flex items-center gap-3">
                  <ContactAvatar id={invoice.client_id} name={invoice.client?.full_name ?? "Unknown customer"} avatarKey={invoice.client?.avatar_key} size="md" />
                  <div>
                    <p className="font-semibold">{invoice.client?.full_name ?? "No customer assigned"}</p>
                    {invoice.client?.email && <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><Mail className="h-3.5 w-3.5" />{invoice.client.email}</p>}
                    {invoice.client?.phone && <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><Phone className="h-3.5 w-3.5" />{invoice.client.phone}</p>}
                  </div>
                </div>
              </LinkedRecordCard>
              <LinkedRecordCard
                icon={FolderKanban}
                label="Project"
                interactive={Boolean(invoice.project_id)}
                loading={loadingProject}
                onClick={openLinkedProject}
              >
                <p className="font-semibold">{invoice.project?.name ?? "No project assigned"}</p>
                {invoice.project?.address && <p className="mt-1 text-xs text-muted-foreground">{invoice.project.address}</p>}
              </LinkedRecordCard>
            </div>
            <section className="rounded-xl border p-4"><p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><CalendarDays className="h-4 w-4" />Dates</p><div className="grid grid-cols-2 gap-4 text-sm"><div><p className="text-muted-foreground">Issued</p><p className="mt-1 font-medium">{date(invoice.issue_date)}</p></div><div><p className="text-muted-foreground">Due</p><p className="mt-1 font-medium">{date(invoice.due_date)}</p></div></div></section>
            <section><p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Line items</p><div className="overflow-hidden rounded-xl border"><div className="grid grid-cols-[1fr_52px_100px] bg-secondary/50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><span>Description</span><span className="text-center">Qty</span><span className="text-right">Amount</span></div>{items.length ? items.map(item => <div key={item.id} className="grid grid-cols-[1fr_52px_100px] border-t px-4 py-3 text-sm"><span>{item.description}</span><span className="text-center text-muted-foreground">{item.quantity}</span><span className="text-right font-medium tabular-nums">{money(item.amount)}</span></div>) : <div className="border-t px-4 py-6 text-center text-sm text-muted-foreground">No line items.</div>}</div></section>
            <div className="ml-auto w-full max-w-xs space-y-2 text-sm"><div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span>{money(invoice.subtotal)}</span></div>{invoice.tax_amount > 0 && <div className="flex justify-between text-muted-foreground"><span>Tax</span><span>{money(invoice.tax_amount)}</span></div>}<Separator /><div className="flex justify-between font-semibold"><span>Total</span><span>{money(invoice.total_amount)}</span></div><div className="flex justify-between text-success"><span>Paid</span><span>{money(invoice.amount_paid)}</span></div><div className="flex justify-between text-base font-semibold"><span>Balance due</span><span>{money(balance)}</span></div></div>
            <PaymentHistory invoiceId={invoice.id} refreshKey={paymentHistoryKey} />
            {invoice.notes && <section className="rounded-xl bg-secondary/50 p-4"><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Notes</p><p className="mt-2 whitespace-pre-wrap text-sm">{invoice.notes}</p></section>}
          </div>
        )}
      </SheetContent>

      {invoice && (
        <RecordPaymentDialog
          open={recordPaymentOpen}
          onClose={() => setRecordPaymentOpen(false)}
          invoiceId={invoice.id}
          invoiceNumber={invoice.invoice_number}
          balance={balance}
          onRecorded={handleRecordPaymentResult}
        />
      )}

      {/* Contextual linked-record drawers — layered above this Sheet, not
          navigation. Reuse the exact ProjectDetailSheet/ContactDrawer used
          by Projects/Pipeline/Calendar/Deals — no duplicate detail UI. */}
      <ProjectDetailSheet
        project={linkedProject}
        open={projectDrawerOpen}
        onClose={() => setProjectDrawerOpen(false)}
        onReload={() => void openLinkedProject()}
        onProjectUpdated={setLinkedProject}
      />
      <ContactDrawer
        contact={contactDrawerContact}
        companies={companies}
        tagOptions={[]}
        colorForTag={tagColorClasses}
        onOpenChange={handleContactDrawerOpenChange}
        onDelete={(c) => {
          if (!window.confirm(`Delete ${c.name}? This can't be undone.`)) return;
          void deleteContact(c.id).then(() => {
            toast.success("Contact deleted");
            setContactDrawerContact(null);
            setLinkedContact(null);
          });
        }}
        onNewDeal={() => navigate({
          to: "/pipeline",
          search: {
            addDeal: "1",
            pName: linkedContact?.name ?? "",
            pEmail: linkedContact?.email ?? "",
            pPhone: linkedContact?.phone ?? "",
            pAddress: linkedContact?.address ?? "",
          },
        } as any)}
      />
    </Sheet>
  );
}

function mapContactRowLocal(row: any): Contact {
  return {
    id: row.id,
    name: row.full_name ?? "Unknown",
    email: row.email ?? "",
    phone: row.phone ?? "",
    address: row.address ?? "",
    company: row.company ?? "",
    company_id: row.company_id ?? null,
    companyName: null,
    source: row.source ?? "",
    tags: row.labels ?? [],
    owner: row.owner ?? "—",
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    createdAt: row.created_at ?? new Date().toISOString(),
    avatar_key: row.avatar_key ?? null,
    avatar_url: row.avatar_url ?? null,
  };
}

/** Card becomes clickable only when the invoice has an explicit linked record — never a giant button, just a subtle hover affordance + chevron. */
function LinkedRecordCard({ icon: Icon, label, interactive, loading, onClick, children }: {
  icon: React.ComponentType<{ className?: string }>; label: string; interactive: boolean; loading: boolean;
  onClick: () => void; children: React.ReactNode;
}) {
  const content = (
    <>
      <p className="mb-3 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="flex items-center gap-2"><Icon className="h-4 w-4" />{label}</span>
        {interactive && (loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronRight className="h-3.5 w-3.5" />)}
      </p>
      {children}
    </>
  );
  if (!interactive) {
    return <section className="rounded-xl border p-4">{content}</section>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="rounded-xl border p-4 text-left transition-colors hover:border-primary/40 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait"
    >
      {content}
    </button>
  );
}
