import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import {
  Plus, Search, ChevronDown, LayoutGrid, List as ListIcon, AlertTriangle,
  DollarSign, TrendingUp, Target, Clock, SlidersHorizontal, Trophy, XCircle,
} from "lucide-react";
import { type Deal, type LostReason } from "@/lib/mock-data";
import { useDeals, updateDeal, addDeal as storeAddDeal, deleteDeal, usePipelineStages, type AddDealInput } from "@/lib/deals-store";
const LOST_REASONS_ALL: LostReason[] = ["Budget", "Timing", "Scope", "Competitor", "No response"];
import { formatMoney, formatDateShort, formatPhone } from "@/lib/format";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { DealDetailDrawer } from "@/components/sales/deal-detail-drawer";
import { STAGE_COLOR_CLASS, useActivePipelineId, usePipelines, setActivePipeline } from "@/lib/pipelines";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Link } from "@tanstack/react-router";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useTeam } from "@/lib/organization";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";

type PipelineSearch = {
  dealId?: string;
  addDeal?: string;
  pName?: string;
  pEmail?: string;
  pPhone?: string;
  pAddress?: string;
};

export const Route = createFileRoute("/sales/pipeline")({
  validateSearch: (raw: Record<string, unknown>): PipelineSearch => ({
    dealId:   typeof raw.dealId   === "string" ? raw.dealId   : undefined,
    addDeal:  typeof raw.addDeal  === "string" ? raw.addDeal  : undefined,
    pName:    typeof raw.pName    === "string" ? raw.pName    : undefined,
    pEmail:   typeof raw.pEmail   === "string" ? raw.pEmail   : undefined,
    pPhone:   typeof raw.pPhone   === "string" ? raw.pPhone   : undefined,
    pAddress: typeof raw.pAddress === "string" ? raw.pAddress : undefined,
  }),
  component: PipelinePage,
});

const VALUE_FILTERS = ["Any value", "< $25k", "$25k–$75k", "> $75k"] as const;
type ValueFilter = (typeof VALUE_FILTERS)[number];

const CLOSE_FILTERS = ["Any date", "Overdue", "Next 30 days", "Next 60 days", "Next 90 days"] as const;
type CloseFilter = (typeof CLOSE_FILTERS)[number];

