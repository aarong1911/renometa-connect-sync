// src/lib/change-order-status.ts
//
// Phase 13.3B — canonical Change Order lifecycle. Mirrors the shape of
// estimate-status.ts (labels/order/icons/colors/transitions in one place).
// Matches the live project_change_orders_status_check constraint added by
// supabase/migrations/20260815_project_change_orders.sql.

import {
  FileEdit, ClipboardCheck, CheckCircle2, Send, Eye, ThumbsUp, ThumbsDown,
  Ban, Clock3, Copy, type LucideIcon,
} from "lucide-react";

export type ChangeOrderStatus =
  | "draft"
  | "internal_review"
  | "ready_to_send"
  | "sent"
  | "viewed"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired"
  | "superseded";

export const CHANGE_ORDER_STATUS_ORDER: ChangeOrderStatus[] = [
  "draft", "internal_review", "ready_to_send", "sent", "viewed",
  "approved", "rejected", "cancelled", "expired", "superseded",
];

export const CHANGE_ORDER_STATUS_LABELS: Record<ChangeOrderStatus, string> = {
  draft: "Draft",
  internal_review: "Internal Review",
  ready_to_send: "Ready to Send",
  sent: "Sent",
  viewed: "Viewed",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
  expired: "Expired",
  superseded: "Superseded",
};

export const CHANGE_ORDER_STATUS_DESCRIPTIONS: Record<ChangeOrderStatus, string> = {
  draft: "Being prepared — internal only",
  internal_review: "Being reviewed internally — still not customer-visible",
  ready_to_send: "Finalized internally — customer-facing snapshot ready",
  sent: "Delivered to the customer, awaiting a response",
  viewed: "Customer has opened the Change Order",
  approved: "Customer accepted — financial/schedule effects may apply",
  rejected: "Customer declined — no approved financial impact",
  cancelled: "Withdrawn by the contractor",
  expired: "Approval deadline passed with no response",
  superseded: "Replaced by a newer version of this Change Order",
};

export const CHANGE_ORDER_STATUS_ICONS: Record<ChangeOrderStatus, LucideIcon> = {
  draft: FileEdit,
  internal_review: ClipboardCheck,
  ready_to_send: CheckCircle2,
  sent: Send,
  viewed: Eye,
  approved: ThumbsUp,
  rejected: ThumbsDown,
  cancelled: Ban,
  expired: Clock3,
  superseded: Copy,
};

export const CHANGE_ORDER_STATUS_TINT: Record<ChangeOrderStatus, { icon: string; badge: string }> = {
  draft: { icon: "text-slate-500", badge: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-500/10 dark:text-slate-400" },
  internal_review: { icon: "text-indigo-600", badge: "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900/40 dark:bg-indigo-500/10 dark:text-indigo-400" },
  ready_to_send: { icon: "text-cyan-600", badge: "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-900/40 dark:bg-cyan-500/10 dark:text-cyan-400" },
  sent: { icon: "text-blue-600", badge: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/40 dark:bg-blue-500/10 dark:text-blue-400" },
  viewed: { icon: "text-violet-600", badge: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/40 dark:bg-violet-500/10 dark:text-violet-400" },
  approved: { icon: "text-emerald-600", badge: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-500/10 dark:text-emerald-400" },
  rejected: { icon: "text-rose-600", badge: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/40 dark:bg-rose-500/10 dark:text-rose-400" },
  cancelled: { icon: "text-muted-foreground", badge: "border-border bg-secondary text-muted-foreground" },
  expired: { icon: "text-orange-600", badge: "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/40 dark:bg-orange-500/10 dark:text-orange-400" },
  superseded: { icon: "text-muted-foreground", badge: "border-border bg-secondary text-muted-foreground" },
};

/** Canonical valid-transition graph — the ONE place this is decided. UI status controls must never offer a transition not listed here. */
// Mirrors the database's enforce_change_order_lifecycle() transition map
// exactly (20260815_project_change_orders.sql) -- sent/viewed -> superseded
// is reachable only through send_project_change_order()'s atomic revision
// supersession, never offered as an ordinary UI status control, but listed
// here so canTransitionChangeOrder() stays a faithful mirror of what the
// database actually allows.
export const CHANGE_ORDER_STATUS_TRANSITIONS: Record<ChangeOrderStatus, ChangeOrderStatus[]> = {
  draft: ["internal_review", "ready_to_send", "cancelled"],
  internal_review: ["draft", "ready_to_send", "cancelled"],
  ready_to_send: ["draft", "sent", "cancelled"],
  sent: ["viewed", "approved", "rejected", "cancelled", "expired", "superseded"],
  viewed: ["approved", "rejected", "cancelled", "expired", "superseded"],
  approved: ["superseded"],
  rejected: ["superseded"],
  cancelled: ["draft"],
  expired: ["draft", "sent"],
  superseded: [],
};

export function canTransitionChangeOrder(from: ChangeOrderStatus, to: ChangeOrderStatus): boolean {
  return CHANGE_ORDER_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminalChangeOrderStatus(status: ChangeOrderStatus): boolean {
  return status === "superseded" || status === "cancelled";
}

/** Statuses in which the Change Order is still directly editable internally. */
export function isChangeOrderDirectlyEditable(status: ChangeOrderStatus): boolean {
  return status === "draft" || status === "internal_review" || status === "ready_to_send";
}

/** Statuses in which the customer-facing approval token accepts approve/reject. */
export function isChangeOrderCustomerActionable(status: ChangeOrderStatus): boolean {
  return status === "sent" || status === "viewed";
}

/** Normalizes a legacy/unexpected stored value to a safe canonical status rather than crashing the UI. */
export function normalizeChangeOrderStatus(raw: string | null | undefined): ChangeOrderStatus {
  return (CHANGE_ORDER_STATUS_ORDER as string[]).includes(raw ?? "")
    ? (raw as ChangeOrderStatus)
    : "draft";
}

export type ChangeOrderItemType = "service" | "labor" | "material" | "equipment" | "allowance" | "credit" | "fee" | "other";

export const CHANGE_ORDER_ITEM_TYPE_ORDER: ChangeOrderItemType[] = [
  "service", "labor", "material", "equipment", "allowance", "credit", "fee", "other",
];

export const CHANGE_ORDER_ITEM_TYPE_LABELS: Record<ChangeOrderItemType, string> = {
  service: "Service", labor: "Labor", material: "Material", equipment: "Equipment",
  allowance: "Allowance", credit: "Credit", fee: "Fee", other: "Other",
};

export type ChangeOrderDiscountOrMarkupType = "percentage" | "fixed";

export const CHANGE_ORDER_DISCOUNT_TYPE_LABELS: Record<ChangeOrderDiscountOrMarkupType, string> = {
  percentage: "Percentage", fixed: "Fixed amount",
};
export const CHANGE_ORDER_MARKUP_TYPE_LABELS: Record<ChangeOrderDiscountOrMarkupType, string> = {
  percentage: "Percentage", fixed: "Fixed amount",
};

export type ChangeOrderApprovalAction = "viewed" | "approved" | "rejected" | "cancelled" | "expired" | "superseded" | "resent";

export const CHANGE_ORDER_APPROVAL_ACTION_LABELS: Record<ChangeOrderApprovalAction, string> = {
  viewed: "Viewed by customer",
  approved: "Approved by customer",
  rejected: "Rejected by customer",
  cancelled: "Cancelled",
  expired: "Expired",
  superseded: "Superseded",
  resent: "Resent",
};
