// src/components/contacts/contact-related-tab.tsx
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Briefcase,
  CalendarClock,
  ChevronRight,
  FileText,
  FolderKanban,
  Loader2,
  Receipt,
  ArrowRight,
} from "lucide-react";

import { DealDetailDrawer } from "@/components/sales/deal-detail-drawer";
import { Skeleton } from "@/components/ui/skeleton";
import {
  deleteDeal,
  updateDeal,
  useDeals,
  usePipelineStages,
} from "@/lib/deals-store";
import { getOrgId } from "@/lib/contacts-store";
import { formatDateShort, formatMoney } from "@/lib/format";
import { useTeam } from "@/lib/organization";
import type {
  Deal,
  LostReason,
  SalesPipelineStage,
} from "@/lib/sales/types";
import { supabase } from "@/lib/supabase";

type ContactRelatedTabProps = {
  contactId: string;
};

type RelatedProject = {
  id: string;
  name: string;
  status: string;
  completion_percentage: number | null;
};

type RelatedEstimate = {
  id: string;
  title: string | null;
  number: string | null;
  status: string | null;
  total: number | null;
  created_at: string;
};

// Real columns confirmed via a live schema check — appointments has no
// assigned-team-member or location column (only a free-text `address`),
// so "assigned team member if available" / "location if available"
// degrade gracefully to not being shown rather than being fabricated.
type RelatedAppointment = {
  id: string;
  service: string | null;
  scheduled_at: string;
  status: string | null;
  address: string | null;
  duration_min: number | null;
};

