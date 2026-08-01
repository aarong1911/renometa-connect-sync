// src/routes/pipeline.tsx

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  DragDropContext,
  Draggable,
  Droppable,
  type DraggableProvided,
  type DropResult,
} from "@hello-pangea/dnd";
import {
  createFileRoute,
  Link,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  GitBranch,
  LayoutGrid,
  List as ListIcon,
  Plus,
  Search,
  SlidersHorizontal,
  Target,
  TrendingUp,
  Trophy,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/app-shell";
import { DealDetailDrawer } from "@/components/sales/deal-detail-drawer";
import { NewDealDialog } from "@/components/sales/new-deal-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MetricCard } from "@/components/ui/metric-card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteDeal,
  updateDeal,
  useDeals,
  usePipelineStages,
  usePipelines,
} from "@/lib/deals-store";
import { formatDateShort, formatMoney } from "@/lib/format";
import { useTeam } from "@/lib/organization";
import type {
  Deal,
  LostReason,
  SalesPipelineStage,
  StageOutcome,
} from "@/lib/sales/types";

type PipelineSearch = {
  dealId?: string;
  addDeal?: string;
  pName?: string;
  pEmail?: string;
  pPhone?: string;
  pAddress?: string;
};

type BoardStage = {
  id: string;
  pipelineId?: string;
  name: string;
  slug: string;
  color: string;
  probability: number;
  position: number;
  outcome: StageOutcome;
};

type ValueFilter =
  | "Any value"
  | "< $25k"
  | "$25k–$75k"
  | "> $75k";

type CloseFilter =
  | "Any date"
  | "Overdue"
  | "Next 30 days"
  | "Next 60 days"
  | "Next 90 days";

const VALUE_FILTERS: ValueFilter[] = [
  "Any value",
  "< $25k",
  "$25k–$75k",
  "> $75k",
];

const CLOSE_FILTERS: CloseFilter[] = [
  "Any date",
  "Overdue",
  "Next 30 days",
  "Next 60 days",
  "Next 90 days",
];

const LOST_REASONS: LostReason[] = [
  "Budget",
  "Timing",
  "Scope",
  "Competitor",
  "No response",
];

const DEFAULT_STAGE_COLORS = [
  "#0EA5E9",
  "#8B5CF6",
  "#F59E0B",
  "#3B82F6",
  "#22C55E",
  "#EF4444",
];

const STAGE_COLOR_BY_SLUG: Record<string, string> = {
  "new-lead": "#0EA5E9",
  "new-opportunity": "#0EA5E9",
  new: "#0EA5E9",
  qualified: "#8B5CF6",
  "proposal-sent": "#F59E0B",
  proposal: "#F59E0B",
  negotiation: "#3B82F6",
  won: "#22C55E",
  lost: "#EF4444",
};

export const Route = createFileRoute("/pipeline")({
  validateSearch: (raw: Record<string, unknown>): PipelineSearch => ({
    dealId:
      typeof raw.dealId === "string" ? raw.dealId : undefined,
    addDeal:
      typeof raw.addDeal === "string" ? raw.addDeal : undefined,
    pName:
      typeof raw.pName === "string" ? raw.pName : undefined,
    pEmail:
      typeof raw.pEmail === "string" ? raw.pEmail : undefined,
    pPhone:
      typeof raw.pPhone === "string" ? raw.pPhone : undefined,
    pAddress:
      typeof raw.pAddress === "string" ? raw.pAddress : undefined,
  }),
  component: PipelinePage,
});

