import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import {
  BarChart, Bar, Cell, PieChart, Pie, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid,
} from "recharts";
import {
  TrendingUp, Users, DollarSign, Target, Activity, Hammer,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/format";
import { useDeals } from "@/lib/deals-store";
import { fallbackStageColor } from "@/lib/stage-colors";
import { useProjects } from "@/lib/projects-store";
import { useLeads } from "@/lib/leads-store";
import { useTeam } from "@/lib/organization";

export const Route = createFileRoute("/insights/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics — Insights" },
      { name: "description", content: "Pipeline, revenue, and operations analytics across your renovation business." },
    ],
  }),
  component: AnalyticsPage,
});

const CHART_COLORS = [
  "oklch(0.55 0.205 262)",
  "oklch(0.65 0.16 220)",
  "oklch(0.62 0.16 152)",
  "oklch(0.74 0.16 70)",
  "oklch(0.55 0.18 300)",
];
const BORDER = "oklch(0.92 0.005 250)";
const MUTED = "oklch(0.55 0.02 250)";

const LEAD_FUNNEL_ORDER = ["new", "contacted", "qualified", "converted"] as const;
const LEAD_FUNNEL_LABEL: Record<(typeof LEAD_FUNNEL_ORDER)[number], string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  converted: "Converted",
};

