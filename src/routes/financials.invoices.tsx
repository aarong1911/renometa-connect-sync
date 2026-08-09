// src/routes/financials.invoices.tsx — Phase 13.5: real Invoices tab
// (previously a redirect back to /financials). Search/filter/table extracted
// from the old single-page Financials dashboard; KPIs/chart/aging now live
// on Overview (/financials) instead.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Search, SlidersHorizontal, CalendarDays, ArrowUpDown, Users } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InvoiceDetailsSheet } from "@/components/financials/InvoiceDetailsSheet";
import { InvoiceStatusBadge } from "@/components/financials/InvoiceStatusBadge";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { cn } from "@/lib/utils";
import { formatMoney, formatDateOnlyShort } from "@/lib/format";
import {
  fetchFinancialsOrgId, fetchFinancialInvoices, isInvoiceOverdue, invoiceBalance,
  type FinancialInvoice,
} from "@/lib/financials";

export const Route = createFileRoute("/financials/invoices")({ component: FinancialsInvoicesPage });

function FinancialsInvoicesPage() {
  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<FinancialInvoice[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [customerFilter, setCustomerFilter] = useState("all");
  const [dueFilter, setDueFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);

  const loadInvoices = async () => {
    setLoading(true);
    const orgId = await fetchFinancialsOrgId();
    if (!orgId) { setInvoices([]); setLoading(false); return; }
    setInvoices(await fetchFinancialInvoices(orgId));
    setLoading(false);
  };

  useEffect(() => { void loadInvoices(); }, []);

  const now = useMemo(() => new Date(), []);
  const customers = useMemo(() => Array.from(new Map(invoices.filter(i => i.clientId).map(i => [i.clientId!, i.clientName])).entries()), [invoices]);
  const filteredInvoices = useMemo(() => {
    const query = search.trim().toLowerCase();
    return invoices
      .filter((invoice) => !query || invoice.invoiceNumber.toLowerCase().includes(query) || invoice.clientName.toLowerCase().includes(query) || invoice.projectName.toLowerCase().includes(query) || invoice.status.toLowerCase().includes(query) || String(invoice.totalAmount).includes(query))
      .filter((invoice) => statusFilter === "all" || (statusFilter === "overdue" ? isInvoiceOverdue(invoice, now) : invoice.status === statusFilter))
      .filter((invoice) => customerFilter === "all" || invoice.clientId === customerFilter)
      .filter((invoice) => dueFilter === "all" || (dueFilter === "overdue" ? isInvoiceOverdue(invoice, now) : dueFilter === "next30" ? (invoice.dueDate && new Date(invoice.dueDate) >= now && new Date(invoice.dueDate) <= new Date(now.getTime() + 30 * 86400000)) : true))
      .sort((a, b) => sortOrder === "newest" ? +new Date(b.createdAt) - +new Date(a.createdAt) : +new Date(a.createdAt) - +new Date(b.createdAt));
  }, [invoices, search, statusFilter, customerFilter, dueFilter, sortOrder, now]);

  return (
    <div className="space-y-4">
      <Card className="p-2">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search invoices by number, customer, project, amount…" value={search} onChange={(event) => setSearch(event.target.value)} className="h-10 border-0 bg-secondary/50 pl-9 shadow-none focus-visible:ring-1" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger className="h-10 w-[126px]"><SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" /><SelectValue placeholder="Status" /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem><SelectItem value="draft">Draft</SelectItem><SelectItem value="sent">Sent</SelectItem><SelectItem value="viewed">Viewed</SelectItem><SelectItem value="partial">Partial</SelectItem><SelectItem value="paid">Paid</SelectItem><SelectItem value="overdue">Overdue</SelectItem></SelectContent></Select>
            <Select value={customerFilter} onValueChange={setCustomerFilter}><SelectTrigger className="h-10 w-[140px]"><Users className="mr-1.5 h-3.5 w-3.5" /><SelectValue placeholder="Customer" /></SelectTrigger><SelectContent><SelectItem value="all">All customers</SelectItem>{customers.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent></Select>
            <Select value={dueFilter} onValueChange={setDueFilter}><SelectTrigger className="h-10 w-[126px]"><CalendarDays className="mr-1.5 h-3.5 w-3.5" /><SelectValue placeholder="Due date" /></SelectTrigger><SelectContent><SelectItem value="all">Any due date</SelectItem><SelectItem value="overdue">Overdue</SelectItem><SelectItem value="next30">Next 30 days</SelectItem></SelectContent></Select>
            <Button variant="outline" className="h-10" onClick={() => setSortOrder(v => v === "newest" ? "oldest" : "newest")}><ArrowUpDown className="mr-1.5 h-3.5 w-3.5" />{sortOrder === "newest" ? "Newest" : "Oldest"}</Button>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="grid grid-cols-[110px_minmax(160px,1.5fr)_100px_100px_90px_90px] gap-4 border-b border-border bg-secondary/40 px-5 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          <div>Invoice</div><div>Customer / Project</div><div>Status</div><div className="text-right">Amount</div><div className="text-right">Balance</div><div>Due</div>
        </div>
        {loading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
        ) : filteredInvoices.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">{search ? "No invoices match your search." : "No invoices yet."}</div>
        ) : (
          <ul className="divide-y divide-border">
            {filteredInvoices.map((inv) => {
              const overdue = isInvoiceOverdue(inv, now);
              const balance = invoiceBalance(inv);
              return (
                <li key={inv.id} onClick={() => setSelectedInvoiceId(inv.id)} role="button" tabIndex={0}
                  className="grid cursor-pointer grid-cols-[110px_minmax(160px,1.5fr)_100px_100px_90px_90px] items-center gap-4 px-5 py-3 transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  <div className="text-[12.5px] font-semibold tabular-nums">{inv.invoiceNumber}</div>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <ContactAvatar id={inv.clientId} name={inv.clientName === "—" ? "Unassigned" : inv.clientName} avatarKey={inv.clientAvatarKey} size="sm" className="h-7 w-7" />
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium leading-tight">{inv.clientName}</p>
                      {inv.projectName !== "—" && <p className="truncate text-[11px] leading-tight text-muted-foreground">{inv.projectName}</p>}
                    </div>
                  </div>
                  <InvoiceStatusBadge status={inv.status} dueDate={inv.dueDate} />
                  <div className="text-right text-[13.5px] font-semibold tabular-nums">{formatMoney(inv.totalAmount)}</div>
                  <div className={cn("text-right text-[12.5px] tabular-nums", balance > 0 ? "font-medium text-foreground" : "text-muted-foreground")}>
                    {inv.status === "draft" ? "—" : formatMoney(balance)}
                  </div>
                  <div className={cn("text-[12px] tabular-nums", overdue ? "font-medium text-destructive" : "text-muted-foreground")}>
                    {inv.dueDate ? formatDateOnlyShort(inv.dueDate) : "—"}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <InvoiceDetailsSheet
        invoiceId={selectedInvoiceId}
        open={Boolean(selectedInvoiceId)}
        onClose={() => setSelectedInvoiceId(null)}
        onUpdated={(patch) => {
          setInvoices((prev) => prev.map((i) => i.id === patch.id ? { ...i, ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.amountPaid !== undefined ? { amountPaid: patch.amountPaid } : {}) } : i));
        }}
      />
    </div>
  );
}
