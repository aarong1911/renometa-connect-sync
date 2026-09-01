// src/routes/index.tsx
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area, YAxis } from "recharts";
import { ROUTES } from "@/lib/routes";
import {
  Plus, FileText, CheckSquare, Contact as ContactIcon,
  Sparkles, UserPlus, DollarSign, Briefcase, CalendarDays, Zap, AlertTriangle,
  TrendingUp, Mail, ArrowRight, Clock, MessageCircle, Smartphone, Instagram,
  Workflow, MessageSquareWarning, Megaphone, CalendarClock, MapPin, User,
  LayoutDashboard, CheckCircle2, ChevronDown,
} from "lucide-react";
import { PageHeader } from "@/components/layout/app-shell";
import { supabase } from "@/lib/supabase";
import { useOrganization } from "@/lib/organization";
import { useTasks } from "@/lib/tasks-store";
import { isActiveStatus } from "@/lib/task-status";
import { parseDateOnlySafe, differenceInCalendarDaysSafe, todayDateOnly } from "@/lib/schedule-health";
import { useDeals } from "@/lib/deals-store";
import { useLeads } from "@/lib/leads-store";
import { useProjects } from "@/lib/projects-store";
import { useAICenterAgents } from "@/lib/ai-center-store";
import { useOrgId } from "@/lib/org-id";
import { queryKeys } from "@/lib/query-keys";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSmsMetaConversations } from "@/lib/sms-meta-conversations";
import { useGmailConversations } from "@/lib/gmail-conversations";
import { useWorkflows, type DbWorkflowRun } from "@/lib/workflows-store";
import { fetchGmailConnectionStatus } from "@/lib/gmail-sync-client";
import { GmailSenderAvatar } from "@/components/inbox/gmail-sender-avatar";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { NewContactDialog } from "@/components/contacts/new-contact-dialog";
import { NewDealDialog } from "@/components/sales/new-deal-dialog";
import { normalizePipelineStage } from "@/lib/pipeline-phases";
import { useMarketingCampaigns } from "@/lib/marketing-campaigns-store";
import { computeEffectiveEstimateTotals } from "@/lib/estimate-totals";
import {
  APPOINTMENT_STATUS_LABELS, APPOINTMENT_STATUS_TINT,
  type AppointmentStatus,
} from "@/lib/appointment-status";

// Recent Activity labels for appointment_activities.activity_type — the
// same deterministic wording the trigger already writes into `summary`
// (see log_appointment_activity() in the 20260807 migration), duplicated
// here as a lookup rather than trusting `summary` directly so a future
// summary wording tweak in the DB can't silently drift the dashboard's
// copy without a matching intentional update here.
const APPOINTMENT_ACTIVITY_LABELS: Record<string, string> = {
  created: "Appointment scheduled",
  rescheduled: "Appointment rescheduled",
  confirmed: "Appointment confirmed",
  started: "Appointment started",
  completed: "Appointment completed",
  reopened: "Appointment reopened",
  cancelled: "Appointment cancelled",
  restored: "Appointment restored",
  marked_no_show: "Appointment marked No Show",
  assigned: "Appointment assigned",
  unassigned: "Appointment unassigned",
  relationship_changed: "Appointment relationship changed",
};

export const Route = createFileRoute("/")({ component: DashboardPage });

// ─── Live Pipeline donut — Command-Center-only phase set ───────────────────
//
// Distinct from src/lib/pipeline-phases.ts's 5-phase grouping (new-leads/
// qualified/appointments/proposals/won) — that mapping folds Negotiation
// into "Proposals" and has no way to show it as its own segment. This
// dashboard's Live Pipeline card wants Negotiation broken out separately,
// so this is its own small, file-local mapping — it never touches deal/
// stage data, purely a presentation grouping for this one donut, same
// principle as pipeline-phases.ts's own header comment.
type CCPipelinePhase = "newLead" | "qualified" | "proposalSent" | "negotiation" | "won";

const CC_PHASE_ORDER: CCPipelinePhase[] = ["newLead", "qualified", "proposalSent", "negotiation", "won"];

const CC_PHASE_LABELS: Record<CCPipelinePhase, string> = {
  newLead: "New Lead",
  qualified: "Qualified",
  proposalSent: "Proposal Sent",
  negotiation: "Negotiation",
  won: "Won",
};

const commandCenterPipelineColors: Record<CCPipelinePhase, string> = {
  newLead: "#3B82F6",
  qualified: "#8B5CF6",
  proposalSent: "#F59E0B",
  negotiation: "#06B6D4",
  won: "#22C55E",
};

// Normalized-stage -> Command Center phase. Covers the same naming variants
// pipeline-phases.ts's STAGE_TO_PHASE does, just with Negotiation broken out
// on its own instead of folded into Proposal Sent, and no separate
// "Appointments" bucket (site-visit/appointment-scheduled stages read as
// still-Qualified here, since this donut has no slot for them). `null`
// means never shown (Lost). An unrecognized/custom stage falls back to
// "proposalSent" — a reasonable mid-funnel default — rather than being
// silently dropped from the total.
const CC_STAGE_TO_PHASE: Record<string, CCPipelinePhase | null> = {
  new: "newLead",
  newlead: "newLead",
  lead: "newLead",

  contacted: "qualified",
  qualified: "qualified",
  sitevisit: "qualified",
  sitevisitscheduled: "qualified",
  appointmentscheduled: "qualified",
  scheduled: "qualified",

  proposal: "proposalSent",
  proposalsent: "proposalSent",
  estimatesent: "proposalSent",
  estimateproposalsent: "proposalSent",
  estimate: "proposalSent",
  followup: "proposalSent",

  negotiation: "negotiation",

  won: "won",
  wonjobapproved: "won",
  jobapproved: "won",
  closedwon: "won",
  approved: "won",

  lost: null,
  closedlost: null,
};

function mapStageToCCPhase(rawStage: string): CCPipelinePhase | null {
  const key = normalizePipelineStage(rawStage);
  if (key in CC_STAGE_TO_PHASE) return CC_STAGE_TO_PHASE[key];
  return "proposalSent";
}

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
  if (!iso) return "";
  const d = new Date(iso);
  const t = d.getTime();
  if (isNaN(t) || d.getFullYear() < 2000 || t > Date.now() + 86_400_000) return "";
  return formatDistanceToNow(d, { addSuffix: opts?.addSuffix ?? true });
}

// ─── KPI sparklines — real per-day buckets only, no synthetic points ────────

const SPARK_DAYS = 14;
// Matches SPARK_DAYS — a 14-day window renders as a clearer, more compact
// Pipeline Pulse chart than a longer window while still showing real
// created/won/lost/stage-changed momentum.
const PULSE_DAYS = 14;

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

// ─── Pipeline Pulse timeline (S2B) ──────────────────────────────────────────
//
// The user-selectable period for Pipeline Pulse. Distinct from SPARK_DAYS/
// PULSE_DAYS above (those stay fixed 14-day windows for the KPI-row
// sparklines and the AI Center card's voice-call stat respectively — this
// feature is scoped to the Pipeline Pulse card only).
export type PulsePeriodKey = "7d" | "14d" | "30d" | "90d" | "year";

