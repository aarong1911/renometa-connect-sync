// src/lib/accounting/project-profitability.ts
//
// Blends OPERATIONAL contract/invoice/payment data (already authoritative —
// src/lib/financials.ts, project-change-orders.ts) with ACCOUNTING revenue/
// COGS from posted journal lines. Per Phase 13.5 Part 26: until real
// expense/cost posting exists, COGS/Gross Profit/Gross Margin must show as
// "No cost data" rather than a fabricated $0 or blank-implies-zero — a
// project can genuinely have $0 posted COGS lines and that must not be
// visually indistinguishable from "we haven't started tracking costs yet."

import { supabase } from "@/lib/supabase";
import { fetchApprovedChangeOrderTotalsByProject } from "@/lib/project-change-orders";
import { fetchFinancialInvoices, isIssued } from "@/lib/financials";
import { fetchGeneralLedgerLines } from "./ledger";

// Kept in sync with src/lib/accounting/statements.ts's COGS_SUBTYPES —
// classification by account_subtype, not code range (Phase 13.5B).
const COGS_SUBTYPES = new Set(["cost_of_goods_sold", "labor", "subcontractor", "equipment"]);

const ACTIVE_PROJECT_STATUSES = ["planning", "contracted", "pre-construction", "active", "punch-list", "completed"];

export type ProjectProfitabilityRow = {
  projectId: string;
  projectName: string;
  contractValue: number;
  invoiced: number;
  collected: number;
  /** null = no posted revenue journal lines exist for this project yet. */
  revenue: number | null;
  /** true only if at least one posted line for this project has a COGS-grouped account_subtype. */
  hasCostData: boolean;
  /** null = hasCostData is false ("No cost data"), independent of whether revenue is posted. */
  cogs: number | null;
  grossProfit: number | null;
  grossMarginPct: number | null;
};

export async function fetchProjectProfitability(orgId: string): Promise<ProjectProfitabilityRow[]> {
  const { data: projectRows, error } = await supabase
    .from("projects")
    .select("id, name, budget_total, estimate_id, status")
    .eq("org_id", orgId)
    .in("status", ACTIVE_PROJECT_STATUSES);
  if (error) { console.error("[accounting/project-profitability]", error); return []; }
  const projects = projectRows ?? [];
  if (projects.length === 0) return [];

  const estimateIds = Array.from(new Set(projects.map((p: any) => p.estimate_id).filter((id: unknown): id is string => !!id)));
  const [estimateAmounts, approvedCOTotals, invoices, glLines] = await Promise.all([
    estimateIds.length > 0
      ? supabase.from("estimates").select("id, total, client_total").in("id", estimateIds).then(({ data }) => {
          const m = new Map<string, number>();
          for (const row of data ?? []) m.set(row.id, Number(row.client_total ?? row.total ?? 0));
          return m;
        })
      : Promise.resolve(new Map<string, number>()),
    fetchApprovedChangeOrderTotalsByProject(),
    fetchFinancialInvoices(orgId),
    fetchGeneralLedgerLines(orgId, {}),
  ]);

  const invoicedByProject = new Map<string, number>();
  const collectedByProject = new Map<string, number>();
  for (const inv of invoices.filter(isIssued)) {
    if (!inv.projectId) continue;
    invoicedByProject.set(inv.projectId, (invoicedByProject.get(inv.projectId) ?? 0) + inv.totalAmount);
    collectedByProject.set(inv.projectId, (collectedByProject.get(inv.projectId) ?? 0) + inv.amountPaid);
  }
  // Phase 13.6A — revenue activity and COST activity are tracked as two
  // INDEPENDENT sets, not one combined "has any ledger activity" flag.
  // Before this fix, a project with posted Revenue but zero posted COGS
  // lines (the exact state after the Phase 13.6 invoice/payment backfill —
  // no Expenses/Vendor Bills workflow exists yet) showed cogs=0 (a real
  // computed zero, technically correct) which then rendered as a fake
  // 100% gross margin — indistinguishable from "this project genuinely
  // cost nothing." A contractor reading that as real job performance
  // would be misled. cogs/grossProfit/grossMarginPct now stay null
  // (rendered as "No cost data") until at least one posted line for that
  // project carries a COGS-grouped account_subtype specifically — revenue
  // is judged independently and stays real/visible regardless.
  const revenueByProject = new Map<string, number>();
  const cogsByProject = new Map<string, number>();
  const projectsWithRevenueActivity = new Set<string>();
  const projectsWithCostActivity = new Set<string>();
  if (glLines) {
    for (const line of glLines) {
      if (!line.projectId) continue;
      if (line.accountType === "revenue") {
        projectsWithRevenueActivity.add(line.projectId);
        revenueByProject.set(line.projectId, (revenueByProject.get(line.projectId) ?? 0) + (line.credit - line.debit));
      } else if (line.accountType === "expense" && COGS_SUBTYPES.has(line.accountSubtype)) {
        projectsWithCostActivity.add(line.projectId);
        cogsByProject.set(line.projectId, (cogsByProject.get(line.projectId) ?? 0) + (line.debit - line.credit));
      }
    }
  }

  return (projects as any[]).map((p) => {
    const baseline = p.estimate_id && estimateAmounts.has(p.estimate_id) ? estimateAmounts.get(p.estimate_id)! : Number(p.budget_total ?? 0);
    const contractValue = round2(baseline + (approvedCOTotals.get(p.id) ?? 0));
    const revenue = projectsWithRevenueActivity.has(p.id) ? round2(revenueByProject.get(p.id) ?? 0) : null;
    const hasCostData = projectsWithCostActivity.has(p.id);
    const cogs = hasCostData ? round2(cogsByProject.get(p.id) ?? 0) : null;
    const grossProfit = revenue !== null && cogs !== null ? round2(revenue - cogs) : null;
    const grossMarginPct = grossProfit !== null && revenue !== null && revenue > 0 ? round2((grossProfit / revenue) * 100) : null;
    return {
      projectId: p.id, projectName: p.name,
      contractValue,
      invoiced: round2(invoicedByProject.get(p.id) ?? 0),
      collected: round2(collectedByProject.get(p.id) ?? 0),
      revenue, hasCostData, cogs, grossProfit, grossMarginPct,
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
