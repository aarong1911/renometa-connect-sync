/// <reference types="node" />
// netlify/functions/proposal-action.ts
//
// Phase 10.4 — the only write path for anonymous customer actions on a
// proposal (select an optional item, approve, reject, request changes).
// Mirrors portal-action.ts's token+action+payload shape. Every action:
//   - re-validates the token server-side (never trusts a client-supplied
//     estimate id)
//   - only proceeds while the estimate is in a customer-actionable status
//     (isCustomerActionable() — the same canonical rule the internal app
//     uses, imported directly rather than re-implemented)
//   - for approve: recalculates totals from the CURRENT estimate_items
//     server-side (never trusts a browser-supplied total) and writes an
//     immutable approval snapshot into the activity row's metadata
//   - is idempotent for approve/reject (a second call on an
//     already-terminal status is rejected, not silently re-applied)
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { isCustomerActionable } from "../../src/lib/estimate-status";
import { calculateEstimate, type CalcLineItem } from "../../src/lib/estimate-calculations";
import { syncEstimateDeal, logDealSyncWarning, type DealSyncTrigger } from "../lib/estimate-deal-sync";

/** Advisory, non-blocking Deal sync — a customer's approve/reject/request-changes action must always succeed even when Deal sync has trouble. */
async function syncDealNonBlocking(estimateId: string, orgId: string, trigger: DealSyncTrigger) {
  try {
    const result = await syncEstimateDeal(supabaseAdmin, { estimateId, orgId, trigger });
    if (!result.ok) logDealSyncWarning(`${trigger} -> deal sync failed (non-blocking)`, { estimateId, orgId, error: result.error });
  } catch (err) {
    logDealSyncWarning(`${trigger} -> deal sync threw (non-blocking)`, { estimateId, orgId, error: String(err) });
  }
}

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function loadEstimate(token: string) {
  if (!token || token.length < 32) return null;
  const { data } = await supabaseAdmin
    .from("estimates")
    .select("id, org_id, status, version_number, deposit_type, deposit_value, discount_type, discount_value, tax_rate")
    .eq("public_token", token)
    .maybeSingle();
  return data;
}

