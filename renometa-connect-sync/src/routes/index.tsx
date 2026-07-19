// src/routes/index.tsx
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AreaChart, Area, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { ROUTES } from "@/lib/routes";
import {
  Plus, FileText, CheckSquare, Contact as ContactIcon,
  Sparkles, UserPlus, DollarSign, Briefcase, CalendarDays, Zap, AlertTriangle,
  TrendingUp, Mail, Phone, ArrowRight, Clock, Filter, Flame,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useOrganization } from "@/lib/organization";
import { useTasks } from "@/lib/tasks-store";
import { useDeals } from "@/lib/deals-store";
import { usePipelines, useActivePipelineId } from "@/lib/pipelines";
import { useAICenterAgents } from "@/lib/ai-center-store";
import { useSmsMetaConversations } from "@/lib/sms-meta-conversations";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: DashboardPage });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtK(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 86_400_000);
}

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return m?.org_id ?? null;
}

// Sparkline noise generator seeded per KPI so each renders a distinct,
// stable-looking trend line — decorative only, not real historical data
// (the KPI value/trend numbers themselves are real).
const spark = (seed: number) =>
  Array.from({ length: 24 }, (_, i) => {
    const noise = Math.sin(i * 1.7 + seed * 3.1) * 6 + Math.cos(i * 0.9 + seed) * 4;
    return { v: 50 + Math.sin(i / 2.4 + seed) * 14 + noise + ((i * (seed + 2)) % 7) };
  });

const STAGE_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#ec4899"];

// ─── KPI cards ────────────────────────────────────────────────────────────────

type Kpi = {
  icon: React.ElementType; iconBg: string; iconColor: string; label: string;
  value: string; delta: string; up: boolean; stroke: string; seed: number; href: string;
};

