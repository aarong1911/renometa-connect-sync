/// <reference types="node" />
// netlify/functions/change-order-data.ts
//
// Phase 13.3B — public, anonymous, token-scoped read for the customer-facing
// Change Order approval page (src/routes/change-order.$token.tsx).
//
// Security audit (post-13.3B), Parts 2 + 5: the customer-safe payload is
// now built ENTIRELY from the immutable project_change_order_versions
// snapshot for the token's exact version — never from the (mutable, in
// theory-only-but-still) live project_change_orders/project_change_order_items
// rows. The live row is read only to check lifecycle state (status,
// version, first_viewed_at) — none of its content fields are returned.
// Since the snapshot was built server-side at send time with an explicit
// field allowlist (see change-order-send.ts), this also guarantees
// internal_notes/reason/internal_cost/internal_markup/org-internal ids can
// never leak here even by accident — they were never written into the
// snapshot in the first place.
//
// First-view tracking is now a single atomic UPDATE ... WHERE
// first_viewed_at IS NULL, so two concurrent first-time requests can never
// both "win" and insert two "viewed" audit rows.
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

function notFound() {
  return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: "Change Order not found" }) };
}

type Snapshot = {
  changeOrderNumber: string;
  version: number;
  title: string;
  scope: string | null;
  customerMessage: string | null;
  items: { name: string; description: string | null; quantity: number; unit: string | null; unitPrice: number; lineTotal: number }[];
  subtotal: number; discountAmount: number; markupAmount: number; taxAmount: number; totalAmount: number;
  scheduleImpactDays: number; proposedStartDate: string | null; proposedCompletionDate: string | null; approvalDueAt: string | null;
  project: { id: string; name: string } | null;
};

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "GET") return { statusCode: 405, headers: HEADERS, body: "Method Not Allowed" };

  const token = event.queryStringParameters?.token;
  if (!token || token.length < 32) return notFound();

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const { data: tokenRow, error: tokenError } = await supabaseAdmin
    .from("project_change_order_access_tokens")
    .select("id, change_order_id, version, expires_at, revoked_at, first_used_at, recipient_email")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (tokenError || !tokenRow) return notFound();
  // Customer-facing UX fix: a revoked token most commonly means the
  // customer (or someone on their behalf) already acted on this exact
  // link -- "revoked" is accurate but reads like something went wrong.
  // Deliberately does not say WHO acted or WHAT the outcome was; that
  // information isn't safely inferable from the token/version alone once
  // it's this stale (a superseding revision revokes the parent's tokens
  // too), so the message stays intentionally generic. HTTP 410 (Gone) is
  // still the correct status code -- only the message text changed.
  if (tokenRow.revoked_at) {
    return {
      statusCode: 410, headers: HEADERS,
      body: JSON.stringify({ error: "This Change Order Has Already Been Completed. This approval link is no longer active. The Change Order may already have been approved, declined, replaced, or cancelled." }),
    };
  }
  if (new Date(tokenRow.expires_at) < new Date()) {
    return {
      statusCode: 410, headers: HEADERS,
      body: JSON.stringify({ error: "This approval link has expired. Please contact your contractor for an updated link." }),
    };
  }

  // Lifecycle-only read -- id/org/project/status/version/first_viewed_at.
  // No content field from this row is ever placed in the response below.
  const { data: co, error: coError } = await supabaseAdmin
    .from("project_change_orders")
    .select("id, org_id, project_id, status, version, first_viewed_at, approval_due_at")
    .eq("id", tokenRow.change_order_id)
    .maybeSingle();

  if (coError || !co) return notFound();
  if (co.version !== tokenRow.version) return { statusCode: 410, headers: HEADERS, body: JSON.stringify({ error: "This approval link refers to an outdated version of this Change Order." }) };
  if (!["sent", "viewed", "approved", "rejected"].includes(co.status)) return notFound();

  const { data: versionRow, error: versionError } = await supabaseAdmin
    .from("project_change_order_versions")
    .select("snapshot")
    .eq("change_order_id", co.id)
    .eq("version", co.version)
    .maybeSingle();

  if (versionError || !versionRow?.snapshot) {
    // No immutable snapshot exists for this version -- there is nothing
    // customer-safe to serve. This should be unreachable in practice (a
    // token can only be issued once a snapshot exists, per
    // validate_project_change_order_access_token()) but is treated as a
    // hard failure rather than falling back to any live-row data.
    return notFound();
  }
  const snapshot = versionRow.snapshot as Snapshot;

  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select("name, public_name, phone, logo_url, primary_color, address, website")
    .eq("id", co.org_id)
    .maybeSingle();

  // Atomic first-view claim: only the request that actually flips
  // first_viewed_at from null wins the race, so exactly one "viewed"
  // approval row is ever written no matter how many concurrent requests
  // arrive for a brand-new link.
  let effectiveStatus = co.status;
  if (co.status === "sent" || co.status === "viewed") {
    const nextStatus = co.status === "sent" ? "viewed" : co.status;
    const { data: claimed } = await supabaseAdmin
      .from("project_change_orders")
      .update({ status: nextStatus, first_viewed_at: new Date().toISOString() })
      .eq("id", co.id)
      .is("first_viewed_at", null)
      .select("id")
      .maybeSingle();

    if (claimed) {
      effectiveStatus = nextStatus;
      if (co.status === "sent") {
        await supabaseAdmin.from("project_change_order_approvals").insert({
          org_id: co.org_id, project_id: co.project_id, change_order_id: co.id, version: co.version,
          action: "viewed", actor_type: "customer", actor_email: tokenRow.recipient_email ?? null, source: "portal",
        });
      }
    } else if (co.status === "sent") {
      // Lost the race, but a prior request already flipped sent -> viewed.
      effectiveStatus = "viewed";
    }
  }

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      changeOrder: {
        number: snapshot.changeOrderNumber,
        version: snapshot.version,
        title: snapshot.title,
        scope: snapshot.scope,
        customerMessage: snapshot.customerMessage,
        status: effectiveStatus,
        currency: "USD",
        subtotal: Number(snapshot.subtotal ?? 0),
        discountAmount: Number(snapshot.discountAmount ?? 0),
        markupAmount: Number(snapshot.markupAmount ?? 0),
        taxAmount: Number(snapshot.taxAmount ?? 0),
        totalAmount: Number(snapshot.totalAmount ?? 0),
        scheduleImpactDays: Number(snapshot.scheduleImpactDays ?? 0),
        proposedStartDate: snapshot.proposedStartDate,
        proposedCompletionDate: snapshot.proposedCompletionDate,
        approvalDueAt: snapshot.approvalDueAt,
        projectName: snapshot.project?.name ?? null,
        projectAddress: null,
      },
      items: (snapshot.items ?? []).map((i, index) => ({
        id: `${co.id}:${index}`, position: index, itemType: "service",
        name: i.name, description: i.description, quantity: Number(i.quantity ?? 0),
        unit: i.unit, unitPrice: Number(i.unitPrice ?? 0), lineTotal: Number(i.lineTotal ?? 0),
        taxable: true,
      })),
      // Attachments: schema linkage exists (project_files.change_order_id)
      // but no attachment UI has been built yet (Change Order form drawer
      // has no Attachments tab), so nothing customer-visible is attached
      // to any Change Order today. When that ships, this endpoint must
      // resolve short-lived signed URLs here at request time for
      // is_customer_visible=true files stored in the private project-media
      // bucket — never persist a signed URL into the snapshot itself.
      attachments: [],
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