async function logActivity(orgId: string, estimateId: string, versionNumber: number, activityType: string, title: string, description?: string, metadata?: Record<string, unknown>) {
  await supabaseAdmin.from("estimate_activities").insert({
    org_id: orgId, estimate_id: estimateId, version_number: versionNumber,
    activity_type: activityType, actor_type: "customer", title, description: description ?? null,
    metadata: metadata ?? {},
  });
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: HEADERS, body: "Method Not Allowed" };

  let reqBody: { token?: string; action?: string; payload?: any };
  try { reqBody = JSON.parse(event.body ?? "{}"); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { token, action, payload } = reqBody;
  if (!token || !action) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "token and action required" }) };

  const estimate = await loadEstimate(token);
  if (!estimate) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: "Proposal not found" }) };

  // ── select_optional — toggle one optional item's customer selection ──
  if (action === "select_optional") {
    if (!isCustomerActionable(estimate.status)) {
      return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: "This proposal can no longer be changed." }) };
    }
    const { itemId, selected } = payload ?? {};
    if (!itemId || typeof selected !== "boolean") {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "itemId and selected required" }) };
    }
    const { data: item, error: itemErr } = await supabaseAdmin
      .from("estimate_items").select("id, optional").eq("id", itemId).eq("estimate_id", estimate.id).maybeSingle();
    if (itemErr || !item || !item.optional) {
      return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: "Optional item not found" }) };
    }
    await supabaseAdmin.from("estimate_items").update({ selected_by_customer: selected }).eq("id", itemId);

    const totals = await recalcAndPersist(estimate.id, estimate.org_id, estimate);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, totals }) };
  }

  // ── approve ────────────────────────────────────────────────────────────
  if (action === "approve") {
    if (!isCustomerActionable(estimate.status)) {
      return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: "This proposal has already been responded to." }) };
    }
    const { customerName, customerEmail, acceptedTerms, signature } = payload ?? {};
    if (!customerName?.trim() || !customerEmail?.trim() || !acceptedTerms || !signature?.trim()) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Name, email, accepted terms, and signature are required." }) };
    }
    if (!/^\S+@\S+\.\S+$/.test(customerEmail.trim())) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Enter a valid email address." }) };
    }

    // Totals are ALWAYS recomputed server-side from the current
    // estimate_items here — the approval snapshot never trusts a
    // browser-supplied total.
    const totals = await recalcAndPersist(estimate.id, estimate.org_id, estimate);

    const now = new Date().toISOString();
    const { error: updateErr } = await supabaseAdmin
      .from("estimates")
      .update({ status: "approved", approved_at: now })
      .eq("id", estimate.id)
      .eq("status", estimate.status); // optimistic guard — fails silently-safe if another request already moved it
    if (updateErr) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: "Could not record approval." }) };

    await logActivity(estimate.org_id, estimate.id, estimate.version_number, "approved", "Proposal approved",
      `Approved by ${customerName.trim()}`, {
        customerName: customerName.trim(), customerEmail: customerEmail.trim(),
        signature: signature.trim(), acceptedTotal: totals.total, acceptedDeposit: totals.depositAmount,
        versionApproved: estimate.version_number, approvedAt: now,
      });

    // Fire-and-forget workflow trigger — mirrors vapi-webhook.ts's internal execute-workflow call.
    fetch(`${process.env.URL ?? "http://localhost:8888"}/.netlify/functions/execute-workflow`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId: estimate.org_id, triggerType: "estimate_approved", triggerData: { estimateId: estimate.id, total: totals.total, customerName: customerName.trim() } }),
    }).catch(() => {});

    await syncDealNonBlocking(estimate.id, estimate.org_id, "approved");

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, status: "approved", total: totals.total }) };
  }

  // ── reject ─────────────────────────────────────────────────────────────
  if (action === "reject") {
    if (!isCustomerActionable(estimate.status)) {
      return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: "This proposal has already been responded to." }) };
    }
    const { reason } = payload ?? {};
    const now = new Date().toISOString();
    const { error: updateErr } = await supabaseAdmin
      .from("estimates")
      .update({ status: "rejected", rejected_at: now })
      .eq("id", estimate.id)
      .eq("status", estimate.status);
    if (updateErr) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: "Could not record response." }) };

    await logActivity(estimate.org_id, estimate.id, estimate.version_number, "rejected", "Proposal rejected",
      reason?.trim() ? String(reason).trim().slice(0, 1000) : undefined, { reason: reason?.trim()?.slice(0, 1000) ?? null });

    await syncDealNonBlocking(estimate.id, estimate.org_id, "rejected");

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, status: "rejected" }) };
  }

  // ── request_changes ───────────────────────────────────────────────────
  if (action === "request_changes") {
    if (!isCustomerActionable(estimate.status)) {
      return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: "This proposal can no longer accept a change request." }) };
    }
    const { message, category } = payload ?? {};
    if (!message?.trim()) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "A message is required." }) };
    const VALID_CATEGORIES = ["scope", "price", "timeline", "materials", "terms", "other"];
    const safeCategory = VALID_CATEGORIES.includes(category) ? category : "other";

    const now = new Date().toISOString();
    const { error: updateErr } = await supabaseAdmin
      .from("estimates")
      .update({ status: "changes_requested", changes_requested_at: now })
      .eq("id", estimate.id)
      .eq("status", estimate.status);
    if (updateErr) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: "Could not record the request." }) };

    await logActivity(estimate.org_id, estimate.id, estimate.version_number, "changes_requested", "Changes requested",
      String(message).trim().slice(0, 2000), { category: safeCategory, message: String(message).trim().slice(0, 2000) });

    await syncDealNonBlocking(estimate.id, estimate.org_id, "changes_requested");

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, status: "changes_requested" }) };
  }

  return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
};

/** Recomputes and persists subtotal/discount/tax/total/deposit from the estimate's CURRENT line items — the one place proposal-action.ts trusts a total, and it's never the browser. */
async function recalcAndPersist(estimateId: string, orgId: string, estimate: { deposit_type: string | null; deposit_value: number | null; discount_type: string | null; discount_value: number | null; tax_rate: number | null }) {
  const { data: items } = await supabaseAdmin
    .from("estimate_items")
    .select("quantity, unit_price, taxable, optional, selected_by_customer, is_heading, discount_type, discount_value")
    .eq("estimate_id", estimateId);

  const calcItems: CalcLineItem[] = (items ?? []).map((i: any) => ({
    quantity: Number(i.quantity ?? 0), unitPrice: Number(i.unit_price ?? 0),
    taxable: i.taxable !== false, optional: !!i.optional, selectedByCustomer: i.selected_by_customer !== false,
    isHeading: !!i.is_heading, discountType: i.discount_type, discountValue: i.discount_value ? Number(i.discount_value) : null,
  }));

  const totals = calculateEstimate({
    items: calcItems,
    discountType: estimate.discount_type as "percent" | "fixed" | null,
    discountValue: estimate.discount_value,
    taxRate: estimate.tax_rate,
    depositType: estimate.deposit_type as "percent" | "fixed" | null,
    depositValue: estimate.deposit_value,
  });

  await supabaseAdmin.from("estimates").update({
    subtotal: totals.subtotal, discount_total: totals.discountTotal, tax_total: totals.taxTotal,
    // total + client_total together — see the matching comment in
    // estimates.tsx's save(): trg_sync_total's sync_total_to_client_total()
    // trigger forces total := client_total on every write, so client_total
    // must always be sent to avoid it silently zeroing/staling `total`.
    total: totals.total, client_total: totals.total,
    deposit_amount: totals.depositAmount, balance_due: totals.balanceDue,
  }).eq("id", estimateId).eq("org_id", orgId);

  return totals;
}
