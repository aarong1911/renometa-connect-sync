// src/components/financials/accounting/GeneralLedger.tsx
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatMoney, formatDateOnlyShort } from "@/lib/format";
import { fetchChartOfAccounts } from "@/lib/accounting/accounts";
import { fetchGeneralLedgerLines, withRunningBalance } from "@/lib/accounting/ledger";
import type { AccountingAccount, GeneralLedgerRow } from "@/lib/accounting/types";
import { EmptySchemaNotice } from "./ChartOfAccounts";

export function GeneralLedger({ orgId }: { orgId: string }) {
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<AccountingAccount[]>([]);
  const [rows, setRows] = useState<GeneralLedgerRow[] | null>(null);
  const [accountId, setAccountId] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

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

  if (rows === null && !loading) return <EmptySchemaNotice />;

  const displayRows = accountId !== "all" && rows ? withRunningBalance(rows) : (rows ?? []).map((r) => ({ ...r, runningBalance: null as number | null }));

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-2 p-2">
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger className="h-9 w-[220px]"><SelectValue placeholder="All accounts" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All accounts</SelectItem>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} · {a.name}</SelectItem>)}</SelectContent>
        </Select>
        <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-9 w-[150px]" />
        <span className="text-xs text-muted-foreground">to</span>
        <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-9 w-[150px]" />
      </Card>

      <Card className="overflow-hidden">
        <div className="grid grid-cols-[90px_100px_1fr_1fr_120px_90px_90px_100px] gap-3 border-b border-border bg-secondary/40 px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          <div>Date</div><div>Entry</div><div>Account</div><div>Description</div><div>Project</div><div className="text-right">Debit</div><div className="text-right">Credit</div><div className="text-right">Balance</div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
        ) : displayRows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">No posted journal activity{accountId !== "all" || dateFrom || dateTo ? " for this filter." : " yet."}</div>
        ) : (
          <ul className="divide-y divide-border">
            {displayRows.map((r) => (
              <li key={r.id} className="grid grid-cols-[90px_100px_1fr_1fr_120px_90px_90px_100px] items-center gap-3 px-4 py-2.5 text-[12.5px]">
                <div className="tabular-nums text-muted-foreground">{formatDateOnlyShort(r.entryDate)}</div>
                <div className="tabular-nums">{r.entryNumber}</div>
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
      </Card>
    </div>
  );
}
