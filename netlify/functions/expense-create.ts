/// <reference types="node" />
// netlify/functions/expense-create.ts
//
// Phase 13.8 — trusted server-side "Add Expense" write path. A direct/
// cash-paid expense is already-incurred and already-paid (unlike a vendor
// bill), so it is recorded and (if accounting is initialized) posted in the
// same request — mirrors invoice-record-payment.ts's "operational insert
// always succeeds; accounting posting is best-effort/non-blocking" shape.
//
// account_id is never trusted from the browser without validation: it must
// belong to this org and be an expense-type account (the DB trigger
// validate_expense_dimensions() enforces this too, as defense-in-depth, but
// this function checks first so it can return a clear 400 instead of a raw
// Postgres trigger error).

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { postExpenseRecorded } from "../lib/accounting";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const VALID_METHODS = new Set(["cash", "check", "ach", "wire", "bank_transfer", "card", "other"]);

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const resolved = await resolveOrgFromBearerToken(admin, event.headers.authorization ?? event.headers.Authorization);
  if (!resolved) return json(401, { error: "Unauthorized" });
  const { userId, orgId } = resolved;

  let body: {
    vendorId?: string | null; projectId?: string | null; contactId?: string | null;
    expenseDate?: string; description?: string; amount?: number; paymentMethod?: string | null;
    accountId?: string; reference?: string; receiptUrl?: string; notes?: string;
  };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid request body" });
  }

  const description = body.description?.trim();
  const expenseDate = body.expenseDate;
  const accountId = body.accountId;
  const amount = Number(body.amount);
  const paymentMethod = body.paymentMethod?.trim() || null;

  if (!description) return json(400, { error: "Description is required" });
  if (!expenseDate) return json(400, { error: "Expense date is required" });
  if (!accountId) return json(400, { error: "Category (account) is required" });
  if (!Number.isFinite(amount) || amount <= 0) return json(400, { error: "Amount must be a positive number" });
  if (paymentMethod && !VALID_METHODS.has(paymentMethod)) return json(400, { error: "Invalid payment method" });
  // Phase 13.8B, Part 4 — this endpoint always inserts status: "posted"
  // below (a direct expense is already-incurred/already-paid, never a
  // draft), and a posted expense's payment_method determines which
  // asset/liability account gets credited (see resolvePaymentAccount() in
  // netlify/lib/accounting.ts). Reject up front with a clear message rather
  // than letting the DB's expenses_posted_requires_payment_method constraint
  // surface as a raw 500 — and never silently default to a fake method.
  if (!paymentMethod) return json(400, { error: "Payment method is required for a posted expense." });

  const { data: account, error: accountError } = await admin
    .from("accounting_accounts")
    .select("id, account_type, is_active")
    .eq("id", accountId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (accountError) return json(500, { error: "Could not verify the selected category." });
  if (!account) return json(404, { error: "Category account not found." });
  if (account.account_type !== "expense") return json(400, { error: "Selected category must be an expense/COGS account." });
  if (!account.is_active) return json(400, { error: "Selected category is inactive. Choose an active category." });

  if (body.vendorId) {
    const { data: vendor } = await admin.from("vendors").select("id, is_active").eq("id", body.vendorId).eq("org_id", orgId).maybeSingle();
    if (!vendor) return json(404, { error: "Vendor not found." });
    if (!vendor.is_active) return json(400, { error: "This vendor is inactive. Reactivate it or choose a different vendor." });
  }
  if (body.projectId) {
    const { data: project } = await admin.from("projects").select("id").eq("id", body.projectId).eq("org_id", orgId).maybeSingle();
    if (!project) return json(404, { error: "Project not found." });
  }

  const { data: expense, error: insertError } = await admin
    .from("expenses")
    .insert({
      org_id: orgId,
      vendor_id: body.vendorId || null,
      project_id: body.projectId || null,
      contact_id: body.contactId || null,
      expense_date: expenseDate,
      description,
      amount,
      payment_method: paymentMethod,
      account_id: accountId,
      status: "posted",
      reference: body.reference?.trim() || null,
      receipt_url: body.receiptUrl?.trim() || null,
      notes: body.notes?.trim() || null,
      created_by: userId,
    })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "42P01") {
      return json(501, { error: "Expense tracking hasn't been set up in this environment yet (pending migration 20260822_expenses_vendors_ap.sql)." });
    }
    console.error("[expense-create] insert failed:", insertError);
    return json(500, { error: insertError.message || "Could not record this expense." });
  }

  let accountingWarning: string | undefined;
  try {
    const { data: accountingSettings } = await admin
      .from("accounting_settings").select("status").eq("org_id", orgId).maybeSingle();
    if (accountingSettings?.status === "initialized") {
      await postExpenseRecorded(admin, orgId, {
        id: expense.id, amount, expenseDate, description, accountId,
        paymentMethod, projectId: body.projectId || null, contactId: body.contactId || null,
      }, userId);
    }
  } catch (accountingError) {
    console.error("[expense-create] accounting posting failed (non-blocking)", {
      expenseId: expense.id, orgId, error: accountingError instanceof Error ? accountingError.message : String(accountingError),
    });
    accountingWarning = "Expense recorded, but accounting posting failed and needs manual review.";
  }

  return json(200, { ok: true, expenseId: expense.id, accountingWarning });
};
