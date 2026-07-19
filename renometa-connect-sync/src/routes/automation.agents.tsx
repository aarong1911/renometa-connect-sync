import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { AgentSearchParams } from "@/lib/routes";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import {
  Bot,
  Search,
  Sparkles,
  Activity,
  Zap,
  TrendingUp,
  CheckCircle2,
  AlertCircle,
  Clock,
  type LucideIcon,
  Filter as FilterIcon,
  MessageSquare,
  PhoneCall,
  ClipboardList,
  Megaphone,
  Receipt,
  Star,
  Inbox as InboxIcon,
  Voicemail,
  Eye,
  Loader2,
  Play,
  Pause,
  Settings2,
  XCircle,
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

type TopTab = "agents" | "tools" | "voice";
type AgentsSearchParams = AgentSearchParams & { tab?: TopTab };

export const Route = createFileRoute("/automation/agents")({
  validateSearch: (search: Record<string, unknown>): AgentsSearchParams => ({
    agentId: typeof search.agentId === "string" ? search.agentId : undefined,
    tab:
      search.tab === "agents" || search.tab === "tools" || search.tab === "voice"
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

const ICON_MAP: Record<string, LucideIcon> = {
  filter: FilterIcon,
  zap: Zap,
  clock: Clock,
  "clipboard-list": ClipboardList,
  "message-square": MessageSquare,
  receipt: Receipt,
  star: Star,
  inbox: InboxIcon,
  voicemail: Voicemail,
  eye: Eye,
  "file-text": MessageSquare,
  brain: Bot,
  "list-checks": CheckCircle2,
  "bar-chart-3": TrendingUp,
};

function resolveIcon(iconName: string): LucideIcon {
  return ICON_MAP[iconName] ?? Bot;
}

// ── Category metadata ─────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<AgentCategory, string> = {
  sales: "Sales & lead response",
  ops: "Estimating & project ops",
  financials: "Financials",
  marketing: "Reputation & marketing",
  internal: "Internal / horizontal",
};

const CATEGORY_DOT: Record<AgentCategory, string> = {
  sales: "bg-primary",
  ops: "bg-warning",
  financials: "bg-success",
  marketing: "bg-accent-foreground",
  internal: "bg-muted-foreground",
};

const TRIGGER_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  event: "Event-driven",
  manual: "Manual",
};

type StatusFilter = "all" | "active" | "paused";

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

  const grouped = useMemo(() => {
    const map = new Map<AgentCategory, AgentInstance[]>();
    filtered.forEach((inst) => {
      const cat = inst.definition.category;
      const arr = map.get(cat) ?? [];
      arr.push(inst);
      map.set(cat, arr);
    });
    return map;
  }, [filtered]);

  const stats = useMemo(() => {
    const active = instances.filter((i) => i.is_enabled).length;
    const runs = instances.reduce((s, i) => s + (i.runs_this_week ?? 0), 0);
    const hours = instances.reduce((s, i) => s + (i.hours_saved ?? 0), 0);
    const withRuns = instances.filter((i) => (i.runs_this_week ?? 0) > 0);
    const avgSuccess =
      withRuns.length === 0
        ? 0
        : Math.round(withRuns.reduce((s, i) => s + (i.success_rate ?? 0), 0) / withRuns.length);
    return { active, runs, hours, avgSuccess };
  }, [instances]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">AI Center</h1>
            <Badge variant="secondary" className="h-5 rounded text-[10px]">
              <Sparkles className="mr-1 h-3 w-3" />
              {loading ? "…" : `${stats.active} live`}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Autonomous agents, on-demand AI tools, and voice agents — all in one place.
          </p>
        </div>
      </div>

      <Tabs value={topTab} onValueChange={handleTopTabChange}>
        <TabsList className="h-9">
          <TabsTrigger value="agents" className="px-4 text-xs">Autonomous Agents</TabsTrigger>
          <TabsTrigger value="tools" className="px-4 text-xs">AI Tools</TabsTrigger>
          <TabsTrigger value="voice" className="px-4 text-xs">Voice Agent</TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="mt-4 space-y-4">
          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Active agents" value={loading ? "…" : stats.active.toString()} icon={Activity} accent="text-success" />
            <StatCard label="Runs this week" value={loading ? "…" : stats.runs.toLocaleString()} icon={Zap} accent="text-primary" />
            <StatCard label="Hours saved" value={loading ? "…" : `${stats.hours.toFixed(1)}h`} icon={Clock} accent="text-warning" />
            <StatCard label="Avg success rate" value={loading ? "…" : `${stats.avgSuccess}%`} icon={TrendingUp} accent="text-success" />
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-55 flex-1">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search agents…"
                className="h-8 pl-8 text-xs"
              />
            </div>
            <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
              <TabsList className="h-8">
                <TabsTrigger value="all" className="h-7 px-2.5 text-xs">All</TabsTrigger>
                <TabsTrigger value="active" className="h-7 px-2.5 text-xs">Active</TabsTrigger>
                <TabsTrigger value="paused" className="h-7 px-2.5 text-xs">Paused</TabsTrigger>
              </TabsList>
            </Tabs>
            <Tabs value={category} onValueChange={(v) => setCategory(v as "all" | AgentCategory)}>
              <TabsList className="h-8">
                <TabsTrigger value="all" className="h-7 px-2.5 text-xs">All</TabsTrigger>
                <TabsTrigger value="sales" className="h-7 px-2.5 text-xs">Sales</TabsTrigger>
                <TabsTrigger value="ops" className="h-7 px-2.5 text-xs">Ops</TabsTrigger>
                <TabsTrigger value="financials" className="h-7 px-2.5 text-xs">Financials</TabsTrigger>
                <TabsTrigger value="marketing" className="h-7 px-2.5 text-xs">Marketing</TabsTrigger>
                <TabsTrigger value="internal" className="h-7 px-2.5 text-xs">Internal</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-5">
              {(Object.keys(CATEGORY_LABEL) as AgentCategory[]).map((cat) => {
                const items = grouped.get(cat);
                if (!items || items.length === 0) return null;
                return (
                  <section key={cat}>
                    <div className="mb-2 flex items-center gap-2">
                      <span className={cn("h-2 w-2 rounded-full", CATEGORY_DOT[cat])} />
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {CATEGORY_LABEL[cat]}
                      </h2>
                      <span className="text-[10px] text-muted-foreground">· {items.length}</span>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {items.map((inst) => (
                        <AgentCard
                          key={inst.id}
                          instance={inst}
                          onToggle={() => handleToggle(inst)}
                          onOpen={() => openAgent(inst.id)}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
              {filtered.length === 0 && (
                <Card className="p-8 text-center text-xs text-muted-foreground">
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

        <TabsContent value="tools" className="mt-4">
          <AIToolsTab />
        </TabsContent>

        <TabsContent value="voice" className="mt-4">
          <VoiceAgentTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── StatCard ──────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, accent }: { label: string; value: string; icon: LucideIcon; accent: string }) {
  return (
    <Card className="p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        <Icon className={cn("h-3.5 w-3.5", accent)} />
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </Card>
  );
}

// ── AgentCard ─────────────────────────────────────────────────────────────────

function AgentCard({
  instance,
  onToggle,
  onOpen,
}: {
  instance: AgentInstance;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const def = instance.definition;
  const Icon = resolveIcon(def.icon);
  const isLive = instance.is_enabled;
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
    <Card
      className={cn(
        "group relative cursor-pointer p-3.5 transition-all hover:shadow-md",
        isLive && "ring-1 ring-inset ring-success/20",
      )}
      onClick={onOpen}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-md border",
              isLive
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border bg-muted text-muted-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold">{def.name}</h3>
              {isLive && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
                </span>
              )}
              {configured && (
                <Badge
                  variant="secondary"
                  className="h-4 rounded border border-primary/30 bg-primary/10 px-1 text-[9px] font-medium uppercase tracking-wider text-primary"
                >
                  <Settings2 className="mr-0.5 h-2.5 w-2.5" />
                  Configured
                </Badge>
              )}
            </div>
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
              {def.description}
            </p>
          </div>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <Switch checked={isLive} onCheckedChange={onToggle} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-2.5">
        <Stat label="Runs/wk" value={(instance.runs_this_week ?? 0).toString()} />
        <Stat label="Success" value={instance.runs_this_week ? `${Math.round(instance.success_rate ?? 0)}%` : "—"} />
        <Stat label="Saved" value={instance.hours_saved ? `${instance.hours_saved.toFixed(1)}h` : "—"} />
      </div>

      <div className="mt-2.5 flex items-center justify-between">
        <Badge
          variant="secondary"
          className={cn(
            "h-5 rounded border px-1.5 text-[10px] capitalize",
            isLive
              ? "border-success/30 bg-success/15 text-success"
              : "border-border bg-muted text-muted-foreground",
          )}
        >
          {isLive ? "active" : "paused"}
        </Badge>
        <span className="text-[10px] text-muted-foreground">
          Last run · {instance.last_run_at ? fmtRelative(instance.last_run_at) : "Never"}
        </span>
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
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
  const isLive = instance.is_enabled;
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
          <div
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-md border",
              isLive ? "border-primary/30 bg-primary/10 text-primary" : "border-border bg-muted text-muted-foreground",
            )}
          >
            <Icon className="h-5 w-5" />
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
          className="h-8 flex-1"
          onClick={onToggle}
        >
          {isLive ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          <span className="text-xs">{isLive ? "Pause agent" : "Enable agent"}</span>
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={() => setConfigOpen(true)}>
          <Settings2 className="h-3.5 w-3.5" />
          <span className="text-xs">Configure</span>
        </Button>
        {def.trigger_type === "manual" && (
          <Button size="sm" variant="outline" className="h-8" onClick={handleRun} disabled={running}>
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            <span className="text-xs">{running ? "Running…" : "Run"}</span>
          </Button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2">
        <DetailStat label="Runs/wk" value={(instance.runs_this_week ?? 0).toString()} />
        <DetailStat label="Success" value={instance.runs_this_week ? `${Math.round(instance.success_rate ?? 0)}%` : "—"} />
        <DetailStat label="Saved" value={instance.hours_saved ? `${instance.hours_saved.toFixed(1)}h` : "—"} />
      </div>

      <Separator />

      {/* Trigger info */}
      <Section title="Trigger" icon={Zap}>
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
      <Section title="Model" icon={Megaphone}>
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
