// netlify/functions/meta-disconnect.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────────────────
// meta-disconnect.ts
//
// POST { product: "whatsapp" | "messenger" | "instagram" | "lead_ads" | "ads" }
// With the per-product schema (see
// supabase/migrations/006_meta_connections_per_product.sql), disconnecting
// a product is just deleting that ONE (org_id, product) row — it can never
// affect any other product's connection, since each lives in its own row.
// `product` is required; there's no longer a meaningful "disconnect
// everything" action here (the old version of this function tried to
// guess whether other products were "using" the same row — that ambiguity
// is exactly what the per-product schema eliminates).
// ─────────────────────────────────────────────────────────────────────────

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const authToken = event.headers.authorization?.slice(7);
  if (!authToken) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { data: { user } } = await supabaseAdmin.auth.getUser(authToken);
  if (!user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Invalid token" }) };
  }

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  const orgId = profile?.organization_id;
  if (!orgId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "No organization" }) };
  }

  let reqBody: { product?: string } = {};
  try { reqBody = JSON.parse(event.body ?? "{}"); } catch { /* default {} */ }

  if (!reqBody.product) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "product is required" }) };
  }

  const { error } = await supabaseAdmin
    .from("meta_connections")
    .delete()
    .eq("org_id", orgId)
    .eq("product", reqBody.product);

  if (error) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
};