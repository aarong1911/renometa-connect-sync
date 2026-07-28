/// <reference types="node" />
// netlify/functions/portal-action.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const PORTAL_URL = "https://portal.renometa.com";

export const handler: Handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: "Method Not Allowed" };

  let reqBody: { token: string; slug?: string; action: string; payload?: any };
  try { reqBody = JSON.parse(event.body ?? "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { token, action, payload } = reqBody;
  if (!token || !action)
    return { statusCode: 400, headers, body: JSON.stringify({ error: "token and action required" }) };

  // Validate — try token first, then slug fallback
  let inv: any = null;
  if (token) {
    const { data } = await supabaseAdmin
      .from("invitations").select("*").eq("token", token)
      .in("status", ["pending", "roster_only", "accepted"]).maybeSingle();
    inv = data;
  }
  if (!inv && reqBody.slug) {
    const { data } = await supabaseAdmin
      .from("invitations").select("*").eq("portal_slug", reqBody.slug)
      .in("status", ["pending", "roster_only", "accepted"]).maybeSingle();
    inv = data;
  }

  if (!inv || inv.role !== "viewer")
    return { statusCode: 403, headers, body: JSON.stringify({ error: "Access denied" }) };

  const clientName = inv.first_name
    ? `${inv.first_name} ${inv.last_name || ""}`.trim()
    : inv.email;

  // ── send_message ────────────────────────────────────────────────────────────
  if (action === "send_message") {
    const { projectId, message: clientMessage } = payload ?? {};
    if (!projectId || !clientMessage?.trim())
      return { statusCode: 400, headers, body: JSON.stringify({ error: "projectId and message required" }) };

    const { error } = await supabaseAdmin.from("project_notes").insert({
      project_id:        projectId,
      body:              clientMessage.trim(),
      author:            clientName,
      is_client_message: true,
      client_email:      inv.email,
    });
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };

    // SMS notification via Twilio
    const twilioSid  = process.env.TWILIO_ACCOUNT_SID;
    const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
    const twilioTo   = process.env.NOTIFY_PHONE_NUMBER;

    if (twilioSid && twilioAuth && twilioFrom && twilioTo) {
      const smsBody = `New portal message from ${clientName}:\n"${clientMessage.trim()}"`;
      try {
        await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
          method: "POST",
          headers: {
            "Authorization": `Basic ${Buffer.from(`${twilioSid}:${twilioAuth}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ From: twilioFrom, To: twilioTo, Body: smsBody }).toString(),
        });
      } catch (smsErr) {
        console.warn("[portal-action] Twilio SMS failed:", smsErr);
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  // ── approve_estimate ────────────────────────────────────────────────────────
  if (action === "approve_estimate") {
    const { estimateId } = payload ?? {};
    if (!estimateId)
      return { statusCode: 400, headers, body: JSON.stringify({ error: "estimateId required" }) };

    const { error } = await supabaseAdmin.from("estimates")
      .update({ status: "accepted", esign_status: "signed", signed_at: new Date().toISOString() })
      .eq("id", estimateId);
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  // ── create_payment (Stripe Checkout) ───────────────────────────────────────
  if (action === "create_payment") {
    const { invoiceId } = payload ?? {};
    if (!invoiceId)
      return { statusCode: 400, headers, body: JSON.stringify({ error: "invoiceId required" }) };

    const { data: invoice } = await supabaseAdmin
      .from("invoices")
      .select("id, invoice_number, total_amount, amount_paid, status, project_id")
      .eq("id", invoiceId).maybeSingle();

    if (!invoice)
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Invoice not found" }) };
    if (invoice.status === "paid")
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Invoice already paid" }) };

    const balance = Math.round((invoice.total_amount - invoice.amount_paid) * 100);
    if (balance <= 0)
      return { statusCode: 400, headers, body: JSON.stringify({ error: "No balance due" }) };

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      await supabaseAdmin.from("project_notes").insert({
        project_id:        invoice.project_id,
        body:              `${clientName} has requested to pay invoice #${invoice.invoice_number} ($${(balance / 100).toLocaleString()}). Please follow up to process payment.`,
        author:            "Portal",
        is_client_message: true,
        client_email:      inv.email,
      });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: "Payment request sent to contractor" }) };
    }

    const stripe  = new Stripe(stripeKey, { apiVersion: "2026-04-22.dahlia" });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency:     "usd",
          product_data: {
            name:        `Invoice #${invoice.invoice_number}`,
            description: "Payment for project",
          },
          unit_amount: balance,
        },
        quantity: 1,
      }],
      mode:        "payment",
      success_url: `${PORTAL_URL}/portal?token=${token}&paid=1`,
      cancel_url:  `${PORTAL_URL}/portal?token=${token}`,
      metadata:    { invoiceId, token, clientEmail: inv.email },
    });

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, checkoutUrl: session.url }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
};