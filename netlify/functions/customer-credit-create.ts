/// <reference types="node" />
// netlify/functions/customer-credit-create.ts
//
// Phase 13.10B — rewritten from Phase 13.10/13.10A's one-shot create+post
// design into an explicit prepare -> post GL -> finalize flow (Part 1/2/3
// of the 13.10B hardening pass). A credit memo must never become
// financially effective (status='posted', counted in A/R/aging/payment
// ceilings) before its journal entry actually exists:
//
//   1. record_customer_credit_memo() — creates/returns a `draft` memo
//      (idempotent: a retry with the same idempotencyKey returns the SAME
//      draft, never a duplicate). Zero financial effect while draft.
//   2. postCustomerCreditMemo() — posts the GL entry, using the
//      RPC-derived revenue_account_id (never a client-supplied one — the
//      RPC itself fails closed if the invoice has no posted 'issued' entry
//      or more than one revenue credit line to derive from).
//   3. finalize_customer_credit_memo() — flips draft -> posted, but only
//      after independently re-verifying the posted JE exists.
//
// If step 2 or 3 fails, this endpoint returns an error — never `ok: true`
// with a still-draft memo. Retrying with the SAME idempotencyKey resumes
// exactly where it left off (same draft reused, GL posting is itself
// idempotent via post_journal_entry's own (org, source_type, source_id,
// posting_key) key, finalize is idempotent if the memo is already posted).

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { postCustomerCreditMemo } from "../lib/accounting";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const resolved = await resolveOrgFromBearerToken(admin, event.headers.authorization ?? event.headers.Authorization);
  if (!resolved) return json(401, { error: "Unauthorized" });
  const { userId, orgId } = resolved;

  let body: { invoiceId?: string; amount?: number; reason?: string; description?: string; creditDate?: string; idempotencyKey?: string };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid request body" });
  }
  const { invoiceId } = body;
  const reason = body.reason?.trim();
  const amount = Number(body.amount);
  const idempotencyKey = body.idempotencyKey?.trim();

  if (!invoiceId) return json(400, { error: "invoiceId required" });
  if (!Number.isFinite(amount) || amount <= 0) return json(400, { error: "Amount must be a positive number" });
  if (!reason) return json(400, { error: "A reason is required" });
  // Phase 13.10C, Part 18/20/44 — defense in depth; the DB RPC itself also
  // rejects a missing/blank key, but reject here first for a clean 400
  // instead of a round trip.
  if (!idempotencyKey) return json(400, { error: "idempotencyKey required" });

  // Advisory pre-check only (Part 27's "no ambiguity" rule applies to the
  // final response, not this early friendly-error read) — the RPC below is
  // the authoritative, fail-closed check for both invoice status and the
  // existence of a postable revenue account.
  const { data: invoice, error: invoiceError } = await admin
    .from("invoices")
    .select("id, org_id, status, invoice_number, project_id, client_id")
    .eq("id", invoiceId).eq("org_id", orgId).maybeSingle();
  if (invoiceError) return json(500, { error: "Could not load the invoice." });
  if (!invoice) return json(404, { error: "Invoice not found." });
  if (invoice.status === "draft" || invoice.status === "cancelled") {
    return json(409, { error: `Cannot credit a ${invoice.status} invoice.` });
  }

  const creditDate = body.creditDate || new Date().toISOString().slice(0, 10);

  const { data: rpcRows, error: rpcError } = await admin.rpc("record_customer_credit_memo", {
    p_org_id: orgId,
    p_invoice_id: invoiceId,
    p_amount: amount,
    p_reason: reason,
    p_description: body.description?.trim() || null,
    p_credit_date: creditDate,
    p_created_by: userId,
    p_idempotency_key: idempotencyKey,
  });
  if (rpcError) {
    // Postgres SQLSTATE 42883 ("undefined_function") does NOT reliably mean
    // "the migration was never applied" — it's the generic "no function
    // matches this name + this exact named-argument set" error, and fires
    // just as readily for a stale PostgREST schema cache or a leftover
    // overload from an earlier partial apply as it does for a genuinely
    // missing function. Hardcoding a "pending migration" message here was
    // actively misleading once the migration really had been applied —
    // surface the real database error instead, which names the exact
    // signature Postgres couldn't resolve and is what's actually
    // diagnosable. See PGRST202 too (PostgREST's own "not in schema cache"
    // code) for the same reason.
    if (rpcError.code === "42883" || rpcError.code === "PGRST202") {
      console.error("[customer-credit-create] record_customer_credit_memo not resolvable — verify migration 20260825 is applied AND that PostgREST's schema cache reflects its current signature", {
        code: rpcError.code, message: rpcError.message, details: (rpcError as any).details, hint: (rpcError as any).hint,
      });
      return json(501, { error: `Customer credit memo creation is unavailable: ${rpcError.message}` });
    }
    return json(409, { error: rpcError.message || "Could not create this credit memo." });
  }
  const prepared = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const creditMemoId: string = prepared?.credit_memo_id;
  const revenueAccountId: string = prepared?.revenue_account_id;
  if (!creditMemoId) {
    console.error("[customer-credit-create] RPC returned no credit_memo_id", { invoiceId, orgId, prepared });
    return json(500, { error: "Could not create this credit memo." });
  }

  // Phase 13.10C, Part 26 — GL posting and finalize are ALWAYS attempted,
  // even when `prepared.status` already came back 'posted' (a prior call
  // with this same idempotencyKey already completed). Both steps are
  // cheaply idempotent (post_journal_entry's own (org, source_type,
  // source_id, posting_key) key; finalize's content re-verification), so
  // this never re-posts or re-finalizes for real — it just gives the
  // response the authoritative, freshly-content-verified posted-only
  // invoice_effective_balance instead of the prepare RPC's own
  // invoice_available_balance (a materially different number whenever
  // another unrelated draft credit is concurrently reserving balance on
  // the same invoice — Part 27, never conflate the two).
  try {
    await postCustomerCreditMemo(admin, orgId, {
      id: creditMemoId, creditNumber: prepared.credit_number, amount, creditDate,
      revenueAccountId, invoiceId, invoiceNumber: invoice.invoice_number,
      projectId: invoice.project_id, contactId: invoice.client_id,
    }, userId);
  } catch (accountingError) {
    console.error("[customer-credit-create] accounting posting failed — memo remains draft, safe to retry", {
      creditMemoId, invoiceId, orgId, error: accountingError instanceof Error ? accountingError.message : String(accountingError),
    });
    return json(502, {
      error: "Could not post accounting for this credit memo. It has NOT been applied to the invoice balance. Retry the same request to resume.",
      creditMemoId,
      recoverable: true,
    });
  }

  const { data: finalizeRows, error: finalizeError } = await admin.rpc("finalize_customer_credit_memo", {
    p_org_id: orgId,
    p_credit_memo_id: creditMemoId,
    p_created_by: userId,
  });
  if (finalizeError) {
    console.error("[customer-credit-create] finalize failed — GL is posted but memo remains draft, safe to retry", {
      creditMemoId, invoiceId, orgId, error: finalizeError.message,
    });
    return json(502, {
      error: "Accounting posted, but the credit memo could not be finalized. Retry the same request to resume.",
      creditMemoId,
      recoverable: true,
    });
  }
  const finalized = Array.isArray(finalizeRows) ? finalizeRows[0] : finalizeRows;

  return json(200, {
    ok: true,
    creditMemoId,
    creditNumber: finalized.credit_number,
    invoiceEffectiveBalance: Number(finalized.invoice_effective_balance),
  });
};
