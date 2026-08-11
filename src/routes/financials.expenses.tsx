// src/routes/financials.expenses.tsx — Phase 13.8: real Expenses/Bills/
// Vendors workspace, replacing the Phase 13.5 placeholder. Vendor writes go
// direct (RLS-scoped, no accounting side effects); expense/bill/payment
// writes always go through the trusted Netlify functions in
// netlify/functions/{expense-create,vendor-bill-create,vendor-bill-post,
// vendor-bill-record-payment}.ts — see src/lib/vendors.ts for the read side.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Plus, Wallet, Receipt, Building2, AlertCircle, HardHat, Briefcase } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMoney, formatCompactMoney, formatDateOnlyShort } from "@/lib/format";
import {
  fetchVendorsOrgId, fetchVendors, fetchExpenses, fetchVendorBills, fetchExpenseCategoryAccounts,
  computeApAging, computeExpenseKpis, vendorDisplayName,
  type Vendor, type Expense, type VendorBill, type ExpenseCategoryAccount,
} from "@/lib/vendors";
import { NewVendorModal } from "@/components/financials/NewVendorModal";
import { NewExpenseModal } from "@/components/financials/NewExpenseModal";
import { NewBillModal } from "@/components/financials/NewBillModal";
import { BillDetailSheet } from "@/components/financials/BillDetailSheet";

export const Route = createFileRoute("/financials/expenses")({ component: ExpensesPage });

type Tab = "expenses" | "bills" | "vendors";

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  posted: "bg-success-soft text-success",
  open: "bg-info-soft text-info",
  partial: "bg-warning-soft text-warning-soft-foreground",
  paid: "bg-success-soft text-success",
  overdue: "bg-destructive-soft text-destructive",
  cancelled: "bg-secondary text-muted-foreground",
};

