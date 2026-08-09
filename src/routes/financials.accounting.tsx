// src/routes/financials.accounting.tsx — Phase 13.5: Accounting section.
// Internal tab state (not nested file routes) per Part 21's "prefer
// Financials-level tabs/subnavigation" guidance — keeps this to one route
// file instead of six.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchFinancialsOrgId } from "@/lib/financials";
import { AccountingOverview } from "@/components/financials/accounting/AccountingOverview";
import { ChartOfAccounts } from "@/components/financials/accounting/ChartOfAccounts";
import { GeneralLedger } from "@/components/financials/accounting/GeneralLedger";
import { TrialBalance } from "@/components/financials/accounting/TrialBalance";
import { ProfitAndLoss } from "@/components/financials/accounting/ProfitAndLoss";
import { BalanceSheet } from "@/components/financials/accounting/BalanceSheet";

export const Route = createFileRoute("/financials/accounting")({ component: AccountingPage });

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "coa", label: "Chart of Accounts" },
  { key: "gl", label: "General Ledger" },
  { key: "tb", label: "Trial Balance" },
  { key: "pl", label: "Profit & Loss" },
  { key: "bs", label: "Balance Sheet" },
] as const;
type TabKey = typeof TABS[number]["key"];

function AccountingPage() {
  const [orgId, setOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("overview");

  useEffect(() => { fetchFinancialsOrgId().then((id) => { setOrgId(id); setLoading(false); }); }, []);

  if (loading) return <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>;
  if (!orgId) return <div className="p-12 text-center text-sm text-muted-foreground">No organization found.</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b border-border pb-2">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={cn("rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors", tab === t.key ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-secondary")}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "overview" && <AccountingOverview orgId={orgId} />}
      {tab === "coa" && <ChartOfAccounts orgId={orgId} />}
      {tab === "gl" && <GeneralLedger orgId={orgId} />}
      {tab === "tb" && <TrialBalance orgId={orgId} />}
      {tab === "pl" && <ProfitAndLoss orgId={orgId} />}
      {tab === "bs" && <BalanceSheet orgId={orgId} />}
    </div>
  );
}
