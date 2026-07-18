import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/app-shell";
import {
  FileText, Receipt, DollarSign,
  AlertCircle, CheckCircle2, XCircle, TrendingUp, Search, Plus, SlidersHorizontal, CalendarDays, ArrowUpDown, Users,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InvoiceModal } from "@/components/projects/InvoiceModal";
import { InvoiceDetailsSheet } from "@/components/financials/InvoiceDetailsSheet";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { AreaChart, Area, ResponsiveContainer, XAxis, Tooltip } from "recharts";

export const Route = createFileRoute("/financials")({
  component: FinancialsLayout,
});

function FinancialsLayout() {
  const { pathname } = useLocation();
  const isRoot = pathname === "/financials" || pathname === "/financials/";
  return isRoot ? <FinancialsDashboard /> : <Outlet />;
}

type Invoice = {
  id: string;
  invoice_number: string;
  status: string;
  issue_date: string;
  due_date: string;
  total_amount: number;
  amount_paid: number;
  client_id: string | null;
  client_name: string;
  client_avatar_key: string | null;
  project_id: string | null;
  project_name: string;
  created_at: string;
};

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return m?.org_id ?? null;
}

const STATUS_STYLE: Record<string, { chip: string; icon: React.ComponentType<{ className?: string }>; label: string }> = {
  paid:        { chip: "text-success-soft-foreground bg-success-soft ring-success-soft",       icon: CheckCircle2, label: "Paid" },
  sent:        { chip: "text-info-soft-foreground bg-info-soft ring-info-soft",                 icon: Receipt,      label: "Sent" },
  viewed:      { chip: "text-info-soft-foreground bg-info-soft ring-info-soft",                 icon: Receipt,      label: "Viewed" },
  overdue:     { chip: "text-destructive-soft-foreground bg-destructive-soft ring-destructive-soft", icon: AlertCircle, label: "Overdue" },
  draft:       { chip: "text-muted-foreground bg-secondary ring-border",                        icon: FileText,     label: "Draft" },
};

