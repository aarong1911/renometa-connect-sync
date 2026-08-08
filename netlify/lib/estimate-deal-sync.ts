/// <reference types="node" />
// netlify/lib/estimate-deal-sync.ts
//
// Phase 10.4 continuation — the ONE canonical server-side Estimate<->Deal
// synchronization service. Called from every place an estimate's status
// changes on a customer-facing path (estimate-send.ts, proposal-data.ts's
// view tracking, proposal-action.ts's approve/reject/request_changes) and
// from the manual "Convert to Deal" fallback in estimates.tsx (via a thin
// Netlify function wrapper) — so there is exactly one place that decides
// how an estimate lifecycle status maps to a Deal stage.
//
// Design constraints this module honors throughout:
//   - never resolves a stage by display name when a canonical field
//     (outcome) is available; only Proposal Sent/Negotiation fall back to
//     normalized-name matching, because pipeline_stages has no dedicated
//     canonical key/slug column for non-terminal stages (confirmed live —
//     `slug` in the TS types is derived client-side via slugify(name), not
//     a real DB column)
//   - never regresses a Deal that has already progressed further (a
//     lifecycle-priority model, not "last write wins")
//   - is idempotent: replaying the same trigger for the same estimate is a
//     safe no-op once the Deal is already at/beyond the target
//   - never creates a Deal solely from a "rejected" event
//   - never throws in a way that should fail the caller's real action
//     (email send, view tracking, approve/reject) — callers treat the
//     returned result as advisory and log-worthy, not fatal
import type { SupabaseClient } from "@supabase/supabase-js";

export type DealSyncTrigger = "sent" | "viewed" | "changes_requested" | "approved" | "rejected";

export type DealSyncResult =
  | { ok: true; skipped: true; reason: string; dealId?: string }
  | { ok: true; skipped: false; created: boolean; moved: boolean; dealId: string; stageId: string; pipelineId: string; previousStageId: string | null }
  | { ok: false; error: string };

type StageCategory = "other" | "proposal_sent" | "negotiation" | "won" | "lost";

const CATEGORY_PRIORITY: Record<StageCategory, number> = {
  other: 0, proposal_sent: 10, negotiation: 20, won: 100, lost: 100,
};

// Only used as a fallback for the two non-terminal stages that have no
// canonical DB field — outcome ('open'/'won'/'lost') already fully
// resolves Won/Lost without any name matching.
const PROPOSAL_SENT_NAME_FRAGMENTS = ["proposalsent", "proposal"];
const NEGOTIATION_NAME_FRAGMENTS = ["negotiation", "negotiating"];

