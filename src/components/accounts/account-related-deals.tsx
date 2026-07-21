// src/components/accounts/account-related-deals.tsx
import { useMemo, useState } from "react";
import {
  Briefcase,
  CalendarClock,
  ChevronRight,
  Plus,
  UserRound,
} from "lucide-react";

import { DealDetailDrawer } from "@/components/sales/deal-detail-drawer";
import { NewDealDialog } from "@/components/sales/new-deal-dialog";
import { Button } from "@/components/ui/button";
import {
  deleteDeal,
  refreshDeals,
  updateDeal,
  useDeals,
  usePipelineStages,
} from "@/lib/deals-store";
import { formatDateShort, formatMoney } from "@/lib/format";
import { useTeam } from "@/lib/organization";
import type {
  Deal,
  LostReason,
  SalesPipelineStage,
} from "@/lib/sales/types";

type AccountRelatedDealsProps = {
  companyId: string;
};

const STAGE_COLORS: Record<string, string> = {
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

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveStage(
  deal: Deal,
  stages: SalesPipelineStage[],
): SalesPipelineStage | undefined {
  return stages.find((stage) => {
    return (
      stage.id === deal.stageId ||
      stage.slug === deal.stage ||
      stage.name === deal.stageName ||
      slugify(stage.name) === deal.stage
    );
  });
}

function resolveStageColor(
  stage: SalesPipelineStage | undefined,
): string {
  if (!stage) return "#64748B";

  const slug = stage.slug || slugify(stage.name);
  return STAGE_COLORS[slug] ?? stage.color ?? "#64748B";
}

export function AccountRelatedDeals({
  companyId,
}: AccountRelatedDealsProps) {
  const deals = useDeals();
  const stages = usePipelineStages();
  const teamMembers = useTeam();

  const [newDealOpen, setNewDealOpen] = useState(false);
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);

  const linkedDeals = useMemo(() => {
    return deals
      .filter((deal) => deal.companyId === companyId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [companyId, deals]);

  async function handleDealUpdate(
    dealId: string,
    patch: Partial<Deal>,
  ): Promise<void> {
    await updateDeal(dealId, patch);
  }

  async function handleStageChange(
    dealId: string,
    stageSlug: string,
  ): Promise<void> {
    const stage = stages.find((item) => {
      return item.slug === stageSlug || item.id === stageSlug;
    });

    await updateDeal(dealId, {
      stageId: stage?.id,
      stage: stage?.slug ?? stageSlug,
      stageName: stage?.name,
      stageColor: stage ? resolveStageColor(stage) : undefined,
      probability: stage?.probability,
      status:
        stage?.slug === "won"
          ? "won"
          : stage?.slug === "lost"
            ? "lost"
            : "open",
    });
  }

  async function handleMarkLost(
    dealId: string,
    reason: LostReason,
    notes: string,
  ): Promise<void> {
    const lostStage = stages.find((stage) => {
      return stage.slug === "lost" || slugify(stage.name) === "lost";
    });

    await updateDeal(dealId, {
      stageId: lostStage?.id,
      stage: "lost",
      stageName: lostStage?.name ?? "Lost",
      stageColor: lostStage
        ? resolveStageColor(lostStage)
        : "#EF4444",
      probability: 0,
      status: "lost",
      lostReason: reason,
      notes,
    });
  }

  async function handleDelete(dealId: string): Promise<void> {
    await deleteDeal(dealId);
    setSelectedDeal(null);
  }

  return (
    <>
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Deals
            </h3>
            <p className="text-xs text-muted-foreground">
              Opportunities linked to this Account.
            </p>
          </div>

          <Button
            type="button"
            size="sm"
            className="bg-blue-600 text-white hover:bg-blue-700"
            onClick={() => setNewDealOpen(true)}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            New Deal
          </Button>
        </div>

        {linkedDeals.length > 0 ? (
          <div className="space-y-2.5">
            {linkedDeals.map((deal) => {
              const stage = resolveStage(deal, stages);
              const color = resolveStageColor(stage);
              const owner =
                teamMembers.find(
                  (member) => member.id === deal.ownerId,
                )?.name ??
                deal.owner ??
                "Unassigned";

              return (
                <button
                  key={deal.id}
                  type="button"
                  className="w-full rounded-xl border bg-white p-3
                    text-left transition-colors hover:border-[#E3CA9A]
                    hover:bg-[#FAF3E4]/35"
                  onClick={() => setSelectedDeal(deal)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold">
                          {deal.name}
                        </p>

                        <span
                          className="inline-flex rounded-full border px-2
                            py-0.5 text-[11px] font-medium"
                          style={{
                            borderColor: color,
                            color,
                            backgroundColor: `${color}14`,
                          }}
                        >
                          {stage?.name ??
                            deal.stageName ??
                            deal.stage}
                        </span>
                      </div>

                      <div className="mt-2 grid gap-x-4 gap-y-1
                        text-xs text-muted-foreground sm:grid-cols-2">
                        <span className="flex items-center gap-1">
                          <UserRound className="h-3 w-3" />
                          Contact: {deal.contactName || "No contact"}
                        </span>

                        <span>Owner: {owner}</span>

                        <span>
                          Expected close:{" "}
                          {deal.expectedClose
                            ? formatDateShort(deal.expectedClose)
                            : "Not set"}
                        </span>

                        <span className="flex items-center gap-1">
                          <CalendarClock className="h-3 w-3" />
                          {deal.nextActivityTitle ||
                            "No next activity"}
                        </span>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-sm font-semibold">
                        {formatMoney(deal.value)}
                      </span>
                      <ChevronRight className="h-4 w-4
                        text-muted-foreground" />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed bg-muted/20
            px-4 py-8 text-center">
            <Briefcase className="mx-auto h-8 w-8
              text-muted-foreground/35" />
            <p className="mt-2 text-sm font-medium">
              No linked Deals
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create a Deal and this Account will be selected
              automatically.
            </p>
          </div>
        )}
      </section>

      <NewDealDialog
        open={newDealOpen}
        onOpenChange={setNewDealOpen}
        initialValues={{
          companyId,
        }}
        onCreated={() => {
          void refreshDeals();
        }}
      />

      <DealDetailDrawer
        deal={selectedDeal}
        onOpenChange={(open) => {
          if (!open) setSelectedDeal(null);
        }}
        onStageChange={handleStageChange}
        onMarkLost={handleMarkLost}
        onDealUpdate={handleDealUpdate}
        onDelete={handleDelete}
        stages={stages}
        teamMembers={teamMembers
          .filter((member) => member.status === "active")
          .map((member) => ({
            id: member.id,
            name: member.name,
          }))}
      />
    </>
  );
}