function ExpensesPage() {
  const [orgId, setOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [tab, setTab] = useState<Tab>("expenses");
  const [search, setSearch] = useState("");

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [bills, setBills] = useState<VendorBill[]>([]);
  const [categories, setCategories] = useState<ExpenseCategoryAccount[]>([]);

  const [vendorModalOpen, setVendorModalOpen] = useState(false);
  const [expenseModalOpen, setExpenseModalOpen] = useState(false);
  const [billModalOpen, setBillModalOpen] = useState(false);
  const [selectedBill, setSelectedBill] = useState<VendorBill | null>(null);

  const load = async () => {
    setLoading(true);
    const id = await fetchVendorsOrgId();
    setOrgId(id);
    if (!id) { setLoading(false); return; }
    const [v, e, b, c] = await Promise.all([
      fetchVendors(id), fetchExpenses(id), fetchVendorBills(id), fetchExpenseCategoryAccounts(id),
    ]);
    setMigrationMissing(v === null || e === null || b === null);
    setVendors(v ?? []);
    setExpenses(e ?? []);
    setBills(b ?? []);
    setCategories(c);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const now = useMemo(() => new Date(), []);
  const kpis = useMemo(() => computeExpenseKpis(expenses, bills, now), [expenses, bills, now]);
  const aging = useMemo(() => computeApAging(bills, now), [bills, now]);

  const filteredExpenses = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return expenses;
    return expenses.filter((e) => e.description.toLowerCase().includes(q) || e.vendorName.toLowerCase().includes(q) || e.accountName.toLowerCase().includes(q) || e.projectName.toLowerCase().includes(q));
  }, [expenses, search]);

  const filteredBills = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return bills;
    return bills.filter((b) => (b.billNumber ?? "").toLowerCase().includes(q) || b.vendorName.toLowerCase().includes(q) || b.projectName.toLowerCase().includes(q));
  }, [bills, search]);

  const filteredVendors = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter((v) => vendorDisplayName(v).toLowerCase().includes(q) || (v.contactName ?? "").toLowerCase().includes(q));
  }, [vendors, search]);

  const vendorBalances = useMemo(() => {
    const m = new Map<string, { open: number; paid: number }>();
    for (const b of bills) {
      const entry = m.get(b.vendorId) ?? { open: 0, paid: 0 };
      if (b.status !== "draft" && b.status !== "cancelled") {
        entry.open += Math.max(0, b.totalAmount - b.amountPaid);
        entry.paid += b.amountPaid;
      }
      m.set(b.vendorId, entry);
    }
    return m;
  }, [bills]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Expenses</h1>
          <p className="text-[13px] text-muted-foreground">Direct expenses, vendor bills, and accounts payable.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setVendorModalOpen(true)}><Building2 className="mr-1.5 h-3.5 w-3.5" />Manage Vendors</Button>
          <Button variant="outline" size="sm" onClick={() => setBillModalOpen(true)}><Receipt className="mr-1.5 h-3.5 w-3.5" />New Bill</Button>
          <Button size="sm" onClick={() => setExpenseModalOpen(true)}><Plus className="mr-1.5 h-3.5 w-3.5" />New Expense</Button>
        </div>
      </div>

      {migrationMissing && !loading && (
        <Card className="flex items-center gap-2 border-warning/40 bg-warning-soft p-3 text-[13px] text-warning-soft-foreground">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Expense tracking tables haven't been created in this environment yet — apply supabase/migrations/20260822_expenses_vendors_ap.sql.
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard icon={Wallet} iconBg="bg-primary-soft" iconColor="text-primary" label="Expenses This Month" value={kpis.expensesThisMonth} />
        <KpiCard icon={HardHat} iconBg="bg-info-soft" iconColor="text-info" label="Direct Project Costs" value={kpis.directProjectCosts} />
        <KpiCard icon={Briefcase} iconBg="bg-secondary" iconColor="text-foreground" label="Operating Expenses" value={kpis.operatingExpenses} />
        <KpiCard icon={AlertCircle} iconBg="bg-destructive-soft" iconColor="text-destructive" label="Accounts Payable" value={kpis.totalPayable} sub={`${kpis.openBillsCount} open bill${kpis.openBillsCount === 1 ? "" : "s"}`} />
      </div>

      {kpis.totalPayable > 0 && (
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold">A/P Aging</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              { label: "Current", value: aging.current },
              { label: "1–30 days", value: aging.d1_30 },
              { label: "31–60 days", value: aging.d31_60 },
              { label: "61–90 days", value: aging.d61_90 },
              { label: "90+ days", value: aging.d90_plus },
            ].map((b) => (
              <div key={b.label} className="rounded-lg border border-border bg-secondary/30 p-2.5">
                <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{b.label}</p>
                <p className="mt-1 text-[15px] font-semibold tabular-nums">{formatMoney(b.value)}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1">
            {([["expenses", "Expenses"], ["bills", "Bills"], ["vendors", "Vendors"]] as const).map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)}
                className={cn("h-8 rounded-md px-3 text-[12.5px] font-medium", tab === key ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60")}>
                {label}
              </button>
            ))}
          </div>
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder={`Search ${tab}…`} value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 border-0 bg-secondary/50 pl-9 shadow-none focus-visible:ring-1" />
          </div>
        </div>
      </Card>

      {loading ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">Loading…</Card>
      ) : tab === "expenses" ? (
        <ExpensesTable expenses={filteredExpenses} empty={expenses.length === 0} />
      ) : tab === "bills" ? (
        <BillsTable bills={filteredBills} empty={bills.length === 0} onSelect={setSelectedBill} />
      ) : (
        <VendorsTable vendors={filteredVendors} empty={vendors.length === 0} balances={vendorBalances} />
      )}

      <NewVendorModal open={vendorModalOpen} onClose={() => setVendorModalOpen(false)} orgId={orgId} onCreated={() => load()} />
      <NewExpenseModal open={expenseModalOpen} onClose={() => setExpenseModalOpen(false)} orgId={orgId} vendors={vendors} categories={categories} onCreated={() => load()} />
      <NewBillModal open={billModalOpen} onClose={() => setBillModalOpen(false)} orgId={orgId} vendors={vendors} categories={categories} onCreated={() => load()} />
      <BillDetailSheet bill={selectedBill} open={Boolean(selectedBill)} onClose={() => setSelectedBill(null)} onChanged={() => { load(); setSelectedBill(null); }} />
    </div>
  );
}

function KpiCard({ icon: Icon, iconBg, iconColor, label, value, sub }: {
  icon: React.ComponentType<{ className?: string }>; iconBg: string; iconColor: string; label: string; value: number; sub?: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", iconBg, iconColor)}><Icon className="h-3.5 w-3.5" /></span>
        <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      </div>
      <p className="mt-2 text-xl font-semibold tabular-nums">{formatCompactMoney(value)}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </Card>
  );
}