function PipelinePage() {
  const { dealId, addDeal: addDealParam, pName, pEmail, pPhone, pAddress } = useSearch({ from: "/sales/pipeline" });
  const navigate = useNavigate({ from: "/sales/pipeline" });
  const deals = useDeals();
  const [search, setSearch] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [valueFilter, setValueFilter] = useState<ValueFilter>("Any value");
  const [stageFilter, setStageFilter] = useState("all");
  const [closeFilter, setCloseFilter] = useState<CloseFilter>("Any date");
  const [moreOpen, setMoreOpen] = useState(false);
  const [view, setView] = useState<"board" | "list">("board");
  const [selected, setSelected] = useState<Deal | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const teamMembers = useTeam();
  const [newDeal, setNewDeal] = useState({ name: "", contactName: "", value: "", ownerId: "", stage: "", address: "", phone: "", email: "" });

  // Open add-deal modal pre-filled when redirected from Contact drawer
  useEffect(() => {
    if (!addDealParam) return;
    setNewDeal((d) => ({
      ...d,
      contactName: pName ?? "",
      email: pEmail ?? "",
      phone: pPhone ?? "",
      address: pAddress ?? "",
    }));
    setAddOpen(true);
    navigate({ search: (s) => ({ ...s, addDeal: undefined, pName: undefined, pEmail: undefined, pPhone: undefined, pAddress: undefined }), replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pipelines = usePipelines();
  const activeId = useActivePipelineId();
  const dbStages = usePipelineStages();
  const activePipeline = useMemo(
    () => pipelines.find((p) => p.id === activeId) ?? null,
    [pipelines, activeId],
  );
  // Stages displayed on the board: active pipeline stages + terminal Won/Lost.
  // When no custom pipeline is active, use the Supabase-loaded stages so the
  // stage IDs (slugs) always match stageSlugToUuid in deals-store.
  const boardStages = useMemo(() => {
    if (!activePipeline) {
      const base = dbStages.filter((s) => s.id !== "won" && s.id !== "lost");
      return [
        ...base.map((s) => ({ id: s.id, name: s.name, colorClass: stageColor(s.id) })),
        { id: "won",  name: "Won",  colorClass: "bg-success" },
        { id: "lost", name: "Lost", colorClass: "bg-destructive" },
      ];
    }
    const custom = activePipeline.stages.map((s) => ({
      id: s.id,
      name: s.name,
      colorClass: STAGE_COLOR_CLASS[s.color],
    }));
    return [
      ...custom,
      { id: "won", name: "Won", colorClass: "bg-success" },
      { id: "lost", name: "Lost", colorClass: "bg-destructive" },
    ];
  }, [activePipeline, dbStages]);
  const stageNameById = useMemo(() => {
    const map: Record<string, string> = {};
    boardStages.forEach((s) => { map[s.id] = s.name; });
    dbStages.forEach((s) => { if (!map[s.id]) map[s.id] = s.name; });
    return map;
  }, [boardStages, dbStages]);

  // Deep-link: open the matching deal drawer when ?dealId=... is present.
  useEffect(() => {
    if (dealId) {
      const found = deals.find((d) => d.id === dealId);
      if (found && found.id !== selected?.id) setSelected(found);
    } else if (selected) {
      setSelected(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId, deals]);

  const handleStageChange = (id: string, newStage: string) => {
    updateDeal(id, { stage: newStage, lostReason: undefined, lostAt: undefined }).catch(() => {
      toast.error("Failed to update deal stage. Please try again.");
    });
  };

  const handleMarkLost = (id: string, reason: LostReason, _notes: string) => {
    updateDeal(id, { stage: "lost", lostReason: reason, lostAt: new Date().toISOString() }).catch(() => {
      toast.error("Failed to mark deal as lost. Please try again.");
    });
  };

  const onDragEnd = (result: DropResult) => {
    const { destination, source, draggableId } = result;
    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) return;
    updateDeal(draggableId, { stage: destination.droppableId }).catch(() => {
      toast.error("Failed to move deal. Please try again.");
    });
  };

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const knownStageIds = new Set(boardStages.map((s) => s.id));
    const firstStageId = boardStages[0]?.id;
    const now = Date.now();
    return deals.map((d) => {
      if (d.stage !== "won" && d.stage !== "lost" && !knownStageIds.has(d.stage) && firstStageId) {
        return { ...d, stage: firstStageId };
      }
      return d;
    }).filter((d) => {
      // Owner filter — match by ownerId (UUID) when available, fall back to name string
      if (ownerFilter !== "all") {
        const matchById = d.ownerId === ownerFilter;
        const matchByName = d.owner === ownerFilter;
        if (!matchById && !matchByName) return false;
      }
      // Value filter
      if (valueFilter === "< $25k" && d.value >= 25000) return false;
      if (valueFilter === "$25k–$75k" && (d.value < 25000 || d.value > 75000)) return false;
      if (valueFilter === "> $75k" && d.value <= 75000) return false;
      // Stage filter (More popover)
      if (stageFilter !== "all" && d.stage !== stageFilter) return false;
      // Close date filter (More popover)
      if (closeFilter !== "Any date" && d.expectedClose) {
        const closeMs = new Date(d.expectedClose).getTime();
        if (closeFilter === "Overdue" && closeMs >= now) return false;
        if (closeFilter === "Next 30 days" && (closeMs < now || closeMs > now + 30 * 86400000)) return false;
        if (closeFilter === "Next 60 days" && (closeMs < now || closeMs > now + 60 * 86400000)) return false;
        if (closeFilter === "Next 90 days" && (closeMs < now || closeMs > now + 90 * 86400000)) return false;
      }
      if (!q) return true;
      return d.name.toLowerCase().includes(q) || d.contactName.toLowerCase().includes(q);
    });
  }, [deals, search, ownerFilter, valueFilter, stageFilter, closeFilter, boardStages]);

  const stats = useMemo(() => {
    const open = filtered.filter((d) => d.stage !== "won" && d.stage !== "lost");
    const won = filtered.filter((d) => d.stage === "won");
    const lost = filtered.filter((d) => d.stage === "lost");
    const pipelineValue = open.reduce((s, d) => s + d.value, 0);
    const wonValue = won.reduce((s, d) => s + d.value, 0);
    const lostValue = lost.reduce((s, d) => s + d.value, 0);
    const decided = won.length + lost.length;
    const winRate = decided > 0 ? Math.round((won.length / decided) * 100) : 0;
    const total = filtered.length;
    const avgDeal = total > 0 ? Math.round(filtered.reduce((s, d) => s + d.value, 0) / total) : 0;
    const avgAge = open.length > 0 ? Math.round(open.reduce((s, d) => s + d.ageDays, 0) / open.length) : 0;
    return { pipelineValue, wonValue, lostValue, winRate, avgDeal, avgAge, openCount: open.length, wonCount: won.length, lostCount: lost.length };
  }, [filtered]);

  const lostBreakdown = useMemo(() => {
    const allLost = filtered.filter((d) => d.stage === "lost");
    const withReason = allLost.filter((d) => d.lostReason);
    const totals = LOST_REASONS_ALL.map((reason) => {
      const items = withReason.filter((d) => d.lostReason === reason);
      return { reason, count: items.length, value: items.reduce((s, d) => s + d.value, 0) };
    });
    const max = Math.max(1, ...totals.map((t) => t.count));
    return { totals, max, totalLost: withReason.length, totalLostAny: allLost.length };
  }, [filtered]);

  const activeOwnerName = useMemo(() => {
    if (ownerFilter === "all") return null;
    return teamMembers.find((m) => m.id === ownerFilter)?.name ?? null;
  }, [ownerFilter, teamMembers]);

  const activeFilterCount = [
    stageFilter !== "all",
    closeFilter !== "Any date",
  ].filter(Boolean).length;

  return (
    <div className="-mb-6 flex h-[calc(100vh-5rem)] flex-col overflow-hidden">
      <PageHeader
        title="Sales Pipeline"
        subtitle="Track deals from first touch to won."
        breadcrumb={["CRM", "Pipeline"]}
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8">
                  {activePipeline?.name ?? "Default Pipeline"}
                  <ChevronDown className="ml-1 h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                <DropdownMenuLabel>Switch Pipeline</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => setActivePipeline(null)}
                  className={!activeId ? "font-medium" : ""}
                >
                  Default Pipeline
                  {!activeId && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
                </DropdownMenuItem>
                {pipelines.map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    onSelect={() => setActivePipeline(p.id)}
                    className={p.id === activeId ? "font-semibold bg-accent" : ""}
                  >
                    {p.name}
                    {p.id === activeId && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/settings/pipelines" className="text-xs">
                    Manage pipelines…
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" className="h-8" onClick={() => setAddOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Deal
            </Button>
          </>
        }
      />

      {/* KPIs */}
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Pipeline value" value={formatMoney(stats.pipelineValue)} sub={`${stats.openCount} open deals`} icon={DollarSign} tone="primary" />
        <Kpi label="Win rate" value={`${stats.winRate}%`} sub={`${formatMoney(stats.wonValue)} won`} icon={TrendingUp} tone="success" />
        <Kpi label="Won / Lost" value={`${stats.wonCount} / ${stats.lostCount}`} sub={`${formatMoney(stats.wonValue)} vs ${formatMoney(stats.lostValue)}`} icon={Trophy} tone="success" />
        <Kpi label="Avg deal size" value={formatMoney(stats.avgDeal)} sub="Across all stages" icon={Target} tone="warning" />
        <Kpi label="Avg age" value={`${stats.avgAge}d`} sub="In current stage" icon={Clock} tone="muted" />
      </div>

      {/* Lost-reason breakdown */}
      <Card className="mb-3 p-3">
        <div className="mb-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-destructive/10 text-destructive">
              <XCircle className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-semibold">Lost reasons</div>
              <div className="text-[11px] text-muted-foreground">
                {lostBreakdown.totalLostAny === 0
                  ? "No lost deals yet"
                  : `${lostBreakdown.totalLostAny} lost · ${formatMoney(stats.lostValue)} in value`}
              </div>
            </div>
          </div>
        </div>
        {lostBreakdown.totalLostAny === 0 ? (
          <div className="py-4 text-center text-[11px] text-muted-foreground">
            No lost deals yet.
          </div>
        ) : lostBreakdown.totalLost === 0 ? (
          <div className="py-4 text-center text-[11px] text-muted-foreground">
            Mark a deal as lost with a reason to see breakdown insights here.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {lostBreakdown.totals.map((t) => {
              const pct = Math.round((t.count / lostBreakdown.max) * 100);
              const sharePct = lostBreakdown.totalLost > 0 ? Math.round((t.count / lostBreakdown.totalLost) * 100) : 0;
              return (
                <div key={t.reason} className="rounded-md border border-border bg-secondary/30 p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-medium">{t.reason}</span>
                    <span className="text-[11px] font-semibold tabular-nums text-muted-foreground">{t.count}</span>
                  </div>
                  <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-destructive/70 transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
                    <span>{sharePct}% share</span>
                    <span>{formatMoney(t.value)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Filters */}
      <Card className="mb-3 shrink-0 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search deals or contacts…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-sm"
            />
          </div>
          {/* Owner — real team members */}
          <Select value={ownerFilter} onValueChange={setOwnerFilter}>
            <SelectTrigger className="h-8 w-auto min-w-[130px] text-xs">
              <SelectValue placeholder="All owners">
                {ownerFilter === "all" ? "All owners" : (activeOwnerName ?? "Owner")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All owners</SelectItem>
              {teamMembers.filter((m) => m.status === "active").map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="mx-0.5 h-5 w-px bg-border" />
          {/* Value chips */}
          <div className="flex items-center gap-1">
            {VALUE_FILTERS.map((v) => (
              <FilterChip key={v} active={valueFilter === v} onClick={() => setValueFilter(v)}>
                {v}
              </FilterChip>
            ))}
          </div>
          {/* More filters popover */}
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                More
                {activeFilterCount > 0 && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                    {activeFilterCount}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 space-y-4 p-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Stage</Label>
                <Select value={stageFilter} onValueChange={setStageFilter}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All stages</SelectItem>
                    {boardStages.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Expected close</Label>
                <Select value={closeFilter} onValueChange={(v) => setCloseFilter(v as CloseFilter)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CLOSE_FILTERS.map((f) => (
                      <SelectItem key={f} value={f}>{f}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {activeFilterCount > 0 && (
                <Button variant="ghost" size="sm" className="h-7 w-full text-xs text-muted-foreground" onClick={() => {
                  setStageFilter("all");
                  setCloseFilter("Any date");
                  setMoreOpen(false);
                }}>
                  Clear filters
                </Button>
              )}
            </PopoverContent>
          </Popover>
          <div className="ml-auto flex h-8 items-center rounded-md border border-border bg-card p-0.5">
            <Button size="sm" variant={view === "board" ? "secondary" : "ghost"} className="h-7 px-2" onClick={() => setView("board")}>
              <LayoutGrid className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant={view === "list" ? "secondary" : "ghost"} className="h-7 px-2" onClick={() => setView("list")}>
              <ListIcon className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </Card>

      {view === "board" ? (
        <DragDropContext onDragEnd={onDragEnd}>
          <div className="-mx-6 flex-1 min-h-0 overflow-auto px-6 pb-6">
            <div className="flex h-full min-w-max gap-3">
              {boardStages.map((stage) => {
                const stageDeals = filtered.filter((d) => d.stage === stage.id);
                const stageTotal = stageDeals.reduce((s, d) => s + d.value, 0);
                return (
                  <div key={stage.id} className="flex w-[300px] shrink-0 flex-col">
                    <div className="mb-2 flex items-center justify-between px-1">
                      <div className="flex items-center gap-2">
                        <div className={`h-1.5 w-1.5 rounded-full ${stage.colorClass}`} />
                        <span className="text-sm font-semibold">{stage.name}</span>
                        <Badge variant="secondary" className="h-5 rounded px-1.5 text-[10px]">{stageDeals.length}</Badge>
                      </div>
                      <span className="text-xs font-medium text-muted-foreground tabular-nums">
                        {stageTotal >= 1000 ? `$${(stageTotal / 1000).toFixed(0)}k` : `$${stageTotal}`}
                      </span>
                    </div>

                    <Droppable droppableId={stage.id}>
                      {(provided, snapshot) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.droppableProps}
                          className={`flex min-h-24 flex-col gap-2 rounded-lg border border-dashed p-2 transition-colors ${
                            snapshot.isDraggingOver ? "border-primary/40 bg-primary-soft/40" : "border-border bg-secondary/30"
                          }`}
                        >
                          {stageDeals.map((deal, idx) => (
                            <Draggable key={deal.id} draggableId={deal.id} index={idx}>
                              {(prov, snap) => (
                                <Card
                                  ref={prov.innerRef}
                                  {...prov.draggableProps}
                                  {...prov.dragHandleProps}
                                  onClick={() => navigate({ search: { dealId: deal.id }, replace: true })}
                                  className={`cursor-pointer p-3 transition-shadow ${snap.isDragging ? "rotate-1 shadow-[var(--shadow-elev-2)]" : "hover:shadow-[var(--shadow-elev-1)]"}`}
                                >
                                  <div className="mb-1.5 flex items-start justify-between gap-2">
                                    <div className={`text-[13px] font-medium leading-snug ${deal.lostReason ? "text-muted-foreground line-through" : ""}`}>
                                      {deal.name}
                                    </div>
                                    <div className="text-[13px] font-semibold tabular-nums">
                                      ${(deal.value / 1000).toFixed(1)}k
                                    </div>
                                  </div>
                                  <div className="mb-2 flex items-center justify-between gap-2">
                                    <div className="text-[11px] text-muted-foreground">{deal.contactName}</div>
                                    {deal.lostReason && (
                                      <Badge variant="outline" className="h-4 rounded border-destructive/30 bg-destructive/5 px-1 text-[9px] font-medium text-destructive">
                                        Lost · {deal.lostReason}
                                      </Badge>
                                    )}
                                  </div>
                                  <div className="mb-2 flex items-center gap-1.5">
                                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
                                      <div
                                        className={`h-full rounded-full ${stageColor(deal.stage)}`}
                                        style={{ width: `${stageProgress(deal.stage)}%` }}
                                      />
                                    </div>
                                    <span className="text-[10px] tabular-nums text-muted-foreground">
                                      {stageProgress(deal.stage)}%
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-1.5">
                                      <Avatar className="h-5 w-5">
                                        <AvatarFallback className="bg-primary-soft text-[9px] font-medium text-primary">
                                          {deal.ownerInitials}
                                        </AvatarFallback>
                                      </Avatar>
                                      <span className="text-[11px] text-muted-foreground">
                                        {formatExpectedClose(deal.expectedClose)}
                                      </span>
                                    </div>
                                    {deal.ageDays > 14 && (
                                      <span className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                        <AlertTriangle className="h-3 w-3" />
                                        {deal.ageDays}d
                                      </span>
                                    )}
                                  </div>
                                </Card>
                              )}
                            </Draggable>
                          ))}
                          {provided.placeholder}
                          {stageDeals.length === 0 && (
                            <div className="py-8 text-center text-[11px] text-muted-foreground">
                              Drag deals here
                            </div>
                          )}
                        </div>
                      )}
                    </Droppable>
                  </div>
                );
              })}
            </div>
          </div>
        </DragDropContext>
      ) : (
        <Card className="flex-1 min-h-0 overflow-hidden p-0">
          <div className="h-full overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-secondary/60 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2.5 pl-4 pr-4 text-left">Deal</th>
                  <th className="py-2.5 pr-4 text-left">Contact</th>
                  <th className="py-2.5 pr-4 text-left">Stage</th>
                  <th className="py-2.5 pr-4 text-right">Value</th>
                  <th className="py-2.5 pr-4 text-left">Owner</th>
                  <th className="py-2.5 pr-4 text-left">Expected close</th>
                  <th className="py-2.5 pr-4 text-left">Age</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="py-12 text-center text-sm text-muted-foreground">No deals match your filters.</td></tr>
                )}
                {filtered.map((d) => (
                  <tr key={d.id} onClick={() => navigate({ search: { dealId: d.id }, replace: true })} className="cursor-pointer border-b border-border hover:bg-secondary/40">
                    <td className="py-2.5 pl-4 pr-4 font-medium">{d.name}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{d.contactName}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant="outline" className="h-5 rounded px-1.5 text-[10px]">
                        <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${stageColor(d.stage)}`} />
                        {stageNameById[d.stage] ?? d.stage}
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-4 text-right font-semibold tabular-nums">{formatMoney(d.value)}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{d.owner}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{formatDateShort(d.expectedClose)}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground tabular-nums">{d.ageDays}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <DealDetailDrawer
        deal={selected ? deals.find((d) => d.id === selected.id) ?? selected : null}
        onOpenChange={(o) => { if (!o) navigate({ search: { dealId: undefined }, replace: true }); }}
        onStageChange={handleStageChange}
        onMarkLost={handleMarkLost}
        onDealUpdate={(dealId, patch) => {
          updateDeal(dealId, patch).catch(() => {
            toast.error("Failed to save changes. Please try again.");
          });
        }}
        onDelete={(dealId) => {
          deleteDeal(dealId).catch(() => {
            toast.error("Failed to delete deal. Please try again.");
          });
          navigate({ search: { dealId: undefined }, replace: true });
          toast.success("Deal deleted");
        }}
        stages={boardStages}
        teamMembers={teamMembers.map((m) => ({ id: m.id, name: m.name }))}
      />

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent onInteractOutside={(e) => {
          const target = ((e as CustomEvent).detail?.originalEvent?.target ?? e.target) as HTMLElement | null;
          if (target?.closest?.(".pac-container")) e.preventDefault();
        }}>
          <DialogHeader>
            <DialogTitle>Add Deal</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Deal name</Label>
              <Input value={newDeal.name} onChange={(e) => setNewDeal((d) => ({ ...d, name: e.target.value }))} placeholder="e.g. Kitchen remodel" />
            </div>
            <div className="space-y-1.5">
              <Label>Contact name</Label>
              <Input value={newDeal.contactName} onChange={(e) => setNewDeal((d) => ({ ...d, contactName: e.target.value }))} placeholder="e.g. John Smith" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input type="email" value={newDeal.email} onChange={(e) => setNewDeal((d) => ({ ...d, email: e.target.value }))} placeholder="john@example.com" />
              </div>
              <div className="space-y-1.5">
                <Label>Phone</Label>
                <Input type="tel" value={newDeal.phone} onChange={(e) => setNewDeal((d) => ({ ...d, phone: formatPhone(e.target.value) }))} placeholder="(555) 123-4567" inputMode="tel" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Address</Label>
              <AddressAutocomplete
                value={newDeal.address}
                onChange={(v) => setNewDeal((d) => ({ ...d, address: v }))}
                onSelect={(parts) =>
                  setNewDeal((d) => ({
                    ...d,
                    address: [parts.street, parts.city, `${parts.state} ${parts.zip}`].filter(Boolean).join(", "),
                  }))
                }
                placeholder="123 Main St, City, ST"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Value ($)</Label>
              <Input type="number" value={newDeal.value} onChange={(e) => setNewDeal((d) => ({ ...d, value: e.target.value }))} placeholder="25000" />
            </div>
            <div className="space-y-1.5">
              <Label>Starting stage</Label>
              <Select value={newDeal.stage} onValueChange={(v) => setNewDeal((d) => ({ ...d, stage: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="First stage (default)" />
                </SelectTrigger>
                <SelectContent>
                  {boardStages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Owner</Label>
              <Select value={newDeal.ownerId} onValueChange={(v) => setNewDeal((d) => ({ ...d, ownerId: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select team member" />
                </SelectTrigger>
                <SelectContent>
                  {teamMembers.filter((m) => m.status === "active").map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={creating}>Cancel</Button>
            <Button
              disabled={!newDeal.name.trim() || creating}
              onClick={async () => {
                const ownerMember = teamMembers.find((m) => m.id === newDeal.ownerId)
                  ?? teamMembers.find((m) => m.status === "active");
                const input: AddDealInput = {
                  name: newDeal.name.trim(),
                  contactName: newDeal.contactName.trim(),
                  email: newDeal.email.trim(),
                  phone: newDeal.phone.trim(),
                  address: newDeal.address.trim(),
                  value: Number(newDeal.value) || 0,
                  stage: newDeal.stage || boardStages[0]?.id || "new",
                  ownerId: ownerMember?.id ?? "",
                  ownerName: ownerMember?.name ?? "Unassigned",
                };
                setCreating(true);
                try {
                  await storeAddDeal(input);
                  setNewDeal({ name: "", contactName: "", value: "", ownerId: "", stage: "", address: "", phone: "", email: "" });
                  setAddOpen(false);
                  toast.success(`Deal "${input.name}" created`);
                } catch {
                  toast.error("Failed to create deal. Please try again.");
                } finally {
                  setCreating(false);
                }
              }}
            >
              {creating ? "Creating…" : "Create Deal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`h-8 rounded-md border px-2.5 text-xs font-medium transition-colors ${
        active
          ? "border-primary/30 bg-primary-soft text-primary"
          : "border-border bg-background text-muted-foreground hover:bg-secondary/60"
      }`}
    >
      {children}
    </button>
  );
}

function Kpi({
  label,
  value,
  sub,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "primary" | "success" | "warning" | "muted";
}) {
  const toneClass = {
    primary: "bg-primary-soft text-primary",
    success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    muted: "bg-secondary text-muted-foreground",
  }[tone];
  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>
        </div>
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${toneClass}`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </Card>
  );
}

function formatExpectedClose(value: string) {
  const target = utcDayTimestamp(new Date(value));
  const today = utcDayTimestamp(new Date());
  const diffDays = Math.max(0, Math.round((target - today) / 86_400_000));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "in 1 day";
  if (diffDays < 30) return `in ${diffDays} days`;

  const months = Math.round(diffDays / 30);
  return months === 1 ? "in 1 month" : `in ${months} months`;
}

function utcDayTimestamp(value: Date) {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function stageColor(id: string) {
  const map: Record<string, string> = {
    new: "bg-muted-foreground",
    qualified: "bg-primary",
    "site-visit": "bg-chart-2",
    proposal: "bg-warning",
    negotiation: "bg-chart-5",
    won: "bg-success",
    lost: "bg-destructive",
  };
  return map[id] ?? "bg-muted-foreground";
}

function stageProgress(id: string) {
  const map: Record<string, number> = {
    new: 10,
    qualified: 30,
    "site-visit": 50,
    proposal: 70,
    negotiation: 85,
    won: 100,
    lost: 100,
  };
  return map[id] ?? 0;
}