function PipelinePage() {
  const searchParams = useSearch({ from: "/pipeline" });
  const navigate = useNavigate({ from: "/pipeline" });

  const deals = useDeals();
  const pipelines = usePipelines();
  const pipelineStages = usePipelineStages();
  const teamMembers = useTeam();
  const [activePipelineId, setActivePipelineId] = useState<string | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState("all");
  const [valueFilter, setValueFilter] =
    useState<ValueFilter>("Any value");
  const [closeFilter, setCloseFilter] =
    useState<CloseFilter>("Any date");
  const [view, setView] = useState<"board" | "list">("board");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [optimisticStageByDeal, setOptimisticStageByDeal] = useState<
    Record<string, string>
  >({});
  const [dealPrefill, setDealPrefill] = useState<{
    contactName?: string;
    email?: string;
    phone?: string;
    address?: string;
  }>({});

  useEffect(() => {
    if (!pipelines.length) return;

    const storedId =
      typeof window !== "undefined"
        ? window.localStorage.getItem(
            "renometa.sales.active-pipeline",
          )
        : null;

    const validStored = pipelines.some(
      (pipeline) => pipeline.id === storedId,
    );

    if (validStored && storedId) {
      setActivePipelineId(storedId);
      return;
    }

    const fallback =
      pipelines.find((pipeline) => pipeline.isDefault) ??
      pipelines[0];

    setActivePipelineId(fallback?.id ?? null);
  }, [pipelines]);

  const activePipeline = useMemo(() => {
    return (
      pipelines.find((pipeline) => {
        return pipeline.id === activePipelineId;
      }) ??
      pipelines.find((pipeline) => pipeline.isDefault) ??
      pipelines[0] ??
      null
    );
  }, [activePipelineId, pipelines]);

  const boardStages = useMemo(() => {
    const pipelineId = activePipeline?.id;

    const relevantStages = pipelineStages
      .filter((stage) => {
        if (!pipelineId) return true;
        return stage.pipelineId === pipelineId;
      })
      .sort((a, b) => a.position - b.position);

    return relevantStages.map((stage, index) => {
      return normalizeStage(stage, index);
    });
  }, [activePipeline?.id, pipelineStages]);

  const selectedDeal = useMemo(() => {
    if (!searchParams.dealId) return null;

    return (
      deals.find((deal) => deal.id === searchParams.dealId) ?? null
    );
  }, [deals, searchParams.dealId]);

  useEffect(() => {
    if (!searchParams.addDeal) return;

    setDealPrefill({
      contactName: searchParams.pName ?? "",
      email: searchParams.pEmail ?? "",
      phone: searchParams.pPhone ?? "",
      address: searchParams.pAddress ?? "",
    });

    setAddOpen(true);

    void navigate({
      replace: true,
      search: (current) => ({
        ...current,
        addDeal: undefined,
        pName: undefined,
        pEmail: undefined,
        pPhone: undefined,
        pAddress: undefined,
      }),
    });
  }, [
    navigate,
    searchParams.addDeal,
    searchParams.pAddress,
    searchParams.pEmail,
    searchParams.pName,
    searchParams.pPhone,
  ]);

  const normalizedDeals = useMemo(() => {
    return deals.map((deal) => {
      const optimisticStageId = optimisticStageByDeal[deal.id];
      const optimisticStage = optimisticStageId
        ? boardStages.find((stage) => stage.id === optimisticStageId)
        : undefined;
      const persistedStage = resolveDealStage(deal, boardStages);
      const stage = optimisticStage ?? persistedStage;

      return {
        ...deal,
        resolvedStageId: stage?.id ?? "",
        resolvedStageSlug: stage?.slug ?? deal.stage,
        resolvedStageName:
          stage?.name ?? deal.stageName ?? deal.stage,
        resolvedStageColor:
          stage?.color ?? deal.stageColor ?? "#4F46E5",
      };
    });
  }, [boardStages, deals, optimisticStageByDeal]);

  useEffect(() => {
    setOptimisticStageByDeal((current) => {
      let changed = false;
      const next = { ...current };

      for (const [dealId, stageId] of Object.entries(current)) {
        const deal = deals.find((item) => item.id === dealId);

        if (!deal) {
          delete next[dealId];
          changed = true;
          continue;
        }

        const persisted = resolveDealStage(deal, boardStages);

        if (persisted?.id === stageId) {
          delete next[dealId];
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [boardStages, deals]);

  const filteredDeals = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const now = Date.now();

    return normalizedDeals.filter((deal) => {
      if (ownerFilter !== "all") {
        const matchesId = deal.ownerId === ownerFilter;
        const matchesName = deal.owner === ownerFilter;

        if (!matchesId && !matchesName) return false;
      }

      if (
        stageFilter !== "all" &&
        deal.resolvedStageId !== stageFilter
      ) {
        return false;
      }

      if (valueFilter === "< $25k" && deal.value >= 25_000) {
        return false;
      }

      if (
        valueFilter === "$25k–$75k" &&
        (deal.value < 25_000 || deal.value > 75_000)
      ) {
        return false;
      }

      if (valueFilter === "> $75k" && deal.value <= 75_000) {
        return false;
      }

      if (closeFilter !== "Any date" && deal.expectedClose) {
        const closeDate = new Date(deal.expectedClose).getTime();
        const day = 86_400_000;

        if (closeFilter === "Overdue" && closeDate >= now) {
          return false;
        }

        if (
          closeFilter === "Next 30 days" &&
          (closeDate < now || closeDate > now + 30 * day)
        ) {
          return false;
        }

        if (
          closeFilter === "Next 60 days" &&
          (closeDate < now || closeDate > now + 60 * day)
        ) {
          return false;
        }

        if (
          closeFilter === "Next 90 days" &&
          (closeDate < now || closeDate > now + 90 * day)
        ) {
          return false;
        }
      }

      if (!normalizedQuery) return true;

      return [
        deal.name,
        deal.contactName,
        deal.companyName,
        deal.owner,
        deal.source,
        deal.serviceType,
      ]
        .filter(Boolean)
        .some((value) => {
          return value!.toLowerCase().includes(normalizedQuery);
        });
    });
  }, [
    closeFilter,
    normalizedDeals,
    ownerFilter,
    query,
    stageFilter,
    valueFilter,
  ]);

  const metrics = useMemo(() => {
    const openDeals = filteredDeals.filter((deal) => {
      const slug = deal.resolvedStageSlug.toLowerCase();
      return deal.status === "open" && slug !== "won" && slug !== "lost";
    });

    const wonDeals = filteredDeals.filter((deal) => {
      return (
        deal.status === "won" ||
        deal.resolvedStageSlug.toLowerCase() === "won"
      );
    });

    const lostDeals = filteredDeals.filter((deal) => {
      return (
        deal.status === "lost" ||
        deal.resolvedStageSlug.toLowerCase() === "lost"
      );
    });

    const pipelineValue = openDeals.reduce((total, deal) => {
      return total + deal.value;
    }, 0);

    const weightedValue = openDeals.reduce((total, deal) => {
      return total + deal.value * (deal.probability / 100);
    }, 0);

    const wonValue = wonDeals.reduce((total, deal) => {
      return total + deal.value;
    }, 0);

    const decidedCount = wonDeals.length + lostDeals.length;
    const winRate = decidedCount
      ? Math.round((wonDeals.length / decidedCount) * 100)
      : 0;

    const averageAge = openDeals.length
      ? Math.round(
          openDeals.reduce((total, deal) => {
            return total + deal.ageDays;
          }, 0) / openDeals.length,
        )
      : 0;

    return {
      pipelineValue,
      weightedValue,
      wonValue,
      winRate,
      averageAge,
      openCount: openDeals.length,
      wonCount: wonDeals.length,
      lostCount: lostDeals.length,
    };
  }, [filteredDeals]);

  const lostBreakdown = useMemo(() => {
    const lostDeals = filteredDeals.filter((deal) => {
      return (
        deal.status === "lost" ||
        deal.resolvedStageSlug.toLowerCase() === "lost"
      );
    });

    return LOST_REASONS.map((reason) => {
      const matchingDeals = lostDeals.filter((deal) => {
        return deal.lostReason === reason;
      });

      return {
        reason,
        count: matchingDeals.length,
        value: matchingDeals.reduce((total, deal) => {
          return total + deal.value;
        }, 0),
      };
    });
  }, [filteredDeals]);

  const activeOwnerName = useMemo(() => {
    if (ownerFilter === "all") return null;

    return (
      teamMembers.find((member) => member.id === ownerFilter)?.name ??
      ownerFilter
    );
  }, [ownerFilter, teamMembers]);

  const activeFilterCount = [
    ownerFilter !== "all",
    stageFilter !== "all",
    valueFilter !== "Any value",
    closeFilter !== "Any date",
  ].filter(Boolean).length;

  async function moveDealToStage(
    dealId: string,
    targetStage: BoardStage,
  ) {
    const previousStageId = normalizedDeals.find((deal) => {
      return deal.id === dealId;
    })?.resolvedStageId;

    setOptimisticStageByDeal((current) => ({
      ...current,
      [dealId]: targetStage.id,
    }));

    try {
      // Status is derived from the target stage's own outcome inside
      // updateDeal (pipeline_stages.outcome is the single source of
      // truth) — not computed here from the stage slug.
      await updateDeal(
        dealId,
        {
          stageId: targetStage.id,
          stage: targetStage.slug,
          probability: targetStage.probability,
          lostReason: targetStage.outcome === "lost" ? undefined : null,
        } as Partial<Deal>,
      );
    } catch (error) {
      setOptimisticStageByDeal((current) => {
        const next = { ...current };

        if (previousStageId) {
          next[dealId] = previousStageId;
        } else {
          delete next[dealId];
        }

        return next;
      });

      throw error;
    }
  }

  async function handleStageChange(
    dealId: string,
    requestedStage: string,
  ) {
    // Only called today via the Deal drawer's "Mark Won" button, passing
    // the literal string "won". Most pipelines have no stage actually named
    // "Won" (confirmed live — only one demo pipeline does), so requiring a
    // real board-stage match here would toast-error and silently fail to
    // mark the deal won for every other pipeline. If a real stage matches,
    // move into it (keeps existing behavior for pipelines that do have one);
    // otherwise fall back to a direct status update — the same safe path
    // already used by Leads' and Inbox's equivalent handlers, where
    // pipeline_stages.outcome (via updateDeal) is still the source of truth.
    const target = boardStages.find((stage) => {
      return (
        stage.id === requestedStage ||
        stage.slug === requestedStage
      );
    });

    try {
      if (target) {
        await moveDealToStage(dealId, target);
      } else {
        await updateDeal(dealId, { stage: requestedStage } as Partial<Deal>);
      }
    } catch (error) {
      console.error("[pipeline] stage update failed:", error);
      toast.error("Failed to update the deal stage.");
    }
  }

  async function handleMarkLost(
    dealId: string,
    reason: LostReason,
    notes: string,
  ) {
    const lostStage = boardStages.find((stage) => {
      return stage.slug.toLowerCase() === "lost";
    });

    try {
      await updateDeal(dealId, {
        stageId: lostStage?.id,
        stage: lostStage?.slug ?? "lost",
        status: "lost",
        probability: 0,
        lostReason: reason,
        lostAt: new Date().toISOString(),
        notes: notes || undefined,
      });
    } catch (error) {
      console.error("[pipeline] mark lost failed:", error);
      toast.error("Failed to mark the deal as lost.");
    }
  }

  async function handleDragEnd(result: DropResult) {
    const { destination, draggableId, source } = result;

    if (!destination) return;

    if (
      destination.droppableId === source.droppableId &&
      destination.index === source.index
    ) {
      return;
    }

    const target = boardStages.find((stage) => {
      return stage.id === destination.droppableId;
    });

    if (!target) return;

    try {
      await moveDealToStage(draggableId, target);
    } catch (error) {
      console.error("[pipeline] drag update failed:", error);
      toast.error("Failed to move the deal.");
    }
  }

  async function handleDealUpdate(
    dealId: string,
    patch: Partial<Deal>,
  ) {
    try {
      await updateDeal(dealId, patch);
    } catch (error) {
      console.error("[pipeline] deal update failed:", error);
      toast.error("Failed to save the deal.");
      throw error;
    }
  }

  async function handleDelete(dealId: string) {
    try {
      await deleteDeal(dealId);

      await navigate({
        replace: true,
        search: (current) => ({
          ...current,
          dealId: undefined,
        }),
      });
    } catch (error) {
      console.error("[pipeline] delete failed:", error);
      toast.error("Failed to delete the deal.");
      throw error;
    }
  }

  function clearFilters() {
    setOwnerFilter("all");
    setStageFilter("all");
    setValueFilter("Any value");
    setCloseFilter("Any date");
    setFiltersOpen(false);
  }

  return (
    <div className="-mb-6 flex h-[calc(100vh-88px)] flex-col overflow-hidden">
      <PageHeader
        icon={GitBranch}
        iconBg="bg-violet-soft"
        iconColor="text-violet"
        title="Pipeline"
        subtitle="Track every opportunity from first contact to closed revenue."
        actions={
          <div className="flex h-full items-center gap-2">
            <Button size="sm" className="h-9" onClick={() => setAddOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              New Deal
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 items-center border-border bg-card px-3
                    focus-visible:ring-0 focus-visible:ring-offset-0
                    data-[state=open]:border-[#EADFC8]
                    data-[state=open]:bg-[#FAF3E4]
                    data-[state=open]:ring-0"
                >
                  {activePipeline?.name ?? "Default Pipeline"}
                  <ChevronDown className="ml-1.5 h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent
              align="end"
              className="min-w-56"
            >
              <DropdownMenuLabel>Switch pipeline</DropdownMenuLabel>
              <DropdownMenuSeparator />

              {pipelines.map((pipeline) => (
                <DropdownMenuItem
                  key={pipeline.id}
                  className={
                    pipeline.id === activePipeline?.id
                      ? "bg-[#FAF3E4] font-medium"
                      : ""
                  }
                  onSelect={() => {
                    setActivePipelineId(pipeline.id);
                    window.localStorage.setItem(
                      "renometa.sales.active-pipeline",
                      pipeline.id,
                    );
                    setStageFilter("all");
                  }}
                >
                  {pipeline.name}
                  {pipeline.id === activePipeline?.id && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      Active
                    </span>
                  )}
                </DropdownMenuItem>
              ))}

              <DropdownMenuSeparator />

              <DropdownMenuItem asChild>
                <Link to="/settings/pipelines">
                  Manage pipelines
                </Link>
              </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      <div className="mb-3 grid shrink-0 grid-cols-2 gap-3 xl:grid-cols-5">
        <MetricCard
          label="Pipeline value"
          value={formatMoney(metrics.pipelineValue)}
          sub={`${metrics.openCount} open deals`}
          icon={CircleDollarSign}
          tone="primary"
        />

        <MetricCard
          label="Weighted value"
          value={formatMoney(metrics.weightedValue)}
          sub="Based on probability"
          icon={Target}
          tone="warning"
        />

        <MetricCard
          label="Win rate"
          value={`${metrics.winRate}%`}
          sub={`${metrics.wonCount} won · ${metrics.lostCount} lost`}
          icon={TrendingUp}
          tone="success"
        />

        <MetricCard
          label="Won revenue"
          value={formatMoney(metrics.wonValue)}
          sub={`${metrics.wonCount} closed deals`}
          icon={Trophy}
          tone="success"
        />

        <MetricCard
          label="Average age"
          value={`${metrics.averageAge}d`}
          sub="Open opportunities"
          icon={Clock3}
          tone="muted"
        />
      </div>

      <Card className="mb-3 shrink-0 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 pl-8 text-sm"
              placeholder="Search deals, contacts, accounts, services..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <Select
            value={ownerFilter}
            onValueChange={setOwnerFilter}
          >
            <SelectTrigger className="h-8 min-w-36 text-xs">
              <SelectValue>
                {ownerFilter === "all"
                  ? "All owners"
                  : activeOwnerName}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="[&_[data-highlighted]]:bg-[#FAF3E4]">
              <SelectItem value="all">All owners</SelectItem>
              {teamMembers
                .filter((member) => member.status === "active")
                .map((member) => (
                  <SelectItem key={member.id} value={member.id}>
                    {member.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>

          <div className="hidden h-5 w-px bg-border lg:block" />

          <div className="flex flex-wrap gap-1">
            {VALUE_FILTERS.map((filter) => (
              <FilterChip
                key={filter}
                active={valueFilter === filter}
                onClick={() => setValueFilter(filter)}
              >
                {filter}
              </FilterChip>
            ))}
          </div>

          <Popover
            open={filtersOpen}
            onOpenChange={setFiltersOpen}
          >
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
              >
                <SlidersHorizontal className="h-4 w-4" />
                More
                {activeFilterCount > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#FAF3E4] px-1 text-[10px] font-semibold">
                    {activeFilterCount}
                  </span>
                )}
              </Button>
            </PopoverTrigger>

            <PopoverContent
              align="end"
              className="w-72 space-y-4 p-4"
            >
              <FilterField label="Stage">
                <Select
                  value={stageFilter}
                  onValueChange={setStageFilter}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="[&_[data-highlighted]]:bg-[#FAF3E4]">
                    <SelectItem value="all">All stages</SelectItem>
                    {boardStages.map((stage) => (
                      <SelectItem key={stage.id} value={stage.id}>
                        {stage.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>

              <FilterField label="Expected close">
                <Select
                  value={closeFilter}
                  onValueChange={(value) => {
                    setCloseFilter(value as CloseFilter);
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="[&_[data-highlighted]]:bg-[#FAF3E4]">
                    {CLOSE_FILTERS.map((filter) => (
                      <SelectItem key={filter} value={filter}>
                        {filter}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>

              {activeFilterCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-full"
                  onClick={clearFilters}
                >
                  Clear all filters
                </Button>
              )}
            </PopoverContent>
          </Popover>

          <div className="ml-auto flex h-8 items-center rounded-md border bg-card p-0.5">
            <Button
              size="sm"
              variant="ghost"
              className={
                view === "board"
                  ? "h-7 bg-[#FAF3E4] px-2 hover:bg-[#FAF3E4]"
                  : "h-7 px-2"
              }
              onClick={() => setView("board")}
              aria-label="Board view"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className={
                view === "list"
                  ? "h-7 bg-[#FAF3E4] px-2 hover:bg-[#FAF3E4]"
                  : "h-7 px-2"
              }
              onClick={() => setView("list")}
              aria-label="List view"
            >
              <ListIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>

      {view === "board" ? (
        <PipelineBoard
          stages={boardStages}
          deals={filteredDeals}
          onDragEnd={handleDragEnd}
          onDealOpen={(dealId) => {
            void navigate({
              replace: true,
              search: (current) => ({
                ...current,
                dealId,
              }),
            });
          }}
        />
      ) : (
        <PipelineList
          deals={filteredDeals}
          onDealOpen={(dealId) => {
            void navigate({
              replace: true,
              search: (current) => ({
                ...current,
                dealId,
              }),
            });
          }}
        />
      )}

      <DealDetailDrawer
        deal={selectedDeal}
        onOpenChange={(open) => {
          if (open) return;

          void navigate({
            replace: true,
            search: (current) => ({
              ...current,
              dealId: undefined,
            }),
          });
        }}
        onStageChange={handleStageChange}
        onMarkLost={handleMarkLost}
        onDealUpdate={handleDealUpdate}
        onDelete={handleDelete}
        stages={boardStages}
        teamMembers={teamMembers.map((member) => ({
          id: member.id,
          name: member.name,
        }))}
      />

      <NewDealDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        initialValues={dealPrefill}
      />
    </div>
  );
}

function PipelineBoard({
  stages,
  deals,
  onDragEnd,
  onDealOpen,
}: {
  stages: BoardStage[];
  deals: Array<
    Deal & {
      resolvedStageId: string;
      resolvedStageSlug: string;
      resolvedStageName: string;
      resolvedStageColor: string;
    }
  >;
  onDragEnd: (result: DropResult) => void;
  onDealOpen: (dealId: string) => void;
}) {
  return (
    <DragDropContext onDragEnd={onDragEnd}>
      {/* Board viewport — owns horizontal scroll only below the wide-desktop
          breakpoint (2xl); at 2xl+ the six stages share the available width
          via minmax(0,1fr) columns and this container never scrolls
          horizontally. Vertical scrolling belongs to each stage's own card
          list below, never to this viewport. */}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          className="grid h-full min-h-0 min-w-0 w-full max-w-full auto-cols-[minmax(260px,1fr)]
            grid-flow-col gap-2 overflow-x-auto pb-1
            2xl:grid-flow-row 2xl:auto-cols-auto 2xl:grid-cols-[repeat(6,minmax(0,1fr))] 2xl:overflow-x-hidden"
        >
          {stages.map((stage) => {
            const stageDeals = deals.filter((deal) => {
              return deal.resolvedStageId === stage.id;
            });

            const totalValue = stageDeals.reduce((total, deal) => {
              return total + deal.value;
            }, 0);

            return (
              <section
                key={stage.id}
                className="flex min-h-0 min-w-0 w-full max-w-full flex-col overflow-hidden"
              >
                <div className="shrink-0">
                  <StageColumnHeader
                    stage={stage}
                    count={stageDeals.length}
                    value={totalValue}
                  />
                </div>

                <Droppable droppableId={stage.id}>
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={
                        snapshot.isDraggingOver
                          ? "flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden rounded-xl border border-[#EADFC8] bg-[#FAF3E4]/60 p-2"
                          : "flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden rounded-xl border border-dashed bg-secondary/25 p-2"
                      }
                    >
                      {stageDeals.map((deal, index) => (
                        <Draggable
                          key={deal.id}
                          draggableId={deal.id}
                          index={index}
                        >
                          {(dragProvided, dragSnapshot) => {
                            const card = (
                              <DealCard
                                deal={deal}
                                stage={stage}
                                dragging={dragSnapshot.isDragging}
                                onOpen={() => onDealOpen(deal.id)}
                                dragProvided={dragProvided}
                              />
                            );
                            // Ancestors of this list now clip via overflow
                            // (overflow-y-auto/overflow-x-hidden) so each
                            // stage can scroll independently — without a
                            // portal, dragging a card across a column
                            // boundary would get visually clipped by its
                            // source column's own overflow. Portaling only
                            // the actively-dragged clone to document.body
                            // keeps it unclipped; the library still tracks
                            // drop targets via geometry, not DOM position.
                            return dragSnapshot.isDragging
                              ? createPortal(card, document.body)
                              : card;
                          }}
                        </Draggable>
                      ))}

                      {provided.placeholder}

                      {stageDeals.length === 0 && (
                        <div className="flex min-h-28 flex-1 items-center justify-center rounded-lg">
                          <p className="text-xs text-muted-foreground">
                            Drag deals here
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </Droppable>
              </section>
            );
          })}
        </div>
      </div>
    </DragDropContext>
  );
}

function StageColumnHeader({
  stage,
  count,
  value,
}: {
  stage: BoardStage;
  count: number;
  value: number;
}) {
  return (
    <div className="mb-2 rounded-lg border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: stage.color }}
            />
            <h2 className="truncate text-sm font-semibold">
              {stage.name}
            </h2>
            <Badge
              variant="secondary"
              className="h-5 rounded px-1.5 text-[10px]"
            >
              {count}
            </Badge>
          </div>

          <p className="mt-1 text-[11px] text-muted-foreground">
            {stage.probability}% probability
          </p>
        </div>

        <p className="shrink-0 text-xs font-semibold tabular-nums">
          {formatCompactMoney(value)}
        </p>
      </div>

      <div
        className="mt-3 h-1 rounded-full"
        style={{ backgroundColor: `${stage.color}26` }}
      >
        <div
          className="h-full rounded-full"
          style={{
            backgroundColor: stage.color,
            width: `${Math.max(stage.probability, 6)}%`,
          }}
        />
      </div>
    </div>
  );
}

function DealCard({
  deal,
  stage,
  dragging,
  onOpen,
  dragProvided,
}: {
  deal: Deal;
  stage: BoardStage;
  dragging: boolean;
  onOpen: () => void;
  dragProvided: DraggableProvided;
}) {
  const overdue = isOverdue(deal.expectedClose);
  const nextActivityOverdue = isOverdue(deal.nextActivityAt);

  return (
    <Card
      ref={dragProvided.innerRef}
      {...dragProvided.draggableProps}
      {...dragProvided.dragHandleProps}
      className={
        dragging
          ? "w-full min-w-0 max-w-full rotate-1 cursor-grabbing border-[#EADFC8] p-3 shadow-lg"
          : "w-full min-w-0 max-w-full cursor-pointer p-3 transition-all hover:-translate-y-0.5 hover:border-[#EADFC8] hover:shadow-sm"
      }
      onClick={onOpen}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">
            {deal.name}
          </h3>
          {deal.companyName && (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {deal.companyName}
            </p>
          )}
        </div>

        <p className="shrink-0 text-sm font-semibold tabular-nums">
          {formatCompactMoney(deal.value)}
        </p>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <ContactAvatar
          id={deal.contactId}
          name={deal.contactName || "No contact"}
          avatarKey={deal.contactAvatarKey}
          size="sm"
          className="h-7 w-7"
        />

        <div className="min-w-0">
          <p className="truncate text-xs font-medium">
            {deal.contactName || "No contact"}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {deal.source || deal.serviceType || "No source"}
          </p>
        </div>
      </div>

      {deal.nextActivityTitle && (
        <div
          className={
            nextActivityOverdue
              ? "mb-3 flex items-center gap-2 rounded-md bg-red-50 px-2 py-1.5 text-[11px] text-red-700"
              : "mb-3 flex items-center gap-2 rounded-md bg-[#FAF3E4] px-2 py-1.5 text-[11px]"
          }
        >
          <CalendarClock className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{deal.nextActivityTitle}</span>
        </div>
      )}

      {deal.tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {deal.tags.slice(0, 2).map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className="h-5 rounded px-1.5 text-[9px]"
            >
              {tag}
            </Badge>
          ))}

          {deal.tags.length > 2 && (
            <Badge
              variant="secondary"
              className="h-5 rounded px-1.5 text-[9px]"
            >
              +{deal.tags.length - 2}
            </Badge>
          )}
        </div>
      )}

      <div className="flex items-center justify-between border-t pt-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <ContactAvatar
            id={deal.ownerId}
            name={deal.owner || "Unassigned"}
            size="xs"
          />

          <span className="truncate text-[11px] text-muted-foreground">
            {deal.owner || "Unassigned"}
          </span>
        </div>

        <span
          className={
            overdue
              ? "flex shrink-0 items-center gap-1 text-[10px] font-medium text-red-600"
              : "shrink-0 text-[10px] text-muted-foreground"
          }
        >
          {overdue && <AlertTriangle className="h-3 w-3" />}
          {formatDateShort(deal.expectedClose, "No expected date")}
        </span>
      </div>

      {deal.lostReason && (
        <div className="mt-2">
          <Badge
            variant="outline"
            className="border-red-200 bg-red-50 text-red-700"
          >
            Lost · {deal.lostReason}
          </Badge>
        </div>
      )}

      <div
        className="mt-2 h-1 rounded-full"
        style={{ backgroundColor: `${stage.color}1F` }}
      >
        <div
          className="h-full rounded-full"
          style={{
            backgroundColor: stage.color,
            width: `${Math.max(deal.probability, 5)}%`,
          }}
        />
      </div>
    </Card>
  );
}

function PipelineList({
  deals,
  onDealOpen,
}: {
  deals: Array<
    Deal & {
      resolvedStageId: string;
      resolvedStageSlug: string;
      resolvedStageName: string;
      resolvedStageColor: string;
    }
  >;
  onDealOpen: (dealId: string) => void;
}) {
  return (
    <Card className="min-h-0 flex-1 overflow-hidden p-0">
      <div className="h-full overflow-auto">
        <table className="w-full min-w-[980px] text-sm">
          <thead className="sticky top-0 z-10 bg-[#FAF3E4]">
            <tr className="border-b">
              <TableHeading>Deal</TableHeading>
              <TableHeading>Contact</TableHeading>
              <TableHeading>Account</TableHeading>
              <TableHeading>Stage</TableHeading>
              <TableHeading align="right">Value</TableHeading>
              <TableHeading>Owner</TableHeading>
              <TableHeading>Expected close</TableHeading>
              <TableHeading>Next activity</TableHeading>
            </tr>
          </thead>

          <tbody>
            {deals.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="py-16 text-center text-sm text-muted-foreground"
                >
                  No deals match the current filters.
                </td>
              </tr>
            )}

            {deals.map((deal) => (
              <tr
                key={deal.id}
                className="cursor-pointer border-b transition-colors hover:bg-[#FAF3E4]/50"
                onClick={() => onDealOpen(deal.id)}
              >
                <TableCell className="font-medium">
                  {deal.name}
                </TableCell>

                <TableCell>
                  <div className="flex items-center gap-2">
                    <ContactAvatar
                      id={deal.contactId}
                      name={deal.contactName || "No contact"}
                      avatarKey={deal.contactAvatarKey}
                      size="sm"
                    />
                    <span>{deal.contactName || "No contact"}</span>
                  </div>
                </TableCell>

                <TableCell muted>
                  {deal.companyName || "—"}
                </TableCell>

                <TableCell>
                  <Badge
                    variant="outline"
                    className="font-medium"
                    style={{
                      borderColor: deal.resolvedStageColor,
                      backgroundColor: colorWithAlpha(
                        deal.resolvedStageColor,
                        0.1,
                      ),
                      color: deal.resolvedStageColor,
                    }}
                  >
                    {deal.resolvedStageName}
                  </Badge>
                </TableCell>

                <TableCell align="right" className="font-semibold">
                  {formatMoney(deal.value)}
                </TableCell>

                <TableCell>
                  <div className="flex items-center gap-2">
                    <ContactAvatar
                      id={deal.ownerId}
                      name={deal.owner || "Unassigned"}
                      size="xs"
                    />
                    <span>{deal.owner || "Unassigned"}</span>
                  </div>
                </TableCell>

                <TableCell muted>
                  <span
                    className={
                      isOverdue(deal.expectedClose)
                        ? "font-medium text-red-600"
                        : ""
                    }
                  >
                    {formatDateShort(deal.expectedClose, "No expected date")}
                  </span>
                </TableCell>

                <TableCell muted>
                  {deal.nextActivityTitle || "—"}
                </TableCell>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
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
      type="button"
      className={
        active
          ? "h-8 rounded-md border border-[#EADFC8] bg-[#FAF3E4] px-2.5 text-xs font-medium"
          : "h-8 rounded-md border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[#FAF3E4]/60"
      }
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function TableHeading({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={
        align === "right"
          ? "px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          : "px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
      }
    >
      {children}
    </th>
  );
}

function TableCell({
  children,
  muted = false,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  muted?: boolean;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={[
        "px-4 py-3",
        muted ? "text-muted-foreground" : "",
        align === "right" ? "text-right tabular-nums" : "",
        className,
      ].join(" ")}
    >
      {children}
    </td>
  );
}

function normalizeStage(
  stage: SalesPipelineStage,
  index: number,
): BoardStage {
  const slug =
    stage.slug ||
    slugify(stage.name) ||
    stage.id;

  return {
    id: stage.id,
    pipelineId: stage.pipelineId,
    name: stage.name,
    slug,
    color:
      STAGE_COLOR_BY_SLUG[slug] ??
      normalizeStageColor(stage.color) ??
      DEFAULT_STAGE_COLORS[index % DEFAULT_STAGE_COLORS.length],
    probability:
      stage.probability ?? defaultProbability(slug, index),
    position: stage.position ?? index,
    outcome: stage.outcome ?? "open",
  };
}

function resolveDealStage(
  deal: Deal,
  stages: BoardStage[],
): BoardStage | undefined {
  return stages.find((stage) => {
    return (
      stage.id === deal.stageId ||
      stage.slug === deal.stage ||
      stage.id === deal.stage ||
      stage.name === deal.stageName ||
      stage.name === deal.stage
    );
  });
}

function normalizeStageColor(
  value?: string | null,
): string | null {
  if (!value) return null;

  const normalized = value.trim();

  if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return normalized;
  }

  const namedColors: Record<string, string> = {
    blue: "#2563EB",
    violet: "#7C3AED",
    purple: "#7C3AED",
    cyan: "#0891B2",
    teal: "#0F766E",
    green: "#15803D",
    amber: "#D97706",
    orange: "#EA580C",
    red: "#B91C1C",
    rose: "#BE123C",
  };

  return namedColors[normalized.toLowerCase()] ?? null;
}

function defaultProbability(
  slug: string,
  index: number,
): number {
  const normalized = slug.toLowerCase();

  if (normalized === "won") return 100;
  if (normalized === "lost") return 0;

  const known: Record<string, number> = {
    "new-opportunity": 10,
    "new-inquiry": 10,
    new: 10,
    qualified: 25,
    "consultation-scheduled": 40,
    "estimate-requested": 50,
    "estimate-sent": 65,
    negotiation: 80,
  };

  return known[normalized] ?? Math.min(90, 10 + index * 12);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatCompactMoney(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}m`;
  }

  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(
      value >= 100_000 ? 0 : 1,
    )}k`;
  }

  return formatMoney(value);
}

function isOverdue(value?: string | null): boolean {
  if (!value) return false;

  const timestamp = new Date(value).getTime();

  return Number.isFinite(timestamp) && timestamp < Date.now();
}

function colorWithAlpha(
  color: string,
  alpha: number,
): string {
  const normalized = color.replace("#", "");

  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return "#FAF3E4";
  }

  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}