function normalizeStageName(name: string): string {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

type StageRow = { id: string; pipeline_id: string; name: string; outcome: string | null; probability: number | null; position: number | null };

function classifyStage(stage: Pick<StageRow, "name" | "outcome">): StageCategory {
  if (stage.outcome === "won") return "won";
  if (stage.outcome === "lost") return "lost";
  const n = normalizeStageName(stage.name);
  if (NEGOTIATION_NAME_FRAGMENTS.some((f) => n.includes(f))) return "negotiation";
  if (PROPOSAL_SENT_NAME_FRAGMENTS.some((f) => n.includes(f))) return "proposal_sent";
  return "other";
}

const TRIGGER_TARGET_CATEGORY: Record<DealSyncTrigger, StageCategory> = {
  sent: "proposal_sent", viewed: "proposal_sent", changes_requested: "negotiation",
  approved: "won", rejected: "lost",
};
// "rejected" deliberately excluded — Part 3/15: never create a Deal solely from a rejection.
const CREATES_DEAL_ON: Set<DealSyncTrigger> = new Set(["sent", "viewed", "changes_requested", "approved"]);

// Part 2/3 (Pipeline Won-action audit) — deals.status is meant to be
// derived from a stage's outcome everywhere a Deal is moved, per the
// "single source of truth" convention documented next to
// resolveDealStatusForOutcome() in src/lib/deals-store.ts. This sync
// service moves deals.stage_id directly via the admin client (it doesn't
// go through updateDeal()), so without this it was the one write path that
// never wrote deals.status/actual_close_date at all — leaving `status`
// stuck at its previous value (usually "open") even after stage_id moved
// into a Won/Lost stage. That produced deals whose header badge (stage-
// name-derived) read "Won" while the action bar's `status === "open"` gate
// still showed "Mark Won", because the two read different columns that had
// silently drifted apart.
function statusForCategory(category: StageCategory): "open" | "won" | "lost" {
  if (category === "won") return "won";
  if (category === "lost") return "lost";
  return "open";
}

function resolveStageForCategory(stages: StageRow[], pipelineId: string, category: StageCategory): StageRow | null {
  const inPipeline = stages.filter((s) => s.pipeline_id === pipelineId);
  if (category === "won") return inPipeline.find((s) => s.outcome === "won") ?? null;
  if (category === "lost") return inPipeline.find((s) => s.outcome === "lost") ?? null;
  const candidates = inPipeline.filter((s) => classifyStage(s) === category).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return candidates[0] ?? null;
}

async function resolveDefaultPipelineId(admin: SupabaseClient, orgId: string): Promise<string | null> {
  const { data } = await admin
    .from("pipelines").select("id")
    .eq("org_id", orgId).eq("is_active", true)
    .order("is_default", { ascending: false })
    .limit(1).maybeSingle();
  return data?.id ?? null;
}

function fireWorkflow(orgId: string, triggerType: string, triggerData: Record<string, unknown>) {
  fetch(`${process.env.URL ?? "http://localhost:8888"}/.netlify/functions/execute-workflow`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgId, triggerType, triggerData }),
  }).catch(() => {});
}