function KpiCard({ k }: { k: Kpi }) {
  const Icon = k.icon;
  return (
    <Link to={k.href} className="group rounded-xl border border-border/70 bg-card p-4 flex flex-col gap-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:shadow-[0_4px_16px_-4px_rgba(15,23,42,0.08)] hover:border-border transition-all duration-200">
      <div className="flex items-center gap-2">
        <div className={cn("h-8 w-8 rounded-lg grid place-items-center", k.iconBg)}>
          <Icon className={cn("h-4 w-4", k.iconColor)} />
        </div>
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{k.label}</span>
      </div>
      <div className="text-[28px] leading-none font-semibold tracking-tight text-foreground">{k.value}</div>
      <div className="flex items-center gap-1 text-[11px]">
        <span className={cn("font-semibold", k.up ? "text-success" : "text-destructive")}>{k.up ? "↑" : "↓"} {k.delta}</span>
        <span className="text-muted-foreground">vs last period</span>
      </div>
      <div className="h-10 -mx-1 opacity-90 group-hover:opacity-100 transition-opacity">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={spark(k.seed)} margin={{ top: 2, bottom: 0, left: 0, right: 0 }}>
            <defs>
              <linearGradient id={`g${k.seed}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={k.stroke} stopOpacity={0.35} />
                <stop offset="100%" stopColor={k.stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="v" stroke={k.stroke} strokeWidth={1.75} fill={`url(#g${k.seed})`} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Link>
  );
}

function QuickActions({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  const actions = [
    { icon: ContactIcon, label: "New Contact", action: () => navigate({ to: ROUTES.CONTACTS }) },
    { icon: Plus, label: "New Deal", action: () => navigate({ to: ROUTES.PIPELINE }) },
    { icon: FileText, label: "New Estimate", action: () => navigate({ to: "/financials/estimates" }) },
    { icon: Zap, label: "Run Workflow", action: () => navigate({ to: ROUTES.AI_CENTER }) },
  ];
  return (
    <div className="rounded-xl border border-border/70 bg-card p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:shadow-[0_4px_16px_-4px_rgba(15,23,42,0.08)] transition-shadow">
      <div className="flex items-center gap-2 mb-3">
        <Zap className="h-4 w-4 text-gold-hover" />
        <span className="text-[13px] font-semibold tracking-tight">Quick Actions</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {actions.map(({ icon: Icon, label, action }) => (
          <button key={label} onClick={action} className="flex items-center gap-2 rounded-lg border border-border/70 bg-background hover:bg-secondary/60 hover:border-border px-3 py-2 text-xs font-medium transition-all">
            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Priority Banner — real, derived bullets only ───────────────────────────

function PriorityBanner({ bullets }: { bullets: { dot: string; text: string }[] }) {
  if (bullets.length === 0) return null;
  return (
    <div className="rounded-xl border border-border/70 bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)] px-5 py-3 flex items-center gap-2 overflow-x-auto">
      <div className="flex items-center gap-2 shrink-0 pr-3 mr-1 border-r border-border/70">
        <Flame className="h-4 w-4 text-orange" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70">Priority Today</span>
      </div>
      <ul className="flex items-center gap-1.5 flex-wrap">
        {bullets.map((it, i) => (
          <li key={i} className="flex items-center gap-2 rounded-full bg-secondary/60 hover:bg-secondary ring-1 ring-border/60 px-3 py-1 text-[12px] font-medium text-foreground/85 cursor-pointer transition-colors">
            <span className={cn("h-1.5 w-1.5 rounded-full", it.dot)} />
            {it.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Shared section shell ───────────────────────────────────────────────────

function SectionCard({ title, icon, iconColor, action, children }: {
  title: string; icon: React.ElementType; iconColor?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  const Icon = icon;
  return (
    <div className="rounded-xl border border-border/70 bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:shadow-[0_4px_16px_-4px_rgba(15,23,42,0.08)] transition-shadow duration-200 flex flex-col">
      <div className="flex items-center justify-between px-5 h-12 border-b border-border/70">
        <div className="flex items-center gap-2">
          <Icon className={cn("h-4 w-4", iconColor ?? "text-muted-foreground")} />
          <span className="text-[13px] font-semibold tracking-tight">{title}</span>
        </div>
        {action}
      </div>
      <div className="flex-1 p-5">{children}</div>
    </div>
  );
}

function CardAction({ children, to }: { children: React.ReactNode; to: string }) {
  return (
    <Link to={to} className="text-[11px] font-medium text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors">
      {children} <ArrowRight className="h-3 w-3" />
    </Link>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function DashboardPage() {
  const org = useOrganization();
  const allTasks = useTasks();
  const allDeals = useDeals();
  const pipelines = usePipelines();
  const activePipelineId = useActivePipelineId();
  const { instances: aiAgents } = useAICenterAgents();
  const { conversations } = useSmsMetaConversations();
  const navigate = useNavigate();

  const [userName, setUserName] = useState("there");
  const [kpiData, setKpiData] = useState({ leads: 0, leadsTrend: 0, pipelineNow: 0, pipelineTrend: 0, projects: 0, projectsTrend: 0, revenue: 0, revenueTrend: 0, bookingsToday: 0 });
  const [activity, setActivity] = useState<{ id: string; who: string; t: string; s: string; when: string }[]>([]);
  const [todaysAppointments, setTodaysAppointments] = useState<{ id: string; time: string; who: string; title: string; where: string }[]>([]);
  const [estimatesAwaiting, setEstimatesAwaiting] = useState<{ id: string; title: string; client_name: string; updated_at: string }[]>([]);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();

  const activePipeline = useMemo(
    () => pipelines.find((p) => p.id === activePipelineId) ?? pipelines[0] ?? null,
    [pipelines, activePipelineId],
  );

  const taskCounts = useMemo(() => {
    const now = new Date();
    const notDone = allTasks.filter(t => t.status !== "done");
    let overdue = 0, dueToday = 0, upcoming = 0;
    for (const t of notDone) {
      const days = daysBetween(new Date(t.due), now);
      if (days < 0) overdue++;
      else if (days === 0) dueToday++;
      else upcoming++;
    }
    const done = allTasks.filter(t => t.status === "done").length;
    const progressPct = (notDone.length + done) > 0 ? Math.round((done / (notDone.length + done)) * 100) : 0;
    return { overdue, dueToday, upcoming, progressPct };
  }, [allTasks]);

  const upcomingTasks = useMemo(() => {
    return allTasks
      .filter(t => t.status !== "done")
      .sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime())
      .slice(0, 5)
      .map(t => ({
        id: t.id, title: t.title,
        time: new Date(t.due).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
      }));
  }, [allTasks]);

  const pipelineDistribution = useMemo(() => {
    const openDeals = allDeals.filter(d => d.stage !== "won" && d.stage !== "lost");
    const totalValue = openDeals.reduce((s, d) => s + Number(d.value ?? 0), 0);
    const byStage = new Map<string, { value: number }>();
    for (const d of openDeals) {
      const entry = byStage.get(d.stage) ?? { value: 0 };
      entry.value += Number(d.value ?? 0);
      byStage.set(d.stage, entry);
    }
    const stageName = (slug: string) => activePipeline?.stages.find(s => s.id === slug)?.name ?? slug;
    const stages = [...byStage.entries()]
      .map(([slug, { value }], i) => ({
        slug, name: stageName(slug), value,
        pct: totalValue > 0 ? Math.round((value / totalValue) * 100) : 0,
        color: STAGE_COLORS[i % STAGE_COLORS.length],
      }))
      .sort((a, b) => b.value - a.value);

    const won = allDeals.filter(d => d.stage === "won");
    const lost = allDeals.filter(d => d.stage === "lost");
    const now = new Date();
    const wonMTD = won.filter(d => new Date(d.expectedClose).getMonth() === now.getMonth()).reduce((s, d) => s + d.value, 0);
    const lostMTD = lost.filter(d => d.lostAt && new Date(d.lostAt).getMonth() === now.getMonth()).reduce((s, d) => s + d.value, 0);
    const conversionRate = (won.length + lost.length) > 0 ? Math.round((won.length / (won.length + lost.length)) * 100) : 0;
    const avgDeal = openDeals.length > 0 ? totalValue / openDeals.length : 0;
    const avgAge = openDeals.length > 0 ? Math.round(openDeals.reduce((s, d) => s + d.ageDays, 0) / openDeals.length) : 0;
    const maxWidth = stages.length > 0 ? stages[0].value : 1;

    return {
      stages: stages.map(s => ({ ...s, barWidth: Math.max(28, Math.round((s.value / maxWidth) * 100)) })),
      totalValue, openCount: openDeals.length, conversionRate, avgDeal, avgAge, wonMTD, lostMTD,
    };
  }, [allDeals, activePipeline]);

  const attentionItems = useMemo(() => {
    const now = new Date();
    const items: { id: string; icon: React.ReactNode; color: string; bg: string; title: string; sub: string; badge: string; badgeColor: string; href: string; weight: number }[] = [];

    for (const t of allTasks) {
      if (t.status === "done") continue;
      const overdueDays = daysBetween(now, new Date(t.due));
      if (overdueDays > 0) {
        items.push({
          id: `task-${t.id}`, icon: <AlertTriangle className="h-4 w-4" />, color: "text-destructive", bg: "bg-destructive-soft ring-destructive-soft",
          title: t.title, sub: `Task overdue · ${overdueDays === 1 ? "1 day" : `${overdueDays} days`}`,
          badge: "Overdue", badgeColor: "bg-destructive-soft text-destructive-soft-foreground ring-1 ring-destructive-soft",
          href: "/tasks", weight: 100 + Math.min(overdueDays, 30),
        });
      }
    }
    for (const e of estimatesAwaiting) {
      const days = daysBetween(now, new Date(e.updated_at));
      if (days >= 2) {
        items.push({
          id: `est-${e.id}`, icon: <FileText className="h-4 w-4" />, color: "text-info", bg: "bg-info-soft ring-info-soft",
          title: "Estimate awaiting response", sub: `${e.title}${e.client_name ? ` · ${e.client_name}` : ""}`,
          badge: "Estimate", badgeColor: "bg-info-soft text-info-soft-foreground ring-1 ring-info-soft",
          href: "/financials/estimates", weight: 70 + Math.min(days, 20),
        });
      }
    }
    const openDeals = allDeals.filter(d => d.stage !== "won" && d.stage !== "lost");
    for (const d of openDeals) {
      if (d.ageDays >= 14) {
        items.push({
          id: `deal-${d.id}`, icon: <Clock className="h-4 w-4" />, color: "text-orange", bg: "bg-orange-soft ring-orange-soft",
          title: "Stale deal — no recent movement", sub: `${d.name}${d.contactName ? ` · ${d.contactName}` : ""}`,
          badge: "Waiting", badgeColor: "bg-orange-soft text-orange-soft-foreground ring-1 ring-orange-soft",
          href: ROUTES.PIPELINE, weight: 50 + Math.min(d.ageDays, 40),
        });
      }
    }
    items.sort((a, b) => b.weight - a.weight);
    return items.slice(0, 4);
  }, [allTasks, estimatesAwaiting, allDeals]);

  useEffect(() => {
    (async () => {
      const orgId = await getOrgId();
      if (!orgId) return;

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("first_name").eq("id", user.id).maybeSingle();
        if (profile?.first_name) setUserName(profile.first_name);
      }

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

      const [
        { count: projCount }, { count: projLastCount },
        { count: leadsCount }, { count: leadsLastCount },
        { data: openDeals }, { data: lastDeals },
        { data: paidInvoices }, { data: lastPaidInvoices },
        { count: bookingsCount },
        { data: apptRows },
        { data: estRows },
      ] = await Promise.all([
        supabase.from("projects").select("*", { count: "exact", head: true }).eq("org_id", orgId).in("status", ["planning","contracted","pre-construction","active","punch-list"]),
        supabase.from("projects").select("*", { count: "exact", head: true }).eq("org_id", orgId).in("status", ["planning","contracted","pre-construction","active","punch-list"]).lt("created_at", monthStart),
        supabase.from("leads").select("*", { count: "exact", head: true }).eq("org_id", orgId),
        supabase.from("leads").select("*", { count: "exact", head: true }).eq("org_id", orgId).lt("created_at", monthStart),
        supabase.from("deals").select("value").eq("org_id", orgId).eq("status", "open"),
        supabase.from("deals").select("value").eq("org_id", orgId).eq("status", "open").lt("created_at", monthStart),
        supabase.from("invoices").select("total_amount").eq("org_id", orgId).eq("status", "paid").gte("created_at", monthStart),
        supabase.from("invoices").select("total_amount").eq("org_id", orgId).eq("status", "paid").gte("created_at", lastMonthStart).lt("created_at", monthStart),
        supabase.from("appointments").select("*", { count: "exact", head: true }).eq("org_id", orgId).neq("status", "cancelled").gte("scheduled_at", todayStart).lt("scheduled_at", todayEnd),
        supabase.from("appointments").select("id, scheduled_at, contact_name, service").eq("org_id", orgId).neq("status", "cancelled").gte("scheduled_at", todayStart).lt("scheduled_at", todayEnd).order("scheduled_at", { ascending: true }).limit(6),
        supabase.from("estimates").select("id, title, client_name, status, updated_at, created_at").eq("org_id", orgId).in("status", ["sent", "viewed"]).order("updated_at", { ascending: false }).limit(10),
      ]);

      const pipelineNow = (openDeals ?? []).reduce((s: number, d: any) => s + Number(d.value ?? 0), 0);
      const pipelineLast = (lastDeals ?? []).reduce((s: number, d: any) => s + Number(d.value ?? 0), 0);
      const revNow = (paidInvoices ?? []).reduce((s: number, i: any) => s + Number(i.total_amount ?? 0), 0);
      const revLast = (lastPaidInvoices ?? []).reduce((s: number, i: any) => s + Number(i.total_amount ?? 0), 0);
      const pct = (a: number, b: number) => b === 0 ? 0 : ((a - b) / b) * 100;

      setKpiData({
        leads: leadsCount ?? 0, leadsTrend: pct(leadsCount ?? 0, leadsLastCount ?? 1),
        pipelineNow, pipelineTrend: pct(pipelineNow, pipelineLast || pipelineNow * 0.9),
        projects: projCount ?? 0, projectsTrend: pct(projCount ?? 0, projLastCount ?? 1),
        revenue: revNow, revenueTrend: pct(revNow, revLast || revNow * 1.02),
        bookingsToday: bookingsCount ?? 0,
      });

      setTodaysAppointments((apptRows ?? []).map((a: any) => ({
        id: a.id,
        time: new Date(a.scheduled_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
        who: a.contact_name || "—",
        title: `${a.service || "Appointment"} — ${a.contact_name || "—"}`,
        where: "Scheduled visit",
      })));

      setEstimatesAwaiting((estRows ?? []).map((e: any) => ({
        id: e.id, title: e.title, client_name: e.client_name, updated_at: e.updated_at || e.created_at,
      })));

      const [{ data: recentLeads }, { data: recentCalls }, { data: recentInvoices }] = await Promise.all([
        supabase.from("leads").select("id, created_at, contacts!contact_id(full_name), source").eq("org_id", orgId).order("created_at", { ascending: false }).limit(3),
        supabase.from("voice_calls").select("id, started_at, caller_number, direction, summary").eq("tenant_id", orgId).order("started_at", { ascending: false }).limit(2),
        supabase.from("invoices").select("id, created_at, total_amount, contacts!client_id(full_name)").eq("org_id", orgId).eq("status", "paid").order("created_at", { ascending: false }).limit(2),
      ]);

      const items: { id: string; who: string; t: string; s: string; when: string; at: string }[] = [];
      for (const l of recentLeads ?? []) {
        const name = (l as any).contacts?.full_name ?? "Someone";
        items.push({ id: `l${l.id}`, who: name, t: "New lead submitted", s: `via ${(l as any).source ?? "website"}`, when: "", at: l.created_at });
      }
      for (const c of recentCalls ?? []) {
        items.push({ id: `c${c.id}`, who: c.caller_number ?? "Unknown", t: `${c.direction === "outbound" ? "Outbound" : "Inbound"} call`, s: c.summary?.slice(0, 50) ?? "", when: "", at: c.started_at });
      }
      for (const inv of recentInvoices ?? []) {
        const name = (inv as any).contacts?.full_name ?? "Client";
        items.push({ id: `i${inv.id}`, who: name, t: "Invoice paid", s: fmtK(Number(inv.total_amount ?? 0)), when: "", at: inv.created_at });
      }
      items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      setActivity(items.slice(0, 5).map(it => ({ ...it, when: formatDistanceToNow(new Date(it.at), { addSuffix: true }) })));
    })();
  }, []);

  const KPIS: Kpi[] = [
    { icon: UserPlus, iconBg: "bg-info-soft", iconColor: "text-info", label: "New Leads", value: String(kpiData.leads), delta: `${Math.abs(Math.round(kpiData.leadsTrend))}%`, up: kpiData.leadsTrend >= 0, stroke: "#3b82f6", seed: 1, href: ROUTES.LEADS },
    { icon: DollarSign, iconBg: "bg-success-soft", iconColor: "text-success", label: "Pipeline Value", value: fmtK(kpiData.pipelineNow), delta: `${Math.abs(Math.round(kpiData.pipelineTrend))}%`, up: kpiData.pipelineTrend >= 0, stroke: "#10b981", seed: 2, href: ROUTES.PIPELINE },
    { icon: Briefcase, iconBg: "bg-violet-soft", iconColor: "text-violet", label: "Active Projects", value: String(kpiData.projects), delta: `${Math.abs(Math.round(kpiData.projectsTrend))}%`, up: kpiData.projectsTrend >= 0, stroke: "#8b5cf6", seed: 3, href: ROUTES.PROJECTS },
    { icon: DollarSign, iconBg: "bg-orange-soft", iconColor: "text-orange", label: "Revenue", value: fmtK(kpiData.revenue), delta: `${Math.abs(Math.round(kpiData.revenueTrend))}%`, up: kpiData.revenueTrend >= 0, stroke: "#f97316", seed: 4, href: "/financials/invoices" },
    { icon: CalendarDays, iconBg: "bg-gold-soft", iconColor: "text-gold-hover", label: "Bookings Today", value: String(kpiData.bookingsToday), delta: "0%", up: true, stroke: "#D9AB57", seed: 5, href: ROUTES.CALENDAR },
  ];

  const priorityBullets = useMemo(() => {
    const bullets: { dot: string; text: string }[] = [];
    if (taskCounts.overdue > 0) bullets.push({ dot: "bg-destructive", text: `${taskCounts.overdue} overdue task${taskCounts.overdue === 1 ? "" : "s"} require attention` });
    if (estimatesAwaiting.length > 0) bullets.push({ dot: "bg-orange", text: `${estimatesAwaiting.length} estimate${estimatesAwaiting.length === 1 ? "" : "s"} awaiting response` });
    if (kpiData.bookingsToday > 0) bullets.push({ dot: "bg-success", text: `${kpiData.bookingsToday} appointment${kpiData.bookingsToday === 1 ? "" : "s"} booked today` });
    if (kpiData.revenueTrend !== 0) bullets.push({ dot: "bg-info", text: `Revenue ${kpiData.revenueTrend > 0 ? "up" : "down"} ${Math.abs(Math.round(kpiData.revenueTrend))}% vs last period` });
    return bullets;
  }, [taskCounts, estimatesAwaiting, kpiData]);

  const aiStats = useMemo(() => {
    const active = aiAgents.filter(a => a.is_enabled);
    const runsThisWeek = aiAgents.reduce((s, a) => s + (a.runs_this_week ?? 0), 0);
    const hoursSaved = aiAgents.reduce((s, a) => s + (a.hours_saved ?? 0), 0);
    const avgSuccess = aiAgents.length > 0 ? Math.round(aiAgents.reduce((s, a) => s + (a.success_rate ?? 0), 0) / aiAgents.length) : 0;
    const top = [...aiAgents].sort((a, b) => (b.runs_this_week ?? 0) - (a.runs_this_week ?? 0)).slice(0, 5);
    return { activeCount: active.length, runsThisWeek, hoursSaved, avgSuccess, top };
  }, [aiAgents]);

  const inboxPreview = useMemo(() => {
    return [...conversations].sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime()).slice(0, 5);
  }, [conversations]);

  const unreadCount = useMemo(() => conversations.filter(c => c.unread).length, [conversations]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-foreground">Command Center</h1>
          <p className="text-[13px] text-muted-foreground mt-0.5">
            {greeting}, {userName}. Here's what's happening at {org.companyName || "your business"} today.
          </p>
        </div>
      </div>

      <PriorityBanner bullets={priorityBullets} />

      {/* KPI row — 5 tiles + Quick Actions, one 6-col grid, matching Lovable exactly */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {KPIS.map((k) => <KpiCard key={k.label} k={k} />)}
        <QuickActions navigate={navigate} />
      </div>

      {/* Needs Attention | Live Pipeline | Inbox */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SectionCard title="Needs Attention" icon={AlertTriangle} iconColor="text-destructive" action={<CardAction to="/tasks">View all</CardAction>}>
          <ul className="divide-y divide-border/70 -m-5">
            {attentionItems.length === 0 ? (
              <li className="px-5 py-8 text-center text-sm text-muted-foreground">You're all caught up</li>
            ) : attentionItems.map((it) => (
              <li key={it.id} className="flex items-center gap-3 px-5 py-3.5 hover:bg-secondary/40 transition-colors cursor-pointer">
                <Link to={it.href} className="contents">
                  <div className={cn("h-9 w-9 rounded-lg grid place-items-center ring-1", it.bg, it.color)}>{it.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate text-foreground">{it.title}</div>
                    <div className="text-xs text-muted-foreground truncate mt-0.5">{it.sub}</div>
                  </div>
                  <span className={cn("text-[10px] font-semibold px-2 py-1 rounded-md", it.badgeColor)}>{it.badge}</span>
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title="Live Pipeline" icon={TrendingUp} iconColor="text-success" action={<CardAction to={ROUTES.PIPELINE}>View pipeline</CardAction>}>
          {pipelineDistribution.stages.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No open deals yet.</p>
          ) : (
            <>
              <div className="flex items-center gap-5">
                <div className="relative h-44 w-44 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={pipelineDistribution.stages} dataKey="value" innerRadius={58} outerRadius={82} paddingAngle={2} stroke="none">
                        {pipelineDistribution.stages.map((s, i) => <Cell key={i} fill={s.color} />)}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-0 grid place-items-center text-center">
                    <div>
                      <div className="text-2xl font-semibold tracking-tight">{fmtK(pipelineDistribution.totalValue)}</div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">Total Pipeline</div>
                    </div>
                  </div>
                </div>
                <ul className="flex-1 space-y-2 text-sm">
                  {pipelineDistribution.stages.map((p) => (
                    <li key={p.slug} className="flex items-center gap-2.5">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color }} />
                      <span className="flex-1 text-[13px] text-foreground/80 truncate">{p.name}</span>
                      <span className="font-semibold text-[13px] tabular-nums">{fmtK(p.value)}</span>
                      <span className="text-muted-foreground text-[11px] w-10 text-right tabular-nums">{p.pct}%</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-5 grid grid-cols-5 gap-3 pt-4 border-t border-border/70">
                {[
                  { l: "Conversion", v: `${pipelineDistribution.conversionRate}%` },
                  { l: "Avg Deal", v: fmtK(pipelineDistribution.avgDeal) },
                  { l: "Avg Age", v: `${pipelineDistribution.avgAge}d` },
                  { l: "Won MTD", v: fmtK(pipelineDistribution.wonMTD) },
                  { l: "Lost MTD", v: fmtK(pipelineDistribution.lostMTD) },
                ].map((s) => (
                  <div key={s.l}>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.l}</div>
                    <div className="text-sm font-semibold mt-1 tabular-nums">{s.v}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </SectionCard>

        <SectionCard title="Inbox" icon={Mail} iconColor="text-violet" action={<CardAction to="/inbox">View inbox</CardAction>}>
          <div className="flex items-center gap-4 text-[13px] border-b border-border/70 pb-2 -mx-5 px-5 mb-1">
            <button className="font-semibold text-foreground border-b-2 border-primary pb-1.5 -mb-[9px]">All</button>
            <button className="text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors">
              Unread {unreadCount > 0 && <span className="rounded bg-primary text-primary-foreground text-[10px] font-semibold px-1.5 py-0.5">{unreadCount}</span>}
            </button>
            <button className="text-muted-foreground hover:text-foreground transition-colors">Mentions</button>
          </div>
          <ul className="divide-y divide-border/60 -mx-5">
            {inboxPreview.length === 0 ? (
              <li className="px-5 py-8 text-center text-sm text-muted-foreground">No conversations yet.</li>
            ) : inboxPreview.map((m) => (
              <li key={m.id} className={cn("flex items-center gap-3 px-5 py-3 cursor-pointer transition-colors", m.unread ? "bg-info-soft/40" : "hover:bg-secondary/40")}>
                <Link to="/inbox" className="contents">
                  <ContactAvatar id={m.id} name={m.contactName} size="md" />
                  <div className="flex-1 min-w-0">
                    <div className={cn("text-[13px] truncate", m.unread ? "font-semibold text-foreground" : "font-medium text-foreground")}>{m.contactName}</div>
                    <div className={cn("text-xs truncate mt-0.5", m.unread ? "text-foreground/70" : "text-muted-foreground")}>{m.preview}</div>
                  </div>
                  {m.unread && <span className="h-2 w-2 rounded-full bg-info shrink-0" />}
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>

      {/* Today's Tasks | AI Center | Sales Pipeline Snapshot */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SectionCard title="Today's Tasks" icon={CheckSquare} iconColor="text-info" action={<CardAction to="/tasks">View tasks</CardAction>}>
          <div className="flex gap-5">
            <div className="space-y-2 shrink-0">
              <div className="rounded-lg bg-destructive-soft ring-1 ring-destructive-soft text-destructive-soft-foreground px-4 py-3 w-24 text-center">
                <div className="text-2xl font-semibold tabular-nums">{taskCounts.overdue}</div><div className="text-[10px] font-medium uppercase tracking-wider mt-0.5">Overdue</div>
              </div>
              <div className="rounded-lg bg-orange-soft ring-1 ring-orange-soft text-orange-soft-foreground px-4 py-3 w-24 text-center">
                <div className="text-2xl font-semibold tabular-nums">{taskCounts.dueToday}</div><div className="text-[10px] font-medium uppercase tracking-wider mt-0.5">Due Today</div>
              </div>
              <div className="rounded-lg bg-info-soft ring-1 ring-info-soft text-info px-4 py-3 w-24 text-center">
                <div className="text-2xl font-semibold tabular-nums">{taskCounts.upcoming}</div><div className="text-[10px] font-medium uppercase tracking-wider mt-0.5">Upcoming</div>
              </div>
            </div>
            <div className="flex-1 min-w-0">
              {upcomingTasks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tasks due soon.</p>
              ) : (
                <ul className="space-y-2.5">
                  {upcomingTasks.map((tk) => (
                    <li key={tk.id} className="flex items-center gap-2.5 text-[13px] group">
                      <span className="flex-1 truncate group-hover:text-foreground text-foreground/85">{tk.title}</span>
                      <span className="text-[11px] text-muted-foreground tabular-nums">{tk.time}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-5">
                <div className="flex items-center justify-between text-[11px] mb-1.5">
                  <span className="text-muted-foreground uppercase tracking-wider">Progress</span>
                  <span className="font-semibold tabular-nums">{taskCounts.progressPct}%</span>
                </div>
                <div className="h-2 rounded-full bg-secondary overflow-hidden">
                  <div className="h-full rounded-full bg-success transition-all duration-500" style={{ width: `${taskCounts.progressPct}%` }} />
                </div>
              </div>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="AI Center" icon={Sparkles} iconColor="text-violet" action={<CardAction to={ROUTES.AI_CENTER}>Open AI Center</CardAction>}>
          <div className="grid grid-cols-4 gap-2.5">
            {[
              { l: "Active Agents", v: String(aiStats.activeCount), c: "text-violet" },
              { l: "Runs This Week", v: String(aiStats.runsThisWeek), c: "text-info" },
              { l: "Hours Saved", v: `${aiStats.hoursSaved.toFixed(1)}h`, c: "text-success" },
              { l: "Success Rate", v: `${aiStats.avgSuccess}%`, c: "text-orange" },
            ].map((s) => (
              <div key={s.l} className="rounded-lg bg-secondary/60 ring-1 ring-border/60 p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{s.l}</div>
                <div className={cn("text-lg font-semibold mt-1 tabular-nums", s.c)}>{s.v}</div>
              </div>
            ))}
          </div>
          <div className="mt-5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">Top AI Agents</div>
            {aiStats.top.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agents configured yet.</p>
            ) : (
              <ul className="space-y-2">
                {aiStats.top.map((a) => (
                  <li key={a.id} className="flex items-center justify-between text-[13px] py-1">
                    <span className="flex items-center gap-2.5 min-w-0">
                      <span className={cn("h-6 w-6 rounded-md grid place-items-center shrink-0", a.is_enabled ? "bg-violet-soft text-violet" : "bg-secondary text-muted-foreground")}>
                        <Sparkles className="h-3 w-3" />
                      </span>
                      <span className="text-foreground/85 truncate">{a.definition?.name ?? "Agent"}</span>
                    </span>
                    <span className={cn("flex items-center gap-1.5 text-[11px] font-medium shrink-0", a.is_enabled ? "text-success" : "text-muted-foreground")}>
                      <span className={cn("h-1.5 w-1.5 rounded-full", a.is_enabled ? "bg-success" : "bg-muted-foreground/50")} />
                      {a.is_enabled ? "Active" : "Idle"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Sales Pipeline Snapshot" icon={Filter} iconColor="text-success" action={<CardAction to={ROUTES.PIPELINE}>View pipeline</CardAction>}>
          {pipelineDistribution.stages.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No open deals yet.</p>
          ) : (
            <div className="grid grid-cols-[1.15fr_auto] gap-x-5 items-start">
              <div className="space-y-2.5">
                {pipelineDistribution.stages.map((r) => (
                  <div key={r.slug} className="flex flex-col items-center gap-1">
                    <div className="h-10 rounded-md flex items-center justify-center text-white text-[11px] font-semibold shadow-sm transition-all hover:brightness-110"
                      style={{ background: r.color, width: `${r.barWidth}%` }}>
                      {r.name}
                    </div>
                    <div className="text-[10px] text-muted-foreground tabular-nums">{fmtK(r.value)} · {r.pct}%</div>
                  </div>
                ))}
              </div>
              <div className="space-y-4 text-xs min-w-[110px]">
                {[
                  { l: "Win Rate", v: `${pipelineDistribution.conversionRate}%` },
                  { l: "Open Deals", v: String(pipelineDistribution.openCount) },
                  { l: "Avg Deal", v: fmtK(pipelineDistribution.avgDeal) },
                  { l: "Cycle Time", v: `${pipelineDistribution.avgAge}d` },
                ].map((s) => (
                  <div key={s.l}>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.l}</div>
                    <div className="text-base font-semibold mt-0.5 tabular-nums">{s.v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      {/* Recent Activity | Today's Schedule */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Recent Activity" icon={Clock} iconColor="text-info" action={<CardAction to={ROUTES.CALL_LOGS}>View all activity</CardAction>}>
          {activity.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No recent activity yet.</p>
          ) : (
            <ul className="-my-1">
              {activity.map((it) => (
                <li key={it.id} className="flex items-center gap-3 py-2 hover:bg-secondary/40 -mx-2 px-2 rounded-md transition-colors">
                  <ContactAvatar id={it.id} name={it.who} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium truncate">{it.t}</div>
                    <div className="text-xs text-muted-foreground truncate">{it.who} · {it.s}</div>
                  </div>
                  <div className="text-[11px] text-muted-foreground tabular-nums shrink-0">{it.when}</div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Today's Schedule" icon={CalendarDays} iconColor="text-violet" action={<CardAction to={ROUTES.CALENDAR}>View calendar</CardAction>}>
          {todaysAppointments.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No appointments today.</p>
          ) : (
            <ul className="space-y-1">
              {todaysAppointments.map((e) => (
                <li key={e.id} className="grid grid-cols-[56px_1fr] gap-3 items-center py-2 hover:bg-secondary/40 -mx-2 px-2 rounded-md transition-colors cursor-pointer">
                  <div className="text-[12px] font-semibold text-muted-foreground tabular-nums text-right">{e.time}</div>
                  <div className="flex items-center gap-3 min-w-0">
                    <ContactAvatar id={e.id} name={e.who} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium truncate">{e.title}</div>
                      <div className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5 truncate">
                        <Phone className="h-3 w-3 shrink-0" /> {e.where}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
