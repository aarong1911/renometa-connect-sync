// src/routes/index.tsx
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area, YAxis } from "recharts";
import { ROUTES } from "@/lib/routes";
import {
  Plus, FileText, CheckSquare, Contact as ContactIcon,
  Sparkles, UserPlus, DollarSign, Briefcase, CalendarDays, Zap, AlertTriangle,
  TrendingUp, Mail, ArrowRight, Clock, MessageCircle, Smartphone, Instagram,
  Workflow, MessageSquareWarning, Megaphone,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useOrganization } from "@/lib/organization";
import { useTasks } from "@/lib/tasks-store";
import { isActiveStatus } from "@/lib/task-status";
import { useDeals } from "@/lib/deals-store";
import { useAICenterAgents } from "@/lib/ai-center-store";
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
import { useBroadcasts } from "@/lib/broadcasts-store";
import { computeEffectiveEstimateTotals } from "@/lib/estimate-totals";

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

function SectionCard({ title, icon, tint, action, children, className }: {
  title: string; icon: React.ElementType; tint: keyof typeof CARD_ICON_COLORS; action?: React.ReactNode; children: React.ReactNode; className?: string;
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

// ─── Main Page ────────────────────────────────────────────────────────────────

function DashboardPage() {
  const org = useOrganization();
  const allTasks = useTasks();
  const allDeals = useDeals();
  const { instances: aiAgents } = useAICenterAgents();
  const { conversations } = useSmsMetaConversations();
  const { conversations: gmailConversations } = useGmailConversations();
  const { workflows: allWorkflows, runs: workflowRuns } = useWorkflows();
  const allBroadcasts = useBroadcasts();
  const navigate = useNavigate();

  const [userName, setUserName] = useState("there");
  const [newContactOpen, setNewContactOpen] = useState(false);
  const [newDealOpen, setNewDealOpen] = useState(false);
  const [kpiData, setKpiData] = useState<{
    leads: number;
    leadsTrend: number | null;
    pipelineNow: number;
    pipelineTrend: number | null;
    projects: number;
    projectsTrend: number | null;
    revenue: number;
    revenueTrend: number | null;
    bookingsToday: number;
  }>({
    leads: 0,
    leadsTrend: null,
    pipelineNow: 0,
    pipelineTrend: null,
    projects: 0,
    projectsTrend: null,
    revenue: 0,
    revenueTrend: null,
    bookingsToday: 0,
  });
  const [sparklines, setSparklines] = useState<{ leads: number[]; revenue: number[]; bookings: number[]; pipeline: number[]; projects: number[] }>({ leads: [], revenue: [], bookings: [], pipeline: [], projects: [] });
  const [inboxTab, setInboxTab] = useState<"all" | "unread">("all");
  const [activity, setActivity] = useState<{ id: string; who: string; t: string; s: string; when: string }[]>([]);
  // Connected Gmail account identity + photo (see gmail-connection-status.ts)
  // — used only so Inbox Preview can render the same real logo/photo the
  // Conversations page shows, via the shared GmailSenderAvatar component.
  const [gmailAccountEmail, setGmailAccountEmail] = useState<string | null>(null);
  const [gmailAccountPictureUrl, setGmailAccountPictureUrl] = useState<string | null>(null);
  // Real estimate rows (id/status/total/valid_until/updated_at) for the
  // Estimates card — counted/summed client-side rather than issuing one
  // query per status.
  const [estimateRows, setEstimateRows] = useState<{ id: string; status: string; total: number; updated_at: string; valid_until: string | null; title: string; client_name: string | null }[]>([]);
  // Real, future-only appointment rows for Today's Tasks' "Next Up" row —
  // the one narrowly-bounded new query added for this correction pass.
  const [upcomingAppointments, setUpcomingAppointments] = useState<{ id: string; scheduled_at: string; title: string }[]>([]);
  // Real deal_activities rows (activity_type + occurred_at) — genuine
  // historical pipeline events (created/won/lost/stage_changed), not a
  // fabricated trend. Powers the Pipeline Pulse card.
  const [dealActivityRows, setDealActivityRows] = useState<{ activity_type: string; occurred_at: string }[]>([]);
  // Real count of voice calls in the pulse window — a single bounded head
  // count, not the full useVoiceConversations() hook (which also does
  // contact-matching queries), since only a number is needed here.
  const [voiceCallsCount, setVoiceCallsCount] = useState(0);
  // Real leads.source values for the Marketing Activity card's "Leads by
  // Source" breakdown — bare column values, grouped/counted client-side
  // rather than server-side, since there's no existing aggregation for this.
  const [leadSources, setLeadSources] = useState<string[]>([]);

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
  //   - appointment.scheduled_at (real, from the new bounded query above)
  //   - estimate.valid_until for a still-open (sent/viewed) estimate —
  //     deliberately NOT estimate.updated_at, which is a past timestamp and
  //     would be backwards to treat as a future "next up" item. A real
  //     valid_until in the future genuinely is a forward-looking date
  //     ("follow up before this quote expires"). No project-milestone
  //     candidate exists — there is no milestone/date schema on `projects`
  //     to draw from honestly.
  const nextUp = useMemo(() => {
    type NextUpItem = { id: string; kind: "task" | "appointment" | "estimate"; title: string; at: string; href: string };
    const now = Date.now();
    const candidates: NextUpItem[] = [];

    for (const t of allTasks) {
      if (!isActiveStatus(t.status)) continue;
      const at = new Date(t.due).getTime();
      if (!isNaN(at) && at >= now) candidates.push({ id: `nu-task-${t.id}`, kind: "task", title: t.title, at: t.due, href: "/tasks" });
    }
    for (const a of upcomingAppointments) {
      const at = new Date(a.scheduled_at).getTime();
      if (!isNaN(at) && at >= now) candidates.push({ id: `nu-appt-${a.id}`, kind: "appointment", title: a.title, at: a.scheduled_at, href: ROUTES.CALENDAR });
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
  }, [allTasks, upcomingAppointments, estimateRows]);

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

  const attentionItems = useMemo(() => {
    const now = new Date();
    const items: { id: string; icon: React.ReactNode; color: string; bg: string; title: string; sub: string; badge: string; badgeColor: string; href: string; weight: number }[] = [];

    for (const t of allTasks) {
      if (!isActiveStatus(t.status)) continue;
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
    // Unread/needs-reply conversations — real (SMS/WhatsApp/Messenger/
    // Instagram carry a genuine is_read-derived `unread` flag; Gmail threads
    // never do yet, see gmail-conversations.ts, so none ever show up here —
    // that's accurate, not a gap to paper over). Weighted above estimates
    // per the requested priority order (overdue tasks, needs-reply
    // conversations, stale estimates, stale deals).
    const unreadConvs = [...conversations, ...gmailConversations].filter(c => c.unread);
    for (const c of unreadConvs.slice(0, 3)) {
      const hoursOld = Math.max(0, (now.getTime() - new Date(c.lastAt).getTime()) / 36e5);
      items.push({
        id: `conv-${c.id}`, icon: <Mail className="h-4 w-4" />, color: "text-info", bg: "bg-info-soft ring-info-soft",
        title: c.contactName, sub: `${c.preview || "New message"}`,
        badge: "Needs Reply", badgeColor: "bg-info-soft text-info-soft-foreground ring-1 ring-info-soft",
        href: "/inbox", weight: 80 + Math.min(Math.round(hoursOld), 20),
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
        id: `est-${e.id}`, icon: <FileText className="h-4 w-4" />, color: "text-info", bg: "bg-info-soft ring-info-soft",
        title: e.title, sub: `${e.client_name ? `${e.client_name} · ` : ""}Waiting ${days} day${days === 1 ? "" : "s"}`,
        badge: "Estimate", badgeColor: "bg-info-soft text-info-soft-foreground ring-1 ring-info-soft",
        href: "/estimates", weight: 55 + Math.min(days, 20),
      });
    }
    const openDeals = allDeals.filter(d => d.stage !== "won" && d.stage !== "lost");
    for (const d of openDeals) {
      if (d.ageDays >= 14) {
        items.push({
          id: `deal-${d.id}`, icon: <Clock className="h-4 w-4" />, color: "text-orange", bg: "bg-orange-soft ring-orange-soft",
          title: d.name, sub: `${d.contactName ? `${d.contactName} · ` : ""}Last activity ${d.ageDays}d ago`,
          badge: "Stale", badgeColor: "bg-orange-soft text-orange-soft-foreground ring-1 ring-orange-soft",
          href: ROUTES.PIPELINE, weight: 30 + Math.min(d.ageDays, 20),
        });
      }
    }
    items.sort((a, b) => b.weight - a.weight);
    return items.slice(0, 3);
  }, [allTasks, estimateRows, allDeals, conversations, gmailConversations]);

  useEffect(() => {
    (async () => {
      try {
      const { orgId, firstName } = await resolveOrgAndUser();
      if (!orgId) return;
      if (firstName) setUserName(firstName);

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      const sparkStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (SPARK_DAYS - 1)).toISOString();
      const pulseStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (PULSE_DAYS - 1)).toISOString();

      const [
        { count: projCount }, { count: projLastCount },
        { count: leadsCount }, { count: leadsLastCount },
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
        { data: dealActivityPulseRows },
        { count: voiceCallsPulseCount },
        { data: leadSourceRows },
        { data: upcomingApptRows },
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
        supabase.from("estimates").select("id, status, total, updated_at, valid_until, title, client_name, created_at").eq("org_id", orgId).order("updated_at", { ascending: false }).limit(500),
        // Tasks card "Completed recently" + Recent Activity — scoped
        // directly by tasks.org_id (Phase 10.1 added a real column here),
        // so this now includes Lead/Deal-linked tasks with no project too,
        // not just project-scoped ones.
        // "done" was never a valid tasks.status value (tasks_status_check
        // only allows not_started/in_progress/on_hold/completed/cancelled)
        // — this filter matched zero rows live until this fix.
        supabase.from("tasks").select("id, title, completed_at").eq("org_id", orgId).eq("status", "completed").not("completed_at", "is", null).order("completed_at", { ascending: false }).limit(5),
        // Pipeline Pulse — real historical deal events (deals-store.ts's
        // logDealActivity), not a fabricated trend. created/won/lost/
        // stage_changed are the meaningful event types for a momentum view.
        supabase.from("deal_activities").select("activity_type, occurred_at").eq("org_id", orgId).in("activity_type", ["created", "won", "lost", "stage_changed"]).gte("occurred_at", pulseStart).order("occurred_at", { ascending: true }),
        supabase.from("voice_calls").select("*", { count: "exact", head: true }).eq("tenant_id", orgId).gte("started_at", pulseStart),
        // Marketing Activity card's "Leads by Source" — bare source
        // values only, grouped client-side (no existing aggregation for
        // this anywhere in the app). Bounded to a reasonable page size.
        supabase.from("leads").select("source").eq("org_id", orgId).limit(1000),
        // Today's Tasks "Next Up" row — the one narrowly-bounded new query
        // for this correction pass (see nextUp memo below). Future
        // appointments only, soonest first, small cap since only the single
        // soonest item across all candidate types is ever shown.
        supabase.from("appointments").select("id, scheduled_at, contact_name, service").eq("org_id", orgId).neq("status", "cancelled").gte("scheduled_at", now.toISOString()).order("scheduled_at", { ascending: true }).limit(5),
      ]);

      const pipelineNow = (openDeals ?? []).reduce((s: number, d: any) => s + Number(d.value ?? 0), 0);
      const pipelineLast = (lastDeals ?? []).reduce((s: number, d: any) => s + Number(d.value ?? 0), 0);
      const revNow = (paidInvoices ?? []).reduce((s: number, i: any) => s + Number(i.total_amount ?? 0), 0);
      const revLast = (lastPaidInvoices ?? []).reduce((s: number, i: any) => s + Number(i.total_amount ?? 0), 0);
      const pct = (a: number, b: number): number | null => b === 0 ? null : ((a - b) / b) * 100;

      setKpiData({
        leads: leadsCount ?? 0, leadsTrend: pct(leadsCount ?? 0, leadsLastCount ?? 0),
        pipelineNow, pipelineTrend: pct(pipelineNow, pipelineLast),
        projects: projCount ?? 0, projectsTrend: pct(projCount ?? 0, projLastCount ?? 0),
        revenue: revNow, revenueTrend: pct(revNow, revLast),
        bookingsToday: bookingsCount ?? 0,
      });

      setSparklines({
        leads: bucketCounts((leadSparkRows ?? []).map((r: any) => r.created_at), SPARK_DAYS),
        revenue: bucketSums((revenueSparkRows ?? []).map((r: any) => ({ at: r.created_at, amount: Number(r.total_amount ?? 0) })), SPARK_DAYS),
        bookings: bucketCounts((bookingSparkRows ?? []).map((r: any) => r.scheduled_at), SPARK_DAYS),
        pipeline: cumulativeSeries((openDealsForSpark ?? []).map((r: any) => ({ at: r.created_at, amount: Number(r.value ?? 0) })), SPARK_DAYS),
        projects: cumulativeSeries((activeProjectsForSpark ?? []).map((r: any) => ({ at: r.created_at, amount: 1 })), SPARK_DAYS),
      });

      setEstimateRows((allEstimateRows ?? []).map((e: any) => {
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
        };
      }));

      setDealActivityRows((dealActivityPulseRows ?? []).map((r: any) => ({
        activity_type: r.activity_type, occurred_at: r.occurred_at,
      })));

      setVoiceCallsCount(voiceCallsPulseCount ?? 0);

      setLeadSources((leadSourceRows ?? []).map((r: any) => r.source).filter(Boolean));

      setUpcomingAppointments((upcomingApptRows ?? []).map((a: any) => ({
        id: a.id,
        scheduled_at: a.scheduled_at,
        title: `${a.service || "Appointment"} — ${a.contact_name || "—"}`,
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
      // Estimate sent/viewed/accepted — real status + real updated_at, not a
      // fabricated "sent" event log (this table has no separate history of
      // status transitions, so "when this row was last updated" is the
      // honest signal available).
      for (const e of (allEstimateRows ?? []).slice(0, 3)) {
        if (e.status === "sent" || e.status === "viewed" || e.status === "accepted") {
          const label = e.status === "accepted" ? "Estimate accepted" : e.status === "viewed" ? "Estimate viewed" : "Estimate sent";
          items.push({ id: `e${e.id}`, who: e.client_name ?? "Client", t: label, s: e.title ?? "", when: "", at: e.updated_at ?? e.created_at });
        }
      }
      for (const t of (completedTaskRows ?? []).slice(0, 3)) {
        items.push({ id: `t${t.id}`, who: "Task completed", t: t.title, s: "", when: "", at: t.completed_at });
      }
      items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      setActivity(items.slice(0, 6).map(it => ({ ...it, when: safeRelativeTime(it.at) })));
      } catch (err: any) {
        // Minimal error honesty: a failed query here used to be
        // indistinguishable from "this org genuinely has no data" — every
        // card would just quietly show its normal empty state. This at
        // least surfaces the failure during development instead of
        // silently swallowing it. A full per-card error UI is deferred —
        // see the Phase 8 correction report.
        if (import.meta.env.DEV) {
          console.error("[Command Center] failed to load dashboard data:", err?.message ?? err);
        }
      }
    })();
  }, []);

  const KPIS: Kpi[] = [
    {
      icon: UserPlus, accent: "#3B82F6", label: "New Leads", value: String(kpiData.leads),
      trend: kpiData.leadsTrend === null ? undefined : { delta: `${Math.abs(Math.round(kpiData.leadsTrend))}%`, up: kpiData.leadsTrend >= 0 }, href: ROUTES.LEADS,
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
      trend: kpiData.pipelineTrend === null ? undefined : { delta: `${Math.abs(Math.round(kpiData.pipelineTrend))}%`, up: kpiData.pipelineTrend >= 0 }, href: ROUTES.PIPELINE,
      sparkline: sparklines.pipeline,
    },
    {
      // Same reasoning as Pipeline Value: projects only carry current
      // status, not a status-change history — this is a running total of
      // the currently-active projects by their real creation dates, not a
      // certified count-per-day.
      icon: Briefcase, accent: "#8B5CF6", label: "Active Projects", value: String(kpiData.projects),
      trend: kpiData.projectsTrend === null ? undefined : { delta: `${Math.abs(Math.round(kpiData.projectsTrend))}%`, up: kpiData.projectsTrend >= 0 }, href: ROUTES.PROJECTS,
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
  // threads for the Inbox Preview — reuses both hooks exactly as Conversations
  // does, no duplicate query. Gmail threads never carry unread=true today
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

  // ─── Estimates card — real counts/value only, no fabricated schema ────────
  const estimatesStats = useMemo(() => {
    const now = new Date();
    let draft = 0, sent = 0, viewed = 0, accepted = 0, declined = 0, expired = 0;
    let acceptedValue = 0, awaitingValue = 0;
    for (const e of estimateRows) {
      const isExpired = (e.status === "sent" || e.status === "viewed") && e.valid_until && new Date(e.valid_until) < now;
      if (isExpired) { expired++; continue; }
      if (e.status === "draft") draft++;
      else if (e.status === "sent") { sent++; awaitingValue += e.total; }
      else if (e.status === "viewed") { viewed++; awaitingValue += e.total; }
      else if (e.status === "accepted") { accepted++; acceptedValue += e.total; }
      else if (e.status === "declined") declined++;
    }
    return { draft, sent, viewed, accepted, declined, expired, acceptedValue, awaitingValue, total: estimateRows.length };
  }, [estimateRows]);

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

  // ─── Marketing Activity — real broadcasts (useBroadcasts, currently
  // localStorage-backed — no dedicated Supabase table exists yet, see
  // broadcasts-store.ts) + real leads.source breakdown. Deliberately does
  // NOT show open/click/reply rate — every broadcast's engagement counters
  // are always initialized to 0 (no send/delivery-tracking pipeline exists
  // yet), so a rate computed from them would just always read "0%", which
  // would look like real data but isn't meaningfully measured yet. ────────
  const marketingStats = useMemo(() => {
    const sent = allBroadcasts.filter(b => b.status === "sent").length;
    const scheduled = allBroadcasts.filter(b => b.status === "scheduled").length;
    const drafts = allBroadcasts.filter(b => b.status === "draft").length;

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
  }, [allBroadcasts, leadSources]);

  // ─── Pipeline Pulse — real deal_activities events only ────────────────────
  const pipelinePulse = useMemo(() => {
    const created = dealActivityRows.filter(r => r.activity_type === "created");
    const won = dealActivityRows.filter(r => r.activity_type === "won");
    const lost = dealActivityRows.filter(r => r.activity_type === "lost");
    const stageChanged = dealActivityRows.filter(r => r.activity_type === "stage_changed");

    const createdSpark = bucketCounts(created.map(r => r.occurred_at), PULSE_DAYS);
    const wonSpark = bucketCounts(won.map(r => r.occurred_at), PULSE_DAYS);
    const lostSpark = bucketCounts(lost.map(r => r.occurred_at), PULSE_DAYS);

    const hasEnoughData = dealActivityRows.length >= 2;

    return {
      hasEnoughData,
      createdSpark, wonSpark, lostSpark,
      createdCount: created.length, wonCount: won.length, lostCount: lost.length, stageChangedCount: stageChanged.length,
    };
  }, [dealActivityRows]);

  return (
    <>
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="-translate-y-2 leading-tight">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Command Center</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {greeting}, {userName}. Here's what's happening at {org.companyName || "your business"} today.
          </p>
        </div>
      </div>

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
          <SectionCard title="Needs Attention" icon={AlertTriangle} tint="orange" action={<CardAction to="/tasks">View all</CardAction>} className="h-full 2xl:min-h-[198px]">
            <ul className="divide-y divide-border/70 -m-3">
              {attentionItems.length === 0 ? (
                <li className="px-3.5 py-6 text-center text-sm text-muted-foreground">You're all caught up</li>
              ) : attentionItems.map((it) => (
                <li key={it.id} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-secondary/40 transition-colors cursor-pointer">
                  <Link to={it.href} className="contents">
                    <div className={cn("h-8 w-8 rounded-lg grid place-items-center ring-1 shrink-0", it.bg, it.color)}>{it.icon}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium truncate text-foreground">{it.title}</div>
                      <div className="text-[11.5px] text-muted-foreground truncate mt-0.5">{it.sub}</div>
                    </div>
                    <span className={cn("text-[10px] font-semibold px-1.5 py-1 rounded-md shrink-0", it.badgeColor)}>{it.badge}</span>
                  </Link>
                </li>
              ))}
            </ul>
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
              {/* Next Up — single soonest actionable item across tasks,
                  appointments, and estimate expirations (see the nextUp
                  memo above). Replaces the old generic 2-task list; this
                  is what covers the Upcoming card's job now that it's been
                  removed, without restoring it as a separate card. */}
              {nextUp ? (
                <Link to={nextUp.href} className="flex items-center gap-2 text-[12.5px] group hover:text-foreground">
                  {nextUp.kind === "appointment" ? (
                    <CalendarDays className="h-3.5 w-3.5 text-violet shrink-0" />
                  ) : nextUp.kind === "estimate" ? (
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

        <div className="col-span-1 lg:col-span-6 2xl:col-span-4 h-full">
          <SectionCard title="Pipeline Pulse" icon={TrendingUp} tint="blue" action={<CardAction to={ROUTES.PIPELINE}>View full report</CardAction>} className="h-full 2xl:min-h-[200px]">
            {!pipelinePulse.hasEnoughData ? (
              <div className="h-full flex flex-col items-center justify-center text-center">
                <p className="text-[13px] font-medium text-muted-foreground">Not enough pipeline history yet</p>
                <p className="text-[11.5px] text-muted-foreground mt-0.5">As deals are created, moved, won, or lost, real momentum will show up here.</p>
              </div>
            ) : (
              <>
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
                      <YAxis hide domain={["dataMin", "dataMax"]} />
                      <Area type="monotone" dataKey="created" stroke="#3B82F6" strokeWidth={2} fill="url(#pulse-created)" dot={false} isAnimationActive={false} />
                      <Area type="monotone" dataKey="won" stroke="#22C55E" strokeWidth={1.5} fill="none" dot={false} isAnimationActive={false} />
                      <Area type="monotone" dataKey="lost" stroke="#EF4444" strokeWidth={1.5} fill="none" dot={false} isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
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
                <p className="text-[10px] text-muted-foreground mt-1">Last {PULSE_DAYS} days</p>
              </>
            )}
          </SectionCard>
        </div>

        <div className="col-span-1 lg:col-span-6 2xl:col-span-5 h-full">
          <SectionCard title="Inbox Preview" icon={Mail} tint="blue" action={<CardAction to="/inbox">View inbox</CardAction>} className="h-full 2xl:min-h-[200px]">
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
                  <Link to="/inbox" className="contents">
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
                        <ContactAvatar id={m.id} name={m.contactName} size="sm" />
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

        <div className="col-span-1 lg:col-span-6 2xl:col-span-3 h-full">
          <SectionCard title="Estimates" icon={FileText} tint="orange" action={<CardAction to="/estimates">View all</CardAction>} className="h-full 2xl:min-h-[200px]">
            {estimatesStats.total === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No estimates yet.</p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { l: "Draft", v: estimatesStats.draft, c: "text-muted-foreground" },
                    { l: "Awaiting", v: estimatesStats.sent + estimatesStats.viewed, c: "text-info" },
                    { l: "Accepted", v: estimatesStats.accepted, c: "text-success" },
                    { l: "Declined", v: estimatesStats.declined, c: "text-destructive" },
                    { l: "Expired", v: estimatesStats.expired, c: "text-orange" },
                  ].map((s) => (
                    <div key={s.l} className="rounded-lg bg-secondary/60 ring-1 ring-border/60 p-1.5">
                      <div className="text-[9.5px] text-muted-foreground uppercase tracking-wider">{s.l}</div>
                      <div className={cn("text-base font-semibold mt-0.5 tabular-nums", s.c)}>{s.v}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 pt-1.5 border-t border-border/70 grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-[9.5px] uppercase tracking-wider text-muted-foreground">Awaiting Value</div>
                    <div className="text-[13px] font-semibold mt-0.5 tabular-nums">{fmtK(estimatesStats.awaitingValue)}</div>
                  </div>
                  <div>
                    <div className="text-[9.5px] uppercase tracking-wider text-muted-foreground">Accepted Value</div>
                    <div className="text-[13px] font-semibold mt-0.5 tabular-nums text-success">{fmtK(estimatesStats.acceptedValue)}</div>
                  </div>
                </div>
              </>
            )}
          </SectionCard>
        </div>

        <div className="col-span-1 lg:col-span-6 xl:col-span-4 2xl:col-span-3 h-full">
          <SectionCard title="Marketing Activity" icon={Megaphone} tint="indigo" action={<CardAction to="/marketing">View all</CardAction>} className="h-full 2xl:min-h-[170px]">
            {marketingStats.sent + marketingStats.scheduled + marketingStats.drafts === 0 && marketingStats.totalLeadsWithSource === 0 ? (
              <p className="py-5 text-center text-sm text-muted-foreground">No marketing activity yet.</p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-1.5">
                  <div className="rounded-lg bg-secondary/60 ring-1 ring-border/60 p-1.5">
                    {/* "Marked Sent," not "Sent" — this reflects a status
                        flag the user set, not a confirmed delivery event.
                        See broadcasts-store.ts: no real send/delivery
                        pipeline is wired up yet, so "Sent" alone would
                        overstate what actually happened. */}
                    <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Marked Sent</div>
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
                {marketingStats.sent > 0 && (
                  <p className="text-[9px] text-muted-foreground mt-1.5">Delivery and engagement tracking are not connected yet.</p>
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

        <div className="col-span-1 lg:col-span-6 xl:col-span-4 2xl:col-span-3 h-full">
          {/* No "View all" action — this feed aggregates leads/calls/
              invoices/estimates/tasks, and no single page shows all of
              that combined. The prior "View all" pointed to Call Logs,
              which only covers voice calls — a misleading destination for
              an aggregated feed. Removed rather than link somewhere wrong;
              restore once a real cross-entity activity page exists. */}
          <SectionCard title="Recent Activity" icon={Clock} tint="indigo" className="h-full 2xl:min-h-[170px]">
            {activity.length === 0 ? (
              <p className="py-5 text-center text-sm text-muted-foreground">No recent activity yet.</p>
            ) : (
              <ul className="-my-0.5">
                {activity.slice(0, 3).map((it) => (
                  <li key={it.id} className="flex items-center gap-2.5 py-1.5 hover:bg-secondary/40 -mx-2 px-2 rounded-md transition-colors">
                    <ContactAvatar id={it.id} name={it.who} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[12.5px] font-medium truncate">{it.t}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{it.who}{it.s ? ` · ${it.s}` : ""}</div>
                    </div>
                    {it.when && (
                      <div className="text-[10.5px] text-muted-foreground tabular-nums shrink-0">{it.when}</div>
                    )}
                  </li>
                ))}
              </ul>
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