// deals.expected_close_date is a `date` column (confirmed live), so this
// always resolves to a YYYY-MM-DD string, never null/""/an invalid Date —
// omitting the field on insert previously left it at its DB default
// (null), which the client-side deal mapper turns into `expectedClose: ""`
// (`row.expected_close_date ?? ""`), and `new Date("")` is an Invalid
// Date — exactly what crashed DealCard's formatDateShort() with
// "RangeError: Invalid time value". Every Deal this service creates now
// always gets a real date, matching addDeal()'s own +30-day default when
// the estimate has no Valid Until to inherit.
function resolveExpectedCloseDate(validUntil: unknown): string {
  if (typeof validUntil === "string" && validUntil.trim()) {
    const parsed = new Date(validUntil);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
}

// Part 8 — the ONE place that keeps projects.deal_id (the canonical
// Project<->Deal link; deals has no reciprocal project_id column, see
// audit notes) in sync with whichever Deal an estimate resolves to here.
// Guarded with `.is("deal_id", null)` so an already-linked Project is
// never silently repointed at a different Deal — matches the same
// first-write-wins convention as projects.estimate_id
// (20260816_estimate_project_contract_link.sql). Fixes the case where a
// Project is converted from an Estimate BEFORE that Estimate has a Deal
// (so createProject() never receives a dealId), and the Deal is only
// created/linked afterward by this same sync — without this, projects.
// deal_id would stay NULL forever with no other write path to fill it in.
async function backfillProjectDealLink(admin: SupabaseClient, orgId: string, projectId: string | null | undefined, dealId: string) {
  if (!projectId) return;
  const { error } = await admin.from("projects").update({ deal_id: dealId }).eq("id", projectId).eq("org_id", orgId).is("deal_id", null);
  if (error) logDealSyncWarning("project deal_id backfill failed", { orgId, projectId, dealId, error: error.message });
}

export function logDealSyncWarning(stage: string, detail: Record<string, unknown>) {
  // Structured, deliberately excludes tokens/keys/proposal content —
  // callers only ever pass estimateId/orgId/status/dealIds/stage info.
  console.warn(`[estimate-deal-sync] ${stage}`, detail);
}

/**
 * Synchronizes the Deal linked to an estimate with its current lifecycle
 * status. Safe to call on every customer-facing status transition — it is
 * a no-op (skipped: true) when there's nothing to do, and it never removes
 * or fails the caller's own action on error (callers must not `throw` this
 * result, only log/warn it).
 */
export async function syncEstimateDeal(
  admin: SupabaseClient,
  params: { estimateId: string; orgId: string; trigger: DealSyncTrigger; actorUserId?: string | null },
): Promise<DealSyncResult> {
  const { estimateId, orgId, trigger, actorUserId } = params;

  const { data: estimate, error: estErr } = await admin
    .from("estimates")
    .select("id, org_id, title, number, total, client_id, company_id, owner_id, deal_id, converted_deal_id, project_id, converted_project_id, version_number, metadata, valid_until")
    .eq("id", estimateId).eq("org_id", orgId).maybeSingle();
  if (estErr || !estimate) return { ok: false, error: estErr?.message ?? "Estimate not found" };

  // Conflict: deal_id and converted_deal_id disagree — never guess.
  if (estimate.deal_id && estimate.converted_deal_id && estimate.deal_id !== estimate.converted_deal_id) {
    logDealSyncWarning("deal_id/converted_deal_id conflict — refusing to guess", {
      estimateId, orgId, dealId: estimate.deal_id, convertedDealId: estimate.converted_deal_id,
    });
    return { ok: true, skipped: true, reason: "deal_id and converted_deal_id point to different Deals" };
  }

  let linkedDealId: string | null = estimate.deal_id ?? estimate.converted_deal_id ?? null;
  let existingDeal: { id: string; org_id: string; pipeline_id: string; stage_id: string; value: number; status: string; actual_close_date: string | null } | null = null;

  if (linkedDealId) {
    const { data: dealRow, error: dealErr } = await admin
      .from("deals").select("id, org_id, pipeline_id, stage_id, value, status, actual_close_date")
      .eq("id", linkedDealId).maybeSingle();
    if (dealErr) return { ok: false, error: dealErr.message };
    if (!dealRow || dealRow.org_id !== orgId) {
      logDealSyncWarning("linked Deal missing or cross-org — refusing to act", { estimateId, orgId, linkedDealId });
      return { ok: true, skipped: true, reason: "linked Deal not found in this organization" };
    }
    existingDeal = dealRow;
    // Repair: deal_id was null but converted_deal_id pointed to a real,
    // same-org Deal — backfill deal_id now that it's validated (Part 7).
    if (!estimate.deal_id && estimate.converted_deal_id) {
      await admin.from("estimates").update({ deal_id: dealRow.id }).eq("id", estimateId).eq("org_id", orgId);
    }
    await backfillProjectDealLink(admin, orgId, estimate.project_id ?? estimate.converted_project_id, dealRow.id);
  }

  const targetCategory = TRIGGER_TARGET_CATEGORY[trigger];

  if (!existingDeal && !CREATES_DEAL_ON.has(trigger)) {
    return { ok: true, skipped: true, reason: `No linked Deal and trigger "${trigger}" does not create one` };
  }

  // ── Resolve pipeline: the linked Deal's own pipeline when one exists, otherwise the org's default/active pipeline. ──
  const pipelineId = existingDeal ? existingDeal.pipeline_id : await resolveDefaultPipelineId(admin, orgId);
  if (!pipelineId) {
    logDealSyncWarning("no active pipeline resolvable for organization", { estimateId, orgId });
    return { ok: false, error: "No active sales pipeline found for this organization" };
  }

  const { data: stageRows, error: stageErr } = await admin
    .from("pipeline_stages").select("id, pipeline_id, name, outcome, probability, position")
    .eq("pipeline_id", pipelineId);
  if (stageErr) return { ok: false, error: stageErr.message };

  const targetStage = resolveStageForCategory((stageRows ?? []) as StageRow[], pipelineId, targetCategory);
  if (!targetStage) {
    logDealSyncWarning(`could not resolve "${targetCategory}" stage`, { estimateId, orgId, pipelineId, trigger });
    return { ok: false, error: `Could not resolve a "${targetCategory.replace("_", " ")}" stage on the active pipeline` };
  }

  // ── No linked Deal yet — create one, at the resolved target stage. ──
  if (!existingDeal) {
    const probability = targetCategory === "won" ? 100 : targetCategory === "lost" ? 0 : (targetStage.probability ?? 50);
    const { data: newDeal, error: insertErr } = await admin
      .from("deals")
      .insert({
        org_id: orgId, pipeline_id: pipelineId, stage_id: targetStage.id,
        title: estimate.title, value: Number(estimate.total ?? 0), probability,
        status: statusForCategory(targetCategory),
        actual_close_date: targetCategory === "won" || targetCategory === "lost" ? new Date().toISOString().slice(0, 10) : null,
        contact_id: estimate.client_id, company_id: estimate.company_id, assigned_to: estimate.owner_id,
        source: "estimate", project_address: (estimate.metadata as { serviceAddress?: string } | null)?.serviceAddress ?? null,
        expected_close_date: resolveExpectedCloseDate(estimate.valid_until),
        custom_fields: { source_estimate_id: estimate.id, source_estimate_number: estimate.number, automatic: true },
        stage_order: 0,
      })
      .select("id, title, stage_id")
      .single();
    if (insertErr || !newDeal) return { ok: false, error: insertErr?.message ?? "Deal insert failed" };

    const { error: linkErr } = await admin
      .from("estimates")
      .update({ deal_id: newDeal.id, converted_deal_id: newDeal.id, converted_at: new Date().toISOString() })
      .eq("id", estimateId).eq("org_id", orgId);
    if (linkErr) {
      await admin.from("deals").delete().eq("id", newDeal.id).eq("org_id", orgId);
      return { ok: false, error: `Deal created but could not be linked back to the estimate (${linkErr.message}); the Deal was removed.` };
    }

    await backfillProjectDealLink(admin, orgId, estimate.project_id ?? estimate.converted_project_id, newDeal.id);

    await admin.from("estimate_activities").insert({
      org_id: orgId, estimate_id: estimateId, version_number: estimate.version_number,
      activity_type: "converted_to_deal", actor_type: actorUserId ? "user" : "system", actor_id: actorUserId ?? null,
      title: "Deal created automatically",
      description: `Created Deal "${estimate.title}" in ${targetStage.name}`,
      metadata: { deal_id: newDeal.id, pipeline_id: pipelineId, stage_id: targetStage.id, estimate_status: trigger, automatic: true },
    });
    await admin.from("deal_activities").insert({
      org_id: orgId, deal_id: newDeal.id, activity_type: "created",
      title: "Deal created from Estimate", description: `Estimate ${estimate.number ?? ""} (${trigger})`.trim(),
      metadata: { estimate_id: estimateId, automatic: true },
    });

    fireWorkflow(orgId, "estimate_deal_created", {
      estimateId, estimateNumber: estimate.number, estimateStatus: trigger, dealId: newDeal.id,
      pipelineId, previousStageId: null, stageId: targetStage.id, probability, total: estimate.total, automatic: true, occurredAt: new Date().toISOString(),
    });

    return { ok: true, skipped: false, created: true, moved: true, dealId: newDeal.id, stageId: targetStage.id, pipelineId, previousStageId: null };
  }

  // ── Existing Deal — apply lifecycle-priority regression guard. ──
  const currentStage = (stageRows ?? []).find((s) => s.id === existingDeal!.stage_id) as StageRow | undefined;
  const currentCategory: StageCategory = currentStage ? classifyStage(currentStage) : "other";
  const currentPriority = CATEGORY_PRIORITY[currentCategory];
  const targetPriority = CATEGORY_PRIORITY[targetCategory];

  let shouldMove: boolean;
  if (targetCategory === "won") {
    shouldMove = currentCategory !== "won"; // approved always wins, unless already Won (idempotent no-op)
  } else if (targetCategory === "lost") {
    shouldMove = currentCategory !== "won" && currentCategory !== "lost"; // never regress a Won Deal from a stale/conflicting rejection; idempotent if already Lost
  } else {
    shouldMove = targetPriority > currentPriority; // sent/viewed/changes_requested may only advance, never regress
  }

  if (!shouldMove) {
    return { ok: true, skipped: true, reason: `Deal already at or beyond "${targetCategory}" (currently "${currentCategory}")`, dealId: existingDeal.id };
  }

  const updatePayload: Record<string, unknown> = { stage_id: targetStage.id, status: statusForCategory(targetCategory) };
  if (targetCategory === "won") updatePayload.probability = 100;
  else if (targetCategory === "lost") updatePayload.probability = 0;
  else if (typeof targetStage.probability === "number") updatePayload.probability = targetStage.probability;
  // Deal value tracks the estimate total on every advancing sync except a
  // rejection, which intentionally preserves whatever value the Deal
  // already had (Part 17).
  if (targetCategory !== "lost") updatePayload.value = Number(estimate.total ?? 0);
  // Mirrors resolveDealStatusForOutcome()'s actual_close_date rule (src/lib/
  // deals-store.ts): populate it on entering won/lost only if not already
  // set, leave it untouched for any non-terminal category.
  if ((targetCategory === "won" || targetCategory === "lost") && !existingDeal.actual_close_date) {
    updatePayload.actual_close_date = new Date().toISOString().slice(0, 10);
  }

  const { error: moveErr } = await admin.from("deals").update(updatePayload).eq("id", existingDeal.id).eq("org_id", orgId);
  if (moveErr) return { ok: false, error: moveErr.message };

  const stageActivityTitle = targetCategory === "won" ? "Linked Deal marked Won"
    : targetCategory === "lost" ? "Linked Deal marked Lost"
    : targetCategory === "negotiation" ? "Linked Deal moved to Negotiation"
    : "Linked Deal moved to Proposal Sent";

  await admin.from("estimate_activities").insert({
    org_id: orgId, estimate_id: estimateId, version_number: estimate.version_number,
    activity_type: "converted_to_deal", actor_type: actorUserId ? "user" : "system", actor_id: actorUserId ?? null,
    title: stageActivityTitle, description: `${estimate.title} → ${targetStage.name}`,
    metadata: { deal_id: existingDeal.id, pipeline_id: pipelineId, previous_stage_id: existingDeal.stage_id, stage_id: targetStage.id, estimate_status: trigger, automatic: true },
  });
  await admin.from("deal_activities").insert({
    org_id: orgId, deal_id: existingDeal.id, activity_type: "stage_changed",
    title: stageActivityTitle, description: `Synced from Estimate ${estimate.number ?? ""} (${trigger})`.trim(),
    metadata: { estimate_id: estimateId, from_stage_id: existingDeal.stage_id, to_stage_id: targetStage.id, automatic: true },
  });

  fireWorkflow(orgId, "estimate_deal_stage_synced", {
    estimateId, estimateNumber: estimate.number, estimateStatus: trigger, dealId: existingDeal.id, pipelineId,
    previousStageId: existingDeal.stage_id, stageId: targetStage.id, probability: updatePayload.probability ?? null,
    total: estimate.total, automatic: true, occurredAt: new Date().toISOString(),
  });

  return { ok: true, skipped: false, created: false, moved: true, dealId: existingDeal.id, stageId: targetStage.id, pipelineId, previousStageId: existingDeal.stage_id };
}
