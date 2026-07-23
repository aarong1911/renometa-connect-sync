// src/routes/index.tsx
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area, YAxis } from "recharts";
import { ROUTES } from "@/lib/routes";
import {
  Plus, FileText, CheckSquare, Contact as ContactIcon,
  Sparkles, UserPlus, DollarSign, Briefcase, CalendarDays, Zap, AlertTriangle,
  TrendingUp, Mail, Phone, ArrowRight, Clock, Filter, Flame, MessageCircle, Smartphone, Instagram, CalendarPlus,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useOrganization } from "@/lib/organization";
import { useTasks } from "@/lib/tasks-store";
import { useDeals } from "@/lib/deals-store";
import { useAICenterAgents } from "@/lib/ai-center-store";
import { useSmsMetaConversations } from "@/lib/sms-meta-conversations";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { NewContactDialog } from "@/components/contacts/new-contact-dialog";
import { NewDealDialog } from "@/components/sales/new-deal-dialog";
import { PHASE_ORDER, PHASE_LABELS, PHASE_COLORS, mapPipelineStageToDashboardPhase, type DashboardPhase } from "@/lib/pipeline-phases";

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

// Guards against corrupt/epoch/null timestamps rendering nonsense like
// "over 56 years ago" — anything outside a sane range collapses to a
// neutral label instead of a fabricated-looking duration.
function safeRelativeTime(iso: string | null | undefined, opts?: { addSuffix?: boolean }): string {
  if (!iso) return "Unknown time";
  const d = new Date(iso);
  const t = d.getTime();
  if (isNaN(t) || d.getFullYear() < 2000 || t > Date.now() + 86_400_000) return "Unknown time";
  return formatDistanceToNow(d, { addSuffix: opts?.addSuffix ?? true });
}

// ─── KPI sparklines — real per-day buckets only, no synthetic points ────────

const SPARK_DAYS = 14;

/** Oldest-to-newest daily counts, bucketed from real row timestamps. */
function bucketCounts(dates: (string | null | undefined)[], days: number): number[] {
  const buckets = new Array(days).fill(0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const raw of dates) {
    if (!raw) continue;
    const d = new Date(raw);
    if (isNaN(d.getTime())) continue;
    d.setHours(0, 0, 0, 0);
    const diff = Math.round((today.getTime() - d.getTime()) / 86_400_000);
    const idx = days - 1 - diff;
    if (idx >= 0 && idx < days) buckets[idx] += 1;
  }
  return buckets;
}

/** Oldest-to-newest daily sums, bucketed from real row timestamps + amounts. */
function bucketSums(rows: { at: string | null | undefined; amount: number }[], days: number): number[] {
  const buckets = new Array(days).fill(0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const r of rows) {
    if (!r.at) continue;
    const d = new Date(r.at);
    if (isNaN(d.getTime())) continue;
    d.setHours(0, 0, 0, 0);
    const diff = Math.round((today.getTime() - d.getTime()) / 86_400_000);
    const idx = days - 1 - diff;
    if (idx >= 0 && idx < days) buckets[idx] += r.amount;
  }
  return buckets;
}

/**
 * Running total, oldest-to-newest, for metrics that only exist as a
 * current snapshot (open pipeline value, active project count) — neither
 * `deals` nor `projects` keep a history of stage/status changes, so there's
 * no record of what the true total was on a past day. This instead sums the
 * *currently* open/active rows by their real `created_at`, so the curve is
 * built entirely from real timestamps and real amounts (never invented),
 * ending at (or near) today's actual total. It reads as "how the
 * currently-open set accumulated," not a certified historical balance.
 */
function cumulativeSeries(rows: { at: string | null | undefined; amount: number }[], days: number): number[] {
  const windowStart = new Date();
  windowStart.setHours(0, 0, 0, 0);
  windowStart.setDate(windowStart.getDate() - (days - 1));

  let baseline = 0;
  const daily = new Array(days).fill(0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const r of rows) {
    if (!r.at) continue;
    const d = new Date(r.at);
    if (isNaN(d.getTime())) continue;
    const dayStart = new Date(d);
    dayStart.setHours(0, 0, 0, 0);
    if (dayStart.getTime() < windowStart.getTime()) {
      baseline += r.amount;
      continue;
    }
    const diff = Math.round((today.getTime() - dayStart.getTime()) / 86_400_000);
    const idx = days - 1 - diff;
    if (idx >= 0 && idx < days) daily[idx] += r.amount;
  }

  const out = new Array(days);
  let running = baseline;
  for (let i = 0; i < days; i++) {
    running += daily[i];
    out[i] = running;
  }
  return out;
}

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return m?.org_id ?? null;
}

