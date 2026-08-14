/// <reference types="node" />
// netlify/functions/invoice-record-payment.ts
//
// Phase 13.10B — rewritten (Part 14/17) to route through the canonical
// record_invoice_payment() DB RPC instead of performing the authoritative
// remaining-balance calculation in application code. The previous version
// had no invoice-row lock at all — two concurrent requests could both read
// the same pre-payment balance and both be accepted, overpaying the
// invoice. record_invoice_payment() locks the invoice FIRST (Part 16 —
// same lock order as record_invoice_payment_reversal() and
// record_customer_credit_memo()), recomputes posted credits and net
// effective payments under that lock, and is the final authority on the
// ceiling. The pre-checks that remain in this endpoint (status validation,
// method allowlist) exist only for a clear, specific error message before
// the round trip — never trusted as the real guard.
//
// invoice_payments is still the canonical ledger; invoices.amount_paid/
// status are a trigger-maintained cache the DB itself keeps in sync
// (sync_invoice_amount_paid()) — this endpoint never writes them directly.

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { postInvoicePaymentSucceeded } from "../lib/accounting";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const VALID_METHODS = new Set(["cash", "check", "card", "ach", "bank_transfer", "other"]);

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

  let body: { invoiceId?: string; amount?: number; method?: string; paidAt?: string; reference?: string; notes?: string; idempotencyKey?: string };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid request body" });
  }
  const { invoiceId, method = "other", paidAt, reference, notes } = body;
  const amount = Number(body.amount);
  const idempotencyKey = body.idempotencyKey?.trim();

  if (!invoiceId) return json(400, { error: "invoiceId required" });
  if (!Number.isFinite(amount) || amount <= 0) return json(400, { error: "amount must be a positive number" });
  if (!VALID_METHODS.has(method)) return json(400, { error: "Invalid payment method" });
  // Phase 13.10C, Part 17/20/45 — defense in depth; record_invoice_payment()
  // also rejects a missing/blank key.
  if (!idempotencyKey) return json(400, { error: "idempotencyKey required" });
  // Part 14/15/16/43 — CRITICAL. paidAt must be supplied by the caller and
  // must be STABLE across a retry of the same logical submission (the
  // client generates it once per submit attempt, alongside idempotencyKey
  // — see RecordPaymentDialog.tsx). This endpoint no longer falls back to
  // `new Date().toISOString()` when omitted — that fallback was exactly
  // the source of the now()-changes-between-retries bug: a first call
  // would store T1, and an omitted-paidAt retry would generate a fresh T2,
  // making the DB's idempotency fingerprint comparison falsely conflict.
  if (!paidAt) return json(400, { error: "paidAt required" });

  const { data: profile, error: profileError } = await admin
    .from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (profileError) return json(500, { error: "Could not load your organization profile." });
  const orgId = profile?.organization_id;
  if (!orgId) return json(403, { error: "No organization was found for this user." });

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
  const paidAtIso = new Date(paidAt).toISOString();

  // record_invoice_payment() is the sole authority on the invoice's
  // status/ceiling checks (locked, credit-aware) -- no pre-fetch/pre-check
  // of the invoice happens here anymore, since any value read before the
  // RPC's own lock would just be stale advice, not a real guard.
  const { data: rpcRows, error: rpcError } = await admin.rpc("record_invoice_payment", {
    p_org_id: orgId,
    p_invoice_id: invoiceId,
    p_amount: amount,
    p_payment_method: method,
    p_reference: reference?.trim() || null,
    p_notes: notes?.trim() || null,
    p_paid_at: paidAtIso,
    p_created_by: user.id,
    p_idempotency_key: idempotencyKey,
  });
  if (rpcError) {
    // See customer-credit-create.ts's identical comment — SQLSTATE 42883
    // does not reliably mean "migration not applied"; surface the real
    // database error instead of a hardcoded, potentially false claim.
    if (rpcError.code === "42883" || rpcError.code === "PGRST202") {
      console.error("[invoice-record-payment] record_invoice_payment not resolvable — verify migration 20260825 is applied AND that PostgREST's schema cache reflects its current signature", {
        code: rpcError.code, message: rpcError.message, details: (rpcError as any).details, hint: (rpcError as any).hint,
      });
      return json(501, { error: `Recording this payment is unavailable: ${rpcError.message}` });
    }
    return json(409, { error: rpcError.message || "Could not record this payment." });
  }
  const result = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const paymentId: string = result?.payment_id;
  if (!paymentId) {
    console.error("[invoice-record-payment] RPC returned no payment_id", { invoiceId, orgId, result });
    return json(500, { error: "Could not record this payment." });
  }

  // Part 18/19 -- accounting posting only ever starts AFTER the canonical
  // invoice_payments insert above has already succeeded (payment.id
  // exists) -- the operational payment record is authoritative regardless
  // of what happens next, same non-blocking best-effort model as every
  // other payment/expense/bill posting in this codebase (payments are NOT
  // subject to the credit-memo prepare/finalize split -- see the
  // migration's ARCHITECTURE comment). Best-effort, non-blocking, and only
  // attempted once this org's accounting has been deliberately activated
  // (status='initialized'); every other org's payments behave exactly as
  // before. post_journal_entry's own (org, source_type, source_id,
  // posting_key) idempotency keys off this payment row's own id, so a
  // retry against the SAME idempotencyKey (which returns the SAME
  // payment_id from the RPC above) can never double-post here either.
  let accountingWarning: string | undefined;
  try {
    const { data: accountingSettings } = await admin
      .from("accounting_settings").select("status").eq("org_id", orgId).maybeSingle();
    if (accountingSettings?.status === "initialized") {
      const { data: invoiceForPosting } = await admin
        .from("invoices").select("invoice_number, project_id, client_id").eq("id", invoiceId).maybeSingle();
      await postInvoicePaymentSucceeded(admin, orgId, {
        id: paymentId, amount, paidAt: paidAtIso.slice(0, 10),
        invoiceNumber: invoiceForPosting?.invoice_number ?? "", projectId: invoiceForPosting?.project_id ?? null, contactId: invoiceForPosting?.client_id ?? null,
      }, user.id);
    }
  } catch (accountingError) {
    console.error("[invoice-record-payment] accounting posting failed (non-blocking)", {
      paymentId, invoiceId, orgId, error: accountingError instanceof Error ? accountingError.message : String(accountingError),
    });
    accountingWarning = "Payment recorded successfully, but accounting posting failed and needs manual review.";
  }

  // Best-effort activity note -- looked up fresh here since the RPC only
  // returns status/amount_paid, not the invoice's project_id/invoice_number.
  const { data: invoiceForNote } = await admin
    .from("invoices").select("invoice_number, project_id").eq("id", invoiceId).maybeSingle();
  if (invoiceForNote?.project_id) {
    await admin.from("project_notes").insert({
      project_id: invoiceForNote.project_id,
      body: `Payment of ${money(amount)} (${method}) recorded for invoice ${invoiceForNote.invoice_number ?? ""}.`,
      author: [user.user_metadata?.first_name, user.user_metadata?.last_name].filter(Boolean).join(" ").trim() || user.email || "Staff",
      is_client_message: false,
    }).then(({ error }) => { if (error) console.warn("[invoice-record-payment] activity note insert failed (non-blocking):", error.message); });
  }

  return json(200, {
    ok: true,
    paymentId,
    status: result.invoice_status,
    amountPaid: Number(result.invoice_amount_paid),
    // Part 27/30 — effectiveBalance (posted-credits-only) is what the
    // customer/staff should ever SEE as the invoice's financial balance;
    // availableBalance (draft+posted) is the write-safety ceiling the RPC
    // itself just enforced — exposed so a caller can gate a further action
    // (e.g. disable Record Payment) without displaying it as a financial
    // number. Never conflate the two.
    effectiveBalance: Number(result.invoice_effective_balance),
    availableBalance: Number(result.invoice_available_balance),
    accountingWarning,
  });
};
