// src/components/financials/accounting/ChartOfAccounts.tsx
import { useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/format";
import { fetchChartOfAccounts, groupAccountsByType } from "@/lib/accounting/accounts";
import { fetchTrialBalance } from "@/lib/accounting/ledger";
import type { AccountingAccount } from "@/lib/accounting/types";

export function ChartOfAccounts({ orgId }: { orgId: string }) {
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<AccountingAccount[] | null>(null);
  const [balances, setBalances] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [accountRows, trialBalance] = await Promise.all([fetchChartOfAccounts(orgId), fetchTrialBalance(orgId)]);
      if (cancelled) return;
      setAccounts(accountRows);
      setBalances(new Map((trialBalance ?? []).map((r) => [r.accountId, r.balance])));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  if (loading) return <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>;
  if (accounts === null) return <EmptySchemaNotice />;

  const groups = groupAccountsByType(accounts);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">Read-only for now — Chart of Accounts CRUD is a future phase; system accounts (locked icon) are used by automated posting and cannot be deleted.</p>
      {groups.map((g) => (
        <Card key={g.type} className="overflow-hidden">
          <div className="border-b border-border bg-secondary/40 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g.label}</div>
          <div className="grid grid-cols-[70px_1fr_140px_100px_90px] gap-3 border-b border-border px-4 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
            <div>Code</div><div>Account</div><div>Subtype</div><div className="text-right">Balance</div><div>Status</div>
          </div>
          <ul className="divide-y divide-border">
            {g.accounts.map((a) => (
              <li key={a.id} className="grid grid-cols-[70px_1fr_140px_100px_90px] items-center gap-3 px-4 py-2 text-[13px]">
                <div className="tabular-nums text-muted-foreground">{a.code}</div>
                <div className="flex items-center gap-1.5 font-medium">{a.name}{a.isSystem && <Lock className="h-3 w-3 text-muted-foreground" />}</div>
                <div className="truncate text-xs text-muted-foreground">{a.accountSubtype.replace(/_/g, " ")}</div>
                <div className="text-right tabular-nums">{formatMoney(balances.get(a.id) ?? 0)}</div>
                <div><Badge variant="outline" className={a.isActive ? "text-success" : "text-muted-foreground"}>{a.isActive ? "Active" : "Inactive"}</Badge></div>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

export function EmptySchemaNotice() {
  return (
    <Card className="p-8 text-center text-sm text-muted-foreground">
      Accounting foundation not deployed yet — run supabase/migrations/20260820_accounting_foundation.sql.
    </Card>
  );
}