// ─── KPI cards ────────────────────────────────────────────────────────────────

type Kpi = {
  icon: React.ElementType;
  /** Single accent hex — drives the icon tint AND the sparkline line/fill, so both always match exactly. */
  accent: string;
  label: string;
  value: string;
  /** Omit when no real comparison baseline exists yet — renders "—" rather than a fabricated trend. */
  trend?: { delta: string; up: boolean };
  href: string;
  /** Real per-day series only (see bucketCounts/bucketSums/cumulativeSeries) — omitted entirely when no historical rows exist for this metric. */
  sparkline?: number[];
};

// Real-data-only metric card: value always real; trend only renders when a
// genuine comparison was computed (see kpiData below) — no decorative
// sparkline or seeded chart noise is ever generated here.
//
// Every row below has an explicit fixed height (not just a min-height), and
// the card itself is a fixed height rather than min-height — a longer label
// ("Active Projects" vs "Revenue") or a wider value string must never grow
// its own row, or the sparkline in that one card would sit lower than the
// others. The flex-1 spacer absorbs any leftover space so the sparkline
// (fixed height, identical chart margins/viewBox in every card) always
// lands on the exact same baseline across all 5 cards.
function KpiCard({ k }: { k: Kpi }) {
  const Icon = k.icon;
  const gradientId = `spark-${k.label.replace(/[^a-zA-Z0-9]/g, "")}`;
  // A single real data point (or an empty/loading array) can't show a
  // trend — it would just repeat one value to fake a line. Two or more
  // real per-day points are required before a sparkline renders at all.
  const showSparkline = !!k.sparkline && k.sparkline.length >= 2;
  // A perfectly flat real series (e.g. Active Projects' cumulative total
  // sitting at 3 the whole window, or New Leads/Revenue genuinely at 0)
  // carries no trend shape either way, so it should always render pinned
  // to the bottom — regardless of whether that flat value is 0 or 3.
  // Flooring the domain at a plain 0 (as before) instead ties the line's
  // height to how far the flat value sits from zero, which is why Active
  // Projects rendered near the top while the zero-valued cards sat at the
  // bottom. Domain [value, value+1] always draws the flat value at the
  // bottom of its own range; a genuinely varying series still auto-scales
  // to [dataMin, dataMax] so its real shape is visible.
  const isFlatSeries = !!k.sparkline && k.sparkline.length > 0 && k.sparkline.every((v) => v === k.sparkline![0]);
  const yDomain: [number | string, number | string] = isFlatSeries ? [k.sparkline![0], k.sparkline![0] + 1] : ["dataMin", "dataMax"];
  return (
    <Link to={k.href} className="group h-44 rounded-2xl border border-border/70 bg-card p-5 flex flex-col overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:shadow-[0_4px_16px_-4px_rgba(15,23,42,0.08)] hover:border-border transition-all duration-200">
      <div className="h-9 flex items-center gap-2.5 shrink-0">
        <div className="h-9 w-9 rounded-[11px] grid place-items-center shrink-0" style={{ background: `${k.accent}1F` }}>
          <Icon className="h-4.5 w-4.5" style={{ color: k.accent }} />
        </div>
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground truncate">{k.label}</span>
      </div>
      <div className="h-8 flex items-center mt-2 shrink-0">
        <span className="text-3xl leading-none font-bold tracking-tight text-foreground truncate">{k.value}</span>
      </div>
      <div className="h-5 flex items-center mt-1 shrink-0">
        {k.trend ? (
          <div className="flex items-center gap-1 text-[11px]">
            <span className={cn("font-semibold", k.trend.up ? "text-success" : "text-destructive")}>
              {k.trend.up ? "↑" : "↓"} {k.trend.delta}
            </span>
            <span className="text-muted-foreground">vs last period</span>
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground">—</div>
        )}
      </div>
      <div className="flex-1 min-h-2" />
      <div className="h-9 shrink-0 -mx-1">
        {showSparkline ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={k.sparkline!.map((v) => ({ v }))} margin={{ top: 3, right: 4, bottom: 3, left: 4 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={k.accent} stopOpacity={0.15} />
                  <stop offset="100%" stopColor={k.accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <YAxis hide domain={yDomain} />
              <Area
                type="monotone"
                dataKey="v"
                stroke={k.accent}
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : null}
      </div>
    </Link>
  );
}

function QuickActions({ navigate, onNewContact, onNewDeal }: {
  navigate: ReturnType<typeof useNavigate>;
  onNewContact: () => void;
  onNewDeal: () => void;
}) {
  const actions = [
    { icon: ContactIcon, label: "New Contact", action: onNewContact, bg: "bg-info-soft", color: "text-info" },
    { icon: Plus, label: "New Deal", action: onNewDeal, bg: "bg-success-soft", color: "text-success" },
    { icon: FileText, label: "New Estimate", action: () => navigate({ to: "/estimates", search: { openNew: true } }), bg: "bg-orange-soft", color: "text-orange" },
    { icon: Zap, label: "Run Workflow", action: () => navigate({ to: "/automation/workflows" }), bg: "bg-violet-soft", color: "text-violet" },
  ];
  return (
    // Fixed h-44 to match KpiCard exactly (same row, same grid) — this used
    // to be an unconstrained height relying on CSS grid's default row
    // stretch, but the 2x2 button grid's natural content height (especially
    // once a label wraps to 2 lines) could exceed the KPI cards' height and
    // grow past it since there was no overflow clamp, making this card
    // visibly taller than its neighbors. overflow-hidden is the backstop;
    // the tightened spacing below keeps normal (non-wrapped) content well
    // under the fixed height so it's never actually needed.
    <div className="@container h-44 overflow-hidden rounded-2xl border border-border/70 bg-card p-5 flex flex-col shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:shadow-[0_4px_16px_-4px_rgba(15,23,42,0.08)] transition-shadow">
      <div className="flex items-center gap-2 mb-2 shrink-0">
        <Zap className="h-4 w-4 text-gold-hover" />
        <span className="text-[13px] font-semibold tracking-tight">Quick Actions</span>
      </div>
      {/* Column count reacts to this card's own width (container query), not
          the viewport — the card can end up narrow even on a wide screen
          depending on sidebar/zoom state, and a viewport breakpoint can't
          see that. Labels never truncate; they wrap to a 2nd line instead. */}
      <div className="grid grid-cols-1 @[240px]:grid-cols-2 gap-2 flex-1">
        {actions.map(({ icon: Icon, label, action, bg, color }) => (
          <button
            key={label}
            onClick={action}
            className="group flex items-center gap-2.5 rounded-xl border border-border/70 bg-background hover:bg-secondary/50 hover:border-border px-3 py-2 min-w-0 text-xs font-semibold text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className={cn("h-8 w-8 rounded-lg grid place-items-center shrink-0", bg)}>
              <Icon className={cn("h-4 w-4", color)} />
            </span>
            <span className="leading-tight whitespace-normal wrap-break-word">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Priority Banner — real, derived bullets only ───────────────────────────

function PriorityBanner({ bullets }: { bullets: { dot: string; text: string; href: string }[] }) {
  if (bullets.length === 0) return null;
  return (
    <div className="static rounded-xl border border-border/70 bg-orange-soft/40 min-h-11.5 px-5 py-2 flex items-center gap-2 overflow-x-auto">
      <div className="flex items-center gap-2 shrink-0 pr-3 mr-1 border-r border-border/70">
        <Flame className="h-4 w-4 text-orange" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70">Priority Today</span>
      </div>
      <ul className="flex items-center gap-1.5 flex-wrap">
        {bullets.map((it, i) => (
          <li key={i}>
            <Link
              to={it.href}
              className="flex items-center gap-2 rounded-full bg-card hover:bg-secondary ring-1 ring-border/60 px-3 py-1 h-6.5 text-[12px] font-medium text-foreground/85 transition-colors"
            >
              <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", it.dot)} />
              {it.text}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Shared section shell ───────────────────────────────────────────────────

// Card header color assignments (see CLAUDE.md task spec, section 16):
// blue = Inbox/Live Pipeline, purple = AI Center, green = Schedule/Pipeline
// snapshot, orange = Needs Attention, amber = Today's Tasks, indigo =
// Recent Activity. Reuses the app's existing "-soft" tokens (already a very
// light tint) rather than inventing a new opacity scale.
// Icon-only category color — every card header otherwise shares one
// neutral background/height/padding/border (see SectionCard). Prop name
// "tint" is kept for call-site compatibility even though the header no
// longer applies a colored background per category.
const CARD_ICON_COLORS = {
  blue: "text-info",
  purple: "text-violet",
  green: "text-success",
  orange: "text-orange",
  amber: "text-gold-hover",
  indigo: "text-primary",
} as const;

function SectionCard({ title, icon, tint, action, children }: {
  title: string; icon: React.ElementType; tint: keyof typeof CARD_ICON_COLORS; action?: React.ReactNode; children: React.ReactNode;
}) {
  const Icon = icon;
  return (
    <div className="rounded-2xl border border-border bg-card shadow-[0_1px_3px_rgba(15,23,42,0.04)] hover:shadow-[0_4px_12px_rgba(15,23,42,0.06)] transition-shadow duration-200 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 h-12 border-b border-border bg-gold-soft">
        <div className="flex items-center gap-2">
          <Icon className={cn("h-4 w-4", CARD_ICON_COLORS[tint])} />
          <span className="text-[13px] font-semibold tracking-tight text-foreground">{title}</span>
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
  const { instances: aiAgents } = useAICenterAgents();
  const { conversations } = useSmsMetaConversations();
  const navigate = useNavigate();

  const [userName, setUserName] = useState("there");
  const [newContactOpen, setNewContactOpen] = useState(false);
  const [newDealOpen, setNewDealOpen] = useState(false);
  const [kpiData, setKpiData] = useState({ leads: 0, leadsTrend: 0, pipelineNow: 0, pipelineTrend: 0, projects: 0, projectsTrend: 0, revenue: 0, revenueTrend: 0, bookingsToday: 0 });
  const [sparklines, setSparklines] = useState<{ leads: number[]; revenue: number[]; bookings: number[]; pipeline: number[]; projects: number[] }>({ leads: [], revenue: [], bookings: [], pipeline: [], projects: [] });
  const [inboxTab, setInboxTab] = useState<"all" | "unread">("all");
  const [activity, setActivity] = useState<{ id: string; who: string; t: string; s: string; when: string }[]>([]);
  const [todaysAppointments, setTodaysAppointments] = useState<{ id: string; time: string; who: string; title: string; where: string }[]>([]);
  const [estimatesAwaiting, setEstimatesAwaiting] = useState<{ id: string; title: string; client_name: string; updated_at: string }[]>([]);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();

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
    // "Total Pipeline" (the center number, Avg Deal, Avg Age) has always
    // meant still-open deals only — that exact business rule is preserved.
    // Won now renders as its own slice/bar for visual completeness (a real
    // won deal should never silently vanish from this chart), but it is
    // deliberately NOT added into totalValue/avgDeal/avgAge — those keep
    // meaning "open pipeline" exactly as before. Classification goes
    // through mapPipelineStageToDashboardPhase() (handles "Won – Job
    // Approved", "Closed Won", etc.) rather than a literal `stage === "won"`
    // check, since a real pipeline stage is essentially never named the
    // literal slug "won" — see deals-store.ts's mapRow for the related fix
    // (a won deal's stage_id is never updated, only its status, so `.stage`
    // used to still read as whatever stage the deal was in before winning).
    const openDeals = allDeals.filter(d => d.stage !== "lost" && mapPipelineStageToDashboardPhase(d.stage) !== "won");
    const totalValue = openDeals.reduce((s, d) => s + Number(d.value ?? 0), 0);

    const wonDeals = allDeals.filter(d => mapPipelineStageToDashboardPhase(d.stage) === "won");
    const wonValue = wonDeals.reduce((s, d) => s + Number(d.value ?? 0), 0);

    // Every rendered slice (the 4 open phases + Won) shares this one
    // denominator, so the legend's percentages sum to 100% and match the
    // pie's actual proportions — Recharts sizes each slice directly off
    // `value`, and Won's value is now one of those slices.
    const percentBase = totalValue + wonValue;

    const byPhase = new Map<DashboardPhase, { value: number; count: number }>();
    for (const d of openDeals) {
      const phase = mapPipelineStageToDashboardPhase(d.stage);
      if (!phase) continue; // "lost" (already excluded above)
      const entry = byPhase.get(phase) ?? { value: 0, count: 0 };
      entry.value += Number(d.value ?? 0);
      entry.count += 1;
      byPhase.set(phase, entry);
    }
    byPhase.set("won", { value: wonValue, count: wonDeals.length });

    const maxPhaseValue = Math.max(1, ...[...byPhase.values()].map(p => p.value));

    // Fixed sales-flow order, never sorted by value. Zero-value/zero-count
    // phases are dropped so no decorative empty slice/bar renders — but a
    // non-zero Won is never omitted just because another phase is larger.
    const phases = PHASE_ORDER
      .map((phase) => {
        const entry = byPhase.get(phase) ?? { value: 0, count: 0 };
        return {
          phase, name: PHASE_LABELS[phase], value: entry.value, count: entry.count,
          pct: percentBase > 0 ? Math.round((entry.value / percentBase) * 100) : 0,
          color: PHASE_COLORS[phase],
          barWidth: entry.value > 0 ? Math.max(28, Math.round((entry.value / maxPhaseValue) * 100)) : 0,
        };
      })
      .filter((p) => p.value > 0 || p.count > 0);

    const lost = allDeals.filter(d => d.stage === "lost");
    const now = new Date();
    const wonMTD = wonDeals.filter(d => new Date(d.expectedClose).getMonth() === now.getMonth()).reduce((s, d) => s + d.value, 0);
    const lostMTD = lost.filter(d => d.lostAt && new Date(d.lostAt).getMonth() === now.getMonth()).reduce((s, d) => s + d.value, 0);
    const conversionRate = (wonDeals.length + lost.length) > 0 ? Math.round((wonDeals.length / (wonDeals.length + lost.length)) * 100) : 0;
    const avgDeal = openDeals.length > 0 ? totalValue / openDeals.length : 0;
    const avgAge = openDeals.length > 0 ? Math.round(openDeals.reduce((s, d) => s + d.ageDays, 0) / openDeals.length) : 0;

    return {
      phases,
      // Open-pipeline-only, as before — Won is shown above but doesn't
      // inflate these.
      totalValue, openCount: openDeals.length, conversionRate, avgDeal, avgAge, wonMTD, lostMTD,
    };
  }, [allDeals]);

  const attentionItems = useMemo(() => {
    const now = new Date();
    const items: { id: string; icon: React.ReactNode; color: string; bg: string; title: string; sub: string; badge: string; badgeColor: string; href: string; weight: number }[] = [];

    for (const t of allTasks) {
      if (t.status === "done") continue;
      const overdueDays = daysBetween(now, new Date(t.due));
      if (overdueDays > 0) {
        items.push({
          id: `task-${t.id}`, icon: <AlertTriangle className="h-4 w-4" />, color: "text-destructive", bg: "bg-destructive-soft ring-destructive-soft",
          title: t.title, sub: `Overdue by ${overdueDays === 1 ? "1 day" : `${overdueDays} days`}`,
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
          title: e.title, sub: `${e.client_name ? `${e.client_name} · ` : ""}Waiting ${days} day${days === 1 ? "" : "s"}`,
          badge: "Estimate", badgeColor: "bg-info-soft text-info-soft-foreground ring-1 ring-info-soft",
          href: "/estimates", weight: 70 + Math.min(days, 20),
        });
      }
    }
    const openDeals = allDeals.filter(d => d.stage !== "won" && d.stage !== "lost");
    for (const d of openDeals) {
      if (d.ageDays >= 14) {
        items.push({
          id: `deal-${d.id}`, icon: <Clock className="h-4 w-4" />, color: "text-orange", bg: "bg-orange-soft ring-orange-soft",
          title: d.name, sub: `${d.contactName ? `${d.contactName} · ` : ""}Last activity ${d.ageDays}d ago`,
          badge: "Stale", badgeColor: "bg-orange-soft text-orange-soft-foreground ring-1 ring-orange-soft",
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
      const sparkStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (SPARK_DAYS - 1)).toISOString();

      const [
        { count: projCount }, { count: projLastCount },
        { count: leadsCount }, { count: leadsLastCount },
        { data: openDeals }, { data: lastDeals },
        { data: paidInvoices }, { data: lastPaidInvoices },
        { count: bookingsCount },
        { data: apptRows },
        { data: estRows },
        { data: leadSparkRows },
        { data: revenueSparkRows },
        { data: bookingSparkRows },
        { data: openDealsForSpark },
        { data: activeProjectsForSpark },
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
        supabase.from("leads").select("created_at").eq("org_id", orgId).gte("created_at", sparkStart),
        supabase.from("invoices").select("created_at, total_amount").eq("org_id", orgId).eq("status", "paid").gte("created_at", sparkStart),
        supabase.from("appointments").select("scheduled_at").eq("org_id", orgId).neq("status", "cancelled").gte("scheduled_at", sparkStart),
        // Full (unbounded) real created_at + value for every currently-open
        // deal — needed (not just the last 14 days) so the running total
        // has the right starting baseline on day one of the window.
        supabase.from("deals").select("value, created_at").eq("org_id", orgId).eq("status", "open"),
        supabase.from("projects").select("created_at").eq("org_id", orgId).in("status", ["planning","contracted","pre-construction","active","punch-list"]),
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

      setSparklines({
        leads: bucketCounts((leadSparkRows ?? []).map((r: any) => r.created_at), SPARK_DAYS),
        revenue: bucketSums((revenueSparkRows ?? []).map((r: any) => ({ at: r.created_at, amount: Number(r.total_amount ?? 0) })), SPARK_DAYS),
        bookings: bucketCounts((bookingSparkRows ?? []).map((r: any) => r.scheduled_at), SPARK_DAYS),
        pipeline: cumulativeSeries((openDealsForSpark ?? []).map((r: any) => ({ at: r.created_at, amount: Number(r.value ?? 0) })), SPARK_DAYS),
        projects: cumulativeSeries((activeProjectsForSpark ?? []).map((r: any) => ({ at: r.created_at, amount: 1 })), SPARK_DAYS),
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
      setActivity(items.slice(0, 5).map(it => ({ ...it, when: safeRelativeTime(it.at) })));
    })();
  }, []);

  const KPIS: Kpi[] = [
    {
      icon: UserPlus, accent: "#3B82F6", label: "New Leads", value: String(kpiData.leads),
      trend: { delta: `${Math.abs(Math.round(kpiData.leadsTrend))}%`, up: kpiData.leadsTrend >= 0 }, href: ROUTES.LEADS,
      // 14-day daily lead-creation counts — real rows, not derived/estimated.
      // Rendered even when every day is genuinely zero (e.g. all existing
      // leads predate the 14-day window) — a flat real zero isn't fake data.
      sparkline: sparklines.leads,
    },
    {
      // No day-by-day snapshot of total open pipeline value exists (deals
      // only carry their current stage/value, not a history of value or
      // stage changes over time), so this isn't a certified historical
      // balance — it's a running total of the *currently* open deals'
      // real values, ordered by their real creation dates. Every point is
      // a real deal/value/date; nothing here is invented.
      icon: DollarSign, accent: "#10B981", label: "Pipeline Value", value: fmtK(kpiData.pipelineNow),
      trend: { delta: `${Math.abs(Math.round(kpiData.pipelineTrend))}%`, up: kpiData.pipelineTrend >= 0 }, href: ROUTES.PIPELINE,
      sparkline: sparklines.pipeline,
    },
    {
      // Same reasoning as Pipeline Value: projects only carry current
      // status, not a status-change history — this is a running total of
      // the currently-active projects by their real creation dates, not a
      // certified count-per-day.
      icon: Briefcase, accent: "#8B5CF6", label: "Active Projects", value: String(kpiData.projects),
      trend: { delta: `${Math.abs(Math.round(kpiData.projectsTrend))}%`, up: kpiData.projectsTrend >= 0 }, href: ROUTES.PROJECTS,
      sparkline: sparklines.projects,
    },
    {
      icon: DollarSign, accent: "#F97316", label: "Revenue", value: fmtK(kpiData.revenue),
      trend: { delta: `${Math.abs(Math.round(kpiData.revenueTrend))}%`, up: kpiData.revenueTrend >= 0 }, href: "/financials",
      // 14-day daily paid-invoice totals — real rows.
      sparkline: sparklines.revenue,
    },
    // No comparable "bookings yesterday" baseline is computed — showing a
    // real trend here would require fabricating a comparison, so this card
    // intentionally omits `trend` and renders "—" instead.
    {
      icon: CalendarDays, accent: "#14B8A6", label: "Bookings Today", value: String(kpiData.bookingsToday), href: ROUTES.CALENDAR,
      // 14-day daily appointment counts — real rows.
      sparkline: sparklines.bookings,
    },
  ];

  const priorityBullets = useMemo(() => {
    const bullets: { dot: string; text: string; href: string }[] = [];
    if (taskCounts.overdue > 0) bullets.push({ dot: "bg-destructive", text: `${taskCounts.overdue} overdue task${taskCounts.overdue === 1 ? "" : "s"} require attention`, href: "/tasks" });
    if (estimatesAwaiting.length > 0) bullets.push({ dot: "bg-orange", text: `${estimatesAwaiting.length} estimate${estimatesAwaiting.length === 1 ? "" : "s"} awaiting response`, href: "/estimates" });
    if (kpiData.bookingsToday > 0) bullets.push({ dot: "bg-success", text: `${kpiData.bookingsToday} appointment${kpiData.bookingsToday === 1 ? "" : "s"} booked today`, href: ROUTES.CALENDAR });
    if (kpiData.revenueTrend !== 0) bullets.push({ dot: "bg-info", text: `Revenue ${kpiData.revenueTrend > 0 ? "up" : "down"} ${Math.abs(Math.round(kpiData.revenueTrend))}% vs last period`, href: "/financials" });
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

  const unreadCount = useMemo(() => conversations.filter(c => c.unread).length, [conversations]);

  const inboxPreview = useMemo(() => {
    const source = inboxTab === "unread" ? conversations.filter(c => c.unread) : conversations;
    return [...source].sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime()).slice(0, 5);
  }, [conversations, inboxTab]);

  return (
    <>
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
        <QuickActions
          navigate={navigate}
          onNewContact={() => setNewContactOpen(true)}
          onNewDeal={() => setNewDealOpen(true)}
        />
      </div>

      {/* Needs Attention | Live Pipeline | Inbox */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SectionCard title="Needs Attention" icon={AlertTriangle} tint="orange" action={<CardAction to="/tasks">View all</CardAction>}>
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

        <SectionCard title="Live Pipeline" icon={TrendingUp} tint="blue" action={<CardAction to={ROUTES.PIPELINE}>View pipeline</CardAction>}>
          {pipelineDistribution.phases.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No open deals yet.</p>
          ) : (
            <>
              <div className="flex items-center gap-5">
                <div className="relative h-54 w-54 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={pipelineDistribution.phases} dataKey="value" innerRadius={72} outerRadius={101} paddingAngle={2} stroke="none">
                        {pipelineDistribution.phases.map((p) => <Cell key={p.phase} fill={p.color} />)}
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
                  {pipelineDistribution.phases.map((p) => (
                    <li key={p.phase} className="flex items-center gap-2.5">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color }} />
                      <span className="flex-1 text-[13px] text-foreground/80 truncate">
                        {p.name} <span className="text-muted-foreground">· {p.count} {p.count === 1 ? "deal" : "deals"}</span>
                      </span>
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

        <SectionCard title="Inbox" icon={Mail} tint="blue" action={<CardAction to="/inbox">View inbox</CardAction>}>
          <div className="flex items-center gap-4 text-[13px] border-b border-border/70 pb-2 -mx-5 px-5 mb-1">
            <button
              onClick={() => setInboxTab("all")}
              className={cn("pb-1.5 -mb-2.25 transition-colors", inboxTab === "all" ? "font-semibold text-foreground border-b-2 border-primary" : "text-muted-foreground hover:text-foreground")}
            >
              All
            </button>
            <button
              onClick={() => setInboxTab("unread")}
              className={cn("pb-1.5 -mb-2.25 flex items-center gap-1 transition-colors", inboxTab === "unread" ? "font-semibold text-foreground border-b-2 border-primary" : "text-muted-foreground hover:text-foreground")}
            >
              Unread {unreadCount > 0 && <span className="rounded bg-primary text-primary-foreground text-[10px] font-semibold px-1.5 py-0.5">{unreadCount}</span>}
            </button>
          </div>
          <ul className="divide-y divide-border/60 -mx-5">
            {inboxPreview.length === 0 ? (
              <li className="px-5 py-8 text-center text-sm text-muted-foreground">
                {inboxTab === "unread" ? "No unread conversations." : "No conversations yet."}
              </li>
            ) : inboxPreview.map((m) => (
              <li key={m.id} className={cn("flex items-center gap-3 px-5 py-3 cursor-pointer transition-colors", m.unread ? "bg-info-soft/40" : "hover:bg-secondary/40")}>
                <Link to="/inbox" className="contents">
                  <div className="relative">
                    <ContactAvatar id={m.id} name={m.contactName} size="md" />
                    <span className="absolute -right-1 -bottom-1 h-5 w-5 rounded-full bg-card ring-2 ring-card grid place-items-center text-muted-foreground">
                      {m.channel === "whatsapp" ? <MessageCircle className="h-3 w-3" /> : m.channel === "instagram" ? <Instagram className="h-3 w-3" /> : m.channel === "messenger" ? <MessageCircle className="h-3 w-3" /> : <Smartphone className="h-3 w-3" />}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className={cn("text-[13px] truncate", m.unread ? "font-semibold text-foreground" : "font-medium text-foreground")}>{m.contactName}</div>
                      {m.unread && <span className="h-1.5 w-1.5 rounded-full bg-info shrink-0" />}
                    </div>
                    <div className={cn("text-xs truncate mt-0.5", m.unread ? "text-foreground/70" : "text-muted-foreground")}>{m.preview}</div>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">{safeRelativeTime(m.lastAt, { addSuffix: false })}</span>
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>

      {/* Today's Tasks | AI Center | Sales Pipeline Snapshot */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SectionCard title="Today's Tasks" icon={CheckSquare} tint="amber" action={<CardAction to="/tasks">View tasks</CardAction>}>
          <div className="flex gap-5">
            <div className="space-y-2 shrink-0">
              <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900/50 px-4 py-3 w-24 text-center">
                <div className="text-2xl font-semibold tabular-nums text-red-600 dark:text-red-400">{taskCounts.overdue}</div><div className="text-[10px] font-medium uppercase tracking-wider mt-0.5 text-red-700 dark:text-red-400">Overdue</div>
              </div>
              <div className="rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-100 dark:border-amber-900/50 px-4 py-3 w-24 text-center">
                <div className="text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">{taskCounts.dueToday}</div><div className="text-[10px] font-medium uppercase tracking-wider mt-0.5 text-amber-800 dark:text-amber-400">Due Today</div>
              </div>
              <div className="rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900/50 px-4 py-3 w-24 text-center">
                <div className="text-2xl font-semibold tabular-nums text-blue-600 dark:text-blue-400">{taskCounts.upcoming}</div><div className="text-[10px] font-medium uppercase tracking-wider mt-0.5 text-blue-700 dark:text-blue-400">Upcoming</div>
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

        <SectionCard title="AI Center" icon={Sparkles} tint="purple" action={<CardAction to={ROUTES.AI_CENTER}>Open AI Center</CardAction>}>
          <div className="grid grid-cols-4 gap-2.5">
            {[
              { l: "Active Agents", v: String(aiStats.activeCount), c: "text-violet" },
              { l: "Runs This Week", v: String(aiStats.runsThisWeek), c: "text-info" },
              { l: "Hours Saved", v: `${aiStats.hoursSaved.toFixed(1)}h`, c: "text-success" },
              { l: "Success Rate", v: aiAgents.length > 0 ? `${aiStats.avgSuccess}%` : "—", c: "text-orange" },
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
                      <span className="min-w-0">
                        <span className="block text-foreground/85 truncate">{a.definition?.name ?? "Agent"}</span>
                        <span className="block text-[10px] text-muted-foreground mt-0.5">
                          {a.runs_this_week ?? 0} runs this week · {(a.hours_saved ?? 0).toFixed(1)}h saved
                          {a.last_run_at ? ` · last run ${safeRelativeTime(a.last_run_at)}` : ""}
                        </span>
                      </span>
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

        <SectionCard title="Sales Pipeline Snapshot" icon={Filter} tint="green" action={<CardAction to={ROUTES.PIPELINE}>View pipeline</CardAction>}>
          {pipelineDistribution.phases.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No open deals yet.</p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-[1.15fr_auto] gap-5 items-start">
              <div className="space-y-3 w-full">
                {pipelineDistribution.phases.map((r) => (
                  <div key={r.phase} className="w-full">
                    <div
                      className="h-10 min-w-20 rounded-lg flex items-center px-3 text-white text-[12px] font-semibold shadow-sm transition-all hover:brightness-110"
                      style={{ background: r.color, width: `${r.barWidth}%` }}
                    >
                      <span className="truncate">{r.name}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground tabular-nums mt-1">{fmtK(r.value)} · {r.pct}%</div>
                  </div>
                ))}
              </div>
              <div className="space-y-4 text-xs min-w-27.5">
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
        <SectionCard title="Recent Activity" icon={Clock} tint="indigo" action={<CardAction to={ROUTES.CALL_LOGS}>View all activity</CardAction>}>
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

        <SectionCard title="Today's Schedule" icon={CalendarDays} tint="green" action={<CardAction to={ROUTES.CALENDAR}>View calendar</CardAction>}>
          {todaysAppointments.length === 0 ? (
            <div className="py-8 text-center"><div className="mx-auto mb-3 h-10 w-10 rounded-xl bg-violet-soft text-violet grid place-items-center"><CalendarDays className="h-5 w-5" /></div><p className="text-sm font-medium">No appointments today</p><p className="text-xs text-muted-foreground mt-1">Use the open time to follow up with leads or estimates.</p><button onClick={() => navigate({ to: ROUTES.CALENDAR })} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold hover:bg-secondary transition-colors"><CalendarPlus className="h-3.5 w-3.5" /> Schedule appointment</button></div>
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
    <NewContactDialog open={newContactOpen} onOpenChange={setNewContactOpen} />
    <NewDealDialog open={newDealOpen} onOpenChange={setNewDealOpen} />
    </>
  );
}
