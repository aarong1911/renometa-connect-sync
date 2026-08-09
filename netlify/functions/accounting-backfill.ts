/// <reference types="node" />
// netlify/functions/accounting-backfill.ts
//
// Phase 13.6 — trusted, org-owner/admin-only, one-time controlled historical
// accounting backfill. Three actions, always for the CALLER'S OWN org
// (resolved server-side from their profile/membership — never a client-
// supplied org id):
//
//   { action: "approve" }            not_initialized -> ready_for_backfill
//   { action: "run", dryRun: bool }  post (or just report) historical events
//   { action: "finalize" }           ready_for_backfill -> initialized,
//                                     ONLY if reconciliation actually passes
//
// Never inserts into accounting_journal_entries/accounting_journal_entry_
// lines directly — every posting goes through postInvoiceIssued()/
// postInvoicePaymentSucceeded() (netlify/lib/accounting.ts), which call the
// post_journal_entry() RPC — so balance validation, tenant validation,
// idempotency, journal numbering, closed-period validation, and
// immutability all stay centralized there, not reimplemented here.

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import {
  postInvoiceIssued, postInvoicePaymentSucceeded, computeServerReconciliation,
  type InvoiceForPosting, type PaymentForPosting, type PostJournalEntryResult,
} from "../lib/accounting";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

// Same org+role resolution idiom as agent-approve-action.ts: a profile
// carrying organization_id directly is that account's own owner/creator
// (always authorized); otherwise only an org_memberships row with
// role owner/admin is authorized. Never trusts a client-supplied org id.
async function resolveOrgAndAuthority(userId: string): Promise<{ orgId: string | null; isOwnerOrAdmin: boolean }> {
  const { data: profile } = await admin.from("profiles").select("organization_id").eq("id", userId).maybeSingle();
  if (profile?.organization_id) return { orgId: profile.organization_id, isOwnerOrAdmin: true };
  const { data: membership } = await admin.from("org_memberships").select("org_id, role").eq("member_id", userId).maybeSingle();
  if (!membership) return { orgId: null, isOwnerOrAdmin: false };
  return { orgId: membership.org_id, isOwnerOrAdmin: membership.role === "owner" || membership.role === "admin" };
}

const ISSUED_STATUSES = new Set(["sent", "viewed", "partial", "paid", "overdue"]);
const EXCLUDED_STATUSES = new Set(["draft", "cancelled", "void"]);

type PostableEvent =
  | { kind: "invoice"; date: string; invoice: InvoiceForPosting; raw: any }
  | { kind: "payment"; date: string; payment: PaymentForPosting; raw: any };

