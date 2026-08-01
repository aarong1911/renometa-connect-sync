// src/lib/estimate-status.ts
//
// Phase 10.4 — canonical estimate/proposal lifecycle. The ONE place
// status labels, order, colors, valid transitions, and action-eligibility
// rules live, mirroring src/lib/appointment-status.ts and
// src/lib/task-status.ts. Matches the live `estimates_status_check`
// constraint added by supabase/migrations/20260809_estimates_proposals_completion.sql.
//
// Replaces the old ad hoc vocabulary (draft/sent/viewed/accepted/declined)
// that never matched the live DB constraint (draft/sent/approved/declined/
// converted) — "accepted" was dead code (zero estimates could ever have
// that status), and "declined"/"rejected" were the same concept under two
// names. The migration normalizes existing "declined" rows to "rejected".

import {
  FileEdit, CheckCircle2, Send, Eye, MessageSquareWarning, ThumbsUp, ThumbsDown,
  Clock3, ArrowRightCircle, Ban, Archive, type LucideIcon,
} from "lucide-react";

export type EstimateStatus =
  | "draft"
  | "ready"
  | "sent"
  | "viewed"
  | "changes_requested"
  | "approved"
  | "rejected"
  | "expired"
  | "converted"
  | "cancelled"
  | "archived";

export const ESTIMATE_STATUS_ORDER: EstimateStatus[] = [
  "draft", "ready", "sent", "viewed", "changes_requested",
  "approved", "rejected", "expired", "converted", "cancelled", "archived",
];

export const ESTIMATE_STATUS_LABELS: Record<EstimateStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  sent: "Sent",
  viewed: "Viewed",
  changes_requested: "Changes Requested",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
  converted: "Converted",
  cancelled: "Cancelled",
  archived: "Archived",
};

export const ESTIMATE_STATUS_DESCRIPTIONS: Record<EstimateStatus, string> = {
  draft: "Being prepared — not yet sent to the customer",
  ready: "Reviewed internally and ready to send",
  sent: "Sent to the customer, awaiting a response",
  viewed: "Customer has opened the proposal",
  changes_requested: "Customer requested changes",
  approved: "Customer approved the proposal",
  rejected: "Customer rejected the proposal",
  expired: "Passed its valid-until date with no response",
  converted: "Approved and converted to a Deal or Project",
  cancelled: "Cancelled internally",
  archived: "Archived — no longer active",
};

export const ESTIMATE_STATUS_ICONS: Record<EstimateStatus, LucideIcon> = {
  draft: FileEdit,
  ready: CheckCircle2,
  sent: Send,
  viewed: Eye,
  changes_requested: MessageSquareWarning,
  approved: ThumbsUp,
  rejected: ThumbsDown,
  expired: Clock3,
  converted: ArrowRightCircle,
  cancelled: Ban,
  archived: Archive,
};

