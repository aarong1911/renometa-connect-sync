// src/lib/pipeline-phases.ts
//
// Groups raw deal.stage ids into five executive-level phases for the
// Command Center's Live Pipeline donut and Sales Pipeline Snapshot ONLY.
// This never changes deal/stage data, and the Pipeline page
// (src/routes/pipeline.tsx) keeps showing every raw stage untouched.
//
// This is a separate concern from the per-raw-stage palette in
// stage-colors.ts (used by the Pipeline board's Kanban columns) — the two
// intentionally use different color assignments since they're different
// views at different levels of granularity.
//
// Real stage names pulled from this org's `pipeline_stages` table
// (inspected directly via the Supabase REST API during this change):
//   New Lead, Qualified, Contacted, Site Visit Scheduled,
//   "Estimate / Proposal Sent", Follow-Up, Negotiation,
//   "Won – Job Approved" (note: EN DASH, not a hyphen), Lost
// `deals-store.ts` slugifies these into deal.stage — see normalizePipelineStage
// below for why the slug format doesn't actually matter (everything
// non-alphanumeric is stripped before matching).
//
// The deeper bug this uncovered: a deal's `stage_id` is only updated on a
// normal stage move — winning a deal only flips `deals.status` to "won" and
// leaves `stage_id` pointing at whatever stage it was in right before
// winning (see the fix in deals-store.ts's mapRow). That's why a won deal
// used to still show up under "Proposals" instead of "Won" here.

export type DashboardPhase = "new-leads" | "qualified" | "appointments" | "proposals" | "won";

// Sales-flow order — the donut/snapshot always render in this order,
// never sorted by value.
export const PHASE_ORDER: DashboardPhase[] = ["new-leads", "qualified", "appointments", "proposals", "won"];

export const PHASE_LABELS: Record<DashboardPhase, string> = {
  "new-leads": "New Leads",
  qualified: "Qualified",
  appointments: "Appointments",
  proposals: "Proposals",
  won: "Won",
};

export const PHASE_COLORS: Record<DashboardPhase, string> = {
  "new-leads": "#3B82F6",   // blue
  qualified: "#10B981",    // teal/green
  appointments: "#F59E0B", // amber/orange
  proposals: "#EF4444",    // red/coral
  won: "#8B5CF6",          // purple
};

/**
 * Normalizes a raw stage string for matching: trims, lowercases, converts
 * underscores to hyphens, collapses repeated whitespace/hyphens, and
 * strips remaining punctuation (including non-ASCII dashes like the en
 * dash "–" found in this org's real "Won – Job Approved" stage name).
 *
 *   normalizePipelineStage("Won – Job Approved") === "wonjobapproved"
 *   normalizePipelineStage("won_job_approved")    === "wonjobapproved"
 *   normalizePipelineStage("Closed Won")           === "closedwon"
 */
export function normalizePipelineStage(stage: string): string {
  return stage
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-/g, "");
}

// Normalized-stage -> phase. Covers every naming variant in use across
// this app's stage sets: the local FALLBACK_STAGES template
// (new/qualified/site-visit/proposal/negotiation/won/lost), this org's
// actual configured pipeline_stages (New Lead, Contacted, Site Visit
// Scheduled, "Estimate / Proposal Sent", Follow-Up, Negotiation,
// "Won – Job Approved"), and other common phrasings. `null` means "never a
// dashboard phase" (Lost).
const STAGE_TO_PHASE: Record<string, DashboardPhase | null> = {
  // New Leads
  new: "new-leads",
  newlead: "new-leads",
  lead: "new-leads",

  // Qualified (includes Contacted)
  contacted: "qualified",
  qualified: "qualified",

  // Appointments
  sitevisit: "appointments",
  sitevisitscheduled: "appointments",
  appointmentscheduled: "appointments",
  scheduled: "appointments",

  // Proposals (Estimate/Proposal Sent, Follow-Up, Negotiation)
  proposal: "proposals",
  proposalsent: "proposals",
  estimatesent: "proposals",
  estimateproposalsent: "proposals",
  estimate: "proposals",
  followup: "proposals",
  negotiation: "proposals",

  // Won
  won: "won",
  wonjobapproved: "won",
  jobapproved: "won",
  closedwon: "won",
  approved: "won",

  // Lost is never a dashboard phase — it's excluded from the donut/snapshot
  // entirely and surfaced only as the existing "Lost MTD" bottom metric.
  lost: null,
  closedlost: null,
};

/**
 * Maps a raw deal.stage id to one of the five Command Center dashboard
 * phases. Returns null only for Lost. Any other unrecognized/custom stage
 * name falls back to "proposals" (a reasonable mid-funnel default) rather
 * than being silently dropped from the total — see callers for how the
 * denominator is computed.
 *
 *   mapPipelineStageToDashboardPhase("Won")                     === "won"
 *   mapPipelineStageToDashboardPhase("Won - Job Approved")       === "won"
 *   mapPipelineStageToDashboardPhase("won_job_approved")         === "won"
 *   mapPipelineStageToDashboardPhase("Closed Won")               === "won"
 *   mapPipelineStageToDashboardPhase("Estimate / Proposal Sent") === "proposals"
 *   mapPipelineStageToDashboardPhase("Follow-Up")                === "proposals"
 *   mapPipelineStageToDashboardPhase("Lost")                     === null
 */
export function mapPipelineStageToDashboardPhase(rawStage: string): DashboardPhase | null {
  const key = normalizePipelineStage(rawStage);
  if (key in STAGE_TO_PHASE) return STAGE_TO_PHASE[key];
  return "proposals";
}
