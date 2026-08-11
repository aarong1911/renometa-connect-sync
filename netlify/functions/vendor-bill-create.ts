/// <reference types="node" />
// netlify/functions/vendor-bill-create.ts
//
// Phase 13.8 — creates a DRAFT vendor bill + its lines. Never posts
// accounting (drafts have no journal entry — see vendor-bill-post.ts for
// that). Totals are always recomputed server-side from the submitted lines
// — the browser's subtotal/tax/total are never trusted (Part 8: "Bill total
// should be authoritative server-side from line items").

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type LineInput = { description?: string; quantity?: number; unitCost?: number; accountId?: string; projectId?: string | null };

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const resolved = await resolveOrgFromBearerToken(admin, event.headers.authorization ?? event.headers.Authorization);
  if (!resolved) return json(401, { error: "Unauthorized" });
  const { userId, orgId } = resolved;

  let body: {
    vendorId?: string; projectId?: string | null; billNumber?: string; billDate?: string; dueDate?: string | null;
    taxAmount?: number; reference?: string; notes?: string; lines?: LineInput[];
  };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid request body" });
  }

  if (!body.vendorId) return json(400, { error: "Vendor is required" });
  if (!body.billDate) return json(400, { error: "Bill date is required" });
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (lines.length === 0) return json(400, { error: "At least one line item is required" });

  const { data: vendor } = await admin.from("vendors").select("id, is_active").eq("id", body.vendorId).eq("org_id", orgId).maybeSingle();
  if (!vendor) return json(404, { error: "Vendor not found." });
  if (!vendor.is_active) return json(400, { error: "This vendor is inactive. Reactivate it or choose a different vendor." });

  if (body.projectId) {
    const { data: project } = await admin.from("projects").select("id").eq("id", body.projectId).eq("org_id", orgId).maybeSingle();
    if (!project) return json(404, { error: "Project not found." });
  }

  const accountIds = Array.from(new Set(lines.map((l) => l.accountId).filter((id): id is string => !!id)));
  if (accountIds.length !== lines.length) return json(400, { error: "Every line requires a category (account)." });

  const { data: accounts, error: accountsError } = await admin
    .from("accounting_accounts").select("id, account_type, is_active").eq("org_id", orgId).in("id", accountIds);
  if (accountsError) return json(500, { error: "Could not verify line categories." });
  const accountsById = new Map((accounts ?? []).map((a: any) => [a.id, { type: a.account_type, active: a.is_active }]));
  for (const l of lines) {
    const account = accountsById.get(l.accountId!);
    if (!account) return json(404, { error: `Category account not found for line "${l.description ?? ""}".` });
    if (account.type !== "expense") return json(400, { error: `Line "${l.description ?? ""}" must use an expense/COGS category.` });
    if (!account.active) return json(400, { error: `Line "${l.description ?? ""}" uses an inactive category. Choose an active category.` });
    const qty = Number(l.quantity ?? 1);
    const unitCost = Number(l.unitCost ?? 0);
    if (!l.description?.trim()) return json(400, { error: "Every line requires a description." });
    if (!Number.isFinite(qty) || qty <= 0) return json(400, { error: "Line quantity must be a positive number." });
    if (!Number.isFinite(unitCost) || unitCost < 0) return json(400, { error: "Line unit cost must be a non-negative number." });
  }

  const subtotal = round2(lines.reduce((s, l) => s + Number(l.quantity ?? 1) * Number(l.unitCost ?? 0), 0));
  const taxAmount = round2(Number(body.taxAmount ?? 0));
  if (!Number.isFinite(taxAmount) || taxAmount < 0) return json(400, { error: "Tax amount must be a non-negative number." });
  const totalAmount = round2(subtotal + taxAmount);
  if (totalAmount <= 0) return json(400, { error: "Bill total must be greater than zero." });

  const billNumber = body.billNumber?.trim() || null;
  if (billNumber) {
    // Case/whitespace-insensitive pre-check, matching the DB's
    // lower(btrim(bill_number)) unique index — compared in JS rather than
    // via `.ilike()` so an operator character in the bill number (%, _)
    // can't be misread as a SQL wildcard. This is a friendlier error
    // message only; the unique index is what's actually authoritative.
    const normalized = billNumber.toLowerCase();
    const { data: existing } = await admin
      .from("vendor_bills").select("bill_number").eq("org_id", orgId).eq("vendor_id", body.vendorId).not("bill_number", "is", null);
    if ((existing ?? []).some((b: any) => (b.bill_number ?? "").trim().toLowerCase() === normalized)) {
      return json(409, { error: `A bill with number "${billNumber}" already exists for this vendor.` });
    }
  }

  const { data: bill, error: billError } = await admin
    .from("vendor_bills")
    .insert({
      org_id: orgId,
      vendor_id: body.vendorId,
      project_id: body.projectId || null,
      bill_number: billNumber,
      bill_date: body.billDate,
      due_date: body.dueDate || null,
      subtotal,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      status: "draft",
      reference: body.reference?.trim() || null,
      notes: body.notes?.trim() || null,
      created_by: userId,
    })
    .select("id")
    .single();

  if (billError) {
    if (billError.code === "42P01") {
      return json(501, { error: "Vendor bills haven't been set up in this environment yet (pending migration 20260822_expenses_vendors_ap.sql)." });
    }
    console.error("[vendor-bill-create] bill insert failed:", billError);
    return json(500, { error: billError.message || "Could not create this bill." });
  }

  const { error: linesError } = await admin.from("vendor_bill_lines").insert(
    lines.map((l) => ({
      org_id: orgId,
      vendor_bill_id: bill.id,
      description: l.description!.trim(),
      quantity: Number(l.quantity ?? 1),
      unit_cost: Number(l.unitCost ?? 0),
      amount: round2(Number(l.quantity ?? 1) * Number(l.unitCost ?? 0)),
      account_id: l.accountId,
      project_id: l.projectId || body.projectId || null,
    })),
  );
  if (linesError) {
    console.error("[vendor-bill-create] lines insert failed, rolling back bill:", linesError);
    await admin.from("vendor_bills").delete().eq("id", bill.id);
    return json(500, { error: linesError.message || "Could not save bill line items." });
  }

  return json(200, { ok: true, billId: bill.id, subtotal, taxAmount, totalAmount });
};
