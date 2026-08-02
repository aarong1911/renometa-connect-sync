// src/lib/project-status.ts
//
// Canonical Project Type / Priority / Budget Range configuration for the
// New Project modal — mirrors src/lib/appointment-status.ts's pattern
// (one place canonical values/labels/colors live, matching the live DB
// check constraints added by
// supabase/migrations/20260808_project_creation_enhancements.sql).
//
// Deliberately does NOT redefine project *status* (Estimating/Contracted/
// Pre-Construction/In Progress/Punch List/Completed) — that configuration
// already exists as STAGE_COLUMNS in src/routes/projects.index.tsx and is
// reused directly rather than duplicated here.

export type ProjectType =
  | "kitchen_remodel" | "bathroom_remodel" | "full_home_remodel" | "home_addition"
  | "roofing" | "flooring" | "painting" | "hvac" | "plumbing" | "electrical"
  | "landscaping" | "commercial_renovation" | "new_construction" | "repair_maintenance" | "other";

export const PROJECT_TYPE_ORDER: ProjectType[] = [
  "kitchen_remodel", "bathroom_remodel", "full_home_remodel", "home_addition",
  "roofing", "flooring", "painting", "hvac", "plumbing", "electrical",
  "landscaping", "commercial_renovation", "new_construction", "repair_maintenance", "other",
];

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  kitchen_remodel: "Kitchen Remodel",
  bathroom_remodel: "Bathroom Remodel",
  full_home_remodel: "Full Home Remodel",
  home_addition: "Home Addition",
  roofing: "Roofing",
  flooring: "Flooring",
  painting: "Painting",
  hvac: "HVAC",
  plumbing: "Plumbing",
  electrical: "Electrical",
  landscaping: "Landscaping",
  commercial_renovation: "Commercial Renovation",
  new_construction: "New Construction",
  repair_maintenance: "Repair / Maintenance",
  other: "Other",
};

export type ProjectPriority = "low" | "normal" | "high" | "urgent";

export const PROJECT_PRIORITY_ORDER: ProjectPriority[] = ["low", "normal", "high", "urgent"];

export const PROJECT_PRIORITY_LABELS: Record<ProjectPriority, string> = {
  low: "Low", normal: "Normal", high: "High", urgent: "Urgent",
};