async function buildDryRun(orgId: string) {
  const { data: invoiceRows, error: invErr } = await admin
    .from("invoices")
    .select("id, invoice_number, status, issue_date, total_amount, amount_paid, project_id, client_id")
    .eq("org_id", orgId);
  if (invErr) throw new Error(`Could not load invoices: ${invErr.message}`);

  const { data: paymentRows, error: payErr } = await admin
    .from("invoice_payments")
    .select("id, invoice_id, amount, status, source, provider, payment_method, paid_at, project_id, contact_id")
    .eq("org_id", orgId);
  if (payErr) throw new Error(`Could not load invoice_payments: ${payErr.message}`);

  const invoicesById = new Map((invoiceRows ?? []).map((i: any) => [i.id, i]));
  const postableInvoices = (invoiceRows ?? []).filter((i: any) => ISSUED_STATUSES.has(i.status) && !EXCLUDED_STATUSES.has(i.status));
  const skippedInvoices = (invoiceRows ?? []).filter((i: any) => !postableInvoices.includes(i));

  const succeededPayments = (paymentRows ?? []).filter((p: any) => p.status === "succeeded");
  const refundedPayments = (paymentRows ?? []).filter((p: any) => p.status === "refunded");
  const skippedPayments = (paymentRows ?? []).filter((p: any) => p.status !== "succeeded" && p.status !== "refunded");

  const ambiguous: Array<{ type: string; id: string; reason: string }> = [];
  const events: PostableEvent[] = [];

  for (const inv of postableInvoices) {
    if (!inv.issue_date) {
      ambiguous.push({ type: "invoice", id: inv.id, reason: `Invoice ${inv.invoice_number} has no issue_date — cannot derive an accounting entry_date without inventing one` });
      continue;
    }
    events.push({
      kind: "invoice",
      date: inv.issue_date,
      invoice: { id: inv.id, invoiceNumber: inv.invoice_number, totalAmount: Number(inv.total_amount ?? 0), issueDate: inv.issue_date, projectId: inv.project_id, clientId: inv.client_id },
      raw: inv,
    });
  }

  // Part 2 — refunds only handled if real refunded rows exist; none found
  // for this org today, so no refund posting rule is invoked at all
  // (nothing invented). Reported explicitly either way.
  for (const pay of refundedPayments) {
    ambiguous.push({ type: "payment_refund", id: pay.id, reason: "A refunded payment row exists but no refund posting rule is implemented in this phase — not posted, flagged for manual review" });
  }

  for (const pay of succeededPayments) {
    const inv = invoicesById.get(pay.invoice_id);
    if (!inv) {
      ambiguous.push({ type: "payment", id: pay.id, reason: `Payment references invoice_id ${pay.invoice_id}, which does not exist in this org's invoices` });
      continue;
    }
    if (!ISSUED_STATUSES.has(inv.status) && inv.status !== "paid") {
      ambiguous.push({ type: "payment", id: pay.id, reason: `Payment's invoice ${inv.invoice_number} is not an issued invoice (status=${inv.status}) — cannot post a payment against an invoice that was never issued` });
      continue;
    }
    if (!pay.paid_at) {
      ambiguous.push({ type: "payment", id: pay.id, reason: "Payment has no paid_at — cannot derive a business date" });
      continue;
    }
    // Part 9 — treat paid_at as a DATE-ONLY business date: read only its
    // leading YYYY-MM-DD, never re-parse the full timestamp through a
    // timezone-sensitive Date object (that was the exact bug fixed in the
    // Phase 13.4 date-only pass).
    const payDate = String(pay.paid_at).slice(0, 10);
    if (payDate < inv.issue_date) {
      ambiguous.push({ type: "payment", id: pay.id, reason: `Payment date ${payDate} is before its invoice's issue_date ${inv.issue_date} — ambiguous chronological order` });
      continue;
    }
    events.push({
      kind: "payment",
      date: payDate,
      payment: { id: pay.id, amount: Number(pay.amount ?? 0), paidAt: payDate, invoiceNumber: inv.invoice_number, projectId: pay.project_id, contactId: pay.contact_id },
      raw: pay,
    });
  }

  // Part 8 — chronological order; invoice-issued must precede its own
  // payment on the same date. Stable tie-break: date, then kind
  // (invoice=0 before payment=1), then source id.
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const kindRank = (k: string) => (k === "invoice" ? 0 : 1);
    if (kindRank(a.kind) !== kindRank(b.kind)) return kindRank(a.kind) - kindRank(b.kind);
    const aId = a.kind === "invoice" ? a.invoice.id : a.payment.id;
    const bId = b.kind === "invoice" ? b.invoice.id : b.payment.id;
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });

  const invoiceEvents = events.filter((e): e is Extract<PostableEvent, { kind: "invoice" }> => e.kind === "invoice");
  const paymentEvents = events.filter((e): e is Extract<PostableEvent, { kind: "payment" }> => e.kind === "payment");
  const totalInvoiceAmount = round2(invoiceEvents.reduce((s, e) => s + e.invoice.totalAmount, 0));
  const totalPaymentAmount = round2(paymentEvents.reduce((s, e) => s + e.payment.amount, 0));

  return {
    events,
    summary: {
      invoiceEntryCount: invoiceEvents.length,
      paymentEntryCount: paymentEvents.length,
      totalInvoiceDebits: totalInvoiceAmount,
      totalInvoiceCredits: totalInvoiceAmount,
      totalPaymentDebits: totalPaymentAmount,
      totalPaymentCredits: totalPaymentAmount,
    },
    postableInvoices: invoiceEvents.map((e) => ({ id: e.invoice.id, invoiceNumber: e.invoice.invoiceNumber, entryDate: e.date, amount: e.invoice.totalAmount, projectId: e.invoice.projectId, contactId: e.invoice.clientId })),
    postablePayments: paymentEvents.map((e) => ({ id: e.payment.id, invoiceNumber: e.payment.invoiceNumber, entryDate: e.date, amount: e.payment.amount, projectId: e.payment.projectId, contactId: e.payment.contactId })),
    skippedInvoices: skippedInvoices.map((i: any) => ({ id: i.id, invoiceNumber: i.invoice_number, status: i.status, reason: EXCLUDED_STATUSES.has(i.status) ? "draft/cancelled — never accounting-postable" : "not an issued status" })),
    skippedPayments: skippedPayments.map((p: any) => ({ id: p.id, status: p.status, reason: "not a succeeded payment" })),
    ambiguous,
  };
}