export const ESTIMATE_STATUS_TINT: Record<EstimateStatus, { icon: string; badge: string }> = {
  draft: { icon: "text-slate-500", badge: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-500/10 dark:text-slate-400" },
  ready: { icon: "text-cyan-600", badge: "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-900/40 dark:bg-cyan-500/10 dark:text-cyan-400" },
  sent: { icon: "text-blue-600", badge: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/40 dark:bg-blue-500/10 dark:text-blue-400" },
  viewed: { icon: "text-violet-600", badge: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/40 dark:bg-violet-500/10 dark:text-violet-400" },
  changes_requested: { icon: "text-amber-600", badge: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/40 dark:bg-amber-500/10 dark:text-amber-400" },
  approved: { icon: "text-emerald-600", badge: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-500/10 dark:text-emerald-400" },
  rejected: { icon: "text-rose-600", badge: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/40 dark:bg-rose-500/10 dark:text-rose-400" },
  expired: { icon: "text-orange-600", badge: "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/40 dark:bg-orange-500/10 dark:text-orange-400" },
  converted: { icon: "text-teal-600", badge: "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-900/40 dark:bg-teal-500/10 dark:text-teal-400" },
  cancelled: { icon: "text-muted-foreground", badge: "border-border bg-secondary text-muted-foreground" },
  archived: { icon: "text-muted-foreground", badge: "border-border bg-secondary text-muted-foreground" },
};

/** Canonical valid-transition graph — the ONE place this is decided. UI status controls must never offer a transition not listed here. */
export const ESTIMATE_STATUS_TRANSITIONS: Record<EstimateStatus, EstimateStatus[]> = {
  draft: ["ready", "cancelled"],
  ready: ["draft", "sent", "cancelled"],
  sent: ["viewed", "approved", "rejected", "changes_requested", "expired", "cancelled"],
  viewed: ["approved", "rejected", "changes_requested", "expired", "cancelled"],
  changes_requested: ["draft", "ready", "sent", "cancelled"],
  approved: ["converted", "cancelled"],
  rejected: ["draft", "archived"],
  expired: ["draft", "sent", "archived"],
  converted: ["archived"],
  cancelled: ["draft", "archived"],
  archived: [],
};

export function canTransition(from: EstimateStatus, to: EstimateStatus): boolean {
  return ESTIMATE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminalEstimateStatus(status: EstimateStatus): boolean {
  return status === "converted" || status === "archived";
}

/** Statuses in which the estimate is still editable internally without creating a new version. */
export function isDirectlyEditable(status: EstimateStatus): boolean {
  return status === "draft" || status === "ready" || status === "changes_requested";
}

/** Statuses in which editing a customer-visible field must create a new version instead of mutating in place (Part 8). */
export function requiresRevisionOnEdit(status: EstimateStatus): boolean {
  return status === "sent" || status === "viewed";
}

/** Statuses in which the customer-facing proposal accepts approve/reject/request-changes actions. */
export function isCustomerActionable(status: EstimateStatus): boolean {
  return status === "sent" || status === "viewed" || status === "changes_requested";
}

/** Normalizes a legacy/unexpected stored value to a safe canonical status rather than crashing the UI. */
export function normalizeEstimateStatus(raw: string | null | undefined): EstimateStatus {
  if (raw === "declined") return "rejected";
  if (raw === "accepted") return "approved";
  return (ESTIMATE_STATUS_ORDER as string[]).includes(raw ?? "") ? (raw as EstimateStatus) : "draft";
}

export type DiscountType = "percent" | "fixed";
export type DepositType = "percent" | "fixed";

export const DISCOUNT_TYPE_LABELS: Record<DiscountType, string> = { percent: "Percentage", fixed: "Fixed amount" };
export const DEPOSIT_TYPE_LABELS: Record<DepositType, string> = { percent: "Percentage", fixed: "Fixed amount" };

// ── Work Type (estimate "title" selector) ──────────────────────────────────
// estimates.title stays a free-text column (no schema change) — Work Type
// is a curated picker over it. WORK_TYPE_LABELS is the canonical
// value->human-label map; matchWorkTypeFromTitle() reverse-maps a stored
// title back to a known key (case/whitespace-insensitive) so legacy and
// hand-typed titles still resolve to the right dropdown option instead of
// silently falling to "other" whenever the casing doesn't match exactly.
export type WorkType =
  | "kitchen_remodel" | "bathroom_remodel" | "full_home_remodel" | "home_addition"
  | "roofing" | "flooring" | "interior_painting" | "exterior_painting"
  | "hvac_installation" | "hvac_repair" | "plumbing" | "electrical" | "landscaping"
  | "commercial_renovation" | "new_construction" | "repair_maintenance"
  | "inspection" | "consultation" | "other";

export const WORK_TYPE_ORDER: WorkType[] = [
  "kitchen_remodel", "bathroom_remodel", "full_home_remodel", "home_addition",
  "roofing", "flooring", "interior_painting", "exterior_painting",
  "hvac_installation", "hvac_repair", "plumbing", "electrical", "landscaping",
  "commercial_renovation", "new_construction", "repair_maintenance",
  "inspection", "consultation", "other",
];

export const WORK_TYPE_LABELS: Record<WorkType, string> = {
  kitchen_remodel: "Kitchen Remodel", bathroom_remodel: "Bathroom Remodel",
  full_home_remodel: "Full Home Remodel", home_addition: "Home Addition",
  roofing: "Roofing", flooring: "Flooring",
  interior_painting: "Interior Painting", exterior_painting: "Exterior Painting",
  hvac_installation: "HVAC Installation", hvac_repair: "HVAC Repair",
  plumbing: "Plumbing", electrical: "Electrical", landscaping: "Landscaping",
  commercial_renovation: "Commercial Renovation", new_construction: "New Construction",
  repair_maintenance: "Repair / Maintenance", inspection: "Inspection",
  consultation: "Consultation", other: "Other",
};

/** Reverse-maps a stored estimates.title to a known WorkType, case/whitespace-insensitive. Falls back to "other" — never throws, never blocks legacy/hand-typed titles from rendering. */
export function matchWorkTypeFromTitle(title: string | null | undefined): WorkType {
  const norm = (title ?? "").trim().toLowerCase();
  if (!norm) return "other";
  for (const key of WORK_TYPE_ORDER) {
    if (key === "other") continue;
    if (WORK_TYPE_LABELS[key].toLowerCase() === norm) return key;
  }
  return "other";
}

export type EstimateItemType = "labor" | "material" | "service" | "equipment" | "allowance" | "fee" | "discount" | "custom";

export const ESTIMATE_ITEM_TYPE_ORDER: EstimateItemType[] = [
  "labor", "material", "service", "equipment", "allowance", "fee", "discount", "custom",
];

export const ESTIMATE_ITEM_TYPE_LABELS: Record<EstimateItemType, string> = {
  labor: "Labor", material: "Material", service: "Service", equipment: "Equipment",
  allowance: "Allowance", fee: "Fee", discount: "Discount", custom: "Custom",
};

export type EstimateItemUnit =
  | "each" | "hour" | "day" | "square_foot" | "linear_foot" | "square_yard"
  | "cubic_yard" | "gallon" | "pound" | "ton" | "fixed" | "custom";

export const ESTIMATE_ITEM_UNIT_LABELS: Record<EstimateItemUnit, string> = {
  each: "each", hour: "hr", day: "day", square_foot: "sq ft", linear_foot: "lin ft",
  square_yard: "sq yd", cubic_yard: "cu yd", gallon: "gal", pound: "lb", ton: "ton",
  fixed: "fixed", custom: "custom",
};

export type EstimateActivityType =
  | "created" | "updated" | "marked_ready" | "sent" | "viewed" | "changes_requested"
  | "revision_created" | "approved" | "rejected" | "expired" | "cancelled" | "restored"
  | "converted_to_deal" | "converted_to_project" | "invoice_created" | "deposit_requested"
  | "payment_received" | "duplicated" | "archived";

export const ESTIMATE_ACTIVITY_LABELS: Record<EstimateActivityType, string> = {
  created: "Estimate created",
  updated: "Estimate updated",
  marked_ready: "Marked ready",
  sent: "Proposal sent",
  viewed: "Proposal viewed",
  changes_requested: "Changes requested",
  revision_created: "Revision created",
  approved: "Proposal approved",
  rejected: "Proposal rejected",
  expired: "Proposal expired",
  cancelled: "Estimate cancelled",
  restored: "Estimate restored",
  converted_to_deal: "Converted to Deal",
  converted_to_project: "Converted to Project",
  invoice_created: "Invoice created",
  deposit_requested: "Deposit requested",
  payment_received: "Payment received",
  duplicated: "Estimate duplicated",
  archived: "Estimate archived",
};