/** Soft-accent tint per priority — color is never the only signal (label text is always shown alongside it). */
export const PROJECT_PRIORITY_TINT: Record<ProjectPriority, { icon: string; badge: string }> = {
  low: { icon: "text-slate-500", badge: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-500/10 dark:text-slate-400" },
  normal: { icon: "text-blue-600", badge: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/40 dark:bg-blue-500/10 dark:text-blue-400" },
  high: { icon: "text-amber-600", badge: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/40 dark:bg-amber-500/10 dark:text-amber-400" },
  urgent: { icon: "text-red-600", badge: "border-red-200 bg-red-50 text-red-700 dark:border-red-900/40 dark:bg-red-500/10 dark:text-red-400" },
};

export type BudgetRange =
  | "not_specified" | "under_10k" | "10k_25k" | "25k_50k" | "50k_100k"
  | "100k_250k" | "250k_500k" | "500k_plus" | "custom";

export const BUDGET_RANGE_ORDER: BudgetRange[] = [
  "not_specified", "under_10k", "10k_25k", "25k_50k", "50k_100k",
  "100k_250k", "250k_500k", "500k_plus", "custom",
];

export const BUDGET_RANGE_LABELS: Record<BudgetRange, string> = {
  not_specified: "Not specified",
  under_10k: "Under $10,000",
  "10k_25k": "$10,000–$25,000",
  "25k_50k": "$25,000–$50,000",
  "50k_100k": "$50,000–$100,000",
  "100k_250k": "$100,000–$250,000",
  "250k_500k": "$250,000–$500,000",
  "500k_plus": "$500,000+",
  custom: "Custom amount",
};

/**
 * Documented midpoint used ONLY to keep the pre-existing, NOT NULL
 * `budget_total` column (already read by pipeline-value/board math) from
 * silently zeroing out when a range — not an exact figure — is selected.
 * Never presented to the user as an exact customer-provided amount; the UI
 * always displays the selected range label instead. Returns null for
 * "not_specified"/"custom" (custom supplies its own exact amount).
 */
export function budgetRangeMidpoint(range: BudgetRange): number | null {
  switch (range) {
    case "under_10k": return 5000;
    case "10k_25k": return 17500;
    case "25k_50k": return 37500;
    case "50k_100k": return 75000;
    case "100k_250k": return 175000;
    case "250k_500k": return 375000;
    case "500k_plus": return 500000;
    default: return null;
  }
}

// ── Project Type → Estimate Work Type mapping ──────────────────────────
//
// Phase 13.2 — Description/Scope templates. ProjectType and WorkType
// (src/lib/estimate-status.ts) are two separate unions maintained for two
// separate constrained DB columns (projects.project_type vs estimates'
// title-derived work type) and are NOT identical: ProjectType collapses
// "interior_painting"/"exterior_painting" into one "painting" value and
// "hvac_installation"/"hvac_repair" into one "hvac" value. This mapping
// exists solely so Project Description/Scope templates can reuse the
// existing scope-of-work-presets.ts / estimate_proposal_templates
// (category=scope_of_work) architecture without inventing a second
// Project Type union or a second template table — see Phase 13.2 report.
import type { WorkType } from "@/lib/estimate-status";

export const PROJECT_TYPE_TO_WORK_TYPES: Record<ProjectType, WorkType[]> = {
  kitchen_remodel: ["kitchen_remodel"],
  bathroom_remodel: ["bathroom_remodel"],
  full_home_remodel: ["full_home_remodel"],
  home_addition: ["home_addition"],
  roofing: ["roofing"],
  flooring: ["flooring"],
  painting: ["interior_painting", "exterior_painting"],
  hvac: ["hvac_installation", "hvac_repair"],
  plumbing: ["plumbing"],
  electrical: ["electrical"],
  landscaping: ["landscaping"],
  commercial_renovation: ["commercial_renovation"],
  new_construction: ["new_construction"],
  repair_maintenance: ["repair_maintenance"],
  other: ["other"],
};

// ── Project progress model (Phase 13.4) ─────────────────────────────────
//
// projects.completion_percentage is nullable but DEFAULTs to 0 at the DB
// level, and until this phase no code path ever wrote a real value to it
// (createProject/updateProjectStatus never touched it, no edit form
// exposed it) — every existing row is the raw column default, including
// rows already marked status="completed". That is the entire root cause
// of every Project card showing "0%": not a display bug, a write-path gap.
//
// Model: completion_percentage is the MANUAL value once a user has
// actually set one; null means "never set" and the UI falls back to a
// workflow-based stage default for DISPLAY only (never written back to
// the row for ordinary stage movement — see getProgressAfterStageChange).
// A real stored 0 is left alone and displayed as 0%, per instruction not
// to collapse "explicit 0" and "never set" once the model is in effect
// going forward; see the Phase 13.4 report for the one-time data-repair
// recommendation for the *existing* rows, which this code does not apply
// automatically.
import type { ProjectStatus } from "@/lib/projects-store";

/** Workflow-based defaults/minimums — NOT a claim of real job completion. */
export const PROJECT_STAGE_MINIMUM_PROGRESS: Record<ProjectStatus, number> = {
  planning: 5,
  contracted: 15,
  "pre-construction": 30,
  active: 50,
  "punch-list": 90,
  completed: 100,
  "on-hold": 0,
  cancelled: 0,
};

export function getStageMinimumProgress(status: ProjectStatus): number {
  return PROJECT_STAGE_MINIMUM_PROGRESS[status] ?? 0;
}

/** True once a user (or the completed-stage write) has set a real completion_percentage — null/undefined means the display value below is stage-derived, not stored. */
export function isProgressManual(project: { completion_percentage: number | null | undefined }): boolean {
  return typeof project.completion_percentage === "number" && Number.isFinite(project.completion_percentage);
}

/** The single shared "what number/bar do we show" helper — Project cards, list view, and detail must all call this instead of reading completion_percentage directly, so null and a genuine stored 0 are never confused and every surface agrees. */
export function getProjectDisplayProgress(project: { completion_percentage: number | null | undefined; status: ProjectStatus }): number {
  const raw = project.completion_percentage;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.min(100, Math.max(0, Math.round(raw)));
  return getStageMinimumProgress(project.status);
}

/**
 * What to persist when a Project's status changes (drag-and-drop, Edit
 * form, detail actions). Deliberately minimal per the preferred model:
 * ordinary stage movement never writes a stage default into the row (that
 * would pollute completion_percentage with artificial numbers) — only
 * "completed" forces a real 100. Everything else (on-hold, cancelled,
 * backward moves, reopening a completed Project) preserves whatever was
 * already stored, including null. Reopening a completed Project therefore
 * currently keeps the stored 100 rather than prompting to choose a new
 * value — the confirmation dialog described in the spec is deferred (see
 * the Phase 13.4 report); this at least matches its hard requirement to
 * never silently reset a completed Project's progress.
 */
export function getProgressAfterStageChange(params: {
  currentProgress: number | null | undefined;
  nextStatus: ProjectStatus;
}): number | null {
  if (params.nextStatus === "completed") return 100;
  return params.currentProgress ?? null;
}
