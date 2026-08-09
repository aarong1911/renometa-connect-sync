/// <reference types="node" />
// netlify/functions/invoice-record-payment.ts
//
// Phase 13.4 follow-up — trusted server-side "Record Payment" write path.
// invoice_payments (supabase/migrations/20260818_invoice_payments_ledger.sql)
// is the canonical ledger; invoices.amount_paid/status are a
// trigger-maintained cache the DB itself keeps in sync (sync_invoice_
// amount_paid()), so this function only ever INSERTs a payment row — it
// never writes invoices.amount_paid directly, and a browser can't either
// (no client write grant on invoice_payments; RLS is select-only).
//
// If the migration hasn't been applied yet in this environment, the insert
// fails with Postgres "relation does not exist" (42P01) — reported as a
// clear, actionable error rather than a raw 500.

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { postInvoicePaymentSucceeded } from "../lib/accounting";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const VALID_METHODS = new Set(["cash", "check", "card", "ach", "bank_transfer", "other"]);
const NON_PAYABLE_STATUSES = new Set(["draft", "void", "cancelled", "paid"]);

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

function money(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const token = event.headers.authorization?.slice(7) ?? event.headers.Authorization?.slice(7);
  if (!token) return json(401, { error: "Unauthorized" });

  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) return json(401, { error: "Invalid token" });

  let body: { invoiceId?: string; amount?: number; method?: string; paidAt?: string; reference?: string; notes?: string };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid request body" });
  }
  const { invoiceId, method = "other", paidAt, reference, notes } = body;
  const amount = Number(body.amount);

  if (!invoiceId) return json(400, { error: "invoiceId required" });
  if (!Number.isFinite(amount) || amount <= 0) return json(400, { error: "amount must be a positive number" });
  if (!VALID_METHODS.has(method)) return json(400, { error: "Invalid payment method" });

  const { data: profile, error: profileError } = await admin
    .from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (profileError) return json(500, { error: "Could not load your organization profile." });
  const orgId = profile?.organization_id;
  if (!orgId) return json(403, { error: "No organization was found for this user." });

  const { data: invoice, error: invoiceError } = await admin
    .from("invoices")
    .select("id, org_id, status, invoice_number, total_amount, amount_paid, project_id, client_id")
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (invoiceError) return json(500, { error: "Could not load the invoice." });
  if (!invoice) return json(404, { error: "Invoice not found." });

  if (NON_PAYABLE_STATUSES.has(invoice.status)) {
    return json(409, { error: `A ${invoice.status} invoice cannot receive a payment.` });
  }

  const balance = Math.round((Number(invoice.total_amount ?? 0) - Number(invoice.amount_paid ?? 0)) * 100) / 100;
  if (balance <= 0) return json(409, { error: "This invoice has no remaining balance." });
  if (amount > balance + 0.005) {
    return json(400, { error: `Payment of ${money(amount)} exceeds the remaining balance of ${money(balance)}. Overpayments aren't supported yet.` });
  }

  // paid_at is timestamptz (a real future Stripe payment needs a true
  // event instant), but `paidAt` here is a BUSINESS DATE picked from a
  // plain <input type="date"> (e.g. "2026-08-08"), not an event instant --
  // new Date("2026-08-08") is spec-guaranteed to parse a date-only string
  // as UTC midnight, so .toISOString() always comes back
  // "2026-08-08T00:00:00.000Z": the calendar date staff selected is
  // preserved exactly in the stored value's date portion regardless of
  // this server's timezone. Every reader (PaymentHistory, the financial
  // trend/collected-this-month buckets in src/lib/financials.ts, and now
  // the accounting journal entry_date below) is responsible for treating
  // that date portion as the business date via formatDateOnly/
  // dateOnlyToLocalDate rather than parsing the full instant in local
  // time -- that read-side handling, not this write, is what was actually
  // broken before.
  const paidAtIso = paidAt ? new Date(paidAt).toISOString() : new Date().toISOString();

  const { data: payment, error: insertError } = await admin
    .from("invoice_payments")
    .insert({
      org_id: orgId,
      invoice_id: invoiceId,
      project_id: invoice.project_id,
      contact_id: invoice.client_id,
      amount,
      status: "succeeded",
      payment_method: method,
      provider: "manual",
      source: "manual",
      paid_at: paidAtIso,
      reference: reference?.trim() || null,
      notes: notes?.trim() || null,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "42P01") {
      return json(501, { error: "The payment ledger hasn't been set up in this environment yet (pending migration 20260818_invoice_payments_ledger.sql)." });
    }
    console.error("[invoice-record-payment] insert failed:", insertError);
    return json(500, { error: "Could not record this payment." });
  }
  // Part 18/19 -- accounting posting only ever starts AFTER the canonical
  // invoice_payments insert above has already succeeded (payment.id
  // exists) -- the operational payment record is authoritative regardless
  // of what happens next. Best-effort, non-blocking, and only attempted
  // once this org's accounting has been deliberately activated
  // (status='initialized'); every other org's payments behave exactly as
  // before. Never credits Revenue here -- that already happened at
  // invoice-issued time. post_journal_entry's own (org, source_type,
  // source_id, posting_key) idempotency keys off this payment row's own
  // id, so this can never double-post even if retried.
  let accountingWarning: string | undefined;
  try {
    const { data: accountingSettings } = await admin
      .from("accounting_settings").select("status").eq("org_id", orgId).maybeSingle();
    if (accountingSettings?.status === "initialized") {
      await postInvoicePaymentSucceeded(admin, orgId, {
        id: payment.id, amount, paidAt: paidAtIso.slice(0, 10),
        invoiceNumber: invoice.invoice_number, projectId: invoice.project_id, contactId: invoice.client_id,
      }, user.id);
    }
  } catch (accountingError) {
    console.error("[invoice-record-payment] accounting posting failed (non-blocking)", {
      paymentId: payment.id, invoiceId, orgId, error: accountingError instanceof Error ? accountingError.message : String(accountingError),
    });
    accountingWarning = "Payment recorded successfully, but accounting posting failed and needs manual review.";
  }

  // The DB trigger (sync_invoice_amount_paid) already updated invoices.
  // Re-read so the response reflects the real post-trigger state rather
  // than a value computed twice (once here, once in the trigger).
  const { data: updatedInvoice } = await admin
    .from("invoices").select("status, amount_paid").eq("id", invoiceId).maybeSingle();

  if (invoice.project_id) {
    await admin.from("project_notes").insert({
      project_id: invoice.project_id,
      body: `Payment of ${money(amount)} (${method}) recorded for invoice ${invoice.invoice_number}.`,
      author: [user.user_metadata?.first_name, user.user_metadata?.last_name].filter(Boolean).join(" ").trim() || user.email || "Staff",
      is_client_message: false,
    }).then(({ error }) => { if (error) console.warn("[invoice-record-payment] activity note insert failed (non-blocking):", error.message); });
  }

  return json(200, {
    ok: true,
    paymentId: payment.id,
    status: updatedInvoice?.status ?? invoice.status,
    amountPaid: Number(updatedInvoice?.amount_paid ?? invoice.amount_paid),
    accountingWarning,
  });
};
