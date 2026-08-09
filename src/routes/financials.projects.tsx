// src/routes/financials.projects.tsx — Phase 13.5: Project Profitability shell.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2, FolderKanban } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/format";
import { fetchFinancialsOrgId } from "@/lib/financials";
import { fetchProjectProfitability, type ProjectProfitabilityRow } from "@/lib/accounting/project-profitability";

export const Route = createFileRoute("/financials/projects")({ component: ProjectProfitabilityPage });

function ProjectProfitabilityPage() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ProjectProfitabilityRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const orgId = await fetchFinancialsOrgId();
      const data = orgId ? await fetchProjectProfitability(orgId) : [];
      if (!cancelled) { setRows(data); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">Project Profitability</p>
          <p className="text-xs text-muted-foreground">Contract, invoiced, and collected are operational; Revenue/COGS come from posted accounting entries once the ledger is initialized.</p>
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="grid grid-cols-[1.6fr_100px_100px_100px_90px_90px_90px_90px] gap-3 border-b border-border bg-secondary/40 px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          <div>Project</div><div className="text-right">Contract</div><div className="text-right">Invoiced</div><div className="text-right">Collected</div>
          <div className="text-right">Revenue</div><div className="text-right">COGS</div><div className="text-right">Gross Profit</div><div className="text-right">Margin</div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <FolderKanban className="mx-auto mb-2 h-6 w-6 text-muted-foreground/30" />
            No active projects yet.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.projectId} className="grid grid-cols-[1.6fr_100px_100px_100px_90px_90px_90px_90px] items-center gap-3 px-4 py-3 text-[13px]">
                <div className="truncate font-medium">{r.projectName}</div>
                <div className="text-right tabular-nums">{formatMoney(r.contractValue)}</div>
                <div className="text-right tabular-nums">{formatMoney(r.invoiced)}</div>
                <div className="text-right tabular-nums text-success">{formatMoney(r.collected)}</div>
                <div className="text-right tabular-nums">{r.revenue === null ? <span className="text-muted-foreground">—</span> : formatMoney(r.revenue)}</div>
                <div className="text-right tabular-nums">
                  {r.cogs === null ? (
                    <span className="text-[11px] text-muted-foreground" title="No project-cost activity has been posted to the ledger yet">No cost data</span>
                  ) : formatMoney(r.cogs)}
                </div>
                <div className="text-right tabular-nums">{r.grossProfit === null ? <span className="text-muted-foreground">—</span> : formatMoney(r.grossProfit)}</div>
                <div className="text-right tabular-nums">{r.grossMarginPct === null ? <span className="text-muted-foreground">—</span> : `${r.grossMarginPct.toFixed(0)}%`}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