async function verifySystemAccounts(orgId: string): Promise<{ ok: boolean; details: any[] }> {
  const expected: Record<string, { type: string; normalBalance: string }> = {
    "1020": { type: "asset", normalBalance: "debit" },
    "1100": { type: "asset", normalBalance: "debit" },
    "4000": { type: "revenue", normalBalance: "credit" },
  };
  const { data, error } = await admin
    .from("accounting_accounts")
    .select("id, code, name, account_type, normal_balance, is_active, is_system, org_id")
    .eq("org_id", orgId)
    .in("code", Object.keys(expected));
  if (error) throw new Error(`Could not verify system accounts: ${error.message}`);

  const details: any[] = [];
  let ok = true;
  for (const code of Object.keys(expected)) {
    const matches = (data ?? []).filter((a: any) => a.code === code);
    const exp = expected[code];
    const problems: string[] = [];
    if (matches.length !== 1) problems.push(`expected exactly 1 row, found ${matches.length}`);
    const row = matches[0];
    if (row) {
      if (row.org_id !== orgId) problems.push("wrong org");
      if (!row.is_active) problems.push("not active");
      if (!row.is_system) problems.push("not marked is_system");
      if (row.account_type !== exp.type) problems.push(`account_type ${row.account_type} !== ${exp.type}`);
      if (row.normal_balance !== exp.normalBalance) problems.push(`normal_balance ${row.normal_balance} !== ${exp.normalBalance}`);
    }
    if (problems.length > 0) ok = false;
    details.push({ code, found: matches.length, problems, row: row ?? null });
  }
  return { ok, details };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const token = event.headers.authorization?.slice(7) ?? event.headers.Authorization?.slice(7);
  if (!token) return json(401, { error: "Unauthorized" });
  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) return json(401, { error: "Invalid token" });

  const { orgId, isOwnerOrAdmin } = await resolveOrgAndAuthority(user.id);
  if (!orgId) return json(403, { error: "No organization was found for this user." });
  if (!isOwnerOrAdmin) return json(403, { error: "Only an organization owner or admin may perform accounting initialization." });

  let body: { action?: string; dryRun?: boolean };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid request body" });
  }

  const { data: settings, error: settingsError } = await admin
    .from("accounting_settings").select("*").eq("org_id", orgId).maybeSingle();
  if (settingsError) return json(500, { error: `Could not load accounting_settings: ${settingsError.message}` });
  if (!settings) return json(409, { error: "accounting_settings row is missing for this org — Chart of Accounts may not be seeded yet." });

  // ── approve: not_initialized -> ready_for_backfill ───────────────────────
  if (body.action === "approve") {
    if (settings.status !== "not_initialized") {
      return json(200, { ok: true, status: settings.status, note: "Already past not_initialized — no change made." });
    }
    const { data: updated, error } = await admin
      .from("accounting_settings")
      .update({ status: "ready_for_backfill", backfill_approved_at: new Date().toISOString(), backfill_approved_by: user.id })
      .eq("org_id", orgId).eq("status", "not_initialized")
      .select("*").maybeSingle();
    if (error) return json(500, { error: `Could not approve backfill: ${error.message}` });
    if (!updated) return json(409, { error: "Status changed concurrently — retry." });
    return json(200, { ok: true, settings: updated });
  }

  // ── run: dry-run report, or actually post ────────────────────────────────
  if (body.action === "run") {
    if (settings.status === "not_initialized") {
      return json(409, { error: "accounting_settings.status is not_initialized — call action=approve first." });
    }
    if (settings.status === "initialized" && !body.dryRun) {
      return json(409, { error: "This org's accounting is already initialized — refusing to re-run a live backfill. Use dryRun:true to inspect." });
    }

    const accountsCheck = await verifySystemAccounts(orgId);
    if (!accountsCheck.ok) {
      return json(409, { error: "System accounts are missing/duplicated/structurally incorrect — refusing to post.", details: accountsCheck.details });
    }

    const dryRunReport = await buildDryRun(orgId);
    if (dryRunReport.ambiguous.length > 0) {
      // Part 27 — stop rather than post uncertain data. Dry run always
      // still returns the report either way so the ambiguity is visible.
      return json(422, { error: "Ambiguous records found — refusing to post until resolved.", dryRun: dryRunReport });
    }

    if (body.dryRun) {
      return json(200, { ok: true, dryRun: dryRunReport, posted: false });
    }

    const postings: Array<{ kind: string; sourceId: string; result: PostJournalEntryResult }> = [];
    for (const e of dryRunReport.events) {
      if (e.kind === "invoice") {
        const result = await postInvoiceIssued(admin, orgId, e.invoice, settings.backfill_approved_by ?? null);
        postings.push({ kind: "invoice", sourceId: e.invoice.id, result });
      } else {
        const result = await postInvoicePaymentSucceeded(admin, orgId, e.payment, settings.backfill_approved_by ?? null);
        postings.push({ kind: "payment", sourceId: e.payment.id, result });
      }
    }

    const reconciliation = await computeServerReconciliation(admin, orgId);
    return json(200, { ok: true, dryRun: dryRunReport, posted: true, postings, reconciliation });
  }

  // ── finalize: ready_for_backfill -> initialized, only if reconciled ─────
  if (body.action === "finalize") {
    if (settings.status === "initialized") {
      return json(200, { ok: true, status: "initialized", note: "Already initialized." });
    }
    if (settings.status !== "ready_for_backfill") {
      return json(409, { error: `Cannot finalize from status ${settings.status} — run the backfill first.` });
    }
    const reconciliation = await computeServerReconciliation(admin, orgId);
    if (!reconciliation.reconciled) {
      return json(422, { error: "Reconciliation failed — refusing to mark initialized.", reconciliation });
    }
    const { data: updated, error } = await admin
      .from("accounting_settings")
      .update({ status: "initialized", backfilled_at: new Date().toISOString() })
      .eq("org_id", orgId).eq("status", "ready_for_backfill")
      .select("*").maybeSingle();
    if (error) return json(500, { error: `Could not finalize: ${error.message}` });
    if (!updated) return json(409, { error: "Status changed concurrently — retry." });
    return json(200, { ok: true, settings: updated, reconciliation });
  }

  return json(400, { error: "Unknown action. Use approve, run, or finalize." });
};
