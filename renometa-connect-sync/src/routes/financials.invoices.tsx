//
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Search, Download, MoreHorizontal, Loader2, FileText, CheckCircle2, Clock, AlertCircle, DollarSign, Receipt } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/financials/invoices")({ component: InvoicesPage });

type Invoice = {
  id: string;
  invoice_number: string;
  status: string;
  issue_date: string;
  due_date: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  amount_paid: number;
  notes: string | null;
  project_id: string;
  project_name: string;
  client_id: string | null;
  client_name: string;
  created_at: string;
  updated_at: string;
};

const STATUS_STYLES: Record<string, string> = {
  draft:   "bg-muted text-muted-foreground border-border",
  sent:    "bg-sky-500/10 text-sky-600 border-sky-200",
  viewed:  "bg-violet-500/10 text-violet-600 border-violet-200",
  paid:    "bg-success/10 text-success border-success/20",
  overdue: "bg-destructive/10 text-destructive border-destructive/20",
  partial: "bg-warning/10 text-warning border-warning/20",
};

function formatMoney(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function fmtDate(s: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(s));
}

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return m?.org_id ?? null;
}

function InvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selected, setSelected] = useState<Invoice | null>(null);

  const load = useCallback(async () => {
    const orgId = await getOrgId();
    if (!orgId) { setLoading(false); return; }

    const { data, error } = await supabase
      .from("invoices")
      .select(`*, projects!project_id(name), contacts!client_id(full_name)`)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });

    if (error) { console.error("[invoices]", error); setLoading(false); return; }

    setInvoices((data ?? []).map((r: any) => ({
      id: r.id,
      invoice_number: r.invoice_number,
      status: r.status ?? "draft",
      issue_date: r.issue_date,
      due_date: r.due_date,
      subtotal: Number(r.subtotal ?? 0),
      tax_amount: Number(r.tax_amount ?? 0),
      total_amount: Number(r.total_amount ?? 0),
      amount_paid: Number(r.amount_paid ?? 0),
      notes: r.notes,
      project_id: r.project_id,
      project_name: r.projects?.name ?? "—",
      client_id: r.client_id,
      client_name: r.contacts?.full_name ?? "—",
      created_at: r.created_at,
      updated_at: r.updated_at,
    })));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return invoices.filter(inv => {
      if (statusFilter !== "all" && inv.status !== statusFilter) return false;
      if (!q) return true;
      return inv.invoice_number.toLowerCase().includes(q) || inv.client_name.toLowerCase().includes(q) || inv.project_name.toLowerCase().includes(q);
    });
  }, [invoices, search, statusFilter]);

  const stats = useMemo(() => ({
    total: invoices.reduce((s, i) => s + i.total_amount, 0),
    paid: invoices.filter(i => i.status === "paid").reduce((s, i) => s + i.total_amount, 0),
    outstanding: invoices.filter(i => !["paid","draft"].includes(i.status)).reduce((s, i) => s + (i.total_amount - i.amount_paid), 0),
    overdue: invoices.filter(i => i.status === "overdue").length,
  }), [invoices]);

  const handleMarkPaid = async (inv: Invoice) => {
    const { error } = await supabase.from("invoices").update({ status: "paid", amount_paid: inv.total_amount, updated_at: new Date().toISOString() }).eq("id", inv.id);
    if (error) { toast.error("Failed to update"); return; }
    toast.success(`Invoice ${inv.invoice_number} marked as paid`);
    load();
    if (selected?.id === inv.id) setSelected({ ...inv, status: "paid", amount_paid: inv.total_amount });
  };

  return (
    <>
      <PageHeader icon={Receipt} iconBg="bg-gold-soft" iconColor="text-gold-hover" title="Invoices" subtitle="Track billing across all projects." breadcrumb={["Financials", "Invoices"]}
        actions={<Button size="sm" onClick={() => toast.info("New invoice — coming soon")}><Download className="mr-1.5 h-3.5 w-3.5" /> Export</Button>}
      />

      {/* KPIs */}
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Total invoiced", value: formatMoney(stats.total), icon: FileText },
          { label: "Paid", value: formatMoney(stats.paid), icon: CheckCircle2, tone: "success" },
          { label: "Outstanding", value: formatMoney(stats.outstanding), icon: Clock, tone: "warning" },
          { label: "Overdue", value: stats.overdue, icon: AlertCircle, tone: "destructive" },
        ].map(k => (
          <Card key={k.label} className="p-3">
            <div className="flex items-start justify-between">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{k.label}</div>
              <k.icon className={cn("h-4 w-4", k.tone === "success" ? "text-success" : k.tone === "warning" ? "text-warning" : k.tone === "destructive" ? "text-destructive" : "text-muted-foreground")} />
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{k.value}</div>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <Card className="mb-3 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search invoices…" value={search} onChange={e => setSearch(e.target.value)} className="h-8 pl-8 text-sm" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {Object.keys(STATUS_STYLES).map(s => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="ml-auto text-xs text-muted-foreground">{filtered.length} invoice{filtered.length !== 1 ? "s" : ""}</span>
        </div>
      </Card>

      {/* Table */}
      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-secondary/60 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <tr className="border-b border-border">
              <th className="py-2.5 pl-4 pr-3 text-left">Invoice #</th>
              <th className="py-2.5 pr-4 text-left">Client</th>
              <th className="py-2.5 pr-4 text-left">Project</th>
              <th className="py-2.5 pr-4 text-left">Status</th>
              <th className="py-2.5 pr-4 text-left">Amount</th>
              <th className="py-2.5 pr-4 text-left">Due</th>
              <th className="w-10 py-2.5 pr-3" />
            </tr>
          </thead>
          <tbody>
            {loading && Array.from({ length: 5 }).map((_, i) => (
              <tr key={i} className="border-b border-border">{Array.from({length:6}).map((_,j)=><td key={j} className="py-3 pr-4"><Skeleton className="h-4 w-24" /></td>)}<td/></tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={7} className="py-12 text-center text-sm text-muted-foreground">No invoices found.</td></tr>
            )}
            {!loading && filtered.map(inv => (
              <tr key={inv.id} onClick={() => setSelected(inv)} className="cursor-pointer border-b border-border hover:bg-secondary/30">
                <td className="py-2.5 pl-4 pr-3 font-medium">{inv.invoice_number}</td>
                <td className="py-2.5 pr-4 text-muted-foreground">{inv.client_name}</td>
                <td className="py-2.5 pr-4 text-muted-foreground">{inv.project_name}</td>
                <td className="py-2.5 pr-4">
                  <Badge variant="secondary" className={cn("h-5 rounded border px-1.5 text-[10px] capitalize", STATUS_STYLES[inv.status] ?? STATUS_STYLES.draft)}>
                    {inv.status}
                  </Badge>
                </td>
                <td className="py-2.5 pr-4 tabular-nums">
                  <div className="font-medium">{formatMoney(inv.total_amount)}</div>
                  {inv.amount_paid > 0 && inv.amount_paid < inv.total_amount && (
                    <div className="text-[11px] text-muted-foreground">{formatMoney(inv.amount_paid)} paid</div>
                  )}
                </td>
                <td className="py-2.5 pr-4 text-[11px] text-muted-foreground">{inv.due_date ? fmtDate(inv.due_date) : "—"}</td>
                <td className="py-2.5 pr-3" onClick={e => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7"><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setSelected(inv)}>View</DropdownMenuItem>
                      {inv.status !== "paid" && <DropdownMenuItem onClick={() => handleMarkPaid(inv)}>Mark as Paid</DropdownMenuItem>}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Detail drawer */}
      <Sheet open={!!selected} onOpenChange={o => !o && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {selected && (
            <>
              <SheetHeader className="border-b border-border pb-4">
                <div className="flex items-start justify-between">
                  <div>
                    <SheetTitle className="text-base">{selected.invoice_number}</SheetTitle>
                    <SheetDescription className="text-xs">{selected.client_name} · {selected.project_name}</SheetDescription>
                  </div>
                  <Badge variant="secondary" className={cn("h-5 rounded border px-1.5 text-[10px] capitalize", STATUS_STYLES[selected.status] ?? STATUS_STYLES.draft)}>{selected.status}</Badge>
                </div>
              </SheetHeader>
              <div className="mt-4 space-y-4 text-sm">
                <div className="grid grid-cols-2 gap-3">
                  <FactBox label="Subtotal" value={formatMoney(selected.subtotal)} />
                  <FactBox label="Tax" value={formatMoney(selected.tax_amount)} />
                  <FactBox label="Total" value={formatMoney(selected.total_amount)} highlight />
                  <FactBox label="Paid" value={formatMoney(selected.amount_paid)} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <FactBox label="Issued" value={selected.issue_date ? fmtDate(selected.issue_date) : "—"} />
                  <FactBox label="Due" value={selected.due_date ? fmtDate(selected.due_date) : "—"} />
                </div>
                {selected.notes && (
                  <div><div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Notes</div>
                    <p className="text-xs text-muted-foreground">{selected.notes}</p>
                  </div>
                )}
                {selected.status !== "paid" && (
                  <Button className="w-full" onClick={() => handleMarkPaid(selected)}>
                    <CheckCircle2 className="mr-1.5 h-4 w-4" /> Mark as Paid
                  </Button>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function FactBox({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-secondary/40 p-2.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-sm font-semibold tabular-nums", highlight && "text-base text-primary")}>{value}</div>
    </div>
  );
}