import { createFileRoute } from "@tanstack/react-router";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  TrendingUp, TrendingDown, Users, DollarSign, Target, Clock, Activity, Hammer,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";
import { pipelineVelocityData, mockDeals, mockProjects } from "@/lib/mock-data";

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
const PRIMARY = CHART_COLORS[0];
const BORDER = "oklch(0.92 0.005 250)";
const MUTED = "oklch(0.55 0.02 250)";

const leadSourceData = [
  { name: "Referral", value: 38, deals: 14 },
  { name: "Web form", value: 24, deals: 9 },
  { name: "Angi", value: 16, deals: 6 },
  { name: "Thumbtack", value: 12, deals: 4 },
  { name: "Houzz", value: 10, deals: 3 },
];

const conversionFunnel = [
  { stage: "Lead", count: 248, rate: 100 },
  { stage: "Qualified", count: 142, rate: 57 },
  { stage: "Estimate sent", count: 86, rate: 35 },
  { stage: "Negotiation", count: 41, rate: 17 },
  { stage: "Won", count: 23, rate: 9 },
];

const projectMixData = [
  { type: "Kitchen", count: 12, revenue: 580000 },
  { type: "Bath", count: 18, revenue: 420000 },
  { type: "Addition", count: 6, revenue: 720000 },
  { type: "Whole home", count: 3, revenue: 1240000 },
  { type: "Outdoor", count: 9, revenue: 285000 },
];

const cycleTimeData = [
  { month: "Nov", lead: 3.2, estimate: 6.4, close: 14.1 },
  { month: "Dec", lead: 2.8, estimate: 5.9, close: 13.4 },
  { month: "Jan", lead: 2.4, estimate: 5.1, close: 12.8 },
  { month: "Feb", lead: 2.1, estimate: 4.8, close: 11.9 },
  { month: "Mar", lead: 1.9, estimate: 4.2, close: 11.2 },
  { month: "Apr", lead: 1.6, estimate: 3.8, close: 10.4 },
];

const ownerPerformance = [
  { name: "Maria Chen", won: 12, value: 480000, rate: 34 },
  { name: "James Park", won: 9, value: 392000, rate: 29 },
  { name: "Priya Shah", won: 8, value: 318000, rate: 31 },
  { name: "David Liu", won: 6, value: 244000, rate: 22 },
];

function AnalyticsPage() {
  const totalPipeline = mockDeals.reduce((s, d) => s + d.value, 0);
  const wonValue = mockDeals.filter((d) => d.stage === "won").reduce((s, d) => s + d.value, 0);
  const activeProjects = mockProjects.filter((p) => p.status === "active").length;

  const kpis = [
    { label: "Pipeline value", value: formatMoney(totalPipeline), delta: "+12.4%", trend: "up" as const, icon: DollarSign, spark: [12, 18, 16, 22, 24, 28, 31] },
    { label: "Won this quarter", value: formatMoney(wonValue), delta: "+8.2%", trend: "up" as const, icon: Target, spark: [8, 10, 12, 11, 14, 17, 19] },
    { label: "Win rate", value: "24.6%", delta: "+2.1pt", trend: "up" as const, icon: TrendingUp, spark: [18, 19, 21, 20, 22, 23, 25] },
    { label: "Active projects", value: String(activeProjects), delta: "−3", trend: "down" as const, icon: Hammer, spark: [22, 24, 23, 21, 20, 19, 18] },
    { label: "Avg deal size", value: formatMoney(48200), delta: "+$3.4k", trend: "up" as const, icon: Activity, spark: [38, 40, 42, 44, 45, 47, 48] },
    { label: "Avg cycle (days)", value: "10.4", delta: "−1.8d", trend: "up" as const, icon: Clock, spark: [14, 13, 13, 12, 12, 11, 10] },
  ];

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">Pipeline, revenue, and operations across your renovation business.</p>
        </div>
        <Tabs defaultValue="quarter">
          <TabsList>
            <TabsTrigger value="month">30d</TabsTrigger>
            <TabsTrigger value="quarter">Quarter</TabsTrigger>
            <TabsTrigger value="year">Year</TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <k.icon className="h-4 w-4 text-muted-foreground" />
                <span className={`flex items-center gap-0.5 text-xs font-medium ${k.trend === "up" ? "text-emerald-600" : "text-rose-600"}`}>
                  {k.trend === "up" ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {k.delta}
                </span>
              </div>
              <div className="mt-2 text-xl font-semibold">{k.value}</div>
              <div className="text-[11px] text-muted-foreground">{k.label}</div>
              <div className="mt-2 h-8">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={k.spark.map((v, i) => ({ i, v }))}>
                    <Line type="monotone" dataKey="v" stroke="oklch(0.55 0.205 262)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">Pipeline velocity</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={pipelineVelocityData}>
                <defs>
                  <linearGradient id="pv" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="oklch(0.55 0.205 262)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="oklch(0.55 0.205 262)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0.005 250)" />
                <XAxis dataKey="week" stroke="oklch(0.55 0.02 250)" fontSize={11} />
                <YAxis stroke="oklch(0.55 0.02 250)" fontSize={11} />
                <Tooltip contentStyle={{ background: "white", border: "1px solid oklch(0.92 0.005 250)", borderRadius: 8 }} />
                <Area type="monotone" dataKey="value" stroke="oklch(0.55 0.205 262)" fill="url(#pv)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Lead sources</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={leadSourceData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                  {leadSourceData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: "white", border: "1px solid oklch(0.92 0.005 250)", borderRadius: 8 }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="mt-2 space-y-1">
              {leadSourceData.map((s, i) => (
                <div key={s.name} className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                    {s.name}
                  </span>
                  <span className="text-muted-foreground">{s.value}% · {s.deals} won</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Conversion funnel</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {conversionFunnel.map((s) => (
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
          <CardHeader><CardTitle className="text-base">Cycle time (days)</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={cycleTimeData}>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0.005 250)" />
                <XAxis dataKey="month" stroke="oklch(0.55 0.02 250)" fontSize={11} />
                <YAxis stroke="oklch(0.55 0.02 250)" fontSize={11} />
                <Tooltip contentStyle={{ background: "white", border: "1px solid oklch(0.92 0.005 250)", borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="lead" stroke={CHART_COLORS[0]} strokeWidth={2} name="Lead → qualified" />
                <Line type="monotone" dataKey="estimate" stroke={CHART_COLORS[1]} strokeWidth={2} name="Estimate sent" />
                <Line type="monotone" dataKey="close" stroke={CHART_COLORS[2]} strokeWidth={2} name="Time to close" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Project mix</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={projectMixData}>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0.005 250)" />
                <XAxis dataKey="type" stroke="oklch(0.55 0.02 250)" fontSize={11} />
                <YAxis stroke="oklch(0.55 0.02 250)" fontSize={11} tickFormatter={(v) => `$${v / 1000}k`} />
                <Tooltip contentStyle={{ background: "white", border: "1px solid oklch(0.92 0.005 250)", borderRadius: 8 }} formatter={(v) => formatMoney(Number(v))} />
                <Bar dataKey="revenue" radius={[6, 6, 0, 0]}>
                  {projectMixData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Owner leaderboard</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
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
            <Button variant="ghost" size="sm" className="mt-3 w-full text-xs">View full team report →</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
