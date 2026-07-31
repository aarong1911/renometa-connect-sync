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
