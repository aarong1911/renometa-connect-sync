import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { AgentSearchParams } from "@/lib/routes";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AgenticPreviewPanel } from "@/components/ai-center/agentic-preview-panel";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import {
  BrainCircuit,
  Bot,
  Search,
  Activity,
  PauseCircle,
  Layers,
  History,
  CheckCircle2,
  AlertCircle,
  Clock3,
  type LucideIcon,
  ListFilter,
  MessageSquareText,
  ClipboardList,
  Megaphone,
  ReceiptText,
  Star,
  Inbox as InboxIcon,
  Voicemail,
  Eye,
  FileText,
  ListChecks,
  BarChart3,
  Loader2,
  Play,
  Pause,
  Settings2,
  XCircle,
  Target,
  Calculator,
  BadgeDollarSign,
  Workflow,
  PhoneCall,
  AudioLines,
  WandSparkles,
  ShieldCheck,
  X as XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { AgentConfigureDialog } from "@/components/automation/agent-configure-dialog";
import { AIToolsTab } from "@/components/automation/ai-tools-tab";
import { VoiceAgentTab } from "@/components/automation/voice-agent-tab";
import {
  useAICenterAgents,
  toggleAgent,
  runAgentManually,
  fetchRecentRuns,
  type AgentInstance,
  type AgentCategory,
  type AgentRun,
} from "@/lib/ai-center-store";
import { isAgentConfigured } from "@/lib/agent-config";

type TopTab = "agents" | "tools" | "voice" | "agentic";
type AgentsSearchParams = AgentSearchParams & { tab?: TopTab };

export const Route = createFileRoute("/ai-center")({
  validateSearch: (search: Record<string, unknown>): AgentsSearchParams => ({
    agentId: typeof search.agentId === "string" ? search.agentId : undefined,
    tab:
      search.tab === "agents" || search.tab === "tools" || search.tab === "voice" || search.tab === "agentic"
        ? search.tab
        : undefined,
  }),
  head: () => ({
    meta: [
      { title: "AI Center — RenoMeta" },
      { name: "description", content: "AI Center — autonomous agents, on-demand AI tools, and voice agents." },
    ],
  }),
  component: AgentsPage,
});

// ── Icon mapping (DB stores icon name as string) ──────────────────────────────
// Improved for role-fit and scannability (Part 9/11) — the DB-stored icon
// key strings are unchanged; only the frontend mapping was upgraded.

const ICON_MAP: Record<string, LucideIcon> = {
  filter: ListFilter,
  zap: Activity,
  clock: Clock3,
  "clipboard-list": ClipboardList,
  "message-square": MessageSquareText,
  receipt: ReceiptText,
  star: Star,
  inbox: InboxIcon,
  voicemail: Voicemail,
  eye: Eye,
  "file-text": FileText,
  brain: BrainCircuit,
  "list-checks": ListChecks,
  "bar-chart-3": BarChart3,
};

function resolveIcon(iconName: string): LucideIcon {
  return ICON_MAP[iconName] ?? Bot;
}

// ── Visual grouping (display-only — Part 3) ─────────────────────────────────
//
// The stored `agent_instances.definition.category` is never changed and
// still drives the category FILTER (CATEGORY_FILTER_LABEL/AgentCategory,
// 5 real values). For DISPLAY only, the "internal" category is split into
// two dashboard panels so Inbox Triage Agent reads naturally under
// "Communication & Inbox" instead of a generic "Internal" bucket — no
// database write, migration, or reseed involved; this is a pure name-based
// UI classifier layered on top of the real category.

type VisualAgentGroup = AgentCategory | "communication";

function getVisualGroup(instance: AgentInstance): VisualAgentGroup {
  const def = instance.definition;
  if (def.category === "internal") {
    const name = def.name.toLowerCase();
    if (name.includes("inbox") || name.includes("communication") || name.includes("triage")) {
      return "communication";
    }
  }
  return def.category;
}

// ── Visual group metadata ────────────────────────────────────────────────────

const VISUAL_GROUP_ORDER: VisualAgentGroup[] = ["sales", "ops", "financials", "marketing", "internal", "communication"];

const CATEGORY_LABEL: Record<VisualAgentGroup, string> = {
  sales: "Sales & Lead Response",
  ops: "Estimating & Projects",
  financials: "Financials",
  marketing: "Reputation & Marketing",
  internal: "Internal / Horizontal",
  communication: "Communication & Inbox",
};

const CATEGORY_ICON: Record<VisualAgentGroup, LucideIcon> = {
  sales: Target,
  ops: Calculator,
  financials: BadgeDollarSign,
  marketing: Megaphone,
  internal: Workflow,
  communication: InboxIcon,
};

/** Restrained, per-category tint — white cards + colored icon tile + a faint header wash, never a saturated full-panel background (Part 5). */
const CATEGORY_TINT: Record<VisualAgentGroup, { icon: string; iconBg: string; headerBg: string; border: string }> = {
  sales: { icon: "text-sky-600 dark:text-sky-400", iconBg: "bg-sky-100 dark:bg-sky-500/15", headerBg: "bg-sky-50/70 dark:bg-sky-500/5", border: "border-sky-200/70 dark:border-sky-900/40" },
  ops: { icon: "text-amber-600 dark:text-amber-400", iconBg: "bg-amber-100 dark:bg-amber-500/15", headerBg: "bg-amber-50/70 dark:bg-amber-500/5", border: "border-amber-200/70 dark:border-amber-900/40" },
  financials: { icon: "text-emerald-600 dark:text-emerald-400", iconBg: "bg-emerald-100 dark:bg-emerald-500/15", headerBg: "bg-emerald-50/70 dark:bg-emerald-500/5", border: "border-emerald-200/70 dark:border-emerald-900/40" },
  marketing: { icon: "text-violet-600 dark:text-violet-400", iconBg: "bg-violet-100 dark:bg-violet-500/15", headerBg: "bg-violet-50/70 dark:bg-violet-500/5", border: "border-violet-200/70 dark:border-violet-900/40" },
  internal: { icon: "text-slate-600 dark:text-slate-400", iconBg: "bg-slate-100 dark:bg-slate-500/15", headerBg: "bg-slate-50/70 dark:bg-slate-500/5", border: "border-slate-200/70 dark:border-slate-800/60" },
  communication: { icon: "text-cyan-600 dark:text-cyan-400", iconBg: "bg-cyan-100 dark:bg-cyan-500/15", headerBg: "bg-cyan-50/70 dark:bg-cyan-500/5", border: "border-cyan-200/70 dark:border-cyan-900/40" },
};

const TRIGGER_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  event: "Event-driven",
  manual: "Manual",
};

