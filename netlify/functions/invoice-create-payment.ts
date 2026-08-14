/// <reference types="node" />
// netlify/functions/invoice-create-payment.ts
//
// Phase 13.7 — trusted server-side Stripe Checkout Session creation for the
// public invoice/payment page. Input is the public invoice TOKEN only —
// never an amount. The Stripe amount is always recomputed here from the
// invoice's own current total_amount/amount_paid, exactly like
// invoice-record-payment.ts's balance check (Part 9/21) — a browser, query
// string, or React state amount is never trusted.
//
// Chose Stripe CHECKOUT over the client-side Payment/Express Checkout
// Element: this project has the server "stripe" SDK installed but no
// @stripe/stripe-js / @stripe/react-stripe-js client packages (verified —
// see audit), and Checkout needs zero client Stripe integration, just a
// redirect to session.url. It gets cards + Apple Pay + Google Pay for free
// with minimal PCI scope (Stripe hosts the whole payment form) — the same
// tradeoff portal-action.ts's existing (different-flow) create_payment
// action already made.
//
// Wallet visibility correction (Phase 13.7A Part 17): because this is
// Stripe-HOSTED Checkout (the customer is redirected to a stripe.com page,
// never Elements/Express Checkout Element rendered on RenoMeta's own
// domain), RenoMeta's application domain does NOT need to be registered
// for Apple Pay/Google Pay to appear — that domain-registration requirement
// only applies when rendering the Payment/Express Checkout Element directly
// on your own site. Wallet visibility on Stripe's hosted page still depends
// on the Stripe account's payment-method configuration, browser/device
// eligibility, and test vs. live mode — not on localhost vs. a deployed
// HTTPS domain the way self-hosted Elements would.

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { resolvePublicInvoiceToken } from "../lib/invoice-tokens";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const SITE_URL = process.env.URL || process.env.DEPLOY_PRIME_URL || "http://localhost:9999";

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  let reqBody: { token?: string };
  try { reqBody = JSON.parse(event.body ?? "{}"); }
  catch { return json(400, { error: "Invalid request body" }); }

  const rawToken = reqBody.token;
  if (!rawToken) return json(400, { error: "token required" });

  const tokenRow = await resolvePublicInvoiceToken(admin, rawToken);
  if (!tokenRow) return json(404, { error: "This invoice link is invalid or no longer available." });

  // Re-read the invoice fresh, right before creating the Checkout Session
  // (Part 21) — the remaining balance must reflect any payment that landed
  // via the webhook between page load and the customer clicking Pay.
  const { data: invoice, error: invoiceError } = await admin
    .from("invoices")
    .select("id, org_id, invoice_number, status, total_amount, amount_paid, project_id, client_id")
    .eq("id", tokenRow.invoice_id)
    .eq("org_id", tokenRow.org_id)
    .maybeSingle();
  if (invoiceError) return json(500, { error: "Could not load the invoice." });
  if (!invoice) return json(404, { error: "This invoice link is invalid or no longer available." });

  if (invoice.status === "paid") return json(409, { error: "This invoice has already been paid." });
  if (["draft", "void", "cancelled"].includes(invoice.status)) return json(409, { error: `A ${invoice.status} invoice cannot be paid.` });

  // Phase 13.10A, Part 12 — credit-aware ceiling. A customer credit memo
  // must reduce what Stripe Checkout charges the exact same way a payment
  // does — otherwise this would create a Checkout Session for a stale
  // balance. No refund logic here (that's Phase 13.11) — this only ever
  // makes the charge amount smaller/zero, never larger.
  //
  // Phase 13.10C, Part 6 — CRITICAL FIX. Payment-INITIATION safety must use
  // the RESERVED available balance (status IN ('draft','posted')), not
  // posted-only — a draft credit whose GL posting/finalize is still
  // pending already reserves its amount (see the migration's ARCHITECTURE
  // comment), and Stripe must never be allowed to charge into that
  // reservation. This is a write-safety check only; the public page's
  // DISPLAYED remaining balance (public-invoice.ts) stays posted-only,
  // unchanged.
  const { data: creditRows } = await admin
    .from("customer_credit_memos").select("total_amount").eq("invoice_id", invoice.id).in("status", ["draft", "posted"]);
  const reservedCreditsCents = Math.round((creditRows ?? []).reduce((s: number, r: any) => s + Number(r.total_amount ?? 0), 0) * 100);

  const balanceCents = Math.round((Number(invoice.total_amount ?? 0) - Number(invoice.amount_paid ?? 0)) * 100) - reservedCreditsCents;
  if (balanceCents <= 0) return json(409, { error: "Payment is temporarily unavailable while an adjustment is being processed." });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json(501, { error: "Online payment isn't configured yet. Please contact your contractor to pay this invoice." });

  const stripe = new Stripe(stripeKey);
  const publicUrl = `${SITE_URL}/invoice/pay/${encodeURIComponent(rawToken)}`;

  // Phase 13.7A Part 4/7 — two near-simultaneous requests (double-click, a
  // second tab, a retried fetch) would otherwise each independently pass
  // the balance check above and create two separate Checkout Sessions/
  // PaymentIntents. Stripe's idempotency key collapses concurrent requests
  // that share the same key into a single underlying creation — the second
  // call returns the SAME session Stripe already started, rather than a
  // new one. The key is derived entirely server-side from stable invoice
  // state (never accepted from the browser): once amount_paid actually
  // changes (a payment lands), the key changes too, so a later legitimate
  // partial-payment request is free to create its own new session.
  const idempotencyKey = `invoice-pay:${invoice.id}:${Math.round(Number(invoice.total_amount ?? 0) * 100)}:${Math.round(Number(invoice.amount_paid ?? 0) * 100)}:${reservedCreditsCents}`;

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: { name: `Invoice ${invoice.invoice_number}` },
            unit_amount: balanceCents,
          },
          quantity: 1,
        }],
        // Stable, server-resolved identifiers only — Part 12 — never
        // customer-supplied metadata. The webhook is authoritative on
        // payment_intent.succeeded (Part 11), which only carries the
        // PaymentIntent's OWN metadata — not the Checkout Session's — so the
        // same identifiers are duplicated onto payment_intent_data.metadata
        // below. Session-level metadata is kept too for any future
        // session-based lookups/support tooling. Never includes the raw
        // public token or any customer-sensitive notes.
        metadata: {
          invoice_id: invoice.id,
          org_id: invoice.org_id,
          project_id: invoice.project_id ?? "",
          contact_id: invoice.client_id ?? "",
        },
        payment_intent_data: {
          metadata: {
            invoice_id: invoice.id,
            org_id: invoice.org_id,
            project_id: invoice.project_id ?? "",
            contact_id: invoice.client_id ?? "",
          },
        },
        // Part 16 — the raw token is embedded ONLY because the customer
        // needs to resume the same public invoice page; it is never logged.
        success_url: `${publicUrl}?payment=processing`,
        cancel_url: `${publicUrl}?payment=cancelled`,
      },
      { idempotencyKey },
    );
    return json(200, { checkoutUrl: session.url });
  } catch (err) {
    console.error("[invoice-create-payment] Stripe session creation failed:", err instanceof Error ? err.message : err);
    return json(502, { error: "Could not start the payment. Please try again." });
  }
};