function FinancialsDashboard() {
  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [range, setRange] = useState<"30d" | "90d" | "12m">("12m");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [customerFilter, setCustomerFilter] = useState("all");
  const [dueFilter, setDueFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [orgId, setOrgId] = useState<string | null>(null);

  const loadInvoices = async () => {
    setLoading(true);
    const resolvedOrgId = await getOrgId();
    setOrgId(resolvedOrgId);
    if (!resolvedOrgId) { setInvoices([]); setLoading(false); return; }
    const { data } = await supabase
      .from("invoices")
      .select("id, invoice_number, status, issue_date, due_date, total_amount, amount_paid, client_id, project_id, contacts!client_id(full_name,avatar_key), projects!project_id(name), created_at")
      .eq("org_id", resolvedOrgId)
      .order("created_at", { ascending: false });
    setInvoices((data ?? []).map((r: any) => ({
      id: r.id, invoice_number: r.invoice_number, status: r.status,
      issue_date: r.issue_date, due_date: r.due_date, total_amount: Number(r.total_amount ?? 0),
      amount_paid: Number(r.amount_paid ?? 0), client_id: r.client_id, project_id: r.project_id,
      client_name: r.contacts?.full_name ?? "—", client_avatar_key: r.contacts?.avatar_key ?? null,
      project_name: r.projects?.name ?? "—", created_at: r.created_at,
    })));
    setLoading(false);
  };

  useEffect(() => { void loadInvoices(); }, []);

  const now = new Date();
  const isOverdue = (inv: Invoice) => inv.status !== "paid" && new Date(inv.due_date) < now;

  const stats = useMemo(() => {
    const outstanding = invoices.filter(i => i.status !== "paid").reduce((s, i) => s + (i.total_amount - i.amount_paid), 0);
    const overdue = invoices.filter(isOverdue).reduce((s, i) => s + (i.total_amount - i.amount_paid), 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const paidThisMonth = invoices.filter(i => i.status === "paid" && new Date(i.created_at) >= monthStart).reduce((s, i) => s + i.amount_paid, 0);
    const totalRevenue = invoices.filter(i => i.status === "paid").reduce((s, i) => s + i.amount_paid, 0);
    return { outstanding, overdue, paidThisMonth, totalRevenue };
  }, [invoices]);

  const trend = useMemo(() => {
    const months = range === "30d" ? 1 : range === "90d" ? 3 : 12;
    const buckets = new Map<string, number>();
    const labels: string[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toLocaleDateString("en-US", { month: "short" });
      labels.push(key);
      buckets.set(key, 0);
    }
    for (const inv of invoices) {
      if (inv.status !== "paid") continue;
      const d = new Date(inv.created_at);
      const key = d.toLocaleDateString("en-US", { month: "short" });
      if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + inv.amount_paid);
    }
    return labels.map(m => ({ m, paid: Math.round((buckets.get(m) ?? 0) / 1000) }));
  }, [invoices, range]);

  const thisMonthLabel = now.toLocaleDateString("en-US", { month: "long" });
  const thisMonthVal = trend[trend.length - 1]?.paid ?? 0;
  const lastMonthVal = trend[trend.length - 2]?.paid ?? 0;
  const momPct = lastMonthVal > 0 ? Math.round(((thisMonthVal - lastMonthVal) / lastMonthVal) * 100) : 0;

  const collectionRate = stats.totalRevenue + stats.outstanding > 0
    ? Math.round((stats.totalRevenue / (stats.totalRevenue + stats.outstanding)) * 100)
    : 0;

  const paidPortion = Math.max(2, Math.round((stats.totalRevenue / Math.max(1, stats.totalRevenue + stats.outstanding)) * 100));
  const overduePortion = Math.max(stats.overdue > 0 ? 2 : 0, Math.round((stats.overdue / Math.max(1, stats.totalRevenue + stats.outstanding)) * 100));
  const outstandingPortion = Math.max(0, 100 - paidPortion - overduePortion);

  const customers = useMemo(() => Array.from(new Map(invoices.filter(i => i.client_id).map(i => [i.client_id!, i.client_name])).entries()), [invoices]);
  const filteredInvoices = useMemo(() => {
    const query = search.trim().toLowerCase();
    return invoices
      .filter((invoice) => !query || invoice.invoice_number.toLowerCase().includes(query) || invoice.client_name.toLowerCase().includes(query) || invoice.project_name.toLowerCase().includes(query) || invoice.status.toLowerCase().includes(query) || String(invoice.total_amount).includes(query))
      .filter((invoice) => statusFilter === "all" || (statusFilter === "overdue" ? isOverdue(invoice) : invoice.status === statusFilter))
      .filter((invoice) => customerFilter === "all" || invoice.client_id === customerFilter)
      .filter((invoice) => dueFilter === "all" || (dueFilter === "overdue" ? isOverdue(invoice) : dueFilter === "next30" ? new Date(invoice.due_date) >= now && new Date(invoice.due_date) <= new Date(now.getTime() + 30 * 86400000) : true))
      .sort((a, b) => sortOrder === "newest" ? +new Date(b.created_at) - +new Date(a.created_at) : +new Date(a.created_at) - +new Date(b.created_at));
  }, [invoices, search, statusFilter, customerFilter, dueFilter, sortOrder]);

  return (
    <div className="space-y-5">
      <PageHeader
        icon={DollarSign}
        iconBg="bg-success-soft"
        iconColor="text-success"
        title="Financials"
        subtitle="Invoices, payments, and cash flow across your business."
        breadcrumb={["Financials"]}
        actions={<Button onClick={() => setCreateOpen(true)}><Plus className="mr-1.5 h-4 w-4" />Create Invoice</Button>}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-warning-soft text-warning-soft-foreground"><AlertCircle className="h-3.5 w-3.5" /></span>
            <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Outstanding</p>
          </div>
          <p className="mt-2 text-xl font-semibold tabular-nums">${(stats.outstanding / 1000).toFixed(1)}k</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-success-soft text-success"><CheckCircle2 className="h-3.5 w-3.5" /></span>
            <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Paid This Month</p>
          </div>
          <p className="mt-2 text-xl font-semibold tabular-nums">${(stats.paidThisMonth / 1000).toFixed(1)}k</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-destructive-soft text-destructive"><XCircle className="h-3.5 w-3.5" /></span>
            <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Overdue</p>
          </div>
          <p className="mt-2 text-xl font-semibold tabular-nums">${(stats.overdue / 1000).toFixed(1)}k</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-info-soft text-info"><TrendingUp className="h-3.5 w-3.5" /></span>
            <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Total Revenue</p>
          </div>
          <p className="mt-2 text-xl font-semibold tabular-nums">${(stats.totalRevenue / 1000).toFixed(1)}k</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card className="p-4">
          <div className="flex items-baseline justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-success" />
              <span className="text-sm font-semibold">Revenue Trend</span>
            </div>
            <div className="flex gap-1">
              {(["30d", "90d", "12m"] as const).map((t) => (
                <button key={t} onClick={() => setRange(t)} className={cn("h-7 rounded-md px-2.5 text-[11px] font-medium", range === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60")}>{t}</button>
              ))}
            </div>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[26px] font-semibold tracking-tight tabular-nums">${thisMonthVal}k</span>
            <span className="text-[11px] text-muted-foreground">{thisMonthLabel} revenue {momPct !== 0 && <span className={cn("font-semibold", momPct > 0 ? "text-success" : "text-destructive")}>· {momPct > 0 ? "↑" : "↓"} {Math.abs(momPct)}%</span>} vs last month</span>
          </div>
          <div className="-mx-2 mt-4 h-40">
            {loading ? <div className="h-full animate-pulse rounded bg-secondary/40" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ top: 5, right: 8, bottom: 0, left: 8 }}>
                  <defs>
                    <linearGradient id="revG" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="m" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} />
                  <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid hsl(var(--border))" }} formatter={(v: any) => [`$${v}k`, "Paid"]} />
                  <Area type="monotone" dataKey="paid" stroke="#10b981" strokeWidth={2} fill="url(#revG)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-info" />
            <span className="text-sm font-semibold">Paid vs Outstanding</span>
          </div>
          <div className="space-y-4">
            <FinBar label="Paid" pct={paidPortion} valueLabel={`$${(stats.totalRevenue / 1000).toFixed(1)}k · ${paidPortion}%`} color="bg-success" tone="text-success" />
            <FinBar label="Outstanding" pct={outstandingPortion} valueLabel={`$${((stats.outstanding - stats.overdue) / 1000).toFixed(1)}k · ${outstandingPortion}%`} color="bg-warning" tone="text-warning-soft-foreground" />
            <FinBar label="Overdue" pct={overduePortion} valueLabel={`$${(stats.overdue / 1000).toFixed(1)}k · ${overduePortion}%`} color="bg-destructive" tone="text-destructive" />
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4">
            <div>
              <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground">Collection Rate</div>
              <div className="mt-0.5 text-[16px] font-semibold tabular-nums text-success">{collectionRate}%</div>
            </div>
            <div>
              <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground">Total Invoices</div>
              <div className="mt-0.5 text-[16px] font-semibold tabular-nums">{invoices.length}</div>
            </div>
          </div>
        </Card>
      </div>

      <Card className="p-2">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search invoices by number, customer, project, amount…" value={search} onChange={(event) => setSearch(event.target.value)} className="h-10 border-0 bg-secondary/50 pl-9 shadow-none focus-visible:ring-1" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger className="h-10 w-[126px]"><SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" /><SelectValue placeholder="Status" /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem><SelectItem value="draft">Draft</SelectItem><SelectItem value="sent">Sent</SelectItem><SelectItem value="paid">Paid</SelectItem><SelectItem value="overdue">Overdue</SelectItem></SelectContent></Select>
            <Select value={customerFilter} onValueChange={setCustomerFilter}><SelectTrigger className="h-10 w-[140px]"><Users className="mr-1.5 h-3.5 w-3.5" /><SelectValue placeholder="Customer" /></SelectTrigger><SelectContent><SelectItem value="all">All customers</SelectItem>{customers.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent></Select>
            <Select value={dueFilter} onValueChange={setDueFilter}><SelectTrigger className="h-10 w-[126px]"><CalendarDays className="mr-1.5 h-3.5 w-3.5" /><SelectValue placeholder="Due date" /></SelectTrigger><SelectContent><SelectItem value="all">Any due date</SelectItem><SelectItem value="overdue">Overdue</SelectItem><SelectItem value="next30">Next 30 days</SelectItem></SelectContent></Select>
            <Button variant="outline" className="h-10" onClick={() => setSortOrder(v => v === "newest" ? "oldest" : "newest")}><ArrowUpDown className="mr-1.5 h-3.5 w-3.5" />{sortOrder === "newest" ? "Newest" : "Oldest"}</Button>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="grid grid-cols-[110px_minmax(160px,1.5fr)_110px_110px_100px] gap-4 border-b border-border bg-secondary/40 px-5 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          <div>Invoice</div><div>Customer</div><div>Status</div><div className="text-right">Amount</div><div>Due</div>
        </div>
        {loading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
        ) : filteredInvoices.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">{search ? "No invoices match your search." : "No invoices yet."}</div>
        ) : (
          <ul className="divide-y divide-border">
            {filteredInvoices.map((inv) => {
              const overdue = isOverdue(inv);
              const statusKey = overdue ? "overdue" : inv.status;
              const s = STATUS_STYLE[statusKey] ?? STATUS_STYLE.draft;
              const SIcon = s.icon;
              return (
                <li
                  key={inv.id}
                  onClick={() => setSelectedInvoiceId(inv.id)}
                  role="button"
                  tabIndex={0}
                  className="grid cursor-pointer grid-cols-[110px_minmax(160px,1.5fr)_110px_110px_100px] items-center gap-4 px-5 py-3 transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <div className="text-[12.5px] font-semibold tabular-nums">{inv.invoice_number}</div>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <ContactAvatar id={inv.client_id} name={inv.client_name === "—" ? "Unassigned" : inv.client_name} avatarKey={inv.client_avatar_key} size="sm" className="h-7 w-7" />
                    <span className="truncate text-[13px] font-medium">{inv.client_name}</span>
                  </div>
                  <span className={cn("inline-flex w-fit items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-semibold ring-1", s.chip)}>
                    <SIcon className="h-3 w-3" /> {s.label}
                  </span>
                  <div className="text-right text-[14px] font-semibold tabular-nums">${inv.total_amount.toLocaleString()}</div>
                  <div className={cn("text-[12px] tabular-nums", overdue ? "font-medium text-destructive" : "text-muted-foreground")}>
                    {new Date(inv.due_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <InvoiceDetailsSheet invoiceId={selectedInvoiceId} open={Boolean(selectedInvoiceId)} onClose={() => setSelectedInvoiceId(null)} />
      <InvoiceModal open={createOpen} onClose={() => setCreateOpen(false)} orgId={orgId ?? undefined} onCreated={() => void loadInvoices()} />
    </div>
  );
}

function FinBar({ label, pct, valueLabel, color, tone }: { label: string; pct: number; valueLabel: string; color: string; tone: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[12px]">
        <span className="font-medium text-foreground/80">{label}</span>
        <span className={cn("font-semibold tabular-nums", tone)}>{valueLabel}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-secondary">
        <div className={cn("h-full transition-all duration-500", color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
