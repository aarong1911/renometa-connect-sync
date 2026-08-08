// src/lib/project-change-orders.ts
//
// Phase 13.3B -- Change Orders domain layer. Types, fetch/CRUD, totals
// (via change-order-calculations.ts), status transitions, revisions, and
// Field/Portal-safe projections. Draft-lifecycle writes (create/update
// items/delete-draft) go straight through Supabase (org-scoped RLS
// protects them); customer-facing state transitions (send/approve/reject)
// are never performed here -- see change-order-approvals.ts and the
// change-order-* Netlify functions, which recompute totals server-side and
// never trust a browser-supplied total for anything customer-facing.

import { supabase } from "@/lib/supabase";
import { getOrgId } from "@/lib/contacts-store";
import {
  calculateChangeOrderTotals,
  type CalcChangeOrderLineItem,
  type DiscountOrMarkupType,
} from "@/lib/change-order-calculations";
import {
  normalizeChangeOrderStatus,
  type ChangeOrderStatus,
  type ChangeOrderItemType,
} from "@/lib/change-order-status";

// ── Types ────────────────────────────────────────────────────────────────

export type ChangeOrderLineItem = {
  id: string;
  orgId: string;
  projectId: string;
  changeOrderId: string;
  position: number;
  itemType: ChangeOrderItemType;
  name: string;
  description: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  lineSubtotal: number;
  taxable: boolean;
  internalCost: number | null;
  internalMarkup: number | null;
  phaseId: string | null;
  taskId: string | null;
  sourceEstimateItemId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChangeOrder = {
  id: string;
  orgId: string;
  projectId: string;
  changeOrderNumber: string;
  title: string;
  description: string | null;
  reason: string | null;
  internalNotes: string | null;
  customerMessage: string | null;
  status: ChangeOrderStatus;
  currency: string;
  subtotal: number;
  discountType: DiscountOrMarkupType | null;
  discountValue: number | null;
  discountAmount: number;
  taxRate: number;
  taxAmount: number;
  markupType: DiscountOrMarkupType | null;
  markupValue: number | null;
  markupAmount: number;
  totalAmount: number;
  scheduleImpactDays: number;
  proposedStartDate: string | null;
  proposedCompletionDate: string | null;
  approvalDueAt: string | null;
  sentAt: string | null;
  firstViewedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  supersededAt: string | null;
  approvedByName: string | null;
  approvedByEmail: string | null;
  rejectedByName: string | null;
  rejectedByEmail: string | null;
  approvalSource: string | null;
  rejectionReason: string | null;
  isCustomerVisible: boolean;
  isFieldVisible: boolean;
  source: string;
  version: number;
  parentChangeOrderId: string | null;
  scheduleImpactAppliedAt: string | null;
  scheduleImpactAppliedBy: string | null;
  scheduleImpactApplication: Record<string, unknown> | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChangeOrderApproval = {
  id: string;
  changeOrderId: string;
  version: number;
  action: string;
  actorType: string;
  actorName: string | null;
  actorEmail: string | null;
  source: string;
  rejectionReason: string | null;
  acknowledgmentText: string | null;
  createdAt: string;
};

// ── Row mappers ──────────────────────────────────────────────────────────

function mapChangeOrderRow(row: Record<string, any>): ChangeOrder {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    changeOrderNumber: row.change_order_number,
    title: row.title,
    description: row.description,
    reason: row.reason,
    internalNotes: row.internal_notes,
    customerMessage: row.customer_message,
    status: normalizeChangeOrderStatus(row.status),
    currency: row.currency ?? "USD",
    subtotal: Number(row.subtotal ?? 0),
    discountType: row.discount_type,
    discountValue: row.discount_value === null || row.discount_value === undefined ? null : Number(row.discount_value),
    discountAmount: Number(row.discount_amount ?? 0),
    taxRate: Number(row.tax_rate ?? 0),
    taxAmount: Number(row.tax_amount ?? 0),
    markupType: row.markup_type,
    markupValue: row.markup_value === null || row.markup_value === undefined ? null : Number(row.markup_value),
    markupAmount: Number(row.markup_amount ?? 0),
    totalAmount: Number(row.total_amount ?? 0),
    scheduleImpactDays: Number(row.schedule_impact_days ?? 0),
    proposedStartDate: row.proposed_start_date,
    proposedCompletionDate: row.proposed_completion_date,
    approvalDueAt: row.approval_due_at,
    sentAt: row.sent_at,
    firstViewedAt: row.first_viewed_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    cancelledAt: row.cancelled_at,
    expiredAt: row.expired_at,
    supersededAt: row.superseded_at,
    approvedByName: row.approved_by_name,
    approvedByEmail: row.approved_by_email,
    rejectedByName: row.rejected_by_name,
    rejectedByEmail: row.rejected_by_email,
    approvalSource: row.approval_source,
    rejectionReason: row.rejection_reason,
    isCustomerVisible: !!row.is_customer_visible,
    isFieldVisible: !!row.is_field_visible,
    source: row.source ?? "connect",
    version: Number(row.version ?? 1),
    parentChangeOrderId: row.parent_change_order_id,
    scheduleImpactAppliedAt: row.schedule_impact_applied_at,
    scheduleImpactAppliedBy: row.schedule_impact_applied_by,
    scheduleImpactApplication: row.schedule_impact_application,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapItemRow(row: Record<string, any>): ChangeOrderLineItem {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    changeOrderId: row.change_order_id,
    position: Number(row.position ?? 0),
    itemType: row.item_type ?? "service",
    name: row.name,
    description: row.description,
    quantity: Number(row.quantity ?? 0),
    unit: row.unit,
    unitPrice: Number(row.unit_price ?? 0),
    lineSubtotal: Number(row.line_subtotal ?? 0),
    taxable: row.taxable !== false,
    internalCost: row.internal_cost === null || row.internal_cost === undefined ? null : Number(row.internal_cost),
    internalMarkup: row.internal_markup === null || row.internal_markup === undefined ? null : Number(row.internal_markup),
    phaseId: row.phase_id,
    taskId: row.task_id,
    sourceEstimateItemId: row.source_estimate_item_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApprovalRow(row: Record<string, any>): ChangeOrderApproval {
  return {
    id: row.id,
    changeOrderId: row.change_order_id,
    version: Number(row.version ?? 1),
    action: row.action,
    actorType: row.actor_type,
    actorName: row.actor_name,
    actorEmail: row.actor_email,
    source: row.source,
    rejectionReason: row.rejection_reason,
    acknowledgmentText: row.acknowledgment_text,
    createdAt: row.created_at,
  };
}

// ── Fetch ────────────────────────────────────────────────────────────────

export async function fetchProjectChangeOrders(projectId: string): Promise<ChangeOrder[]> {
  const { data, error } = await supabase
    .from("project_change_orders")
    .select("*")
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapChangeOrderRow);
}

export async function fetchChangeOrderItems(changeOrderId: string): Promise<ChangeOrderLineItem[]> {
  const { data, error } = await supabase
    .from("project_change_order_items")
    .select("*")
    .eq("change_order_id", changeOrderId)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapItemRow);
}

export async function fetchChangeOrderApprovals(changeOrderId: string): Promise<ChangeOrderApproval[]> {
  const { data, error } = await supabase
    .from("project_change_order_approvals")
    .select("*")
    .eq("change_order_id", changeOrderId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapApprovalRow);
}

// ── Totals ───────────────────────────────────────────────────────────────

export function toCalcLineItems(items: Pick<ChangeOrderLineItem, "quantity" | "unitPrice" | "taxable">[]): CalcChangeOrderLineItem[] {
  return items.map((i) => ({ quantity: i.quantity, unitPrice: i.unitPrice, taxable: i.taxable }));
}

export type ChangeOrderTotalsInput = {
  items: Pick<ChangeOrderLineItem, "quantity" | "unitPrice" | "taxable">[];
  discountType: DiscountOrMarkupType | null;
  discountValue: number | null;
  markupType: DiscountOrMarkupType | null;
  markupValue: number | null;
  taxRate: number;
};

export function computeChangeOrderTotals(input: ChangeOrderTotalsInput) {
  return calculateChangeOrderTotals({
    items: toCalcLineItems(input.items),
    discountType: input.discountType,
    discountValue: input.discountValue,
    markupType: input.markupType,
    markupValue: input.markupValue,
    taxRate: input.taxRate,
  });
}

// ── Create / Update draft ───────────────────────────────────────────────

export type CreateChangeOrderInput = {
  projectId: string;
  title: string;
  description?: string | null;
  reason?: string | null;
};

export async function createChangeOrderDraft(input: CreateChangeOrderInput): Promise<ChangeOrder> {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("No organization found for current user");
  const { data: { user } } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from("project_change_orders")
    .insert({
      org_id: orgId,
      project_id: input.projectId,
      title: input.title,
      description: input.description ?? null,
      reason: input.reason ?? null,
      status: "draft",
      created_by: user?.id ?? null,
      updated_by: user?.id ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return mapChangeOrderRow(data);
}

export type UpdateChangeOrderInput = Partial<{
  title: string;
  description: string | null;
  reason: string | null;
  internalNotes: string | null;
  customerMessage: string | null;
  currency: string;
  discountType: DiscountOrMarkupType | null;
  discountValue: number | null;
  markupType: DiscountOrMarkupType | null;
  markupValue: number | null;
  taxRate: number;
  scheduleImpactDays: number;
  proposedStartDate: string | null;
  proposedCompletionDate: string | null;
  approvalDueAt: string | null;
  isFieldVisible: boolean;
}>;

/** Recomputes and persists subtotal/discount/markup/tax/total from the Change Order's current items -- never trusts a browser-supplied total. */
export async function updateChangeOrder(id: string, patch: UpdateChangeOrderInput): Promise<ChangeOrder> {
  const items = await fetchChangeOrderItems(id);
  const { data: { user } } = await supabase.auth.getUser();

  const { data: current } = await supabase.from("project_change_orders").select("discount_type,discount_value,markup_type,markup_value,tax_rate").eq("id", id).single();

  const totals = computeChangeOrderTotals({
    items,
    discountType: patch.discountType !== undefined ? patch.discountType : (current?.discount_type ?? null),
    discountValue: patch.discountValue !== undefined ? patch.discountValue : (current?.discount_value ?? null),
    markupType: patch.markupType !== undefined ? patch.markupType : (current?.markup_type ?? null),
    markupValue: patch.markupValue !== undefined ? patch.markupValue : (current?.markup_value ?? null),
    taxRate: patch.taxRate !== undefined ? patch.taxRate : (current?.tax_rate ?? 0),
  });

  const updatePayload: Record<string, unknown> = {
    updated_by: user?.id ?? null,
    subtotal: totals.subtotal,
    discount_amount: totals.discountAmount,
    markup_amount: totals.markupAmount,
    tax_amount: totals.taxAmount,
    total_amount: totals.total,
  };
  if (patch.title !== undefined) updatePayload.title = patch.title;
  if (patch.description !== undefined) updatePayload.description = patch.description;
  if (patch.reason !== undefined) updatePayload.reason = patch.reason;
  if (patch.internalNotes !== undefined) updatePayload.internal_notes = patch.internalNotes;
  if (patch.customerMessage !== undefined) updatePayload.customer_message = patch.customerMessage;
  if (patch.currency !== undefined) updatePayload.currency = patch.currency;
  if (patch.discountType !== undefined) updatePayload.discount_type = patch.discountType;
  if (patch.discountValue !== undefined) updatePayload.discount_value = patch.discountValue;
  if (patch.markupType !== undefined) updatePayload.markup_type = patch.markupType;
  if (patch.markupValue !== undefined) updatePayload.markup_value = patch.markupValue;
  if (patch.taxRate !== undefined) updatePayload.tax_rate = patch.taxRate;
  if (patch.scheduleImpactDays !== undefined) updatePayload.schedule_impact_days = patch.scheduleImpactDays;
  if (patch.proposedStartDate !== undefined) updatePayload.proposed_start_date = patch.proposedStartDate;
  if (patch.proposedCompletionDate !== undefined) updatePayload.proposed_completion_date = patch.proposedCompletionDate;
  if (patch.approvalDueAt !== undefined) updatePayload.approval_due_at = patch.approvalDueAt;
  if (patch.isFieldVisible !== undefined) updatePayload.is_field_visible = patch.isFieldVisible;

  const { data, error } = await supabase
    .from("project_change_orders")
    .update(updatePayload)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return mapChangeOrderRow(data);
}

/** Only draft Change Orders can be deleted (enforced by RLS delete policy too). */
export async function deleteChangeOrderDraft(id: string): Promise<void> {
  const { error } = await supabase.from("project_change_orders").delete().eq("id", id);
  if (error) throw error;
}

export async function markChangeOrderReady(id: string): Promise<ChangeOrder> {
  const { data, error } = await supabase
    .from("project_change_orders")
    .update({ status: "ready_to_send" })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return mapChangeOrderRow(data);
}

export async function returnChangeOrderToDraft(id: string): Promise<ChangeOrder> {
  const { data, error } = await supabase
    .from("project_change_orders")
    .update({ status: "draft" })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return mapChangeOrderRow(data);
}

/**
 * Security audit (round 3): cancellation of a sent/viewed Change Order is
 * no longer a plain client-side UPDATE -- project_change_orders_update
 * RLS now only permits ordinary writes while status is still draft/
 * internal_review/ready_to_send. This calls the change-order-cancel
 * Netlify function, which checks the change_orders "cancel" permission
 * and then invokes cancel_project_change_order() (service_role-only) with
 * the caller's independently-verified org_id/actor_user_id.
 */
export async function cancelChangeOrder(id: string): Promise<ChangeOrder> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("You must be signed in to cancel a Change Order");

  const res = await fetch("/.netlify/functions/change-order-cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ changeOrderId: id }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || "Could not cancel this Change Order");

  const { data, error } = await supabase.from("project_change_orders").select("*").eq("id", id).single();
  if (error) throw error;
  return mapChangeOrderRow(data);
}

// ── Line items ───────────────────────────────────────────────────────────

export type UpsertLineItemInput = {
  id?: string;
  changeOrderId: string;
  projectId: string;
  position: number;
  itemType: ChangeOrderItemType;
  name: string;
  description?: string | null;
  quantity: number;
  unit?: string | null;
  unitPrice: number;
  taxable: boolean;
  internalCost?: number | null;
  internalMarkup?: number | null;
  phaseId?: string | null;
  taskId?: string | null;
};

export async function upsertChangeOrderItem(input: UpsertLineItemInput): Promise<ChangeOrderLineItem> {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("No organization found for current user");
  const lineSubtotal = (input.quantity || 0) * (input.unitPrice || 0);

  const payload = {
    org_id: orgId,
    project_id: input.projectId,
    change_order_id: input.changeOrderId,
    position: input.position,
    item_type: input.itemType,
    name: input.name,
    description: input.description ?? null,
    quantity: input.quantity,
    unit: input.unit ?? null,
    unit_price: input.unitPrice,
    line_subtotal: Math.round(lineSubtotal * 100) / 100,
    taxable: input.taxable,
    internal_cost: input.internalCost ?? null,
    internal_markup: input.internalMarkup ?? null,
    phase_id: input.phaseId ?? null,
    task_id: input.taskId ?? null,
  };

  if (input.id) {
    const { data, error } = await supabase
      .from("project_change_order_items")
      .update(payload)
      .eq("id", input.id)
      .select("*")
      .single();
    if (error) throw error;
    return mapItemRow(data);
  }

  const { data, error } = await supabase
    .from("project_change_order_items")
    .insert(payload)
    .select("*")
    .single();
  if (error) throw error;
  return mapItemRow(data);
}

export async function deleteChangeOrderItem(id: string): Promise<void> {
  const { error } = await supabase.from("project_change_order_items").delete().eq("id", id);
  if (error) throw error;
}

export async function reorderChangeOrderItems(items: { id: string; position: number }[]): Promise<void> {
  await Promise.all(
    items.map((i) => supabase.from("project_change_order_items").update({ position: i.position }).eq("id", i.id)),
  );
}

// ── Revisions ────────────────────────────────────────────────────────────

/**
 * Creates a new draft revision from an existing Change Order.
 *
 * Security audit (round 4): this no longer performs the INSERT directly
 * from the browser (a raw client-side insert would have to be trusted for
 * change_order_number/version/parent linkage). It calls the
 * change-order-create-revision Netlify function, which checks the
 * change_orders "create" permission and then invokes
 * create_project_change_order_revision() (service_role-only) -- that RPC
 * derives version = parent.version + 1 and inherits the parent's
 * change_order_number from the real, advisory-lock-guarded parent row,
 * copies line items server-side, and never copies tokens, approval
 * records, or financial adjustments. Does NOT mark the source superseded
 * -- that only happens when the new revision is actually sent (see
 * change-order-send.ts / send_project_change_order()).
 */
export async function createChangeOrderRevision(sourceId: string): Promise<ChangeOrder> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("You must be signed in to create a revision");

  const res = await fetch("/.netlify/functions/change-order-create-revision", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ changeOrderId: sourceId }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || "Could not create a revision of this Change Order");

  const newId = body?.result?.id;
  if (!newId) throw new Error("The revision was created but its id was not returned");

  const { data, error } = await supabase.from("project_change_orders").select("*").eq("id", newId).single();
  if (error) throw error;
  return mapChangeOrderRow(data);
}

// ── Financial summary (Part 12/13 -- Original / Approved / Revised / Pending) ──

export type ProjectChangeOrderFinancialSummary = {
  originalContractValue: number;
  approvedChangeOrdersTotal: number;
  revisedContractValue: number;
  pendingChangeOrdersTotal: number;
  approvedCount: number;
  pendingCount: number;
  draftCount: number;
};

// Pending means actually awaiting a customer decision -- only sent/viewed.
// ready_to_send is still internal (never delivered to the customer), so
// it must not be counted as pending customer approval.
const PENDING_STATUSES: ChangeOrderStatus[] = ["sent", "viewed"];

/**
 * Security audit (round 4), Parts 5-7: "Approved Change Orders" is no
 * longer derived from summing `co.totalAmount` for every row whose own
 * `status === 'approved'` -- that double-counted a lineage when an
 * earlier version had been approved and later superseded by an approved
 * revision (e.g. CO-003 v1 +$5,000 approved, then v2 +$6,000 approved --
 * summing both rows' totals would report +$11,000). The database ledger
 * (project_financial_adjustments) is the single source of truth: approve_
 * project_change_order() reverses a lineage's earlier active adjustment
 * in the same transaction it applies a new one, so summing every
 * `status = 'applied' and reversed_at is null` row for this Project
 * always yields the correct, non-double-counted total -- exactly one
 * effective adjustment per lineage at a time.
 */
export async function fetchProjectChangeOrderFinancialSummary(
  projectId: string,
  originalContractValue: number,
): Promise<ProjectChangeOrderFinancialSummary> {
  const [changeOrders, adjustmentsResult] = await Promise.all([
    fetchProjectChangeOrders(projectId),
    supabase
      .from("project_financial_adjustments")
      .select("amount")
      .eq("project_id", projectId)
      .eq("source_type", "change_order")
      .eq("status", "applied")
      .is("reversed_at", null),
  ]);
  if (adjustmentsResult.error) throw adjustmentsResult.error;

  const pending = changeOrders.filter((co) => PENDING_STATUSES.includes(co.status));
  const drafts = changeOrders.filter((co) => co.status === "draft" || co.status === "internal_review");
  const approvedCount = changeOrders.filter((co) => co.status === "approved").length;

  const approvedChangeOrdersTotal = Math.round(
    (adjustmentsResult.data ?? []).reduce((sum, a) => sum + Number(a.amount), 0) * 100,
  ) / 100;
  const pendingChangeOrdersTotal = Math.round(pending.reduce((sum, co) => sum + co.totalAmount, 0) * 100) / 100;
  const revisedContractValue = Math.round((originalContractValue + approvedChangeOrdersTotal) * 100) / 100;

  return {
    originalContractValue,
    approvedChangeOrdersTotal,
    revisedContractValue,
    pendingChangeOrdersTotal,
    approvedCount,
    pendingCount: pending.length,
    draftCount: drafts.length,
  };
}

/**
 * Org-wide (RLS-scoped) approved Change Order totals, one row per Project
 * that has at least one active adjustment -- a single query so a Project
 * list/board view can show each card's Revised Contract Value without an
 * N+1 fetch per card. Same ledger source of truth as
 * fetchProjectChangeOrderFinancialSummary(): project_financial_adjustments
 * where source_type='change_order', status='applied', reversed_at is null.
 */
export async function fetchApprovedChangeOrderTotalsByProject(): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from("project_financial_adjustments")
    .select("project_id, amount")
    .eq("source_type", "change_order")
    .eq("status", "applied")
    .is("reversed_at", null);
  if (error) throw error;

  const totals = new Map<string, number>();
  for (const row of data ?? []) {
    const prev = totals.get(row.project_id) ?? 0;
    totals.set(row.project_id, Math.round((prev + Number(row.amount)) * 100) / 100);
  }
  return totals;
}

// ── Lineage effectiveness (Contract/Estimate integration follow-up) ────────
//
// A Change Order "lineage" is every row sharing the same (project_id,
// change_order_number) -- v1, v2, v3, ... A lineage's LATEST DOCUMENT
// (highest version) and its FINANCIALLY EFFECTIVE version (the one with
// the still-active project_financial_adjustments row) are two different
// concepts that can diverge: sending a revision immediately supersedes
// the prior document, but that prior version's approved financial
// adjustment is only reversed when the REPLACEMENT is actually approved
// (see send_project_change_order()/approve_project_change_order() in
// 20260815_project_change_orders.sql -- ledger semantics themselves are
// unchanged here, this is read-only). If the latest revision is rejected/
// cancelled/expired instead, an earlier version can remain both
// "Superseded" (document-wise) and the currently effective contract
// amount at the same time -- this helper makes that queryable so the UI
// can say so plainly instead of leaving "Superseded" to imply "no longer
// matters."

export type EffectiveChangeOrderLineage = {
  changeOrderId: string;
  changeOrderNumber: string;
  version: number;
  amount: number;
};

/**
 * One entry per lineage (keyed by change_order_number) that currently has
 * an active (status='applied', reversed_at is null) financial adjustment
 * -- i.e. the version whose approved amount is presently included in
 * Revised Contract Value. A lineage with no approved version yet (or
 * whose only approved version has since been reversed with nothing new
 * approved) simply has no entry.
 */
export async function fetchEffectiveChangeOrderLineages(projectId: string): Promise<Map<string, EffectiveChangeOrderLineage>> {
  const [changeOrders, adjustmentsResult] = await Promise.all([
    fetchProjectChangeOrders(projectId),
    supabase
      .from("project_financial_adjustments")
      .select("source_id, amount")
      .eq("project_id", projectId)
      .eq("source_type", "change_order")
      .eq("status", "applied")
      .is("reversed_at", null),
  ]);
  if (adjustmentsResult.error) throw adjustmentsResult.error;

  const byId = new Map(changeOrders.map((co) => [co.id, co]));
  const result = new Map<string, EffectiveChangeOrderLineage>();
  for (const row of adjustmentsResult.data ?? []) {
    const co = byId.get(row.source_id);
    if (!co) continue;
    result.set(co.changeOrderNumber, { changeOrderId: co.id, changeOrderNumber: co.changeOrderNumber, version: co.version, amount: Number(row.amount) });
  }
  return result;
}

/** The highest version present for each Change Order lineage in a Project -- "the latest document," independent of financial effectiveness. */
export function latestVersionByLineage(changeOrders: Pick<ChangeOrder, "changeOrderNumber" | "version">[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const co of changeOrders) map.set(co.changeOrderNumber, Math.max(map.get(co.changeOrderNumber) ?? 0, co.version));
  return map;
}

// ── Schedule impact application (Part 14) ───────────────────────────────

/**
 * Explicit, user-confirmed application of an approved Change Order's
 * schedule impact to the Project's target completion date. Never runs
 * automatically on approval.
 *
 * Security audit (post-13.3B): this no longer writes directly from the
 * browser. It calls the change-order-apply-schedule-impact Netlify
 * function, which checks the caller's change_orders "edit" permission and
 * then invokes apply_project_change_order_schedule_impact() (a SECURITY
 * DEFINER RPC, called with the user's own access token so it can resolve
 * auth.uid()) -- that RPC is what actually enforces org membership,
 * requires status='approved', requires schedule_impact_applied_at is
 * still null, and locks both rows, so a second call (even a raced
 * concurrent one) can never apply it twice.
 */
export async function applyChangeOrderScheduleImpact(id: string, newCompletionDate: string): Promise<ChangeOrder> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("You must be signed in to apply schedule impact");

  const res = await fetch("/.netlify/functions/change-order-apply-schedule-impact", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ changeOrderId: id, newCompletionDate }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || "Could not apply schedule impact");

  const { data, error } = await supabase.from("project_change_orders").select("*").eq("id", id).single();
  if (error) throw error;
  return mapChangeOrderRow(data);
}