export const PULSE_PERIOD_OPTIONS: { key: PulsePeriodKey; label: string }[] = [
  { key: "7d", label: "Last 7 days" },
  { key: "14d", label: "Last 14 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "year", label: "This year" },
];

const PULSE_PERIOD_DAYS: Record<PulsePeriodKey, number> = { "7d": 7, "14d": 14, "30d": 30, "90d": 90, year: 366 };
// Bucket width per period. Widened for 30d (regression fix): daily buckets
// over 30 days produce a comb of one-day needle spikes (…0, 3, 0…) because
// real pipeline events cluster on a handful of days. 3-day grouping keeps
// ~10 points — enough to read momentum — while merging adjacent activity
// into a truthful shape instead of isolated triangles. 7d/14d stay daily
// (a short window with few points reads fine, and the headroomed Y domain
// on the chart softens any lone spike); 90d weekly and year monthly are
// unchanged. The Created/Won/Lost/Stage-Move COUNT tiles below the chart
// remain exact real counts, independent of this bucketing.
const PULSE_BUCKET_DAYS: Record<PulsePeriodKey, number> = { "7d": 1, "14d": 1, "30d": 3, "90d": 7, year: 30 };

/** Real calendar start for a period — "year" is Jan 1 of the current year, not a rolling 366-day window. */
function pulsePeriodStart(period: PulsePeriodKey, now: Date): Date {
  if (period === "year") return new Date(now.getFullYear(), 0, 1);
  const days = PULSE_PERIOD_DAYS[period];
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Buckets real event dates into fixed-width intervals from `start` to `now` — used for Pipeline Pulse's chart only (see PULSE_BUCKET_DAYS above for why a fixed bucket width, not calendar-month-aware, is an acceptable approximation here). */
function bucketByPeriod(dates: (string | null | undefined)[], start: Date, now: Date, bucketDays: number): number[] {
  const startTime = new Date(start).getTime();
  const totalDays = Math.max(1, Math.ceil((now.getTime() - startTime) / 86_400_000) + 1);
  const bucketCount = Math.max(1, Math.ceil(totalDays / bucketDays));
  const buckets = new Array(bucketCount).fill(0);
  for (const raw of dates) {
    if (!raw) continue;
    const d = new Date(raw);
    if (isNaN(d.getTime())) continue;
    const diffDays = Math.floor((d.getTime() - startTime) / 86_400_000);
    const idx = Math.floor(diffDays / bucketDays);
    if (idx >= 0 && idx < bucketCount) buckets[idx] += 1;
  }
  return buckets;
}

// Resolves org id AND first_name from one auth call + one profiles query —
// the main data effect below used to call supabase.auth.getUser() twice
// back-to-back (once here, once again just to read first_name) and issue
// two separate profiles selects. Merged into a single round trip.
async function resolveOrgAndUser(): Promise<{ orgId: string | null; firstName: string | null }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { orgId: null, firstName: null };
  const { data: profile } = await supabase.from("profiles").select("organization_id, first_name").eq("id", user.id).maybeSingle();
  let orgId = profile?.organization_id ?? null;
  if (!orgId) {
    const { data: membership } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
    orgId = membership?.org_id ?? null;
  }
  return { orgId, firstName: profile?.first_name ?? null };
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
    <Link to={k.href} className="group h-36 rounded-2xl border border-border/70 bg-card p-3.5 flex flex-col overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:shadow-[0_4px_16px_-4px_rgba(15,23,42,0.08)] hover:border-border transition-all duration-200">
      <div className="h-7 flex items-center gap-2 shrink-0">
        <div className="h-7 w-7 rounded-[9px] grid place-items-center shrink-0" style={{ background: `${k.accent}1F` }}>
          <Icon className="h-3.5 w-3.5" style={{ color: k.accent }} />
        </div>
        <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground truncate">{k.label}</span>
      </div>
      <div className="h-7 flex items-center mt-1 shrink-0">
        <span className="text-[26px] leading-none font-bold tracking-tight text-foreground truncate">{k.value}</span>
      </div>
      <div className="h-4 flex items-center mt-0.5 shrink-0">
        {k.trend ? (
          <div className="flex items-center gap-1 text-[10.5px]">
            <span className={cn("font-semibold", k.trend.up ? "text-success" : "text-destructive")}>
              {k.trend.up ? "↑" : "↓"} {k.trend.delta}
            </span>
            <span className="text-muted-foreground">vs last period</span>
          </div>
        ) : (
          <div className="text-[10.5px] text-muted-foreground">—</div>
        )}
      </div>
      <div className="flex-1 min-h-1" />
      <div className="h-7 shrink-0 -mx-1">
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
    <div className="@container h-36 overflow-hidden rounded-2xl border border-border/70 bg-card p-3.5 flex flex-col shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:shadow-[0_4px_16px_-4px_rgba(15,23,42,0.08)] transition-shadow">
      <div className="flex items-center gap-2 mb-1.5 shrink-0">
        <Zap className="h-3.5 w-3.5 text-gold-hover" />
        <span className="text-[12.5px] font-semibold tracking-tight">Quick Actions</span>
      </div>
      {/* Column count reacts to this card's own width (container query), not
          the viewport — the card can end up narrow even on a wide screen
          depending on sidebar/zoom state, and a viewport breakpoint can't
          see that. Labels never truncate; they wrap to a 2nd line instead. */}
      <div className="grid grid-cols-1 @[240px]:grid-cols-2 gap-1.5 flex-1">
        {actions.map(({ icon: Icon, label, action, bg, color }) => (
          <button
            key={label}
            onClick={action}
            className="group flex items-center gap-2 rounded-xl border border-border/70 bg-background hover:bg-secondary/50 hover:border-border px-2 py-1.5 min-w-0 text-[11.5px] font-semibold text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className={cn("h-6.5 w-6.5 rounded-lg grid place-items-center shrink-0", bg)}>
              <Icon className={cn("h-3.5 w-3.5", color)} />
            </span>
            <span className="leading-tight whitespace-nowrap">{label}</span>
          </button>
        ))}
      </div>
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

const CARD_HEADER_BACKGROUNDS = {
  blue: "bg-info-soft/75",
  purple: "bg-violet-soft/75",
  green: "bg-success-soft/70",
  orange: "bg-orange-soft/75",
  amber: "bg-gold-soft",
  indigo: "bg-primary/10",
} as const;

function SectionCard({ title, icon, tint, action, count, children, className }: {
  title: string; icon: React.ElementType; tint: keyof typeof CARD_ICON_COLORS; action?: React.ReactNode;
  /** Optional header count badge (e.g. Needs Attention's qualifying-item count). Omitted entirely when undefined — every other card is visually unchanged. */
  count?: number;
  children: React.ReactNode; className?: string;
}) {
  const Icon = icon;
  // Every operational card gets a restrained category tint in its header.
  // The body remains white so the dashboard stays light and readable.
  const headerBg = CARD_HEADER_BACKGROUNDS[tint];
  return (
    <div className={cn("rounded-2xl border border-border bg-card shadow-[0_1px_3px_rgba(15,23,42,0.04)] hover:shadow-[0_4px_12px_rgba(15,23,42,0.06)] transition-shadow duration-200 flex flex-col overflow-hidden", className)}>
      <div className={cn("flex items-center justify-between px-3 h-9 border-b border-border shrink-0", headerBg)}>
        <div className="flex items-center gap-1.5">
          <Icon className={cn("h-3.5 w-3.5", CARD_ICON_COLORS[tint])} />
          <span className="text-[13px] font-semibold tracking-tight text-foreground">{title}</span>
          {count !== undefined && (
            <span className="ml-0.5 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-muted-foreground tabular-nums">
              {count}
            </span>
          )}
        </div>
        {action}
      </div>
      <div className="flex-1 min-h-0 p-3">{children}</div>
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

// ─── Needs Attention — category model ──────────────────────────────────────
//
// The card body shows ONLY a fixed 3-column category grid (3×2 for the six
// categories today; the grid stays 3-wide and flows downward, so it can
// extend to 9 later with no layout change). Clicking a tile opens a
// portalled Popover with that category's records — the popover floats above
// the page and never participates in dashboard grid sizing, so selecting a
// category can't stretch the card or its row (the regression this replaces:
// an inline flex-1 detail list that grew with the record count and, under
// the row's 2xl:items-stretch, dragged Live Pipeline / Today's Tasks to the
// same height). The order here is the grid fill order AND the sort
// tie-break preference.
type AttentionCategory = "tasks" | "conversations" | "leads" | "deals" | "projects" | "estimates";

const ATTENTION_CATEGORY_ORDER: AttentionCategory[] = [
  "tasks", "conversations", "leads", "deals", "projects", "estimates",
];

const ATTENTION_CATEGORY_LABELS: Record<AttentionCategory, string> = {
  tasks: "Tasks", conversations: "Conversations", leads: "Leads",
  deals: "Deals", projects: "Projects", estimates: "Estimates",
};

type AttentionItem = {
  id: string;
  category: AttentionCategory;
  icon: React.ReactNode;
  color: string;
  bg: string;
  title: string;
  sub: string;
  badge: string;
  badgeColor: string;
  /** Deep-link target — a real route string. */
  href: string;
  /** Optional search params for the deep-link (e.g. { dealId }, { estimateId }, { contactId }). */
  search?: Record<string, string>;
  /** Higher = more urgent. Drives per-category sort order. */
  weight: number;
  /** Days-based urgency metric (overdue days / days waiting / age) — used only for the tile status line. */
  metricDays?: number;
  /** For "tasks" items only: the linked project_id, if any. Consumed by the
   *  Projects rollup category (grouping is by id, never by name). */
  projectId?: string | null;
};

/** Contextual footer link for a category's popover — every target route already exists. */
const ATTENTION_CATEGORY_FOOTER: Record<AttentionCategory, { to: string; label: string }> = {
  tasks: { to: "/tasks", label: "View all tasks" },
  conversations: { to: "/inbox", label: "View conversations" },
  leads: { to: "/leads", label: "View leads" },
  deals: { to: "/pipeline", label: "View pipeline" },
  projects: { to: "/projects", label: "View projects" },
  estimates: { to: "/estimates", label: "View estimates" },
};

/**
 * The short status line under a category tile's count. Customer-facing copy
 * only — never implementation language. An empty category reads "All clear"
 * (or "No issues" for Leads/Projects, which have no qualifying rule yet —
 * see the report; this is deliberately indistinguishable from a real "0"
 * to the user).
 */
function attentionCategoryHint(cat: AttentionCategory, list: AttentionItem[]): string {
  if (list.length === 0) return cat === "leads" || cat === "projects" ? "No issues" : "All clear";
  switch (cat) {
    case "tasks": {
      const max = Math.max(0, ...list.map((i) => i.metricDays ?? 0));
      return max > 0 ? `${max}d oldest overdue` : `${list.length} overdue`;
    }
    case "conversations": return `${list.length} unread`;
    case "deals": return `${list.length} stalled`;
    case "estimates": return `${list.length} to review`;
    // Projects is a ROLLUP: `list` here is one synthetic row per affected
    // project (see attentionByCategory), so `list.length` is the distinct
    // affected-project count, not a task count.
    case "projects": return `${list.length} affected project${list.length === 1 ? "" : "s"}`;
    default: return `${list.length} to review`;
  }
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function DashboardPage() {
  const org = useOrganization();
  const allTasks = useTasks();
  const allDeals = useDeals();
  const allLeads = useLeads();
  const { projects: allProjects } = useProjects();
  const { instances: aiAgents } = useAICenterAgents();
  const { conversations } = useSmsMetaConversations();
  const { conversations: gmailConversations } = useGmailConversations();
  const { workflows: allWorkflows, runs: workflowRuns } = useWorkflows();
  const allCampaigns = useMarketingCampaigns();
  const navigate = useNavigate();
  const orgId = useOrgId();

  const [newContactOpen, setNewContactOpen] = useState(false);
  const [newDealOpen, setNewDealOpen] = useState(false);
  const [inboxTab, setInboxTab] = useState<"all" | "unread">("all");
  // Connected Gmail account identity + photo (see gmail-connection-status.ts)
  // — used only so Recent Conversations can render the same real logo/photo the
  // Conversations page shows, via the shared GmailSenderAvatar component.
  const [gmailAccountEmail, setGmailAccountEmail] = useState<string | null>(null);
  const [gmailAccountPictureUrl, setGmailAccountPictureUrl] = useState<string | null>(null);
  // Pipeline Pulse's selected timeline — pure UI preference state (S2B),
  // not server business state; no migration, no persistence required.
  const [pulsePeriod, setPulsePeriod] = useState<PulsePeriodKey>("30d");
  //
  // userName, kpiData, sparklines, activity, estimateRows, nextBooking,
  // voiceCallsCount, leadSources — all formerly individual useState pieces
  // populated by one mount-only effect (Phase 8/10's "Command Center failed
  // to load..." console error was this effect's only failure signal).
  // Replaced (S2B) by dashboardSummaryQuery below — a single Query-backed
  // fetch covering exactly the same data, with a real staleTime/refetch
  // strategy instead of "fetch once, never again". See that query and the
  // derived consts right after it for where each of these now comes from.
  // ─── Dashboard summary — Query-backed (S2B) ────────────────────────────────
  // Replaces the former mount-only `useEffect(..., [])` + a dozen setState
  // calls covering the KPI row, sparklines, Next Booking, Recent Activity,
  // and Needs Attention's estimate/task data. Internal fetch logic below is
  // UNCHANGED from before this migration (same queries, same date-boundary
  // math, same shapes) — only the OUTER mechanism moved from "fetch once on
  // mount, never again" to a cached, invalidatable useQuery. New Leads
  // count/trend and Active Projects' CURRENT count moved OUT of this query
  // entirely (now derived from canonical useLeads()/useProjects() below —
  // see the S2B report); deal_activities/Pipeline Pulse also moved out (see
  // pipelinePulseQuery above, now its own dynamic-period query). Every
  // OTHER raw read here still has no canonical shared store to draw from
  // (invoices/appointments/estimates/tasks-for-Recent-Activity/voice_calls),
  // consistent with "a dedicated Query is fine for date-window aggregates
  // and dashboard-specific summaries" — this is exactly that, just no
  // longer mount-only.
  const dashboardSummaryQuery = useQuery({
    queryKey: orgId ? queryKeys.dashboard.summary(orgId) : ["dashboard", "summary", "pending"],
    enabled: !!orgId,
    // Medium tier (platform audit) — real-time freshness for this bucket
    // isn't critical (KPI counts, sparklines, recent-activity feed); a
    // moderate staleTime plus the QueryClient's default
    // refetchOnWindowFocus keeps it reasonably fresh without refetching
    // this fairly large multi-query bucket on every remount.
    staleTime: 60_000,
    queryFn: async () => {
      const { firstName } = await resolveOrgAndUser();

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
      // Bookings Today (Phase 10.3 correction pass) needs the organization's
      // own "today", not the visiting browser's — a booking at 11pm org-
      // local could otherwise be miscounted as tomorrow (or vice versa) if
      // the two timezones disagree. Scoped to just this one KPI rather than
      // reworking every other date boundary above (monthStart/todayStart),
      // which power unrelated cards not reported as broken.
      const { data: orgTzRow } = await supabase.from("organizations").select("timezone").eq("id", orgId!).maybeSingle();
      const orgTimezone = orgTzRow?.timezone || "America/New_York";
      const orgTzYmd = now.toLocaleDateString("en-CA", { timeZone: orgTimezone });
      // Classic no-library timezone-offset trick: the same instant rendered
      // as a wall-clock string in UTC vs. in the target zone, re-parsed as
      // local browser time — the difference is how far the zone sits from
      // UTC at `now` (DST-aware since it uses `now`, not a fixed offset).
      const orgTzOffsetMs =
        new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime() -
        new Date(now.toLocaleString("en-US", { timeZone: orgTimezone })).getTime();
      const orgTodayStart = new Date(new Date(`${orgTzYmd}T00:00:00Z`).getTime() + orgTzOffsetMs).toISOString();
      const orgTodayEnd = new Date(new Date(orgTodayStart).getTime() + 86_400_000).toISOString();
      const sparkStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (SPARK_DAYS - 1)).toISOString();
      const pulseStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (PULSE_DAYS - 1)).toISOString();

      const [
        { count: projLastCount },
        { data: openDeals }, { data: lastDeals },
        { data: paidInvoices }, { data: lastPaidInvoices },
        { count: bookingsCount },
        { data: leadSparkRows },
        { data: revenueSparkRows },
        { data: bookingSparkRows },
        { data: openDealsForSpark },
        { data: activeProjectsForSpark },
        { data: allEstimateRows },
        { data: completedTaskRows },
        { count: voiceCallsPulseCount },
        { data: leadSourceRows },
        { data: nextBookingRows },
        { data: apptActivityRows },
      ] = await Promise.all([
        supabase.from("projects").select("*", { count: "exact", head: true }).eq("org_id", orgId!).in("status", ["planning","contracted","pre-construction","active","punch-list"]).lt("created_at", monthStart),
        supabase.from("deals").select("value").eq("org_id", orgId!).eq("status", "open"),
        supabase.from("deals").select("value").eq("org_id", orgId).eq("status", "open").lt("created_at", monthStart),
        supabase.from("invoices").select("total_amount").eq("org_id", orgId).eq("status", "paid").gte("created_at", monthStart),
        supabase.from("invoices").select("total_amount").eq("org_id", orgId).eq("status", "paid").gte("created_at", lastMonthStart).lt("created_at", monthStart),
        // BOOKINGS TODAY = every appointment scheduled for today (organization
        // timezone) except cancelled/no_show — a no-show never happened, so
        // it doesn't belong in a same-day booking count any more than a
        // cancellation does. Completed appointments still count (they DID
        // occur today), matching "every appointment scheduled for today
        // except cancelled/no_show" rather than an "upcoming only" reading.
        supabase.from("appointments").select("*", { count: "exact", head: true }).eq("org_id", orgId).not("status", "in", "(cancelled,no_show)").gte("scheduled_at", orgTodayStart).lt("scheduled_at", orgTodayEnd),
        supabase.from("leads").select("created_at").eq("org_id", orgId).gte("created_at", sparkStart),
        supabase.from("invoices").select("created_at, total_amount").eq("org_id", orgId).eq("status", "paid").gte("created_at", sparkStart),
        supabase.from("appointments").select("scheduled_at").eq("org_id", orgId).neq("status", "cancelled").gte("scheduled_at", sparkStart),
        // Full (unbounded) real created_at + value for every currently-open
        // deal — needed (not just the last 14 days) so the running total
        // has the right starting baseline on day one of the window.
        supabase.from("deals").select("value, created_at").eq("org_id", orgId).eq("status", "open"),
        supabase.from("projects").select("created_at").eq("org_id", orgId).in("status", ["planning","contracted","pre-construction","active","punch-list"]),
        // Estimates card — every status, bounded to a reasonable page size
        // rather than 5 separate per-status count queries. Also reused
        // below for the Recent Activity feed's estimate-sent/viewed/
        // accepted events (title/client_name), so no second query needed.
        // Also the single source of truth for Needs Attention's stale-
        // estimate detection (see attentionItems above) — deriving from
        // this full set instead of a separate narrow query is what fixes
        // the "most-recently-touched-10" truncation bug from Phase 8.
        //
        // TODO(Phase 8, deferred): still capped at 500 rows. An org with
        // more than 500 estimates would get silently incomplete counts/
        // totals here with no on-screen indication. Safely removing the
        // cap needs either a paginated fetch or a server-side aggregate
        // (e.g. an RPC returning per-status counts/sums), not just a higher
        // limit — deferred rather than attempted in this correction pass.
        supabase.from("estimates").select("id, status, total, updated_at, valid_until, title, client_name, created_at, converted_deal_id, converted_project_id, deposit_amount").eq("org_id", orgId).order("updated_at", { ascending: false }).limit(500),
        // Tasks card "Completed recently" + Recent Activity — scoped
        // directly by tasks.org_id (Phase 10.1 added a real column here),
        // so this now includes Lead/Deal-linked tasks with no project too,
        // not just project-scoped ones.
        // "done" was never a valid tasks.status value (tasks_status_check
        // only allows not_started/in_progress/on_hold/completed/cancelled)
        // — this filter matched zero rows live until this fix.
        supabase.from("tasks").select("id, title, completed_at").eq("org_id", orgId).eq("status", "completed").not("completed_at", "is", null).order("completed_at", { ascending: false }).limit(5),
        // Fixed 14-day voice-call count for the AI Center card's own stat
        // (unrelated to Pipeline Pulse's now-dynamic period — see
        // pipelinePulseQuery above) — pulseStart here is just this constant
        // window, not the user-selected Pipeline Pulse timeline.
        supabase.from("voice_calls").select("*", { count: "exact", head: true }).eq("tenant_id", orgId).gte("started_at", pulseStart),
        // Marketing Activity card's "Leads by Source" — bare source
        // values only, grouped client-side (no existing aggregation for
        // this anywhere in the app). Bounded to a reasonable page size.
        supabase.from("leads").select("source").eq("org_id", orgId).limit(1000),
        // Next Booking card (Phase 10.3 correction pass) — the single
        // soonest non-terminal appointment, with the full detail set the
        // dedicated card needs (assignee, location/meeting link, duration).
        // Excludes every terminal status (cancelled/completed/no_show), not
        // just cancelled — a completed or no-show appointment is not a real
        // "next booking" even if its scheduled_at is still technically in
        // the future relative to when it was marked done.
        supabase.from("appointments")
          .select("id, scheduled_at, ends_at, duration_min, title, contact_name, service, status, address, meeting_url, assigned_to, assignee:profiles!appointments_assigned_to_fkey(first_name,last_name)")
          .eq("org_id", orgId)
          .not("status", "in", "(cancelled,completed,no_show)")
          .gte("scheduled_at", now.toISOString())
          .order("scheduled_at", { ascending: true })
          .limit(1),
        // Recent Activity — appointment lifecycle events, merged into the
        // same feed as Task/Lead/Estimate/Invoice/Call events below. Reads
        // from appointment_activities (Phase 10.3's trigger-owned audit
        // trail), never from application-side guessing.
        supabase.from("appointment_activities")
          .select("id, appointment_id, activity_type, summary, actor_id, created_at, appointments!inner(title, service, contact_name, org_id)")
          .eq("org_id", orgId)
          .order("created_at", { ascending: false })
          .limit(5),
      ]);

      const pipelineNow = (openDeals ?? []).reduce((s: number, d: any) => s + Number(d.value ?? 0), 0);
      const pipelineLast = (lastDeals ?? []).reduce((s: number, d: any) => s + Number(d.value ?? 0), 0);
      const revNow = (paidInvoices ?? []).reduce((s: number, i: any) => s + Number(i.total_amount ?? 0), 0);
      const revLast = (lastPaidInvoices ?? []).reduce((s: number, i: any) => s + Number(i.total_amount ?? 0), 0);
      const pct = (a: number, b: number): number | null => b === 0 ? null : ((a - b) / b) * 100;

      // New Leads count/trend and Active Projects' CURRENT count are no
      // longer computed here — derived from canonical useLeads()/
      // useProjects() in the component (see leadsKpi/projectsKpi below).
      // `projLastCount` (raw, below) is still this query's job — neither
      // store exposes created_at in a form that lets a point-in-time-in-
      // the-past count be reconstructed client-side, so the "vs last
      // month" % for Active Projects is finished in the component by
      // combining this raw count with the live canonical current count.
      const kpiData = {
        pipelineNow, pipelineTrend: pct(pipelineNow, pipelineLast),
        revenue: revNow, revenueTrend: pct(revNow, revLast),
        bookingsToday: bookingsCount ?? 0,
      };

      const sparklines = {
        leads: bucketCounts((leadSparkRows ?? []).map((r: any) => r.created_at), SPARK_DAYS),
        revenue: bucketSums((revenueSparkRows ?? []).map((r: any) => ({ at: r.created_at, amount: Number(r.total_amount ?? 0) })), SPARK_DAYS),
        bookings: bucketCounts((bookingSparkRows ?? []).map((r: any) => r.scheduled_at), SPARK_DAYS),
        pipeline: cumulativeSeries((openDealsForSpark ?? []).map((r: any) => ({ at: r.created_at, amount: Number(r.value ?? 0) })), SPARK_DAYS),
        projects: cumulativeSeries((activeProjectsForSpark ?? []).map((r: any) => ({ at: r.created_at, amount: 1 })), SPARK_DAYS),
      };

      const estimateRows = (allEstimateRows ?? []).map((e: any) => {
        // Shared with the Estimates page (src/lib/estimate-totals.ts) so
        // the two pages can't silently diverge on the total-calculation
        // FORMULA. This dashboard doesn't fetch estimate_items (that would
        // mean a second, per-estimate-items query on top of the 500-row
        // estimates query above), so `items` is always empty here and the
        // helper always returns the stored total unchanged — the Estimates
        // page still wins when an estimate's stored total has gone stale
        // relative to its real line items. Full parity is deferred; see
        // the TODO on the estimates query above.
        const stored = { subtotal: 0, tax_total: 0, total: Number(e.total ?? 0) };
        const { total } = computeEffectiveEstimateTotals(stored, []);
        return {
          id: e.id, status: e.status, total, updated_at: e.updated_at, valid_until: e.valid_until ?? null,
          title: e.title ?? "Untitled", client_name: e.client_name ?? null,
          converted_deal_id: e.converted_deal_id ?? null, converted_project_id: e.converted_project_id ?? null,
          deposit_amount: Number(e.deposit_amount ?? 0),
        };
      });

      const voiceCallsCount = voiceCallsPulseCount ?? 0;
      const leadSources = (leadSourceRows ?? []).map((r: any) => r.source).filter(Boolean);

      let nextBooking: {
        id: string; scheduledAt: string; endsAt: string; durationMin: number;
        title: string; contactName: string | null; status: string;
        address: string | null; meetingUrl: string | null; assigneeName: string | null;
      } | null = null;
      {
        const row = (nextBookingRows ?? [])[0] as any;
        if (row) {
          const assignee = row.assignee;
          const assigneeName = assignee ? `${assignee.first_name ?? ""} ${assignee.last_name ?? ""}`.trim() : null;
          const endsAt = row.ends_at ?? new Date(new Date(row.scheduled_at).getTime() + (row.duration_min ?? 60) * 60000).toISOString();
          nextBooking = {
            id: row.id,
            scheduledAt: row.scheduled_at,
            endsAt,
            durationMin: row.duration_min ?? 60,
            title: row.title || row.service || "Appointment",
            contactName: row.contact_name ?? null,
            status: row.status,
            address: row.address ?? null,
            meetingUrl: row.meeting_url ?? null,
            assigneeName: assigneeName || null,
          };
        }
      }

      const [{ data: recentLeads }, { data: recentCalls }, { data: recentInvoices }, { data: recentDealEvents }, { data: recentProjects }] = await Promise.all([
        // id/avatar_url/avatar_key added to the join (S2 avatar audit) — a
        // real Contact identity + its canonical avatar, not just a display
        // name, so Recent Activity can render the SAME avatar Inbox/
        // Contacts show for this Contact instead of a generated fallback
        // seeded by the wrong (non-contact) id.
        supabase.from("leads").select("id, created_at, contacts!contact_id(id, full_name, avatar_url, avatar_key), source").eq("org_id", orgId).order("created_at", { ascending: false }).limit(3),
        // contact_id + avatar join added — voice_calls does carry contact_id
        // when the caller matched a saved Contact (see
        // voice-conversations.ts); null for an unmatched number, which
        // correctly gets no ContactAvatar below (falls to the Phone icon).
        supabase.from("voice_calls").select("id, started_at, caller_number, direction, summary, contact_id, contacts!contact_id(avatar_url, avatar_key)").eq("tenant_id", orgId).order("started_at", { ascending: false }).limit(2),
        supabase.from("invoices").select("id, created_at, total_amount, contacts!client_id(id, full_name, avatar_url, avatar_key)").eq("org_id", orgId).eq("status", "paid").order("created_at", { ascending: false }).limit(2),
        // Deal lifecycle — REAL persisted events from deal_activities (the
        // same event log Pipeline Pulse reads, written by deals-store.ts's
        // logDealActivity() on every actual create/win/lose). Only the three
        // meaningful business milestones (created/won/lost) surface in the
        // feed — never `updated`/`contact_linked`/`stage_changed` noise. The
        // deal→contact join yields the canonical ContactAvatar identity for
        // the row; a deal with no primary contact falls back to the deal
        // name + the entity icon.
        supabase.from("deal_activities").select("id, activity_type, title, description, occurred_at, deals!deal_id(name, contact_id, contacts!contact_id(id, full_name, avatar_url, avatar_key))").eq("org_id", orgId).in("activity_type", ["created", "won", "lost"]).order("occurred_at", { ascending: false }).limit(4),
        // Project creation — `projects.created_at` is a real persisted
        // timestamp (NOT `updated_at`, which would fabricate a "created"
        // event from unrelated later edits). There is no project_activities
        // table, so this is the only honest project signal available; the
        // client_id→contacts join gives the row its canonical avatar.
        supabase.from("projects").select("id, name, created_at, contacts!client_id(id, full_name, avatar_url, avatar_key)").eq("org_id", orgId).order("created_at", { ascending: false }).limit(3),
      ]);

      // contactId/avatarUrl/avatarKey (S2 avatar audit): populated ONLY
      // when the source row actually has a stable Contact relationship —
      // leads/invoices/calls join to a real contacts row above; estimates
      // and tasks have no such link fetched here (estimates.client_id
      // exists but the shared allEstimateRows query above isn't joined to
      // contacts — left alone to avoid reshaping a query several other
      // cards depend on; tasks have no contact relationship in the schema
      // at all). Those items render the entity icon instead, same as
      // appointments already do — never a name-matched or made-up avatar.
      const items: { id: string; who: string; t: string; s: string; when: string; at: string; kind?: string; contactId?: string; avatarUrl?: string | null; avatarKey?: string | null }[] = [];
      for (const l of recentLeads ?? []) {
        const contact = (l as any).contacts;
        items.push({ id: `l${l.id}`, who: contact?.full_name ?? "Someone", t: "New lead submitted", s: `via ${(l as any).source ?? "website"}`, when: "", at: l.created_at, kind: "lead", contactId: contact?.id, avatarUrl: contact?.avatar_url ?? null, avatarKey: contact?.avatar_key ?? null });
      }
      for (const c of recentCalls ?? []) {
        const contact = (c as any).contacts;
        items.push({ id: `c${c.id}`, who: c.caller_number ?? "Unknown", t: `${c.direction === "outbound" ? "Outbound" : "Inbound"} call`, s: c.summary?.slice(0, 50) ?? "", when: "", at: c.started_at, kind: "call", contactId: (c as any).contact_id ?? undefined, avatarUrl: contact?.avatar_url ?? null, avatarKey: contact?.avatar_key ?? null });
      }
      for (const inv of recentInvoices ?? []) {
        const contact = (inv as any).contacts;
        items.push({ id: `i${inv.id}`, who: contact?.full_name ?? "Client", t: "Invoice paid", s: fmtK(Number(inv.total_amount ?? 0)), when: "", at: inv.created_at, kind: "invoice", contactId: contact?.id, avatarUrl: contact?.avatar_url ?? null, avatarKey: contact?.avatar_key ?? null });
      }
      // Deal created / won / lost — real deal_activities rows (see the query
      // above). `who` prefers the linked Contact's name so it reads like the
      // other Contact-anchored rows; the avatar comes from that same joined
      // contacts row (canonical S2 identity), or the entity icon when the
      // deal has no primary contact.
      for (const d of recentDealEvents ?? []) {
        const deal = (d as any).deals;
        const contact = deal?.contacts;
        const label = d.activity_type === "won" ? "Deal won" : d.activity_type === "lost" ? "Deal lost" : "Deal created";
        items.push({ id: `d${d.id}`, who: contact?.full_name ?? deal?.name ?? "Deal", t: label, s: contact?.full_name ? (deal?.name ?? "") : "", when: "", at: d.occurred_at, kind: "deal", contactId: contact?.id, avatarUrl: contact?.avatar_url ?? null, avatarKey: contact?.avatar_key ?? null });
      }
      // Project created — real `projects.created_at` (never `updated_at`).
      for (const p of recentProjects ?? []) {
        const contact = (p as any).contacts;
        items.push({ id: `p${p.id}`, who: contact?.full_name ?? p.name ?? "Project", t: "Project created", s: contact?.full_name ? (p.name ?? "") : "", when: "", at: p.created_at, kind: "project", contactId: contact?.id, avatarUrl: contact?.avatar_url ?? null, avatarKey: contact?.avatar_key ?? null });
      }
      // Estimate sent/viewed/approved — real status + real updated_at, not a
      // fabricated "sent" event log (this table has no separate history of
      // status transitions, so "when this row was last updated" is the
      // honest signal available). Canonical status vocabulary from
      // src/lib/estimate-status.ts (Phase 10.4) — "accepted" was dead code,
      // it never matched a live DB value.
      for (const e of (allEstimateRows ?? []).slice(0, 3)) {
        if (e.status === "sent" || e.status === "viewed" || e.status === "approved") {
          const label = e.status === "approved" ? "Estimate approved" : e.status === "viewed" ? "Estimate viewed" : "Estimate sent";
          items.push({ id: `e${e.id}`, who: e.client_name ?? "Client", t: label, s: e.title ?? "", when: "", at: e.updated_at ?? e.created_at, kind: "estimate" });
        }
      }
      for (const t of (completedTaskRows ?? []).slice(0, 3)) {
        items.push({ id: `t${t.id}`, who: "Task completed", t: t.title, s: "", when: "", at: t.completed_at, kind: "task" });
      }
      // Appointment lifecycle events (Phase 10.3 correction pass) — reads
      // appointment_activities (trigger-owned, see
      // supabase/migrations/20260807_calendar_appointments_completion.sql),
      // merged into this same time-ordered feed rather than a separate
      // Calendar-only activity list, so a scheduled/rescheduled/cancelled
      // appointment shows up next to Lead/Task/Invoice events exactly like
      // every other Recent Activity source.
      for (const a of (apptActivityRows ?? []).slice(0, 4)) {
        const appt = (a as any).appointments;
        const label = APPOINTMENT_ACTIVITY_LABELS[a.activity_type as string] ?? a.summary;
        const subject = appt?.title || appt?.service || "Appointment";
        const who = appt?.contact_name ? `${subject} with ${appt.contact_name}` : subject;
        items.push({ id: `aa${a.id}`, who, t: label, s: a.actor_id ? "" : "System", when: "", at: a.created_at, kind: "appointment" });
      }
      items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      const activity = items.slice(0, 6).map(it => ({ ...it, when: safeRelativeTime(it.at) }));

      return {
        firstName,
        kpiData, sparklines, estimateRows, voiceCallsCount, leadSources, nextBooking, activity,
        projLastCount: projLastCount ?? 0,
      };
    },
  });

  // Minimal error honesty (unchanged from the old mount-only effect): a
  // failed fetch here used to be indistinguishable from "this org genuinely
  // has no data" — every card would just quietly show its normal empty
  // state. This at least surfaces the failure during development.
  useEffect(() => {
    if (dashboardSummaryQuery.error && import.meta.env.DEV) {
      console.error("[Command Center] failed to load dashboard data:", (dashboardSummaryQuery.error as any)?.message ?? dashboardSummaryQuery.error);
    }
  }, [dashboardSummaryQuery.error]);

  // Defaults mirror the old useState initial values exactly, so every
  // downstream reference below (kpiData.revenue, sparklines.leads, etc.)
  // continues to work unchanged while the query is still loading.
  const kpiData = dashboardSummaryQuery.data?.kpiData ?? {
    pipelineNow: 0, pipelineTrend: null as number | null,
    revenue: 0, revenueTrend: null as number | null,
    bookingsToday: 0,
  };
  const sparklines = dashboardSummaryQuery.data?.sparklines ?? { leads: [], revenue: [], bookings: [], pipeline: [], projects: [] };
  const estimateRows = dashboardSummaryQuery.data?.estimateRows ?? [];
  const voiceCallsCount = dashboardSummaryQuery.data?.voiceCallsCount ?? 0;
  const leadSources = dashboardSummaryQuery.data?.leadSources ?? [];
  const nextBooking = dashboardSummaryQuery.data?.nextBooking ?? null;
  const activity = dashboardSummaryQuery.data?.activity ?? [];
  const userName = dashboardSummaryQuery.data?.firstName || "there";

  // New Leads — derived from canonical useLeads() (S2B), not a raw query.
  // Same semantics as before this migration: `count` is ALL leads ever
  // (not date-bounded — matches the original raw `leads` head-count with
  // no created_at filter), `lastCount` is how many existed as of the start
  // of this month, for the "vs last month" trend %. leads-store.ts's own
  // useSyncExternalStore already reflects every Lead mutation immediately
  // (create/update via its own emit()), so this KPI now updates the instant
  // a Lead is created anywhere in the app — no query, no realtime
  // subscription needed for this one.
  const leadsKpi = useMemo(() => {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    const lastCount = allLeads.filter(l => new Date(l.createdAt).getTime() < monthStart).length;
    return { count: allLeads.length, lastCount };
  }, [allLeads]);
  const leadsTrend = leadsKpi.lastCount === 0 ? null : ((leadsKpi.count - leadsKpi.lastCount) / leadsKpi.lastCount) * 100;

  // Active Projects — CURRENT count derived from canonical useProjects()
  // (S2B), using the REAL persisted status set confirmed via project-
  // status.ts and every other real consumer in the app (planning/
  // contracted/pre-construction/active/punch-list) — NOT mock-data.ts's
  // stale `ProjectStatus` type ("active"|"on-hold"|"cancelled"), which
  // doesn't match live data and was never the source of truth; see the
  // S2B report's status audit. `status` is compared as a plain string here
  // specifically because that TS type is known-wrong, not worked around by
  // guessing new values. Trend still combines this live count with
  // `projLastCount` (a dedicated query — useProjects() has no created_at
  // field to reconstruct a past-point-in-time count from).
  const ACTIVE_PROJECT_STATUSES = ["planning", "contracted", "pre-construction", "active", "punch-list"];
  const activeProjectsCount = useMemo(
    () => allProjects.filter(p => ACTIVE_PROJECT_STATUSES.includes(p.status as string)).length,
    [allProjects],
  );
  const projLastCount = dashboardSummaryQuery.data?.projLastCount ?? 0;
  const projectsTrend = projLastCount === 0 ? null : ((activeProjectsCount - projLastCount) / projLastCount) * 100;

  useEffect(() => {
    fetchGmailConnectionStatus().then((status) => {
      if (!status) return;
      setGmailAccountEmail(status.accountEmail);
      setGmailAccountPictureUrl(status.accountPictureUrl);
    });
  }, []);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();

  const taskCounts = useMemo(() => {
    const now = new Date();
    // isActiveStatus excludes both completed AND cancelled — a cancelled
    // task is not "not done" in the sense this widget means (it's not
    // pending, it's abandoned), same rule as the Tasks page's own overdue
    // calculation (src/lib/task-status.ts).
    const notDone = allTasks.filter(t => isActiveStatus(t.status));
    let overdue = 0, dueToday = 0, upcoming = 0;
    for (const t of notDone) {
      const days = daysBetween(new Date(t.due), now);
      if (days < 0) overdue++;
      else if (days === 0) dueToday++;
      else upcoming++;
    }
    const done = allTasks.filter(t => t.status === "completed").length;
    const progressPct = (notDone.length + done) > 0 ? Math.round((done / (notDone.length + done)) * 100) : 0;
    return { overdue, dueToday, upcoming, done, progressPct };
  }, [allTasks]);

  // ─── Next Up — the single soonest actionable future item, shown as one
  // compact row inside Today's Tasks (Phase 8 correction: replaces the
  // removed standalone Upcoming card without restoring it as its own
  // card). Only genuinely future-dated, real data is considered:
  //   - task.due (real)
  //   - estimate.valid_until for a still-open (sent/viewed) estimate —
  //     deliberately NOT estimate.updated_at, which is a past timestamp and
  //     would be backwards to treat as a future "next up" item. A real
  //     valid_until in the future genuinely is a forward-looking date
  //     ("follow up before this quote expires"). No project-milestone
  //     candidate exists — there is no milestone/date schema on `projects`
  //     to draw from honestly.
  //
  // Phase 10.3 correction pass: appointments were previously merged in
  // here too ("Consultation — Aaron" rendering inside Today's Tasks), which
  // is wrong — Today's Tasks must be task-only. Appointments now have
  // their own dedicated "Next Booking" card (see nextBooking state/query
  // above and the card below) instead.
  const nextUp = useMemo(() => {
    type NextUpItem = { id: string; kind: "task" | "estimate"; title: string; at: string; href: string };
    const now = Date.now();
    const candidates: NextUpItem[] = [];

    for (const t of allTasks) {
      if (!isActiveStatus(t.status)) continue;
      const at = new Date(t.due).getTime();
      if (!isNaN(at) && at >= now) candidates.push({ id: `nu-task-${t.id}`, kind: "task", title: t.title, at: t.due, href: "/tasks" });
    }
    for (const e of estimateRows) {
      if (e.status !== "sent" && e.status !== "viewed") continue;
      if (!e.valid_until) continue;
      const at = new Date(e.valid_until).getTime();
      if (!isNaN(at) && at >= now) candidates.push({ id: `nu-est-${e.id}`, kind: "estimate", title: e.title, at: e.valid_until, href: "/estimates" });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    return candidates[0];
  }, [allTasks, estimateRows]);

  const pipelineDistribution = useMemo(() => {
    // The donut renders every visible sales phase, including Won. Its
    // center value therefore uses representedValue (open + won) so the
    // displayed total is mathematically identical to the rendered slices.
    // Open-pipeline-only metrics such as Avg Deal and Avg Age continue to
    // use totalValue/openDeals and remain clearly separate below. Classification goes
    // through mapStageToCCPhase() (handles "Won – Job Approved", "Closed
    // Won", etc.) rather than a literal `stage === "won"` check, since a
    // real pipeline stage is essentially never named the literal slug "won"
    // — see deals-store.ts's mapRow for the related fix (a won deal's
    // stage_id is never updated, only its status, so `.stage` used to still
    // read as whatever stage the deal was in before winning).
    const openDeals = allDeals.filter((d) => {
      const phase = mapStageToCCPhase(d.stage);
      return phase !== null && phase !== "won";
    });
    const totalValue = openDeals.reduce((s, d) => s + Number(d.value ?? 0), 0);

    const wonDeals = allDeals.filter(d => mapStageToCCPhase(d.stage) === "won");
    const wonValue = wonDeals.reduce((s, d) => s + Number(d.value ?? 0), 0);

    // Every rendered slice (the 4 open phases + Won) shares this one
    // denominator, so the legend's percentages sum to 100% and match the
    // pie's actual proportions — Recharts sizes each slice directly off
    // `value`, and Won's value is now one of those slices.
    const representedValue = totalValue + wonValue;
    const percentBase = representedValue;

    const byPhase = new Map<CCPipelinePhase, { value: number; count: number }>();
    for (const d of openDeals) {
      const phase = mapStageToCCPhase(d.stage);
      if (!phase) continue; // "lost" (already excluded above)
      const entry = byPhase.get(phase) ?? { value: 0, count: 0 };
      entry.value += Number(d.value ?? 0);
      entry.count += 1;
      byPhase.set(phase, entry);
    }
    byPhase.set("won", { value: wonValue, count: wonDeals.length });

    const maxPhaseValue = Math.max(1, ...[...byPhase.values()].map(p => p.value));

    // Fixed sales-flow order, never sorted by value. Every phase is always
    // listed (even a genuinely zero-value/zero-count one, e.g. Negotiation
    // with no deals currently in it) so the legend never silently omits a
    // real stage — but only phases with a real value get a Pie `data` entry
    // below, so a zero-value phase is listed at 0% without ever drawing a
    // fabricated donut slice for it.
    const phases = CC_PHASE_ORDER.map((phase) => {
      const entry = byPhase.get(phase) ?? { value: 0, count: 0 };
      return {
        phase, name: CC_PHASE_LABELS[phase], value: entry.value, count: entry.count,
        pct: percentBase > 0 ? Math.round((entry.value / percentBase) * 100) : 0,
        color: commandCenterPipelineColors[phase],
        barWidth: entry.value > 0 ? Math.max(28, Math.round((entry.value / maxPhaseValue) * 100)) : 0,
      };
    });
    const pieSlices = phases.filter((p) => p.value > 0);

    const lost = allDeals.filter(d => mapStageToCCPhase(d.stage) === null);
    const now = new Date();
    const wonMTD = wonDeals.filter(d => new Date(d.expectedClose).getMonth() === now.getMonth()).reduce((s, d) => s + d.value, 0);
    const lostMTD = lost.filter(d => d.lostAt && new Date(d.lostAt).getMonth() === now.getMonth()).reduce((s, d) => s + d.value, 0);
    const conversionRate = (wonDeals.length + lost.length) > 0 ? Math.round((wonDeals.length / (wonDeals.length + lost.length)) * 100) : 0;
    const avgDeal = openDeals.length > 0 ? totalValue / openDeals.length : 0;
    const avgAge = openDeals.length > 0 ? Math.round(openDeals.reduce((s, d) => s + d.ageDays, 0) / openDeals.length) : 0;

    return {
      phases, pieSlices,
      // Open-pipeline-only, as before — Won is shown above but doesn't
      // inflate these.
      totalValue, representedValue, openCount: openDeals.length, conversionRate, avgDeal, avgAge, wonMTD, lostMTD,
    };
  }, [allDeals]);

  const attentionItemsAll = useMemo<AttentionItem[]>(() => {
    const now = new Date();
    const items: AttentionItem[] = [];

    for (const t of allTasks) {
      if (!isActiveStatus(t.status)) continue;
      // Live-test stabilization fix (Needs Attention vs Tasks/Overdue count
      // parity): this used to read `t.due`, which tasks-store silently
      // falls back to `created_at` when a task has no real due date — so
      // every UNDATED active task counted as "overdue" here, inflating the
      // Needs Attention count well past the Tasks page's Overdue tab (which
      // uses `dueDateRaw` via the shared schedule-health helpers). Now uses
      // the same real, nullable due date + same helpers, so Needs
      // Attention's overdue-task set is a true subset of the Tasks page's
      // Overdue count — an undated task is simply never overdue.
      const dueDate = parseDateOnlySafe(t.dueDateRaw);
      if (!dueDate) continue;
      const overdueDays = differenceInCalendarDaysSafe(todayDateOnly(), dueDate);
      if (overdueDays !== null && overdueDays > 0) {
        items.push({
          id: `task-${t.id}`, category: "tasks", icon: <AlertTriangle className="h-4 w-4" />, color: "text-destructive", bg: "bg-destructive-soft ring-destructive-soft",
          title: t.title, sub: `Overdue by ${overdueDays === 1 ? "1 day" : `${overdueDays} days`}`,
          badge: "Overdue", badgeColor: "bg-destructive-soft text-destructive-soft-foreground ring-1 ring-destructive-soft",
          // No per-task deep link exists (the Tasks page opens details in a
          // local-state drawer, not a URL param) — land on /tasks. Reported
          // as a known limitation.
          href: "/tasks", weight: 100 + Math.min(overdueDays, 30), metricDays: overdueDays,
          // Captured so the Projects category can roll these up by project_id
          // (never by name). A task with no project stays only in Tasks.
          projectId: t.projectId ?? null,
        });
      }
    }
    // Unread/needs-reply conversations — real (SMS/WhatsApp/Messenger/
    // Instagram carry a genuine is_read-derived `unread` flag; Gmail threads
    // never do yet, see gmail-conversations.ts, so none ever show up here —
    // that's accurate, not a gap to paper over). Weighted above estimates
    // per the requested priority order (overdue tasks, needs-reply
    // conversations, stale estimates, stale deals).
    // Every unread thread qualifies (no longer capped at 3) — the tile
    // count must reflect the COMPLETE category, and the detail list scrolls
    // internally so it can show more than 3 without resizing the card.
    const unreadConvs = [...conversations, ...gmailConversations].filter(c => c.unread);
    for (const c of unreadConvs) {
      const hoursOld = Math.max(0, (now.getTime() - new Date(c.lastAt).getTime()) / 36e5);
      items.push({
        id: `conv-${c.id}`, category: "conversations", icon: <Mail className="h-4 w-4" />, color: "text-info", bg: "bg-info-soft ring-info-soft",
        title: c.contactName, sub: `${c.preview || "New message"}`,
        badge: "Needs Reply", badgeColor: "bg-info-soft text-info-soft-foreground ring-1 ring-info-soft",
        // inbox.tsx's own deep-link effect resolves ?contactId to the real
        // contact+channel thread (same mechanism Recent Conversations and
        // Contacts' "Message" action use). No contactId (rare) → bare /inbox.
        href: "/inbox", search: (c as any).contactId ? { contactId: String((c as any).contactId) } : undefined,
        weight: 80 + Math.min(Math.round(hoursOld), 20), metricDays: Math.round(hoursOld / 24),
      });
    }
    // Stale estimates — derived from the FULL estimates dataset already
    // loaded for the Estimates card (estimateRows, up to 500 rows), not a
    // separate narrow query. Previously this ran off a `sent/viewed order
    // by updated_at desc limit 10` query, which kept only the 10 MOST
    // RECENTLY touched sent/viewed estimates and evaluated staleness after
    // that limit — a genuinely 30-day-stale estimate could be silently
    // excluded once an org had more than 10 outstanding ones, since it had
    // already been pushed out of the "top 10 by recency" window before the
    // staleness filter ever ran. Filtering the full set fixes that.
    //
    // Timestamp used: `updated_at`. There is no `sent_at` column on
    // `estimates` (confirmed — no such column exists anywhere in this
    // schema/codebase), so `updated_at` is the most defensible real
    // timestamp available for "how long has this been sitting." Expired
    // estimates (a real valid_until in the past) are excluded here — they
    // aren't "awaiting a response" anymore, they need a new estimate, not a
    // follow-up nudge.
    const staleEstimates = estimateRows
      .filter((e) => {
        if (e.status !== "sent" && e.status !== "viewed") return false;
        const isExpired = !!e.valid_until && new Date(e.valid_until) < now;
        if (isExpired) return false;
        return daysBetween(now, new Date(e.updated_at)) >= 2;
      })
      // Oldest updated_at first — the most genuinely stale estimates are
      // considered ahead of the merely-a-few-days-old ones before the
      // overall weight-sort/slice below picks the final visible set.
      .sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime());
    for (const e of staleEstimates) {
      const days = daysBetween(now, new Date(e.updated_at));
      items.push({
        id: `est-${e.id}`, category: "estimates", icon: <FileText className="h-4 w-4" />, color: "text-info", bg: "bg-info-soft ring-info-soft",
        title: e.title, sub: `${e.client_name ? `${e.client_name} · ` : ""}Waiting ${days} day${days === 1 ? "" : "s"}`,
        badge: "Estimate", badgeColor: "bg-info-soft text-info-soft-foreground ring-1 ring-info-soft",
        href: "/estimates", search: { estimateId: e.id }, weight: 55 + Math.min(days, 20), metricDays: days,
      });
    }
    // Changes requested — the customer responded, this always outranks a
    // merely-stale "still waiting" estimate since it needs a real edit.
    const changesRequested = estimateRows.filter((e) => e.status === "changes_requested");
    for (const e of changesRequested) {
      items.push({
        id: `est-cr-${e.id}`, category: "estimates", icon: <FileText className="h-4 w-4" />, color: "text-warning", bg: "bg-warning-soft ring-warning-soft",
        title: e.title, sub: `${e.client_name ? `${e.client_name} · ` : ""}Changes requested`,
        badge: "Changes Requested", badgeColor: "bg-warning-soft text-warning-soft-foreground ring-1 ring-warning-soft",
        href: "/estimates", search: { estimateId: e.id }, weight: 90,
      });
    }
    // Proposal expiring within 3 days — still sent/viewed, not yet expired.
    const expiringSoon = estimateRows.filter((e) => {
      if (e.status !== "sent" && e.status !== "viewed") return false;
      if (!e.valid_until) return false;
      const days = daysBetween(now, new Date(e.valid_until));
      return new Date(e.valid_until) >= now && days <= 3;
    });
    for (const e of expiringSoon) {
      const days = daysBetween(now, new Date(e.valid_until!));
      items.push({
        id: `est-exp-${e.id}`, category: "estimates", icon: <Clock className="h-4 w-4" />, color: "text-orange", bg: "bg-orange-soft ring-orange-soft",
        title: e.title, sub: `${e.client_name ? `${e.client_name} · ` : ""}Expires in ${days} day${days === 1 ? "" : "s"}`,
        badge: "Expiring Soon", badgeColor: "bg-orange-soft text-orange-soft-foreground ring-1 ring-orange-soft",
        href: "/estimates", search: { estimateId: e.id }, weight: 70, metricDays: days,
      });
    }
    // Approved but not yet converted to a Deal or Project, or (once
    // converted) not yet invoiced for its deposit — real, actionable
    // follow-ups, not a fabricated reminder.
    const approvedAwaiting = estimateRows.filter((e) => e.status === "approved" && !e.converted_deal_id && !e.converted_project_id);
    for (const e of approvedAwaiting) {
      items.push({
        id: `est-conv-${e.id}`, category: "estimates", icon: <CheckCircle2 className="h-4 w-4" />, color: "text-success", bg: "bg-success-soft ring-success-soft",
        title: e.title, sub: `${e.client_name ? `${e.client_name} · ` : ""}Approved — ready to convert`,
        badge: "Approved", badgeColor: "bg-success-soft text-success-soft-foreground ring-1 ring-success-soft",
        href: "/estimates", search: { estimateId: e.id }, weight: 65,
      });
    }
    const openDeals = allDeals.filter(d => d.stage !== "won" && d.stage !== "lost");
    for (const d of openDeals) {
      if (d.ageDays >= 14) {
        items.push({
          id: `deal-${d.id}`, category: "deals", icon: <Clock className="h-4 w-4" />, color: "text-orange", bg: "bg-orange-soft ring-orange-soft",
          title: d.name, sub: `${d.contactName ? `${d.contactName} · ` : ""}Last activity ${d.ageDays}d ago`,
          badge: "Stale", badgeColor: "bg-orange-soft text-orange-soft-foreground ring-1 ring-orange-soft",
          href: ROUTES.PIPELINE, search: { dealId: d.id }, weight: 30 + Math.min(d.ageDays, 20), metricDays: d.ageDays,
        });
      }
    }
    // NOTE: no atomic issue is ever pushed with category "leads" or
    // "projects". Leads has no qualifying rule yet (tile shows 0 / "No
    // issues"). Projects is a ROLLUP built downstream in attentionByCategory
    // from the Project-linked task items above — it summarises existing
    // atomic issues rather than adding new ones, so it is intentionally
    // absent here and never affects this array's length (the header total).
    items.sort((a, b) => (b.weight - a.weight)
      || (ATTENTION_CATEGORY_ORDER.indexOf(a.category) - ATTENTION_CATEGORY_ORDER.indexOf(b.category)));
    return items;
  }, [allTasks, estimateRows, allDeals, conversations, gmailConversations]);

  const projectNameById = useMemo(
    () => new Map(allProjects.map((p) => [p.id, p.name])),
    [allProjects],
  );

  // Qualifying items grouped by category (each list stays weight-sorted).
  // Every declared category always has an entry (possibly empty) so the
  // grid is stable and never reflows as counts change.
  const attentionByCategory = useMemo(() => {
    const map = new Map<AttentionCategory, AttentionItem[]>();
    for (const cat of ATTENTION_CATEGORY_ORDER) map.set(cat, []);
    for (const it of attentionItemsAll) map.get(it.category)!.push(it);

    // ── Projects = ROLLUP category ────────────────────────────────────────
    // The Projects tile/popover summarises Project-linked ATOMIC issues that
    // already exist elsewhere in attentionItemsAll — today, the only
    // supported Project issue is an overdue qualifying Task with a real
    // project_id. Structure is issue-type-agnostic (a per-project aggregate)
    // so milestone / estimate / financial Project signals can be folded in
    // later without touching the UI.
    //
    // CRITICAL: these synthetic rows are NOT appended to attentionItemsAll,
    // so they do NOT change the header total (attentionItemsAll.length =
    // unique atomic issues). A task that affects a project is counted once,
    // under Tasks; its Project row is an organisational summary, not a new
    // issue — the visible tile-count sum can therefore exceed the header,
    // by design. Tasks with no project_id never produce a Project row
    // (no "Unknown Project").
    const byProject = new Map<string, { taskCount: number; oldestOverdueDays: number }>();
    for (const it of map.get("tasks")!) {
      if (!it.projectId) continue;
      const agg = byProject.get(it.projectId) ?? { taskCount: 0, oldestOverdueDays: 0 };
      agg.taskCount += 1;
      agg.oldestOverdueDays = Math.max(agg.oldestOverdueDays, it.metricDays ?? 0);
      byProject.set(it.projectId, agg);
    }
    const projectRows: AttentionItem[] = [...byProject.entries()]
      .map(([projectId, agg]) => ({
        id: `proj-${projectId}`,
        category: "projects" as const,
        icon: <Briefcase className="h-4 w-4" />,
        color: "text-orange",
        bg: "bg-orange-soft ring-orange-soft",
        title: projectNameById.get(projectId) ?? "Project",
        sub: `${agg.taskCount} overdue task${agg.taskCount === 1 ? "" : "s"}`
          + (agg.oldestOverdueDays > 0 ? ` · Oldest ${agg.oldestOverdueDays}d overdue` : ""),
        badge: String(agg.taskCount),
        badgeColor: "bg-orange-soft text-orange-soft-foreground ring-1 ring-orange-soft",
        href: "/projects",
        search: { projectId },
        // Highest-impact first: most qualifying overdue tasks, then oldest
        // overdue task as tie-break.
        weight: agg.taskCount * 1000 + Math.min(agg.oldestOverdueDays, 999),
        metricDays: agg.oldestOverdueDays,
        projectId,
      }))
      .sort((a, b) => b.weight - a.weight);
    map.set("projects", projectRows);

    return map;
  }, [attentionItemsAll, projectNameById]);

  // Which category's popover is open (null = none). Only one at a time;
  // opened on tile click, closed by outside-click / Escape (Radix Popover
  // defaults) or by navigating from a record. Purely local UI state — the
  // popover is portalled, so this never affects dashboard layout.
  const [openAttentionCat, setOpenAttentionCat] = useState<AttentionCategory | null>(null);

  // Header count: the number of UNIQUE ATOMIC attention issues —
  // `attentionItemsAll.length` (overdue tasks + unread conversations +
  // qualifying deals + qualifying estimates). Never derived from visible
  // rows. NOTE: this is deliberately NOT the sum of the visible tile
  // counts. Projects is a rollup of Task issues, so its tile count adds to
  // the visible sum but not to the header — e.g. Tasks 33 + Deals 4 +
  // Projects 5 shows a visible sum of 42 while the header stays 37.


  const KPIS: Kpi[] = [
    {
      icon: UserPlus, accent: "#3B82F6", label: "New Leads", value: String(leadsKpi.count),
      trend: leadsTrend === null ? undefined : { delta: `${Math.abs(Math.round(leadsTrend))}%`, up: leadsTrend >= 0 }, href: ROUTES.LEADS,
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
      // Current value reads from pipelineDistribution.totalValue — the SAME
      // canonical useDeals()-derived open-pipeline sum the Live Pipeline
      // donut/legend already show (Command Center audit, S2), not the
      // separate one-shot `deals` query this used to read (kpiData.pipelineNow
      // — a snapshot from page load that never updated when a deal changed
      // elsewhere, and used a second, independently-written "is this deal
      // open" rule that could in principle disagree with the donut's). The
      // trend % below still needs a real "value as of last month" snapshot
      // the shared store doesn't carry, so it stays sourced from
      // kpiData.pipelineTrend (a dedicated one-shot query) — a documented,
      // narrower boundary, not the whole metric.
      icon: DollarSign, accent: "#10B981", label: "Pipeline Value", value: fmtK(pipelineDistribution.totalValue),
      trend: kpiData.pipelineTrend === null ? undefined : { delta: `${Math.abs(Math.round(kpiData.pipelineTrend))}%`, up: kpiData.pipelineTrend >= 0 }, href: ROUTES.PIPELINE,
      sparkline: sparklines.pipeline,
    },
    {
      // Same reasoning as Pipeline Value: projects only carry current
      // status, not a status-change history — this is a running total of
      // the currently-active projects by their real creation dates, not a
      // certified count-per-day.
      icon: Briefcase, accent: "#8B5CF6", label: "Active Projects", value: String(activeProjectsCount),
      trend: projectsTrend === null ? undefined : { delta: `${Math.abs(Math.round(projectsTrend))}%`, up: projectsTrend >= 0 }, href: ROUTES.PROJECTS,
      sparkline: sparklines.projects,
    },
    {
      icon: DollarSign, accent: "#F97316", label: "Revenue", value: fmtK(kpiData.revenue),
      trend: kpiData.revenueTrend === null ? undefined : { delta: `${Math.abs(Math.round(kpiData.revenueTrend))}%`, up: kpiData.revenueTrend >= 0 }, href: "/financials",
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

  // Phase 8 correction: this card previously showed "Runs This Week",
  // "Hours Saved", and "Success Rate" as if they were reliable weekly
  // metrics. They weren't:
  //   - agent_instances.runs_this_week (supabase/migrations/20260531_ai_center.sql)
  //     is a plain incrementing counter with no weekly reset job anywhere in
  //     this repo — it's really a lifetime total, just misnamed. Kept, but
  //     relabeled "Total Runs" below instead of removed, since the count
  //     itself is real.
  //   - hours_saved defaults to 0 and netlify/functions/run-agent.ts never
  //     writes to it for a normal agent run — it would just always read 0,
  //     which looks like real (bad) data rather than "not tracked." Removed.
  //   - success_rate's own update formula (run-agent.ts) adds a flat 100 to
  //     the running average on every success and is never touched at all on
  //     a failed run, so it trends toward 100% regardless of real outcomes.
  //     Removed rather than displaying a structurally-biased number.
  const aiStats = useMemo(() => {
    const active = aiAgents.filter(a => a.is_enabled);
    const totalRuns = aiAgents.reduce((s, a) => s + (a.runs_this_week ?? 0), 0);
    const top = [...aiAgents].sort((a, b) => (b.runs_this_week ?? 0) - (a.runs_this_week ?? 0)).slice(0, 5);
    return { activeCount: active.length, totalCount: aiAgents.length, totalRuns, top };
  }, [aiAgents]);

  const hasAiActivity = aiAgents.length > 0 || voiceCallsCount > 0;

  // Merges SMS/WhatsApp/Messenger/Instagram conversations with real Gmail
  // threads for Recent Conversations — reuses both hooks exactly as
  // Conversations does, no duplicate query. Gmail threads never carry unread=true today
  // (no read/unread tracking exists yet for Gmail — see gmail-conversations.ts),
  // so they simply never appear in the "Unread" tab, which is accurate rather
  // than fabricated.
  const allInboxConversations = useMemo(
    () => [...conversations, ...gmailConversations],
    [conversations, gmailConversations],
  );

  const unreadCount = useMemo(() => allInboxConversations.filter(c => c.unread).length, [allInboxConversations]);

  const inboxPreview = useMemo(() => {
    const source = inboxTab === "unread" ? allInboxConversations.filter(c => c.unread) : allInboxConversations;
    return [...source].sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime()).slice(0, 3);
  }, [allInboxConversations, inboxTab]);

  // ─── Workflows card — real workflow rows + real workflow_runs, no invented
  // run activity. ─────────────────────────────────────────────────────────
  const workflowsStats = useMemo(() => {
    const activeWorkflows = allWorkflows.filter(w => w.status === "active");
    const running = workflowRuns.filter(r => r.status === "running").length;
    const now = Date.now();
    const recentRuns = workflowRuns.filter(r => now - new Date(r.startedAt).getTime() <= 7 * 86_400_000);
    const recentSuccesses = recentRuns.filter(r => r.status === "success").length;
    const recentFailures = recentRuns.filter(r => r.status === "failed").length;

    // A workflow "requires attention" when its own most recent run failed —
    // computed from the real, already-sorted-desc workflow_runs list, never
    // fabricated.
    const latestRunByWorkflow = new Map<string, DbWorkflowRun>();
    for (const r of workflowRuns) {
      if (!latestRunByWorkflow.has(r.workflowId)) latestRunByWorkflow.set(r.workflowId, r);
    }
    const needingAttention = allWorkflows
      .filter(w => latestRunByWorkflow.get(w.id)?.status === "failed")
      .slice(0, 3);

    return { activeCount: activeWorkflows.length, totalCount: allWorkflows.length, running, recentSuccesses, recentFailures, needingAttention };
  }, [allWorkflows, workflowRuns]);

  // ─── Marketing Activity — real Campaigns (the live `campaigns` table,
  // reconciled — not duplicated — as of Phase 14.1) + real leads.source
  // breakdown. Sent count reflects campaigns whose backend processing has actually
  // completed (marketing-campaign-process-queue.ts), not merely a status
  // flag the user set.
  const marketingStats = useMemo(() => {
    const sent = allCampaigns.filter(c => c.status === "completed").length;
    const scheduled = allCampaigns.filter(c => c.status === "scheduled" || c.status === "queued" || c.status === "sending").length;
    const drafts = allCampaigns.filter(c => c.status === "draft").length;

    const bySource = new Map<string, number>();
    for (const s of leadSources) {
      bySource.set(s, (bySource.get(s) ?? 0) + 1);
    }
    const topSources = [...bySource.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([source, count]) => ({ source, count }));
    const maxSourceCount = Math.max(1, ...topSources.map(s => s.count));

    return { sent, scheduled, drafts, topSources, maxSourceCount, totalLeadsWithSource: leadSources.length };
  }, [allCampaigns, leadSources]);

  // ─── Pipeline Pulse — real deal_activities events, dynamic timeline ────────
  // Pipeline Pulse root-cause fix (S2A) + always-visible timeline (S2B):
  // deal_activities is a REAL event log, written by deals-store.ts's
  // logDealActivity() on every actual create/win/lose/stage-change — the
  // schema/logging were never the problem, a fixed 14-day window with an
  // all-or-nothing "not enough history" gate was. S2B replaces the fixed
  // window with the user-selectable `pulsePeriod` (default: last 30 days,
  // per this phase's spec) and makes the card ALWAYS render the chart/tiles
  // — real zeros for a quiet period, never a card-collapsing empty state.
  //
  // Query-backed (not mount-only): queryKeys.dashboard.pipelinePulse(orgId,
  // period) — a distinct cache entry per period, so switching back to an
  // already-viewed period is instant with no refetch, and the central
  // RealtimeBridge invalidates every period's cached entry together on any
  // deal_activities change (see realtime-bridge.tsx), satisfying "create/
  // move/win a deal -> Pipeline Pulse updates without refresh" with no
  // component-owned subscription.
  const pipelinePulseQuery = useQuery({
    queryKey: orgId ? queryKeys.dashboard.pipelinePulse(orgId, pulsePeriod) : ["dashboard", "pipelinePulse", "pending"],
    queryFn: async () => {
      const now = new Date();
      const start = pulsePeriodStart(pulsePeriod, now);
      const { data, error } = await supabase
        .from("deal_activities")
        .select("activity_type, occurred_at")
        .eq("org_id", orgId!)
        .in("activity_type", ["created", "won", "lost", "stage_changed"])
        .gte("occurred_at", start.toISOString())
        .order("occurred_at", { ascending: true });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({ activity_type: r.activity_type as string, occurred_at: r.occurred_at as string }));
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });
  const dealActivityRows = pipelinePulseQuery.data ?? [];

  const pipelinePulse = useMemo(() => {
    const now = new Date();
    const start = pulsePeriodStart(pulsePeriod, now);
    const bucketDays = PULSE_BUCKET_DAYS[pulsePeriod];

    const created = dealActivityRows.filter(r => r.activity_type === "created");
    const won = dealActivityRows.filter(r => r.activity_type === "won");
    const lost = dealActivityRows.filter(r => r.activity_type === "lost");
    const stageChanged = dealActivityRows.filter(r => r.activity_type === "stage_changed");

    return {
      // Real signal, purely informational now (S2B) — the chart/tiles
      // render unconditionally regardless of this value; it only toggles
      // the small "No pipeline movement in this period" note.
      hasWindowActivity: dealActivityRows.length > 0,
      createdSpark: bucketByPeriod(created.map(r => r.occurred_at), start, now, bucketDays),
      wonSpark: bucketByPeriod(won.map(r => r.occurred_at), start, now, bucketDays),
      lostSpark: bucketByPeriod(lost.map(r => r.occurred_at), start, now, bucketDays),
      createdCount: created.length, wonCount: won.length, lostCount: lost.length, stageChangedCount: stageChanged.length,
    };
  }, [dealActivityRows, pulsePeriod]);

  // All-time fallback counts for the "no activity in the window" message —
  // derived from the SAME canonical allDeals (useDeals()) the Live Pipeline
  // donut already uses, not a new query and not fabricated: real current
  // deal statuses, just not scoped to the last PULSE_DAYS days.
  const pipelineAllTime = useMemo(() => ({
    open: allDeals.filter(d => d.status === "open").length,
    won: allDeals.filter(d => d.status === "won").length,
    lost: allDeals.filter(d => d.status === "lost").length,
  }), [allDeals]);

  return (
    <>
    <div className="space-y-2">
      <PageHeader
        icon={LayoutDashboard}
        iconBg="bg-info-soft"
        iconColor="text-info"
        title="Command Center"
        subtitle={`${greeting}, ${userName}. Here's what's happening at ${org.companyName || "your business"} today.`}
      />

      {/* KPI row — 5 tiles + Quick Actions, one 6-col grid, matching Lovable exactly */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {KPIS.map((k) => <KpiCard key={k.label} k={k} />)}
        <QuickActions
          navigate={navigate}
          onNewContact={() => setNewContactOpen(true)}
          onNewDeal={() => setNewDealOpen(true)}
        />
      </div>

      {/* One combined 12-col grid for every card below the KPI row —
          items-start so natural content height is used instead of CSS
          grid's default row-stretch (which was creating large empty areas
          in shorter cards next to a taller neighbor). Explicit col-spans
          per breakpoint approximate the suggested compact arrangement
          (Needs Attention 4 / Live Pipeline 5 / Upcoming 3, etc. at 2xl)
          while degrading gracefully: 2 columns at lg, supporting cards
          wrapping to a second row at xl, single column below lg. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start 2xl:items-stretch">
        <div className="col-span-1 lg:col-span-6 2xl:col-span-4 h-full">
          <SectionCard title="Needs Attention" icon={AlertTriangle} tint="orange" count={attentionItemsAll.length} action={<CardAction to="/tasks">View all</CardAction>} className="h-full 2xl:min-h-[198px]">
            {/* Card body = ONLY the category grid (3 cols x 2 rows for the
                six categories). No inline detail list, no flex-1 panel, no
                internal scroll region here, so the card's height is fixed
                by its own small grid and can never stretch the dashboard
                row. `h-full` + `grid-rows-2` lets the tiles fill the card's
                2xl:min-h-[198px] cleanly (no dead whitespace) without ever
                exceeding it. Records live in a portalled Popover (below). */}
            <div className="-m-3 grid h-full grid-cols-2 sm:grid-cols-3 sm:grid-rows-2 gap-px bg-border/60">
              {ATTENTION_CATEGORY_ORDER.map((cat) => {
                const list = attentionByCategory.get(cat) ?? [];
                const open = openAttentionCat === cat;
                const hint = attentionCategoryHint(cat, list);
                const footer = ATTENTION_CATEGORY_FOOTER[cat];
                return (
                  <Popover key={cat} open={open} onOpenChange={(o) => setOpenAttentionCat(o ? cat : null)}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          "group flex min-w-0 flex-col justify-center gap-1 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                          open ? "bg-orange-soft/70" : "bg-card hover:bg-secondary/50",
                        )}
                      >
                        <span className={cn("truncate text-[11px] font-medium transition-colors", open ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")}>
                          {ATTENTION_CATEGORY_LABELS[cat]}
                        </span>
                        <span className={cn("text-[19px] font-semibold leading-none tabular-nums", list.length > 0 ? "text-foreground" : "text-muted-foreground/50")}>
                          {list.length}
                        </span>
                        <span className="truncate text-[10.5px] text-muted-foreground/80">{hint}</span>
                      </button>
                    </PopoverTrigger>
                    {/* Portalled: floats above the page, never affects
                        dashboard geometry. Own scroll area; outside-click
                        and Escape close via Radix defaults. */}
                    <PopoverContent align="start" sideOffset={6} className="w-[340px] p-0">
                      <div className="flex items-center gap-2 border-b px-3 py-2 text-[12px] font-semibold">
                        {ATTENTION_CATEGORY_LABELS[cat]} <span className="text-muted-foreground">&middot; {list.length}</span>
                      </div>
                      <div className="max-h-[300px] overflow-y-auto overscroll-contain">
                        {list.length === 0 ? (
                          <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">Nothing needs attention here</p>
                        ) : (
                          <ul className="divide-y divide-border/60">
                            {list.map((it) => (
                              <li key={it.id}>
                                <Link
                                  to={it.href}
                                  search={it.search as never}
                                  onClick={() => setOpenAttentionCat(null)}
                                  className="flex items-start gap-2.5 px-3 py-2 hover:bg-secondary/40 transition-colors"
                                >
                                  <div className={cn("mt-0.5 h-6 w-6 rounded-md grid place-items-center ring-1 shrink-0", it.bg, it.color)}>{it.icon}</div>
                                  <div className="min-w-0 flex-1">
                                    <div className="text-[12px] font-medium truncate text-foreground">{it.title}</div>
                                    <div className="text-[11px] text-muted-foreground truncate">{it.sub}</div>
                                  </div>
                                  <span className={cn("text-[9px] font-semibold px-1.5 py-0.5 rounded shrink-0", it.badgeColor)}>{it.badge}</span>
                                </Link>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div className="border-t px-3 py-2">
                        <Link
                          to={footer.to}
                          onClick={() => setOpenAttentionCat(null)}
                          className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                        >
                          {footer.label} <ArrowRight className="h-3 w-3" />
                        </Link>
                      </div>
                    </PopoverContent>
                  </Popover>
                );
              })}
            </div>
          </SectionCard>
        </div>

        <div className="col-span-1 lg:col-span-6 2xl:col-span-5 h-full">
          <SectionCard title="Live Pipeline" icon={TrendingUp} tint="blue" action={<CardAction to={ROUTES.PIPELINE}>View pipeline</CardAction>} className="h-full 2xl:min-h-[198px]">
            {pipelineDistribution.pieSlices.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No open deals yet.</p>
            ) : (
              <div className="h-full flex flex-col">
                <div className="flex flex-1 min-h-0 items-center gap-3">
                  <div className="relative h-32 w-32 shrink-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={pipelineDistribution.pieSlices} dataKey="value" innerRadius={44} outerRadius={61} paddingAngle={2} stroke="none">
                          {pipelineDistribution.pieSlices.map((p) => <Cell key={p.phase} fill={p.color} />)}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 grid place-items-center text-center">
                      <div>
                        <div className="text-lg font-semibold tracking-tight">{fmtK(pipelineDistribution.representedValue)}</div>
                        {/* Explicitly "Open + Won" rather than a bare
                            "Total Deal Value" — this donut is the one place
                            Won is added back in, while the KPI row's
                            "Pipeline Value" tile stays open-only. Both
                            numbers are correct for what they each claim;
                            this subtitle is the fix for the two of them
                            looking confusingly different at a glance. */}
                        <div className="text-[9.5px] uppercase tracking-wider text-muted-foreground mt-0.5">Open + Won</div>
                      </div>
                    </div>
                  </div>
                  <ul className="flex-1 space-y-1 text-sm">
                    {pipelineDistribution.phases.map((p) => (
                      <li key={p.phase} className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color }} />
                        <span className="flex-1 text-[12.5px] text-foreground/80 truncate">
                          {p.name} <span className="text-muted-foreground">· {p.count} {p.count === 1 ? "deal" : "deals"}</span>
                        </span>
                        <span className="font-semibold text-[12.5px] tabular-nums">{fmtK(p.value)}</span>
                        <span className="text-muted-foreground text-[11px] w-9 text-right tabular-nums">{p.pct}%</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="mt-auto grid grid-cols-5 gap-2 pt-2 border-t border-border/70">
                  {[
                    { l: "Conversion", v: `${pipelineDistribution.conversionRate}%` },
                    { l: "Avg Deal", v: fmtK(pipelineDistribution.avgDeal) },
                    { l: "Avg Age", v: `${pipelineDistribution.avgAge}d` },
                    { l: "Won MTD", v: fmtK(pipelineDistribution.wonMTD) },
                    { l: "Lost MTD", v: fmtK(pipelineDistribution.lostMTD) },
                  ].map((s) => (
                    <div key={s.l}>
                      <div className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{s.l}</div>
                      <div className="text-[13px] font-semibold mt-0.5 tabular-nums">{s.v}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </SectionCard>
        </div>

        <div className="col-span-1 lg:col-span-12 2xl:col-span-3 h-full">
          <SectionCard title="Today's Tasks" icon={CheckSquare} tint="amber" action={<CardAction to="/tasks">View tasks</CardAction>} className="h-full 2xl:min-h-[198px]">
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900/50 px-1 py-1 text-center">
                <div className="text-base font-semibold tabular-nums text-red-600 dark:text-red-400">{taskCounts.overdue}</div><div className="text-[9px] font-medium uppercase tracking-wider mt-0.5 text-red-700 dark:text-red-400">Overdue</div>
              </div>
              <div className="rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-100 dark:border-amber-900/50 px-1 py-1 text-center">
                <div className="text-base font-semibold tabular-nums text-amber-600 dark:text-amber-400">{taskCounts.dueToday}</div><div className="text-[9px] font-medium uppercase tracking-wider mt-0.5 text-amber-800 dark:text-amber-400">Due Today</div>
              </div>
              <div className="rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900/50 px-1 py-1 text-center">
                <div className="text-base font-semibold tabular-nums text-blue-600 dark:text-blue-400">{taskCounts.upcoming}</div><div className="text-[9px] font-medium uppercase tracking-wider mt-0.5 text-blue-700 dark:text-blue-400">Upcoming</div>
              </div>
              <div className="rounded-lg bg-green-50 dark:bg-green-950/40 border border-green-100 dark:border-green-900/50 px-1 py-1 text-center">
                {/* "Completed Total" — this is allTasks' all-time done
                    count (taskCounts.done), not a "today"/"recent" figure.
                    Previously labeled just "Completed," which silently
                    implied a recent window it didn't actually use. */}
                <div className="text-base font-semibold tabular-nums text-green-600 dark:text-green-400">{taskCounts.done}</div><div className="text-[9px] font-medium uppercase tracking-wider mt-0.5 text-green-700 dark:text-green-400">Completed Total</div>
              </div>
            </div>
            <div className="mt-1.5">
              {/* Next Up — single soonest actionable item across tasks and
                  estimate expirations (see the nextUp memo above; Phase
                  10.3: appointments removed from here, task-only card —
                  see the dedicated Next Booking card instead). Replaces
                  the old generic 2-task list; this is what covers the
                  Upcoming card's job now that it's been removed, without
                  restoring it as a separate card. */}
              {nextUp ? (
                <Link to={nextUp.href} className="flex items-center gap-2 text-[12.5px] group hover:text-foreground">
                  {nextUp.kind === "estimate" ? (
                    <FileText className="h-3.5 w-3.5 text-info shrink-0" />
                  ) : (
                    <CheckSquare className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                  )}
                  <span className="flex-1 truncate text-foreground/85 group-hover:text-foreground">{nextUp.title}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">{safeRelativeTime(nextUp.at)}</span>
                </Link>
              ) : (
                <p className="text-[12.5px] text-muted-foreground">No tasks due soon.</p>
              )}
              <div className="mt-1.5">
                <div className="flex items-center justify-between text-[10.5px] mb-1">
                  <span className="text-muted-foreground uppercase tracking-wider">Progress</span>
                  <span className="font-semibold tabular-nums">{taskCounts.progressPct}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                  <div className="h-full rounded-full bg-success transition-all duration-500" style={{ width: `${taskCounts.progressPct}%` }} />
                </div>
              </div>
            </div>
          </SectionCard>
        </div>

        {/* Next Booking (Phase 10.3 correction pass) — dedicated card, was
            previously only rendered inline inside Today's Tasks' Next Up
            row (wrong: an appointment is not a task). Added as a new grid
            item rather than resized into the existing row above, so no
            other card's width/column-span changes. */}
        <div className="col-span-1 lg:col-span-12 2xl:col-span-3 h-full">
          <SectionCard title="Next Booking" icon={CalendarClock} tint="blue" action={<CardAction to={ROUTES.CALENDAR}>View calendar</CardAction>} className="h-full 2xl:min-h-[198px]">
            {nextBooking ? (
              <Link to={ROUTES.CALENDAR} className="flex h-full flex-col gap-1.5 group">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-foreground group-hover:text-primary">{nextBooking.title}</p>
                    {nextBooking.contactName && <p className="truncate text-[11.5px] text-muted-foreground">{nextBooking.contactName}</p>}
                  </div>
                  <span className={cn(
                    "shrink-0 rounded-full border px-1.5 py-0.5 text-[9.5px] font-semibold",
                    APPOINTMENT_STATUS_TINT[nextBooking.status as AppointmentStatus]?.badge ?? "border-border bg-secondary text-muted-foreground",
                  )}>
                    {APPOINTMENT_STATUS_LABELS[nextBooking.status as AppointmentStatus] ?? nextBooking.status}
                  </span>
                </div>
                <div className="text-[11.5px] text-foreground/85">
                  {new Date(nextBooking.scheduledAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                  <span className="text-muted-foreground"> · </span>
                  {new Date(nextBooking.scheduledAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                  –{new Date(nextBooking.endsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                </div>
                {nextBooking.assigneeName && (
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <User className="h-3 w-3 shrink-0" /> <span className="truncate">{nextBooking.assigneeName}</span>
                  </div>
                )}
                {nextBooking.address && (
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <MapPin className="h-3 w-3 shrink-0" /> <span className="truncate">{nextBooking.address}</span>
                  </div>
                )}
                <div className="mt-auto pt-1 text-[10.5px] font-medium text-primary">
                  {formatDistanceToNow(new Date(nextBooking.scheduledAt), { addSuffix: true })}
                </div>
              </Link>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
                <CalendarClock className="h-5 w-5 text-muted-foreground/40" />
                <p className="text-[12px] text-muted-foreground">No upcoming appointments</p>
                <Link to={ROUTES.CALENDAR} className="text-[11px] font-medium text-primary hover:underline">
                  Schedule appointment
                </Link>
              </div>
            )}
          </SectionCard>
        </div>

        <div className="col-span-1 lg:col-span-6 2xl:col-span-4 h-full">
          <SectionCard
            title="Pipeline Pulse"
            icon={TrendingUp}
            tint="blue"
            action={
              <div className="flex items-center gap-2">
                {/* Compact timeline selector (S2B) — pure UI state, not
                    persisted/migrated. Changing it only changes which
                    deal_activities window this card queries/displays; it
                    never touches the Pipeline page or any deal data. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors"
                    >
                      {PULSE_PERIOD_OPTIONS.find(p => p.key === pulsePeriod)?.label}
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {PULSE_PERIOD_OPTIONS.map((p) => (
                      <DropdownMenuItem key={p.key} onClick={() => setPulsePeriod(p.key)}>
                        {p.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <CardAction to={ROUTES.PIPELINE}>View pipeline</CardAction>
              </div>
            }
            className="h-full 2xl:min-h-[200px]"
          >
            {/* Chart/tiles ALWAYS render (S2B) — a quiet period is real
                zeros, not a reason to collapse the whole card. The old
                behavior (replacing this entire card with an empty-state
                message) is gone; only a small note appears when the
                selected period has no logged activity. */}
            <div className="flex items-center gap-3 text-[10.5px] text-muted-foreground mb-1">
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-info" /> Created</span>
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-success" /> Won</span>
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-destructive" /> Lost</span>
            </div>
            <div className="h-20 -mx-1">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
                  data={pipelinePulse.createdSpark.map((v, i) => ({ created: v, won: pipelinePulse.wonSpark[i] ?? 0, lost: pipelinePulse.lostSpark[i] ?? 0 }))}
                >
                  <defs>
                    <linearGradient id="pulse-created" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3B82F6" stopOpacity={0.18} />
                      <stop offset="100%" stopColor="#3B82F6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  {/* Y domain anchored at 0 (not dataMin) with ~30% headroom
                      above the peak and a floor of 4 — so a lone bucket of
                      2-3 events no longer slams to the top edge as a needle,
                      and a zero-activity period renders as a calm flat line
                      along the bottom rather than a stretched axis. */}
                  <YAxis hide domain={[0, (dataMax: number) => Math.max(4, Math.ceil((dataMax || 0) * 1.3))]} />
                  <Area type="monotone" dataKey="created" stroke="#3B82F6" strokeWidth={2} fill="url(#pulse-created)" baseValue={0} dot={false} isAnimationActive={false} />
                  <Area type="monotone" dataKey="won" stroke="#22C55E" strokeWidth={1.5} fill="none" baseValue={0} dot={false} isAnimationActive={false} />
                  <Area type="monotone" dataKey="lost" stroke="#EF4444" strokeWidth={1.5} fill="none" baseValue={0} dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            {!pipelinePulse.hasWindowActivity && (
              <p className="text-[10.5px] text-muted-foreground text-center -mt-1 mb-1">No pipeline movement in this period</p>
            )}
            <div className="mt-1.5 grid grid-cols-4 gap-2 pt-1.5 border-t border-border/70">
              {[
                { l: "Created", v: String(pipelinePulse.createdCount), c: "text-info" },
                { l: "Won", v: String(pipelinePulse.wonCount), c: "text-success" },
                { l: "Lost", v: String(pipelinePulse.lostCount), c: "text-destructive" },
                { l: "Stage Moves", v: String(pipelinePulse.stageChangedCount), c: "text-orange" },
              ].map((s) => (
                <div key={s.l}>
                  <div className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{s.l}</div>
                  <div className={cn("text-[13px] font-semibold mt-0.5 tabular-nums", s.c)}>{s.v}</div>
                </div>
              ))}
            </div>
            {/* Current pipeline inventory shown as clearly-separate supporting
                context (S2B) — never combined with the selected period's
                activity numbers above into one ambiguous figure. */}
            <p className="text-[10px] text-muted-foreground mt-1">
              {PULSE_PERIOD_OPTIONS.find(p => p.key === pulsePeriod)?.label} · Pipeline now: {pipelineAllTime.open} open, {pipelineAllTime.won} won, {pipelineAllTime.lost} lost
            </p>
          </SectionCard>
        </div>

        <div className="col-span-1 lg:col-span-6 2xl:col-span-5 h-full">
          <SectionCard title="Recent Conversations" icon={Mail} tint="blue" action={<CardAction to="/inbox">View conversations</CardAction>} className="h-full 2xl:min-h-[200px]">
            <div className="flex items-center gap-3 text-[12.5px] border-b border-border/70 pb-1.5 -mx-3.5 px-3.5 mb-1">
              <button
                onClick={() => setInboxTab("all")}
                className={cn("pb-1.5 -mb-2 transition-colors", inboxTab === "all" ? "font-semibold text-foreground border-b-2 border-primary" : "text-muted-foreground hover:text-foreground")}
              >
                All
              </button>
              <button
                onClick={() => setInboxTab("unread")}
                className={cn("pb-1.5 -mb-2 flex items-center gap-1 transition-colors", inboxTab === "unread" ? "font-semibold text-foreground border-b-2 border-primary" : "text-muted-foreground hover:text-foreground")}
              >
                Unread {unreadCount > 0 && <span className="rounded bg-primary text-primary-foreground text-[10px] font-semibold px-1.5 py-0.5">{unreadCount}</span>}
              </button>
            </div>
            <ul className="divide-y divide-border/60 -mx-3.5">
              {inboxPreview.length === 0 ? (
                <li className="px-3.5 py-6 text-center text-sm text-muted-foreground">
                  {inboxTab === "unread" ? "No unread conversations." : "No conversations yet."}
                </li>
              ) : inboxPreview.map((m) => (
                <li key={m.id} className={cn("flex items-center gap-2.5 px-3.5 py-2 cursor-pointer transition-colors", m.unread ? "bg-info-soft/40" : "hover:bg-secondary/40")}>
                  {/* search={{contactId}} — inbox.tsx's own deep-link effect
                      (already used by Contacts' "Message" action) resolves
                      this to the real contact+channel thread and opens it,
                      preferring an existing sm-/gm-/voice- conversation over
                      a placeholder. Previously this just linked to bare
                      "/inbox", landing on whatever Inbox auto-selects rather
                      than the conversation actually clicked. */}
                  <Link to="/inbox" search={{ contactId: m.contactId }} className="contents">
                    <div className="relative shrink-0">
                      {m.channel === "email" ? (
                        <GmailSenderAvatar
                          senderName={m.contactName}
                          senderEmail={m.senderEmail ?? ""}
                          matchedContactId={m.contactId}
                          connectedAccountEmail={gmailAccountEmail}
                          connectedAccountPictureUrl={gmailAccountPictureUrl}
                          size="sm"
                        />
                      ) : (
                        // Command Center avatar audit (S2): was `id={m.id}`
                        // — the CONVERSATION id (e.g. `sm-<contactId>::
                        // messenger`), not the Contact id, and avatarUrl/
                        // avatarKey were never passed at all. ContactAvatar
                        // seeds its generated fallback off `id`, so this (a)
                        // never showed a real avatar_url (Meta profile
                        // picture, user-picked avatar) and (b) gave the SAME
                        // Contact a DIFFERENT generated avatar per channel,
                        // since the conversation id differs by channel even
                        // for one Contact — disagreeing with Inbox/Contacts,
                        // which correctly seed by contact_id. Conversation
                        // already carries contactId/avatarUrl/avatarKey
                        // (sms-meta-conversations.ts/gmail-conversations.ts
                        // both populate them from the real contacts row) —
                        // using them here is the same canonical resolution
                        // Inbox/Contacts already use, not a new one.
                        <ContactAvatar id={m.contactId} name={m.contactName} avatarUrl={m.avatarUrl} avatarKey={m.avatarKey} size="sm" />
                      )}
                      <span className="absolute -right-1 -bottom-1 h-4 w-4 rounded-full bg-card ring-2 ring-card grid place-items-center text-muted-foreground">
                        {m.channel === "whatsapp" ? <MessageCircle className="h-2.5 w-2.5" /> : m.channel === "instagram" ? <Instagram className="h-2.5 w-2.5" /> : m.channel === "messenger" ? <MessageCircle className="h-2.5 w-2.5" /> : m.channel === "email" ? <Mail className="h-2.5 w-2.5" /> : <Smartphone className="h-2.5 w-2.5" />}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div className={cn("text-[12.5px] truncate", m.unread ? "font-semibold text-foreground" : "font-medium text-foreground")}>{m.contactName}</div>
                        {m.unread && <span className="h-1.5 w-1.5 rounded-full bg-info shrink-0" />}
                      </div>
                      <div className={cn("text-[11.5px] truncate mt-0.5", m.unread ? "text-foreground/70" : "text-muted-foreground")}>{m.preview}</div>
                    </div>
                    {safeRelativeTime(m.lastAt, { addSuffix: false }) && (
                      <span className="text-[10px] text-muted-foreground shrink-0">{safeRelativeTime(m.lastAt, { addSuffix: false })}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>

        {/* Recent Activity — relocated here (Phase 10.3 layout correction
            pass) from a standalone trailing card at the bottom of the page,
            which had no siblings to share its row with and forced an extra
            near-empty final row (the page-overflow regression). Takes the
            former Estimates card's position — Estimates was removed from
            Command Center (route/sidebar/data untouched, see below) and
            this card now shares its row with Marketing Activity/Workflows/
            AI Center using the same col-span breakpoints as those three, so
            the row totals 12 at 2xl with no orphan card. */}
        <div className="col-span-1 lg:col-span-6 xl:col-span-4 2xl:col-span-3 h-full">
          {/* No "View all" action — this feed aggregates leads/calls/
              invoices/estimates/tasks/appointments, and no single page
              shows all of that combined. The prior "View all" pointed to
              Call Logs, which only covers voice calls — a misleading
              destination for an aggregated feed. Removed rather than link
              somewhere wrong; restore once a real cross-entity activity
              page exists. */}
          {/* Fixed compact height (not just min-h) — this card's list is the
              only content among the four bottom-row cards that can grow
              with live data (Marketing/Workflows/AI Center all render a
              fixed tile grid + a 2-row-capped list, naturally settling
              around ~170-190px). Without a matching max-h here, a busy
              activity feed made this card taller than its siblings, which
              then stretched the whole row (2xl:items-stretch) and
              reintroduced the page-level scrollbar. min-h-0 + flex-1 on the
              list (via SectionCard's own body wrapper) + overflow-y-auto
              here is what makes only the list scroll instead of the card
              growing. */}
          <SectionCard title="Recent Activity" icon={Clock} tint="indigo" className="h-full 2xl:min-h-[170px] 2xl:max-h-[198px]">
            {activity.length === 0 ? (
              <p className="py-5 text-center text-sm text-muted-foreground">No recent activity yet.</p>
            ) : (
              <ul className="-my-0.5 max-h-[132px] min-h-0 overflow-y-auto overflow-x-hidden">
                {activity.map((it) => (
                  <li key={it.id} className="flex min-w-0 items-center gap-2.5 py-1.5 hover:bg-secondary/40 -mx-2 px-2 rounded-md transition-colors">
                    {it.contactId ? (
                      // Real Contact identity — same canonical resolution
                      // (contact_id + avatar_url/avatar_key) Inbox/Contacts
                      // use, never a name-matched or invented avatar. See
                      // the item-construction loop above for exactly which
                      // sources this is populated from.
                      <ContactAvatar id={it.contactId} name={it.who} avatarUrl={it.avatarUrl} avatarKey={it.avatarKey} size="sm" />
                    ) : (
                      // No stable Contact relationship for this item's
                      // source (or none matched) — a real entity icon per
                      // kind, never ContactAvatar seeded by a non-contact id.
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-info-soft text-info">
                        {it.kind === "appointment" ? <CalendarClock className="h-4 w-4" />
                          : it.kind === "call" ? <Smartphone className="h-4 w-4" />
                          : it.kind === "estimate" ? <FileText className="h-4 w-4" />
                          : it.kind === "task" ? <CheckSquare className="h-4 w-4" />
                          : it.kind === "lead" ? <UserPlus className="h-4 w-4" />
                          : it.kind === "deal" ? <TrendingUp className="h-4 w-4" />
                          : it.kind === "project" ? <Briefcase className="h-4 w-4" />
                          : it.kind === "invoice" ? <DollarSign className="h-4 w-4" />
                          : <Clock className="h-4 w-4" />}
                      </span>
                    )}
                    <div className="flex-1 min-w-0 overflow-hidden">
                      <div className="truncate text-[12.5px] font-medium">{it.t}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{it.who}{it.s ? ` · ${it.s}` : ""}</div>
                    </div>
                    {it.when && (
                      <div className="shrink-0 whitespace-nowrap text-[10.5px] text-muted-foreground tabular-nums">{it.when}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>

        <div className="col-span-1 lg:col-span-6 xl:col-span-4 2xl:col-span-3 h-full">
          <SectionCard title="Campaigns" icon={Megaphone} tint="indigo" action={<CardAction to="/marketing">View all</CardAction>} className="h-full 2xl:min-h-[170px]">
            {marketingStats.sent + marketingStats.scheduled + marketingStats.drafts === 0 && marketingStats.totalLeadsWithSource === 0 ? (
              <p className="py-5 text-center text-sm text-muted-foreground">No campaigns yet.</p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-1.5">
                  <div className="rounded-lg bg-secondary/60 ring-1 ring-border/60 p-1.5">
                    <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Sent</div>
                    <div className="text-base font-semibold mt-0.5 tabular-nums text-success">{marketingStats.sent}</div>
                  </div>
                  <div className="rounded-lg bg-secondary/60 ring-1 ring-border/60 p-1.5">
                    <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Scheduled</div>
                    <div className="text-base font-semibold mt-0.5 tabular-nums text-info">{marketingStats.scheduled}</div>
                  </div>
                  <div className="rounded-lg bg-secondary/60 ring-1 ring-border/60 p-1.5">
                    <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Drafts</div>
                    <div className="text-base font-semibold mt-0.5 tabular-nums text-muted-foreground">{marketingStats.drafts}</div>
                  </div>
                </div>
                {marketingStats.topSources.length > 0 && (
                  <div className="mt-1.5">
                    <div className="text-[9.5px] uppercase tracking-wider text-muted-foreground mb-1">Leads by Source</div>
                    <ul className="space-y-1">
                      {marketingStats.topSources.map((s) => (
                        <li key={s.source} className="flex items-center gap-2">
                          <span className="w-16 shrink-0 truncate text-[11px] text-foreground/80">{s.source}</span>
                          <span className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                            <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round((s.count / marketingStats.maxSourceCount) * 100)}%` }} />
                          </span>
                          <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{s.count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </SectionCard>
        </div>

        <div className="col-span-1 lg:col-span-6 xl:col-span-4 2xl:col-span-3 h-full">
          <SectionCard title="Workflows" icon={Workflow} tint="purple" action={<CardAction to={ROUTES.WORKFLOWS}>View all</CardAction>} className="h-full 2xl:min-h-[170px]">
            {workflowsStats.totalCount === 0 ? (
              <div className="py-5 text-center">
                <p className="text-[12.5px] font-medium text-muted-foreground">No workflows yet</p>
                <button onClick={() => navigate({ to: ROUTES.WORKFLOWS })} className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11.5px] font-semibold hover:bg-secondary transition-colors">
                  <Zap className="h-3.5 w-3.5" /> Create
                </button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-1.5">
                  {[
                    { l: "Active", v: workflowsStats.activeCount, c: "text-violet" },
                    { l: "Running", v: workflowsStats.running, c: "text-info" },
                    { l: "OK (7d)", v: workflowsStats.recentSuccesses, c: "text-success" },
                    { l: "Failed (7d)", v: workflowsStats.recentFailures, c: "text-destructive" },
                  ].map((s) => (
                    <div key={s.l} className="rounded-lg bg-secondary/60 ring-1 ring-border/60 p-1.5">
                      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{s.l}</div>
                      <div className={cn("text-base font-semibold mt-0.5 tabular-nums", s.c)}>{s.v}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-1.5">
                  {workflowsStats.needingAttention.length > 0 ? (
                    <ul className="space-y-1">
                      {workflowsStats.needingAttention.slice(0, 2).map((w) => (
                        <li key={w.id}>
                          <Link to={ROUTES.WORKFLOWS} className="flex items-center gap-2 text-[12px] py-0.5 hover:text-foreground">
                            <span className="h-5 w-5 rounded-md grid place-items-center shrink-0 bg-destructive-soft text-destructive">
                              <MessageSquareWarning className="h-3 w-3" />
                            </span>
                            <span className="truncate text-foreground/85">{w.name}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : workflowRuns.length > 0 ? (
                    <p className="text-[12px] text-muted-foreground">All workflows healthy.</p>
                  ) : (
                    <p className="text-[12px] text-muted-foreground">No workflow runs recorded yet.</p>
                  )}
                </div>
              </>
            )}
          </SectionCard>
        </div>

        <div className="col-span-1 lg:col-span-6 xl:col-span-4 2xl:col-span-3 h-full">
          <SectionCard title="AI Center" icon={Sparkles} tint="purple" action={<CardAction to={ROUTES.AI_CENTER}>Open</CardAction>} className="h-full 2xl:min-h-[170px]">
            {!hasAiActivity ? (
              <div className="py-5 text-center">
                <p className="text-[12.5px] font-medium text-muted-foreground">No AI agents configured yet</p>
                <button onClick={() => navigate({ to: ROUTES.AI_CENTER })} className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11.5px] font-semibold hover:bg-secondary transition-colors">
                  <Sparkles className="h-3.5 w-3.5" /> Set up AI Center
                </button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-4 gap-1.5">
                  {[
                    { l: "Active", v: String(aiStats.activeCount), c: "text-violet" },
                    { l: "Configured", v: String(aiStats.totalCount), c: "text-info" },
                    // Real, but a lifetime counter, not week-scoped — see
                    // the aiStats comment above. Labeled honestly instead
                    // of calling it "This Week."
                    { l: "Total Runs", v: String(aiStats.totalRuns), c: "text-success" },
                    { l: `Voice Calls (${PULSE_DAYS}d)`, v: String(voiceCallsCount), c: "text-orange" },
                  ].map((s) => (
                    <div key={s.l} className="rounded-lg bg-secondary/60 ring-1 ring-border/60 p-1.5">
                      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{s.l}</div>
                      <div className={cn("text-base font-semibold mt-0.5 tabular-nums", s.c)}>{s.v}</div>
                    </div>
                  ))}
                </div>
                {aiStats.top.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {aiStats.top.slice(0, 2).map((a) => (
                      <li key={a.id} className="flex items-center justify-between text-[12px] py-0.5">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className={cn("h-5 w-5 rounded-md grid place-items-center shrink-0", a.is_enabled ? "bg-violet-soft text-violet" : "bg-secondary text-muted-foreground")}>
                            <Sparkles className="h-2.5 w-2.5" />
                          </span>
                          <span className="truncate text-foreground/85">{a.definition?.name ?? "Agent"}</span>
                        </span>
                        <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", a.is_enabled ? "bg-success" : "bg-muted-foreground/50")} />
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
    <NewContactDialog open={newContactOpen} onOpenChange={setNewContactOpen} />
    <NewDealDialog open={newDealOpen} onOpenChange={setNewDealOpen} />
    </>
  );
}