// Category FILTER — unchanged, still the 5 real database category values.
// "communication" is intentionally NOT exposed here (Part 3): it's a
// visual-only split of the real "internal" category, not a new filter.
const CATEGORY_FILTER_LABEL: Record<"all" | AgentCategory, string> = {
  all: "All categories",
  sales: "Sales",
  ops: "Operations",
  financials: "Financials",
  marketing: "Marketing",
  internal: "Internal",
};

type StatusFilter = "all" | "active" | "paused";

// ── Top-level tab config (Part 4) ───────────────────────────────────────────
const TOP_TABS: { value: TopTab; label: string; icon: LucideIcon }[] = [
  { value: "agents", label: "Autonomous Agents", icon: Bot },
  { value: "tools", label: "AI Tools", icon: WandSparkles },
  { value: "voice", label: "Voice Agent", icon: AudioLines },
  { value: "agentic", label: "Agentic (Beta)", icon: ShieldCheck },
];

function AgentsPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | AgentCategory>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const { agentId: urlAgentId, tab: urlTab } = Route.useSearch();
  const navigate = Route.useNavigate();

  const [topTab, setTopTab] = useState<TopTab>(urlTab ?? "agents");
  const [selectedId, setSelectedId] = useState<string | null>(urlAgentId ?? null);

  const { instances, loading } = useAICenterAgents();

  // Sync URL search params
  useEffect(() => { setSelectedId(urlAgentId ?? null); }, [urlAgentId]);
  useEffect(() => {
    const next = urlTab ?? "agents";
    if (next !== topTab) setTopTab(next);
  }, [urlTab, topTab]);

  const openAgent = (id: string) => {
    setSelectedId(id);
    navigate({ search: { agentId: id, tab: undefined } });
  };

  const closeAgent = () => {
    setSelectedId(null);
    navigate({ search: { agentId: undefined, tab: undefined } });
  };

  const handleTopTabChange = (value: string) => {
    const nextTab = value as TopTab;
    setTopTab(nextTab);
    if (nextTab !== "agents") setSelectedId(null);
    navigate({
      search: {
        agentId: nextTab === "agents" ? urlAgentId : undefined,
        tab: nextTab === "agents" ? undefined : nextTab,
      },
    });
  };

  const handleToggle = async (inst: AgentInstance) => {
    const next = !inst.is_enabled;
    try {
      await toggleAgent(inst.id, next);
      toast.success(`${inst.definition.name} ${next ? "enabled" : "paused"}`);
    } catch {
      toast.error("Failed to update agent");
    }
  };

  const selected = useMemo(
    () => instances.find((a) => a.id === selectedId) ?? null,
    [instances, selectedId],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return instances.filter((inst) => {
      const def = inst.definition;
      if (category !== "all" && def.category !== category) return false;
      if (statusFilter === "active" && !inst.is_enabled) return false;
      if (statusFilter === "paused" && inst.is_enabled) return false;
      if (!q) return true;
      return (
        def.name.toLowerCase().includes(q) ||
        def.description.toLowerCase().includes(q)
      );
    });
  }, [instances, query, category, statusFilter]);

  // Grouped by VISUAL group (not raw stored category) so Inbox Triage Agent
  // lands in "Communication & Inbox" for display while its stored category
  // (and the category filter above) stays "internal" — see getVisualGroup().
  const grouped = useMemo(() => {
    const map = new Map<VisualAgentGroup, AgentInstance[]>();
    filtered.forEach((inst) => {
      const group = getVisualGroup(inst);
      const arr = map.get(group) ?? [];
      arr.push(inst);
      map.set(group, arr);
    });
    return map;
  }, [filtered]);

  // Honest, real-count operational status only (Part 6) — the legacy
  // runs_this_week/success_rate/hours_saved fields are NOT reintroduced
  // here; see AgentRow/AgentDetail for where they're de-emphasized instead
  // of removed outright (still real column data, just not presented as
  // trustworthy business metrics — see prior Phase 9.6 audit).
  const stats = useMemo(() => {
    const active = instances.filter((i) => i.is_enabled).length;
    const paused = instances.length - active;
    const dayMs = 24 * 60 * 60 * 1000;
    const ranRecently = instances.filter((i) => i.last_run_at && Date.now() - new Date(i.last_run_at).getTime() < dayMs).length;
    return { active, paused, total: instances.length, ranRecently };
  }, [instances]);

  const hasActiveFilters = query.trim() !== "" || category !== "all" || statusFilter !== "all";
  const clearFilters = () => { setQuery(""); setCategory("all"); setStatusFilter("all"); };

  return (
    <div className="space-y-3">
      <PageHeader
        icon={BrainCircuit}
        iconBg="bg-violet-soft"
        iconColor="text-violet"
        title="AI Center"
        subtitle="Manage autonomous agents, AI tools, voice agents, approvals, and execution activity."
        actions={
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 text-[11px] font-medium text-success">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
            </span>
            {/* AI-H1.1 badge-audit fix — this counts agent_instances.is_enabled
                (Autonomous Agents only, via useAICenterAgents()); it never
                included Voice Agents or Agentic Beta. The unscoped "agent(s)
                live" wording read as an AI-Center-wide claim while only ever
                reflecting one subsystem — label it explicitly instead of
                fabricating a real cross-system total. */}
            {loading ? "…" : `${stats.active} autonomous agent${stats.active === 1 ? "" : "s"} live`}
          </span>
        }
      />

      <Tabs value={topTab} onValueChange={handleTopTabChange}>
        <TabsList className="h-10 gap-1 bg-secondary/60 p-1">
          {TOP_TABS.map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              className={cn(
                "h-8 gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground",
                "data-[state=active]:border data-[state=active]:border-primary/30 data-[state=active]:bg-primary-soft",
                "data-[state=active]:text-primary data-[state=active]:shadow-sm",
                "hover:text-foreground",
              )}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="agents" className="mt-3 space-y-3">
          {/* KPI cards — honest, real operational counts only */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 mb-3">
            <MetricCard layout="row" className="px-3.5 py-2.5" label="Active agents" value={loading ? "…" : stats.active} icon={Activity} tone="success" />
            <MetricCard layout="row" className="px-3.5 py-2.5" label="Paused agents" value={loading ? "…" : stats.paused} icon={PauseCircle} tone="muted" />
            <MetricCard layout="row" className="px-3.5 py-2.5" label="Ran in last 24h" value={loading ? "…" : stats.ranRecently} icon={History} tone="primary" />
            <MetricCard layout="row" className="px-3.5 py-2.5" label="Total agents" value={loading ? "…" : stats.total} icon={Layers} tone="info" />
          </div>

          {/* Filters — one compact row, wraps cleanly at narrower widths */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="relative min-w-55 flex-1">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search agents…"
                className="h-9 pl-8 text-sm"
              />
            </div>
            <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
              <TabsList className="h-9">
                <TabsTrigger value="all" className="h-7 px-2.5 text-xs">All</TabsTrigger>
                <TabsTrigger value="active" className="h-7 px-2.5 text-xs">Active</TabsTrigger>
                <TabsTrigger value="paused" className="h-7 px-2.5 text-xs">Paused</TabsTrigger>
              </TabsList>
            </Tabs>
            <Select value={category} onValueChange={(v) => setCategory(v as "all" | AgentCategory)}>
              <SelectTrigger className="h-9 w-[168px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(CATEGORY_FILTER_LABEL) as ("all" | AgentCategory)[]).map((c) => (
                  <SelectItem key={c} value={c} className="text-xs">{CATEGORY_FILTER_LABEL[c]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasActiveFilters && (
              <Button size="sm" variant="ghost" className="h-9 text-xs" onClick={clearFilters}>
                <XIcon className="mr-1 h-3.5 w-3.5" /> Clear filters
              </Button>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
              {VISUAL_GROUP_ORDER.map((group) => {
                const items = grouped.get(group);
                if (!items || items.length === 0) return null;
                return (
                  <AgentCategoryPanel
                    key={group}
                    group={group}
                    agents={items}
                    onToggle={handleToggle}
                    onOpen={openAgent}
                  />
                );
              })}
              {filtered.length === 0 && (
                <Card className="p-8 text-center text-xs text-muted-foreground xl:col-span-2 2xl:col-span-3">
                  No agents match your filters.
                </Card>
              )}
            </div>
          )}

          <AgentDetailSheet
            instance={selected}
            onOpenChange={(open) => !open && closeAgent()}
            onToggle={() => selected && handleToggle(selected)}
          />
        </TabsContent>

        <TabsContent value="tools" className="mt-3">
          <AIToolsTab />
        </TabsContent>

        <TabsContent value="voice" className="mt-3">
          <VoiceAgentTab />
        </TabsContent>

        <TabsContent value="agentic" className="mt-3">
          <AgenticPreviewPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── AgentCategoryPanel ────────────────────────────────────────────────────────
// One grouped dashboard module (Part 4): colored header strip + white body
// of compact stacked agent rows. Six of these render in a 3×2 dashboard
// grid instead of the previous full-width vertically stacked sections.

function AgentCategoryPanel({
  group,
  agents,
  onToggle,
  onOpen,
}: {
  group: VisualAgentGroup;
  agents: AgentInstance[];
  onToggle: (inst: AgentInstance) => void;
  onOpen: (id: string) => void;
}) {
  const tint = CATEGORY_TINT[group];
  const Icon = CATEGORY_ICON[group];

  return (
    <Card className="flex min-h-[220px] flex-col overflow-hidden p-0">
      <div className={cn("flex items-center gap-2 border-b px-3 py-2", tint.headerBg, tint.border)}>
        <div className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded", tint.iconBg)}>
          <Icon className={cn("h-3.5 w-3.5", tint.icon)} />
        </div>
        <h2 className="text-[13px] font-semibold text-foreground">{CATEGORY_LABEL[group]}</h2>
        <Badge variant="secondary" className="h-4.5 rounded px-1.5 text-[10px] font-medium">
          {agents.length}
        </Badge>
      </div>
      <div className="flex-1 space-y-2.5 p-2.5">
        {agents.map((inst) => (
          <AgentRow
            key={inst.id}
            instance={inst}
            group={group}
            onToggle={() => onToggle(inst)}
            onOpen={() => onOpen(inst.id)}
          />
        ))}
      </div>
    </Card>
  );
}

// ── AgentRow ──────────────────────────────────────────────────────────────────
// Compact horizontal row (Part 6) — replaces the previous tall per-agent
// card. No legacy metric columns; last-run text or "No runs yet" only.

function AgentRow({
  instance,
  group,
  onToggle,
  onOpen,
}: {
  instance: AgentInstance;
  group: VisualAgentGroup;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const def = instance.definition;
  const Icon = resolveIcon(def.icon);
  const tint = CATEGORY_TINT[group];
  const isLive = instance.is_enabled;
  const hasRuns = (instance.runs_this_week ?? 0) > 0;
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    const update = () => setConfigured(isAgentConfigured(def.id));
    update();
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as { id?: string } | undefined;
      if (!detail?.id || detail.id === def.id) update();
    };
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === `agent-config:${def.id}`) update();
    };
    window.addEventListener("agent-config-change", onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("agent-config-change", onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [def.id]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className={cn(
        "cursor-pointer rounded-md border border-border p-3 transition-colors hover:bg-secondary/40 min-h-[76px]",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        isLive && "border-success/30",
      )}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded", tint.iconBg)}>
            <Icon className={cn("h-3.5 w-3.5", tint.icon)} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-[12.5px] font-semibold leading-tight">{def.name}</h3>
            <p className="mt-1 line-clamp-2 text-[11px] leading-[1.35] text-muted-foreground">
              {def.description}
            </p>
          </div>
        </div>
        {/* Switch communicates active/paused on its own — no duplicate badge (Part 6). stopPropagation keeps a switch click from opening the detail sheet. Top-aligned with the name, with a little breathing room from the card edge. */}
        <div onClick={(e) => e.stopPropagation()} className="ml-2 shrink-0 pt-0.5">
          <Switch checked={isLive} onCheckedChange={onToggle} aria-label={isLive ? `Pause ${def.name}` : `Enable ${def.name}`} />
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 pl-[2.375rem]">
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge variant="outline" className="h-4.5 shrink-0 rounded px-1.5 text-[9.5px]">
            {TRIGGER_LABEL[def.trigger_type] ?? def.trigger_type}
          </Badge>
          {configured && (
            <Badge
              variant="secondary"
              className="h-4.5 shrink-0 rounded border border-primary/30 bg-primary/10 px-1 text-[9px] font-medium uppercase tracking-wider text-primary"
            >
              <Settings2 className="mr-0.5 h-2.5 w-2.5" />
              Set
            </Badge>
          )}
        </div>
        <span className="shrink-0 text-[9.5px] text-muted-foreground">
          {hasRuns ? `Last run · ${fmtRelative(instance.last_run_at!)}` : "No runs yet"}
        </span>
      </div>
    </div>
  );
}

// ── AgentDetailSheet ──────────────────────────────────────────────────────────

function AgentDetailSheet({
  instance,
  onOpenChange,
  onToggle,
}: {
  instance: AgentInstance | null;
  onOpenChange: (open: boolean) => void;
  onToggle: () => void;
}) {
  return (
    <Sheet open={!!instance} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {instance && <AgentDetail instance={instance} onToggle={onToggle} />}
      </SheetContent>
    </Sheet>
  );
}

function AgentDetail({ instance, onToggle }: { instance: AgentInstance; onToggle: () => void }) {
  const def = instance.definition;
  const Icon = resolveIcon(def.icon);
  const tint = CATEGORY_TINT[getVisualGroup(instance)];
  const isLive = instance.is_enabled;
  const hasRuns = (instance.runs_this_week ?? 0) > 0;
  const [configOpen, setConfigOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);

  useEffect(() => {
    setRunsLoading(true);
    fetchRecentRuns(instance.id, 5)
      .then(setRuns)
      .finally(() => setRunsLoading(false));
  }, [instance.id]);

  const handleRun = async () => {
    setRunning(true);
    const result = await runAgentManually(def.id);
    setRunning(false);
    if (result.success) {
      toast.success(`${def.name} ran successfully`);
      fetchRecentRuns(instance.id, 5).then(setRuns);
    } else {
      toast.error(result.error ?? "Agent failed");
    }
  };

  return (
    <div className="space-y-4">
      <SheetHeader className="space-y-2 px-0 text-left">
        <div className="flex items-center gap-3">
          <div className={cn("flex h-10 w-10 items-center justify-center rounded-md", tint.iconBg)}>
            <Icon className={cn("h-5 w-5", tint.icon)} />
          </div>
          <div className="min-w-0 flex-1">
            <SheetTitle className="text-base">{def.name}</SheetTitle>
            <Badge
              variant="secondary"
              className={cn(
                "mt-1 h-5 rounded border px-1.5 text-[10px] capitalize",
                isLive ? "border-success/30 bg-success/15 text-success" : "border-border bg-muted text-muted-foreground",
              )}
            >
              {isLive ? "active" : "paused"}
            </Badge>
          </div>
        </div>
        <SheetDescription className="text-xs leading-relaxed">{def.description}</SheetDescription>
      </SheetHeader>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={isLive ? "outline" : "default"}
          className="h-9 flex-1"
          onClick={onToggle}
        >
          {isLive ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          <span className="text-sm">{isLive ? "Pause agent" : "Enable agent"}</span>
        </Button>
        <Button size="sm" variant="outline" className="h-9" onClick={() => setConfigOpen(true)}>
          <Settings2 className="h-3.5 w-3.5" />
          <span className="text-sm">Configure</span>
        </Button>
        {def.trigger_type === "manual" && (
          <Button size="sm" variant="outline" className="h-9" onClick={handleRun} disabled={running}>
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            <span className="text-sm">{running ? "Running…" : "Run"}</span>
          </Button>
        )}
      </div>

      {/* Stats — only shown once real runs exist; legacy fields are never presented as trustworthy on their own (Part 6) */}
      {hasRuns ? (
        <div className="grid grid-cols-3 gap-2">
          <DetailStat label="Runs/wk" value={(instance.runs_this_week ?? 0).toString()} />
          <DetailStat label="Success" value={`${Math.round(instance.success_rate ?? 0)}%`} />
          <DetailStat label="Saved" value={instance.hours_saved ? `${instance.hours_saved.toFixed(1)}h` : "—"} />
        </div>
      ) : (
        <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
          No runs yet — metrics will appear here once this agent executes.
        </div>
      )}

      <Separator />

      {/* Trigger info */}
      <Section title="Trigger" icon={Activity}>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary" className="h-5 rounded text-[10px]">
            {TRIGGER_LABEL[def.trigger_type] ?? def.trigger_type}
          </Badge>
          {def.trigger_config?.label && (
            <Badge variant="outline" className="h-5 rounded text-[10px]">
              {def.trigger_config.label}
            </Badge>
          )}
          {def.trigger_config?.event_type && (
            <Badge variant="outline" className="h-5 rounded text-[10px]">
              {def.trigger_config.event_type.replace(/_/g, " ")}
            </Badge>
          )}
        </div>
      </Section>

      {/* Model */}
      <Section title="Model" icon={BrainCircuit}>
        <Badge variant="outline" className="h-5 rounded text-[10px]">
          {def.model ?? "claude-haiku-4-5"}
        </Badge>
      </Section>

      {/* Recent runs */}
      <Section title="Recent runs" icon={PhoneCall}>
        {runsLoading ? (
          <div className="flex items-center gap-2 py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Loading runs…</span>
          </div>
        ) : runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No runs yet.</p>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <div
                key={run.id}
                className="flex items-start gap-2 rounded-md border border-border bg-secondary/30 p-2"
              >
                {run.status === "completed" && (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                )}
                {run.status === "failed" && (
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                )}
                {run.status === "running" && (
                  <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] leading-snug">
                    {run.result_summary
                      ? run.result_summary.slice(0, 120)
                      : run.status === "running"
                        ? "Running…"
                        : "No summary available"}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>{fmtDateTime(run.started_at)}</span>
                    {run.actions_taken?.length > 0 && (
                      <span>· {run.actions_taken.length} actions</span>
                    )}
                    {run.cost_usd && <span>· ${run.cost_usd.toFixed(4)}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {!isLive && (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2.5">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <p className="text-[11px] leading-snug text-warning">
            This agent is paused. Enable it to start processing automatically.
          </p>
        </div>
      )}

      <AgentConfigureDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        agentId={def.id}
        agentName={def.name}
        triggers={[TRIGGER_LABEL[def.trigger_type] ?? def.trigger_type]}
        channels={(def.actions ?? []).map((a: any) => a.type?.replace(/_/g, " "))}
      />
    </div>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-2.5">
      <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-base font-semibold tabular-nums">{value}</div>
    </Card>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {title}
      </div>
      {children}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function fmtDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(iso));
}