// Real columns confirmed via a live schema check — invoices has no
// paid_at column, only amount_paid (a real paid amount, not a date).
type RelatedInvoice = {
  id: string;
  invoice_number: string | null;
  status: string | null;
  total_amount: number | null;
  amount_paid: number | null;
  due_date: string | null;
  issue_date: string | null;
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

function stageColor(stage: SalesPipelineStage | undefined): string {
  if (!stage) return "#64748B";

  const slug = stage.slug || slugify(stage.name);
  return STAGE_COLORS[slug] ?? stage.color ?? "#64748B";
}

function getStage(
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

export function ContactRelatedTab({
  contactId,
}: ContactRelatedTabProps) {
  const deals = useDeals();
  const stages = usePipelineStages();
  const teamMembers = useTeam();

  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [projects, setProjects] = useState<RelatedProject[]>([]);
  const [estimates, setEstimates] = useState<RelatedEstimate[]>([]);
  const [appointments, setAppointments] = useState<RelatedAppointment[]>([]);
  const [invoices, setInvoices] = useState<RelatedInvoice[]>([]);
  const [loadingRelated, setLoadingRelated] = useState(true);

  const contactDeals = useMemo(() => {
    return deals
      .filter((deal) => deal.contactId === contactId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [contactId, deals]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoadingRelated(true);

      const orgId = await getOrgId();

      if (!orgId || cancelled) {
        setLoadingRelated(false);
        return;
      }

      const [{ data: projectRows }, { data: estimateRows }, { data: appointmentRows }, { data: invoiceRows }] =
        await Promise.all([
          supabase
            .from("projects")
            .select("id, name, status, completion_percentage")
            .eq("client_id", contactId)
            .eq("org_id", orgId)
            .order("created_at", { ascending: false }),
          supabase
            .from("estimates")
            .select("id, title, number, status, total, created_at")
            .eq("client_id", contactId)
            .eq("org_id", orgId)
            .order("created_at", { ascending: false }),
          // Newest/soonest-relevant first isn't a single ORDER BY here since
          // upcoming vs. past need different priority — sorted client-side
          // below (upcomingFirst) instead of trying to express that in SQL.
          supabase
            .from("appointments")
            .select("id, service, scheduled_at, status, address, duration_min")
            .eq("contact_id", contactId)
            .eq("org_id", orgId)
            .order("scheduled_at", { ascending: false })
            .limit(50),
          supabase
            .from("invoices")
            .select("id, invoice_number, status, total_amount, amount_paid, due_date, issue_date")
            .eq("client_id", contactId)
            .eq("org_id", orgId)
            .order("issue_date", { ascending: false })
            .limit(50),
        ]);

      if (cancelled) return;

      setProjects((projectRows as RelatedProject[] | null) ?? []);
      setEstimates((estimateRows as RelatedEstimate[] | null) ?? []);
      setAppointments((appointmentRows as RelatedAppointment[] | null) ?? []);
      setInvoices((invoiceRows as RelatedInvoice[] | null) ?? []);
      setLoadingRelated(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [contactId]);

  async function handleDealUpdate(
    dealId: string,
    patch: Partial<Deal>,
  ) {
    await updateDeal(dealId, patch);
  }

  async function handleStageChange(
    dealId: string,
    stageSlug: string,
  ) {
    const stage = stages.find((item) => {
      return item.slug === stageSlug || item.id === stageSlug;
    });

    await updateDeal(dealId, {
      stageId: stage?.id,
      stage: stage?.slug ?? stageSlug,
      stageName: stage?.name,
      stageColor: stage ? stageColor(stage) : undefined,
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
  ) {
    const lostStage = stages.find((stage) => {
      return stage.slug === "lost" || slugify(stage.name) === "lost";
    });

    await updateDeal(dealId, {
      stageId: lostStage?.id,
      stage: "lost",
      stageName: lostStage?.name ?? "Lost",
      stageColor: lostStage ? stageColor(lostStage) : "#EF4444",
      probability: 0,
      status: "lost",
      lostReason: reason,
      notes,
    });
  }

  async function handleDelete(dealId: string) {
    await deleteDeal(dealId);
    setSelectedDeal(null);
  }

  // Upcoming appointments soonest-first, then past appointments most-recent-
  // first — a single ORDER BY can't express "upcoming ascending, past
  // descending" in one pass, so it's done client-side over the (already
  // small, capped) loaded set.
  const sortedAppointments = useMemo(() => {
    const now = Date.now();
    const upcoming = appointments
      .filter((a) => new Date(a.scheduled_at).getTime() >= now)
      .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
    const past = appointments
      .filter((a) => new Date(a.scheduled_at).getTime() < now)
      .sort((a, b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime());
    return [...upcoming, ...past];
  }, [appointments]);

  const hasAny =
    contactDeals.length > 0 ||
    projects.length > 0 ||
    estimates.length > 0 ||
    appointments.length > 0 ||
    invoices.length > 0;

  return (
    <>
      <div className="space-y-5">
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Deals
            </h3>
            <p className="text-xs text-muted-foreground">
              Opportunities linked to this Contact.
            </p>
          </div>

          {contactDeals.length > 0 ? (
            <div className="space-y-2.5">
              {contactDeals.map((deal) => {
                const stage = getStage(deal, stages);
                const color = stageColor(stage);
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
                      <div className="min-w-0">
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
                          <span>Owner: {owner}</span>
                          <span>
                            Expected close:{" "}
                            {deal.expectedClose
                              ? formatDateShort(deal.expectedClose)
                              : "Not set"}
                          </span>
                          <span>
                            Next activity:{" "}
                            {deal.nextActivityTitle || "None"}
                          </span>
                          <span>
                            {deal.nextActivityAt
                              ? formatDateShort(deal.nextActivityAt)
                              : "No activity due date"}
                          </span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-sm font-semibold">
                          {formatMoney(deal.value)}
                        </span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
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
                Create a Deal and this Contact will be selected
                automatically.
              </p>
            </div>
          )}
        </section>

        {loadingRelated ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <>
            {projects.length > 0 && (
              <section className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold">Projects</h3>
                  <p className="text-xs text-muted-foreground">
                    Active and historical work for this Contact.
                  </p>
                </div>

                <div className="space-y-2">
                  {projects.map((project) => (
                    <div
                      key={project.id}
                      className="rounded-xl border bg-white p-3"
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex h-9 w-9 items-center
                          justify-center rounded-full bg-blue-50
                          text-blue-600">
                          <FolderKanban className="h-4 w-4" />
                        </div>

                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">
                            {project.name}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {project.status}
                            {project.completion_percentage !== null
                              ? ` · ${project.completion_percentage}% complete`
                              : ""}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {estimates.length > 0 && (
              <section className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold">Estimates</h3>
                  <p className="text-xs text-muted-foreground">
                    Estimates created for this Contact.
                  </p>
                </div>

                <div className="space-y-2">
                  {estimates.map((estimate) => (
                    <div
                      key={estimate.id}
                      className="rounded-xl border bg-white p-3"
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex h-9 w-9 items-center
                          justify-center rounded-full bg-amber-50
                          text-amber-700">
                          <FileText className="h-4 w-4" />
                        </div>

                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">
                            {estimate.title ||
                              estimate.number ||
                              "Untitled Estimate"}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {estimate.status || "Draft"} ·{" "}
                            {formatDateShort(estimate.created_at)}
                          </p>
                        </div>

                        <span className="shrink-0 text-sm font-semibold">
                          {formatMoney(estimate.total ?? 0)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {sortedAppointments.length > 0 && (
              <section className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold">Appointments</h3>
                  <p className="text-xs text-muted-foreground">
                    Upcoming first, then past appointments for this Contact.
                  </p>
                </div>

                <div className="space-y-2">
                  {sortedAppointments.map((appt) => {
                    const isPast = new Date(appt.scheduled_at).getTime() < Date.now();
                    return (
                      <div key={appt.id} className="rounded-xl border bg-white p-3">
                        <div className="flex items-start gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-success/10 text-success">
                            <CalendarClock className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-semibold">{appt.service || "Consultation"}</p>
                              <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${isPast ? "border-border text-muted-foreground" : "border-success/40 text-success"}`}>
                                {isPast ? "Past" : "Upcoming"}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {new Date(appt.scheduled_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                              {appt.duration_min ? ` · ${appt.duration_min} min` : ""}
                              {" · "}{appt.status || "scheduled"}
                              {appt.address ? ` · ${appt.address}` : ""}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <Link
                    to="/calendar"
                    className="flex items-center justify-center gap-1.5 rounded-md border border-border py-2 text-xs font-medium text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                  >
                    Open in Calendar <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              </section>
            )}

            {invoices.length > 0 && (
              <section className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold">Invoices</h3>
                  <p className="text-xs text-muted-foreground">
                    Invoices billed to this Contact.
                  </p>
                </div>

                <div className="space-y-2">
                  {invoices.map((inv) => (
                    <div key={inv.id} className="rounded-xl border bg-white p-3">
                      <div className="flex items-start gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-500/10 text-violet-600">
                          <Receipt className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">{inv.invoice_number || "Invoice"}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {inv.status || "draft"}
                            {inv.due_date ? ` · Due ${formatDateShort(inv.due_date)}` : ""}
                            {/* amount_paid is a real, separate column — shown
                                as its own data point rather than computing
                                an unsupported remaining-balance figure. */}
                            {inv.amount_paid ? ` · ${formatMoney(inv.amount_paid)} paid` : ""}
                          </p>
                        </div>
                        <span className="shrink-0 text-sm font-semibold">
                          {formatMoney(inv.total_amount ?? 0)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {!hasAny && (
              <div className="flex flex-col items-center rounded-xl
                border border-dashed py-10 text-center">
                <Briefcase className="h-8 w-8
                  text-muted-foreground/35" />
                <p className="mt-2 text-sm font-medium">
                  No related records yet
                </p>
                <p className="mt-1 max-w-xs text-xs
                  text-muted-foreground">
                  Deals, Projects, Estimates, Appointments, and Invoices
                  linked to this Contact will appear here.
                </p>
              </div>
            )}
          </>
        )}
      </div>

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