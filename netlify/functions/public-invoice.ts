/// <reference types="node" />
// netlify/functions/public-invoice.ts
//
// Phase 13.7 — public, anonymous, token-scoped read for the customer-facing
// invoice/payment page (src/routes/invoice.pay.$token.tsx). Mirrors
// proposal-data.ts's established pattern: service-role client, GET +
// ?token=, no Authorization header (an anonymous customer has no session).
//
// Returns CUSTOMER-SAFE fields only — no org_id, no client_id, no internal
// ids beyond the invoice's own line items, no service-role data. The
// remaining balance is always computed here from invoices.total_amount -
// invoices.amount_paid (the server's own numbers), never trusted from the
// browser.

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolvePublicInvoiceToken } from "../lib/invoice-tokens";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }, body: "" };
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });

  const rawToken = event.queryStringParameters?.token;
  if (!rawToken) return json(400, { error: "token required" });

  // Uniform "invalid or expired" for every failure mode (unknown hash,
  // revoked, expired) — never lets a customer distinguish which.
  const tokenRow = await resolvePublicInvoiceToken(admin, rawToken);
  if (!tokenRow) return json(404, { error: "This invoice link is invalid or no longer available." });

  const { data: invoice, error: invoiceError } = await admin
    .from("invoices")
    .select("id, org_id, invoice_number, status, issue_date, due_date, subtotal, tax_amount, total_amount, amount_paid, client_id, project_id")
    .eq("id", tokenRow.invoice_id)
    .eq("org_id", tokenRow.org_id) // defense in depth — token row's own org_id must match the invoice it points at
    .maybeSingle();
  if (invoiceError) return json(500, { error: "Could not load the invoice." });
  if (!invoice) return json(404, { error: "This invoice link is invalid or no longer available." });

  const [{ data: items }, { data: org }, { data: client }, { data: project }] = await Promise.all([
    admin.from("invoice_items").select("id, description, quantity, unit_price, amount").eq("invoice_id", invoice.id).order("created_at", { ascending: true }),
    admin.from("organizations").select("public_name, name, logo_url, phone, email, website").eq("id", invoice.org_id).maybeSingle(),
    invoice.client_id ? admin.from("contacts").select("full_name").eq("id", invoice.client_id).maybeSingle() : Promise.resolve({ data: null }),
    invoice.project_id ? admin.from("projects").select("name").eq("id", invoice.project_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);

  const totalAmount = Number(invoice.total_amount ?? 0);
  const amountPaid = Number(invoice.amount_paid ?? 0);
  const remainingBalance = round2(Math.max(0, totalAmount - amountPaid));

  return json(200, {
    invoiceNumber: invoice.invoice_number,
    status: invoice.status,
    issueDate: invoice.issue_date,
    dueDate: invoice.due_date,
    customerName: client?.full_name ?? null,
    projectName: project?.name ?? null,
    lineItems: (items ?? []).map((i: any) => ({
      description: i.description, quantity: Number(i.quantity ?? 0), unitPrice: Number(i.unit_price ?? 0), amount: Number(i.amount ?? 0),
    })),
    subtotal: Number(invoice.subtotal ?? 0),
    taxAmount: Number(invoice.tax_amount ?? 0),
    total: totalAmount,
    amountPaid: round2(amountPaid),
    remainingBalance,
    business: {
      name: org?.public_name?.trim() || org?.name?.trim() || "Your contractor",
      logoUrl: org?.logo_url ?? null,
      phone: org?.phone ?? null,
      email: org?.email ?? null,
      website: org?.website ?? null,
    },
  });
};
