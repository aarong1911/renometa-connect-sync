// src/components/financials/accounting/GeneralLedger.tsx
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatMoney, formatDateOnlyShort } from "@/lib/format";
import { fetchChartOfAccounts } from "@/lib/accounting/accounts";
import { fetchGeneralLedgerLines, withRunningBalance } from "@/lib/accounting/ledger";
import type { AccountingAccount, GeneralLedgerRow } from "@/lib/accounting/types";
import { EmptySchemaNotice } from "./ChartOfAccounts";

const GL_GRID = "grid-cols-[90px_110px_1fr_1fr_120px_90px_90px_100px]";

type SortField = "date" | "entry" | "description" | "account" | "amount";
type SortDir = "desc" | "asc";

const SORT_FIELDS: Array<{ key: SortField; label: string }> = [
  { key: "date", label: "Date" },
  { key: "entry", label: "Entry #" },
  { key: "description", label: "Description" },
  { key: "account", label: "Account" },
  { key: "amount", label: "Amount" },
];

function lineAmount(r: GeneralLedgerRow): number {
  return r.debit > 0 ? r.debit : r.credit;
}

function compareRows(a: GeneralLedgerRow, b: GeneralLedgerRow, field: SortField, dir: SortDir): number {
  let cmp: number;
  switch (field) {
    case "date":
      cmp = a.entryDate === b.entryDate ? a.entryNumber.localeCompare(b.entryNumber) : a.entryDate.localeCompare(b.entryDate);
      break;
    case "entry":
      cmp = a.entryNumber.localeCompare(b.entryNumber);
      break;
    case "description":
      cmp = (a.description ?? a.entryDescription ?? "").localeCompare(b.description ?? b.entryDescription ?? "");
      break;
    case "account":
      cmp = `${a.accountCode} ${a.accountName}`.localeCompare(`${b.accountCode} ${b.accountName}`);
      break;
    case "amount":
      cmp = lineAmount(a) - lineAmount(b);
      break;
  }
  return dir === "asc" ? cmp : -cmp;
}

export function GeneralLedger({ orgId }: { orgId: string }) {
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<AccountingAccount[]>([]);
  const [rows, setRows] = useState<GeneralLedgerRow[] | null>(null);
  const [accountId, setAccountId] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [accountRows, lineRows] = await Promise.all([
        fetchChartOfAccounts(orgId),
        fetchGeneralLedgerLines(orgId, {
          accountId: accountId !== "all" ? accountId : undefined,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
        }),
      ]);
      if (cancelled) return;
      setAccounts(accountRows ?? []);
      setRows(lineRows);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [orgId, accountId, dateFrom, dateTo]);

  // Running balance is computed once over the natural chronological order
  // (fetchGeneralLedgerLines returns date-ascending) so its meaning never
  // changes; the Sort by/Order controls below only reorder how these same
  // rows are displayed, they never recompute the balance.
  const balancedRows = useMemo(
    () => (accountId !== "all" && rows ? withRunningBalance(rows) : (rows ?? []).map((r) => ({ ...r, runningBalance: null as number | null }))),
    [rows, accountId],
  );
  const displayRows = useMemo(
    () => [...balancedRows].sort((a, b) => compareRows(a, b, sortField, sortDir)),
    [balancedRows, sortField, sortDir],
  );

  if (rows === null && !loading) return <EmptySchemaNotice />;

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3 p-3">
        <FilterField label="Account">
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger className="h-9 w-[200px]"><SelectValue placeholder="All accounts" /></SelectTrigger>
            <SelectContent><SelectItem value="all">All accounts</SelectItem>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} · {a.name}</SelectItem>)}</SelectContent>
          </Select>
        </FilterField>
        <FilterField label="From">
          <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-9 w-[150px]" />
        </FilterField>
        <FilterField label="To">
          <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-9 w-[150px]" />
        </FilterField>
        <div className="ml-auto flex flex-wrap items-end gap-3">
          <FilterField label="Sort by">
            <Select value={sortField} onValueChange={(v) => setSortField(v as SortField)}>
              <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>{SORT_FIELDS.map((f) => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}</SelectContent>
            </Select>
          </FilterField>
          <FilterField label="Order">
            <Select value={sortDir} onValueChange={(v) => setSortDir(v as SortDir)}>
              <SelectTrigger className="h-9 w-[140px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="desc">Descending</SelectItem>
                <SelectItem value="asc">Ascending</SelectItem>
              </SelectContent>
            </Select>
          </FilterField>
        </div>
      </Card>

      <Card className="flex max-h-[calc(100vh-380px)] min-h-[320px] flex-col overflow-hidden p-0">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={`sticky top-0 z-10 grid ${GL_GRID} gap-3 border-b border-border bg-secondary px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground`}>
            <div>Date</div><div>Entry</div><div>Account</div><div>Description</div><div>Project</div><div className="text-right">Debit</div><div className="text-right">Credit</div><div className="text-right">Balance</div>
          </div>
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
          ) : displayRows.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No posted journal activity{accountId !== "all" || dateFrom || dateTo ? " for this filter." : " yet."}</div>
          ) : (
            <ul className="divide-y divide-border">
              {displayRows.map((r) => (
                <li key={r.id} className={`grid ${GL_GRID} items-center gap-3 px-4 py-2.5 text-[12.5px] transition-colors hover:bg-secondary/50`}>
                  <div className="tabular-nums text-muted-foreground">{formatDateOnlyShort(r.entryDate)}</div>
                  <div className="truncate tabular-nums">{r.entryNumber}</div>
                  <div className="truncate">{r.accountCode} · {r.accountName}</div>
                  <div className="truncate text-muted-foreground">{r.description ?? r.entryDescription ?? "—"}</div>
                  <div className="truncate text-muted-foreground">{r.projectName ?? "—"}</div>
                  <div className="text-right tabular-nums">{r.debit > 0 ? formatMoney(r.debit) : ""}</div>
                  <div className="text-right tabular-nums">{r.credit > 0 ? formatMoney(r.credit) : ""}</div>
                  <div className="text-right tabular-nums font-medium">{r.runningBalance === null ? "—" : formatMoney(r.runningBalance)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