function ExpensesTable({ expenses, empty }: { expenses: Expense[]; empty: boolean }) {
  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-[90px_minmax(160px,1.5fr)_120px_110px_90px_90px_90px] gap-4 border-b border-border bg-secondary/40 px-5 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        <div>Date</div><div>Description</div><div>Vendor</div><div>Category</div><div>Project</div><div>Method</div><div className="text-right">Amount</div>
      </div>
      {expenses.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">{empty ? "No expenses yet." : "No expenses match your search."}</div>
      ) : (
        <ul className="divide-y divide-border">
          {expenses.map((e) => (
            <li key={e.id} className="grid grid-cols-[90px_minmax(160px,1.5fr)_120px_110px_90px_90px_90px] items-center gap-4 px-5 py-3">
              <div className="text-[12px] tabular-nums text-muted-foreground">{formatDateOnlyShort(e.expenseDate)}</div>
              <div className="min-w-0 truncate text-[13px] font-medium">{e.description}</div>
              <div className="truncate text-[12.5px] text-muted-foreground">{e.vendorName}</div>
              <div className="truncate text-[12.5px]">
                {e.accountName}
                {e.isCogs && <Badge variant="outline" className="ml-1.5 text-[10px]">Direct cost</Badge>}
              </div>
              <div className="truncate text-[12.5px] text-muted-foreground">{e.projectName}</div>
              <div className="text-[12px] capitalize text-muted-foreground">{e.paymentMethod ?? "—"}</div>
              <div className="text-right text-[13.5px] font-semibold tabular-nums">{formatMoney(e.amount)}</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function BillsTable({ bills, empty, onSelect }: { bills: VendorBill[]; empty: boolean; onSelect: (b: VendorBill) => void }) {
  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-[110px_minmax(160px,1.5fr)_100px_100px_90px_90px_90px] gap-4 border-b border-border bg-secondary/40 px-5 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        <div>Bill #</div><div>Vendor / Project</div><div>Status</div><div className="text-right">Total</div><div className="text-right">Balance</div><div>Due</div><div>Date</div>
      </div>
      {bills.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">{empty ? "No vendor bills yet." : "No bills match your search."}</div>
      ) : (
        <ul className="divide-y divide-border">
          {bills.map((b) => {
            const balance = Math.max(0, b.totalAmount - b.amountPaid);
            return (
              <li key={b.id} onClick={() => onSelect(b)} role="button" tabIndex={0}
                className="grid cursor-pointer grid-cols-[110px_minmax(160px,1.5fr)_100px_100px_90px_90px_90px] items-center gap-4 px-5 py-3 transition-colors hover:bg-secondary/50">
                <div className="text-[12.5px] font-semibold tabular-nums">{b.billNumber ?? "—"}</div>
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium leading-tight">{b.vendorName}</p>
                  {b.projectName !== "—" && <p className="truncate text-[11px] leading-tight text-muted-foreground">{b.projectName}</p>}
                </div>
                <Badge className={cn("w-fit capitalize", STATUS_STYLES[b.status])}>{b.status}</Badge>
                <div className="text-right text-[13.5px] font-semibold tabular-nums">{formatMoney(b.totalAmount)}</div>
                <div className={cn("text-right text-[12.5px] tabular-nums", balance > 0 ? "font-medium" : "text-muted-foreground")}>{b.status === "draft" ? "—" : formatMoney(balance)}</div>
                <div className="text-[12px] tabular-nums text-muted-foreground">{b.dueDate ? formatDateOnlyShort(b.dueDate) : "—"}</div>
                <div className="text-[12px] tabular-nums text-muted-foreground">{formatDateOnlyShort(b.billDate)}</div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function VendorsTable({ vendors, empty, balances }: { vendors: Vendor[]; empty: boolean; balances: Map<string, { open: number; paid: number }> }) {
  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-[minmax(160px,1.5fr)_130px_160px_120px_100px_90px] gap-4 border-b border-border bg-secondary/40 px-5 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        <div>Vendor</div><div>Type</div><div>Contact</div><div className="text-right">Open Balance</div><div className="text-right">Total Paid</div><div>Status</div>
      </div>
      {vendors.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">{empty ? "No vendors yet." : "No vendors match your search."}</div>
      ) : (
        <ul className="divide-y divide-border">
          {vendors.map((v) => {
            const bal = balances.get(v.id) ?? { open: 0, paid: 0 };
            return (
              <li key={v.id} className="grid grid-cols-[minmax(160px,1.5fr)_130px_160px_120px_100px_90px] items-center gap-4 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{vendorDisplayName(v)}</p>
                  {v.licenseNumber && <p className="truncate text-[11px] text-muted-foreground">Lic. {v.licenseNumber}</p>}
                </div>
                <div className="truncate text-[12.5px] capitalize text-muted-foreground">{v.vendorType.replace(/_/g, " ")}</div>
                <div className="truncate text-[12.5px] text-muted-foreground">{v.companyName && v.contactName ? v.contactName : "—"}</div>
                <div className={cn("text-right text-[13px] tabular-nums", bal.open > 0 ? "font-medium" : "text-muted-foreground")}>{formatMoney(bal.open)}</div>
                <div className="text-right text-[12.5px] tabular-nums text-muted-foreground">{formatMoney(bal.paid)}</div>
                <Badge variant={v.isActive ? "outline" : "secondary"} className="w-fit">{v.isActive ? "Active" : "Inactive"}</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