// ── Expiration (Part 11) ─────────────────────────────────────────────────

/**
 * Derived-only expiration display: a Change Order past its approval
 * deadline while still sent/viewed is shown as overdue without any
 * database write (no cron, no status mutation from the browser). The
 * approve/reject RPCs independently re-check approval_due_at server-side,
 * so even if this derived check were somehow bypassed in the UI, no
 * approval can succeed past the deadline without a new send/version.
 */
export function isChangeOrderOverdue(co: Pick<ChangeOrder, "status" | "approvalDueAt">): boolean {
  if (co.status !== "sent" && co.status !== "viewed") return false;
  if (!co.approvalDueAt) return false;
  return new Date(co.approvalDueAt).getTime() < Date.now();
}

// ── Field/Portal-safe projections (Parts 31/32) ─────────────────────────

export type FieldChangeOrder = {
  id: string;
  title: string;
  scope: string | null;
  status: ChangeOrderStatus;
  scheduleImpactDays: number;
  proposedCompletionDate: string | null;
  approvedAt: string | null;
};

/** Field must never receive pricing, margins, negotiation notes, or the approval token -- only approved, field-visible operational facts. */
export function toFieldChangeOrder(co: ChangeOrder): FieldChangeOrder | null {
  if (!co.isFieldVisible || co.status !== "approved") return null;
  return {
    id: co.id,
    title: co.title,
    scope: co.description,
    status: co.status,
    scheduleImpactDays: co.scheduleImpactDays,
    proposedCompletionDate: co.proposedCompletionDate,
    approvedAt: co.approvedAt,
  };
}

