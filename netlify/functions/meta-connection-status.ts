// netlify/functions/meta-connection-status.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────────────────
// meta-connection-status.ts
//
// Returns ALL of the org's meta_connections rows (one per connected
// product — see supabase/migrations/006_meta_connections_per_product.sql),
// minus the encrypted access_token, for display in Settings → Integrations.
// Each product (whatsapp/messenger/instagram/lead_ads/ads) is fully
// independent; there is no shared "connected_products" array anymore.
// Auth required — caller must be a logged-in org member.
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
  if (event.httpMethod !== "GET") {
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

  // Explicitly typed here because supabaseAdmin is created via createClient()
  // with no <Database> generic anywhere in this codebase, so the Supabase
  // client can't infer a row shape for .select() and TypeScript falls back
  // to GenericStringError, which breaks property access below (row.product).
  // Same fix pattern as meta-oauth-callback.ts's existingRow — see
  // .claude/skills/meta-integrations/SKILL.md for the full explanation.
  interface MetaConnectionRow {
    product: string;
    meta_user_id: string;
    meta_user_name: string | null;
    meta_user_picture_url: string | null;
    business_id: string | null;
    business_name: string | null;
    page_id: string | null;
    page_name: string | null;
    ig_actor_id: string | null;
    ig_username: string | null;
    waba_id: string | null;
    waba_phone_number_id: string | null;
    waba_display_phone: string | null;
    ad_account_id: string | null;
    ad_account_name: string | null;
    is_active: boolean;
    expires_at: string | null;
    updated_at: string;
  }

  const { data: connections, error } = (await supabaseAdmin
    .from("meta_connections")
    .select(
      "product, meta_user_id, meta_user_name, meta_user_picture_url, business_id, business_name, page_id, page_name, ig_actor_id, ig_username, waba_id, waba_phone_number_id, waba_display_phone, ad_account_id, ad_account_name, is_active, expires_at, updated_at",
    )
    .eq("org_id", orgId)) as unknown as { data: MetaConnectionRow[] | null; error: any };

  if (error) {
    console.error("[meta-connection-status] query error:", error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Lookup failed" }) };
  }

  // Keyed by product for convenient frontend lookup
  // (connections.whatsapp, connections.ads, etc.) — `connections` is an
  // array from Supabase since there can be 0-5 rows per org now.
  const byProduct: Record<string, MetaConnectionRow> = {};
  for (const row of connections ?? []) {
    byProduct[row.product] = row;
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ connections: byProduct }) };
};