// Every figure on this page is derived from the real deals/projects/leads
// stores below — no seeded/hardcoded demo numbers, no fabricated deltas or
// sparklines. Metrics with no reliable real comparison (e.g. cycle time —
// there's no per-stage timestamp history stored yet) are shown as an
// honest empty state instead of an invented number.
function AnalyticsPage() {
  const deals = useDeals();
  const { projects } = useProjects();
  const leads = useLeads();
  const team = useTeam();

  const dealStats = useMemo(() => {
    const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
    const won = deals.filter((d) => d.stage === "won");
    const lost = deals.filter((d) => d.stage === "lost");
    const pipelineValue = open.reduce((s, d) => s + d.value, 0);
    const wonValue = won.reduce((s, d) => s + d.value, 0);
    const winRate = won.length + lost.length > 0 ? (won.length / (won.length + lost.length)) * 100 : null;
    const avgDealSize = deals.length > 0 ? deals.reduce((s, d) => s + d.value, 0) / deals.length : 0;
    return { pipelineValue, wonValue, winRate, avgDealSize, open, won, lost };
  }, [deals]);

  const activeProjects = useMemo(() => projects.filter((p) => p.status === "active").length, [projects]);

  const kpis = [
    { label: "Pipeline value", value: formatMoney(dealStats.pipelineValue), icon: DollarSign },
    { label: "Won value", value: formatMoney(dealStats.wonValue), icon: Target },
    { label: "Win rate", value: dealStats.winRate === null ? "—" : `${dealStats.winRate.toFixed(1)}%`, icon: TrendingUp },
    { label: "Active projects", value: String(activeProjects), icon: Hammer },
    { label: "Avg deal size", value: formatMoney(dealStats.avgDealSize), icon: Activity },
  ];

  const stageDistribution = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of deals) map.set(d.stage, (map.get(d.stage) ?? 0) + 1);
    return Array.from(map.entries()).map(([stage, count]) => ({ stage, count, color: fallbackStageColor(stage).hex }));
  }, [deals]);

  const leadSourceData = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of leads) map.set(l.source, (map.get(l.source) ?? 0) + 1);
    const total = leads.length;
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, value: total > 0 ? Math.round((count / total) * 100) : 0, count }))
      .sort((a, b) => b.count - a.count);
  }, [leads]);

  const leadFunnel = useMemo(() => {
    const total = leads.length;
    return LEAD_FUNNEL_ORDER.map((status) => {
      const count = leads.filter((l) => l.status === status).length;
      return { stage: LEAD_FUNNEL_LABEL[status], count, rate: total > 0 ? Math.round((count / total) * 100) : 0 };
    });
  }, [leads]);

  // Real `projects` rows have no category/type column — grouping by status
  // (the field that actually exists) instead of fabricating a project type.
  const projectMixData = useMemo(() => {
    const map = new Map<string, { count: number; revenue: number }>();
    for (const p of projects) {
      const entry = map.get(p.status) ?? { count: 0, revenue: 0 };
      entry.count += 1;
      entry.revenue += p.budget_total ?? 0;
      map.set(p.status, entry);
    }
    return Array.from(map.entries()).map(([status, v]) => ({ status, ...v }));
  }, [projects]);

  const ownerPerformance = useMemo(() => {
    const byOwner = new Map<string, { name: string; won: number; value: number; wonCount: number; lostCount: number }>();
    for (const d of deals) {
      if (d.stage !== "won" && d.stage !== "lost") continue;
      const key = d.ownerId || d.owner || "unassigned";
      const entry = byOwner.get(key) ?? { name: d.owner || "Unassigned", won: 0, value: 0, wonCount: 0, lostCount: 0 };
      if (d.stage === "won") { entry.won += 1; entry.value += d.value; entry.wonCount += 1; }
      else entry.lostCount += 1;
      byOwner.set(key, entry);
    }
    return Array.from(byOwner.values())
      .map((o) => ({ ...o, rate: o.wonCount + o.lostCount > 0 ? Math.round((o.wonCount / (o.wonCount + o.lostCount)) * 100) : 0 }))
      .filter((o) => o.won > 0 || o.lostCount > 0)
      .sort((a, b) => b.value - a.value);
  }, [deals]);

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">Pipeline, revenue, and operations across your renovation business.</p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <k.icon className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="mt-2 text-xl font-semibold">{k.value}</div>
              <div className="text-[11px] text-muted-foreground">{k.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">Deals by stage</CardTitle></CardHeader>
          <CardContent>
            {stageDistribution.length === 0 ? (
              <EmptyPanel text="No deals yet — this will fill in once your pipeline has activity." />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={stageDistribution}>
                  <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                  <XAxis dataKey="stage" stroke={MUTED} fontSize={11} />
                  <YAxis stroke={MUTED} fontSize={11} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: "white", border: `1px solid ${BORDER}`, borderRadius: 8 }} />
                  <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                    {stageDistribution.map((s, i) => <Cell key={i} fill={s.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Lead sources</CardTitle></CardHeader>
          <CardContent>
            {leadSourceData.length === 0 ? (
              <EmptyPanel text="No leads yet." />
            ) : (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={leadSourceData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                      {leadSourceData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: "white", border: `1px solid ${BORDER}`, borderRadius: 8 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="mt-2 space-y-1">
                  {leadSourceData.map((s, i) => (
                    <div key={s.name} className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                        {s.name}
                      </span>
                      <span className="text-muted-foreground">{s.value}% · {s.count} lead{s.count === 1 ? "" : "s"}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Lead funnel</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {leads.length === 0 ? (
              <EmptyPanel text="No leads yet." />
            ) : leadFunnel.map((s) => (
              <div key={s.stage}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium">{s.stage}</span>
                  <span className="text-muted-foreground">{s.count} · {s.rate}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-secondary">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${s.rate}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Cycle time</CardTitle></CardHeader>
          <CardContent>
            <EmptyPanel text="Not enough stage-history data yet to calculate cycle time." />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Projects by status</CardTitle></CardHeader>
          <CardContent>
            {projectMixData.length === 0 ? (
              <EmptyPanel text="No projects yet." />
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={projectMixData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                  <XAxis dataKey="status" stroke={MUTED} fontSize={11} />
                  <YAxis stroke={MUTED} fontSize={11} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} />
                  <Tooltip contentStyle={{ background: "white", border: `1px solid ${BORDER}`, borderRadius: 8 }} formatter={(v) => formatMoney(Number(v))} />
                  <Bar dataKey="revenue" radius={[6, 6, 0, 0]}>
                    {projectMixData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Owner leaderboard</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {ownerPerformance.length === 0 ? (
              <EmptyPanel text="No closed deals yet." />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="pb-2 font-medium">Owner</th>
                    <th className="pb-2 text-right font-medium">Won</th>
                    <th className="pb-2 text-right font-medium">Value</th>
                    <th className="pb-2 text-right font-medium">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {ownerPerformance.map((o) => (
                    <tr key={o.name} className="border-b last:border-0">
                      <td className="py-2.5 font-medium">{o.name}</td>
                      <td className="py-2.5 text-right">{o.won}</td>
                      <td className="py-2.5 text-right">{formatMoney(o.value)}</td>
                      <td className="py-2.5 text-right">
                        <Badge variant="secondary" className="font-mono text-[11px]">{o.rate}%</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-lg border border-dashed text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}