export type PortalChangeOrderLineItem = {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  lineTotal: number;
};

export type PortalChangeOrder = {
  number: string;
  version: number;
  title: string;
  scope: string | null;
  customerMessage: string | null;
  status: ChangeOrderStatus;
  currency: string;
  items: PortalChangeOrderLineItem[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
  scheduleImpactDays: number;
  proposedStartDate: string | null;
  proposedCompletionDate: string | null;
  approvalDueAt: string | null;
};

/** Portal-safe projection -- excludes internal notes, internal costs/markup, org IDs, and any token/system-activity internals. Used by the customer-facing preview inside Connect today, and will be the same shape the future Portal renders. */
export function toPortalChangeOrder(co: ChangeOrder, items: ChangeOrderLineItem[]): PortalChangeOrder {
  return {
    number: co.changeOrderNumber,
    version: co.version,
    title: co.title,
    scope: co.description,
    customerMessage: co.customerMessage,
    status: co.status,
    currency: co.currency,
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unitPrice,
      lineTotal: item.lineSubtotal,
    })),
    subtotal: co.subtotal,
    discountAmount: co.discountAmount,
    taxAmount: co.taxAmount,
    totalAmount: co.totalAmount,
    scheduleImpactDays: co.scheduleImpactDays,
    proposedStartDate: co.proposedStartDate,
    proposedCompletionDate: co.proposedCompletionDate,
    approvalDueAt: co.approvalDueAt,
  };
}
