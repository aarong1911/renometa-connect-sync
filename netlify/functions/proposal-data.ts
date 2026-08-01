/// <reference types="node" />
// netlify/functions/proposal-data.ts
//
// Phase 10.4 — public, anonymous, token-scoped read for the customer-facing
// proposal page (src/routes/proposal.$token.tsx). Mirrors portal-data.ts's
// established pattern exactly: service-role client, GET + ?token=, no
// Authorization header (there is no logged-in customer session), returns
// only a customer-safe payload (never cost_price/markup/internal notes/
// internal IDs — see the explicit column allowlists below). Also records
// the view (first_viewed_at/last_viewed_at/view_count, sent->viewed
// transition, one "viewed" activity on first view only) so repeated
// refreshes don't spam the activity feed.
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { syncEstimateDeal, logDealSyncWarning } from "../lib/estimate-deal-sync";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "GET") return { statusCode: 405, headers: HEADERS, body: "Method Not Allowed" };

  const token = event.queryStringParameters?.token;
  // High-entropy tokens only — never enumerable, never derived from the
  // estimate's own id. A malformed/short token is rejected before ever
  // reaching the database.
  if (!token || token.length < 32) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: "Proposal not found" }) };
  }

  const { data: estimate, error } = await supabaseAdmin
    .from("estimates")
    .select(`
      id, org_id, number, title, status, version_number, currency,
      subtotal, discount_total, tax_total, tax_rate, total,
      deposit_type, deposit_value, deposit_amount, balance_due,
      valid_until, scope, exclusions, assumptions, customer_note, terms,
      client_name, first_viewed_at, view_count,
      client:contacts!client_id(full_name, email, phone, address),
      company:companies(name, address, city, state, zip)
    `)
    .eq("public_token", token)
    .maybeSingle();

  if (error || !estimate) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: "Proposal not found" }) };
  }

  // A proposal is only ever reachable once it's actually been sent — a
  // draft/ready estimate's token (if one somehow existed) must not leak.
  if (!["sent", "viewed", "changes_requested", "approved", "rejected", "expired"].includes(estimate.status)) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: "Proposal not found" }) };
  }

  const [{ data: items }, { data: org }] = await Promise.all([
    supabaseAdmin
      .from("estimate_items")
      .select("id, position, item_type, category, name, description, quantity, unit, unit_price, line_total:total, optional, selected_by_customer, is_heading, taxable")
      .eq("estimate_id", estimate.id)
      .order("position", { ascending: true }),
    supabaseAdmin
      .from("organizations")
      .select("name, public_name, phone, logo_url, primary_color, address, website")
      .eq("id", estimate.org_id)
      .maybeSingle(),
  ]);

  // ── view tracking — first view only creates an activity + sent->viewed
  // transition; later views just bump last_viewed_at/view_count so a
  // customer re-opening the link doesn't flood the activity feed.
  const now = new Date().toISOString();
  const isFirstView = !estimate.first_viewed_at;
  const updatePayload: Record<string, unknown> = {
    last_viewed_at: now,
    view_count: (estimate.view_count ?? 0) + 1,
  };
  if (isFirstView) updatePayload.first_viewed_at = now;
  if (estimate.status === "sent") updatePayload.status = "viewed";

  await supabaseAdmin.from("estimates").update(updatePayload).eq("id", estimate.id);

  // Advisory, non-blocking — a customer opening their proposal link must
  // never see an error because Deal sync had trouble. Reuses the same Deal
  // if one already exists (created at send-time); never regresses a Deal
  // that's already past Proposal Sent.
  if (updatePayload.status === "viewed") {
    try {
      const syncResult = await syncEstimateDeal(supabaseAdmin, { estimateId: estimate.id, orgId: estimate.org_id, trigger: "viewed" });
      if (!syncResult.ok) logDealSyncWarning("viewed -> deal sync failed (non-blocking)", { estimateId: estimate.id, orgId: estimate.org_id, error: syncResult.error });
    } catch (syncError) {
      logDealSyncWarning("viewed -> deal sync threw (non-blocking)", { estimateId: estimate.id, orgId: estimate.org_id, error: String(syncError) });
    }
  }

  if (isFirstView) {
    await supabaseAdmin.from("estimate_activities").insert({
      org_id: estimate.org_id,
      estimate_id: estimate.id,
      version_number: estimate.version_number,
      activity_type: "viewed",
      actor_type: "customer",
      title: "Proposal viewed",
      description: estimate.client_name ? `First opened by ${estimate.client_name}` : "First opened by the customer",
    });
  }

  // Customer-safe payload only — no cost_price/markup/internal notes/
  // internal ids beyond what the approval action itself needs (the token
  // IS the credential; the estimate's raw id is not returned).
  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      estimate: {
        number: estimate.number,
        title: estimate.title,
        status: estimate.status === "sent" ? "viewed" : estimate.status,
        versionNumber: estimate.version_number,
        currency: estimate.currency,
        subtotal: Number(estimate.subtotal ?? 0),
        discountTotal: Number(estimate.discount_total ?? 0),
        taxTotal: Number(estimate.tax_total ?? 0),
        taxRate: Number(estimate.tax_rate ?? 0),
        total: Number(estimate.total ?? 0),
        depositType: estimate.deposit_type,
        depositAmount: Number(estimate.deposit_amount ?? 0),
        balanceDue: Number(estimate.balance_due ?? 0),
        validUntil: estimate.valid_until,
        scope: estimate.scope,
        exclusions: estimate.exclusions,
        assumptions: estimate.assumptions,
        customerNote: estimate.customer_note,
        terms: estimate.terms,
        customerName: (estimate as any).client?.full_name || estimate.client_name || "",
        customerAddress: (estimate as any).client?.address || null,
      },
      items: (items ?? []).map((i: any) => ({
        id: i.id, position: i.position, itemType: i.item_type, category: i.category,
        name: i.name, description: i.description, quantity: Number(i.quantity ?? 0),
        unit: i.unit, unitPrice: Number(i.unit_price ?? 0), lineTotal: Number(i.line_total ?? 0),
        optional: !!i.optional, selectedByCustomer: !!i.selected_by_customer, isHeading: !!i.is_heading,
      })),
      org: {
        name: org?.public_name || org?.name || "Your Contractor",
        phone: org?.phone || null,
        logo: org?.logo_url || null,
        primaryColor: org?.primary_color || "#3B82F6",
        address: org?.address || null,
        website: org?.website || null,
      },
    }),
  };
};
