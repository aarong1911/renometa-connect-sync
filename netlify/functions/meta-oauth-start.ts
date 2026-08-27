// netlify/functions/meta-oauth-start.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────
// meta-oauth-start.ts
//
// Entry point opened in a POPUP window (not a full-page redirect) from
// Settings → Integrations. Signs orgId + nonce into `state`, RESERVES the
// nonce (hashed) in meta_oauth_nonces so meta-oauth-callback.ts can enforce
// single-use consumption (see supabase/migrations/20260905_meta_oauth_nonces.sql
// — NOT applied yet; this reservation insert will fail until it is), then
// 302s to Facebook's OAuth dialog. See .claude/skills/meta-integrations/SKILL.md.
//
// The HMAC-signed `state` alone only proves the callback wasn't forged/
// tampered with and hasn't expired — it does NOT make the nonce single-use
// (a captured, still-valid state could otherwise be replayed within the
// TTL window). The DB reservation below is what makes replay fail.
//
// Required env vars: META_APP_ID, META_OAUTH_STATE_SECRET (or reuse
// ENCRYPTION_KEY), URL (Netlify's own deploy URL, used to build redirect_uri)
// ─────────────────────────────────────────────────────────────────────────

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const NONCE_TTL_MS = 10 * 60 * 1000; // must match the state payload's own TTL check in meta-oauth-callback.ts

const PRODUCT_SCOPES: Record<string, string[]> = {
  whatsapp: ["whatsapp_business_management", "whatsapp_business_messaging", "business_management"],
  "fb-messenger": ["pages_messaging", "pages_show_list", "business_management"],
  "instagram-direct": ["instagram_basic", "instagram_manage_messages", "pages_show_list", "business_management"],
  "meta-lead-ads": ["pages_show_list", "pages_manage_ads", "pages_read_engagement", "business_management"],
  "meta-ads": ["ads_management", "ads_read", "business_management"],
};

function signState(payload: string, secret: string): string {
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

export const handler: Handler = async (event) => {
  const params = event.queryStringParameters ?? {};
  const orgId = params.orgId;
  const userId = params.userId;
  const product = params.product ?? "whatsapp";

  if (!orgId) {
    return { statusCode: 400, body: "Missing orgId" };
  }
  if (!userId) {
    return { statusCode: 400, body: "Missing userId" };
  }

  const stateSecret = process.env.META_OAUTH_STATE_SECRET || process.env.ENCRYPTION_KEY;
  const appId = process.env.META_APP_ID;
  if (!stateSecret || !appId) {
    return { statusCode: 500, body: "Meta OAuth is not configured (missing META_APP_ID or META_OAUTH_STATE_SECRET)" };
  }

  // 32 random bytes (upgraded from the prior 16 — a stronger single-use
  // token now that a DB-persisted hash of it is the actual replay guard,
  // not just an opaque value inside the signed state).
  const nonce = crypto.randomBytes(32).toString("hex");
  const nonceHash = crypto.createHash("sha256").update(nonce).digest("hex");
  const now = Date.now();
  const statePayload = JSON.stringify({ orgId, userId, product, nonce, ts: now });
  const state = signState(statePayload, stateSecret);

  // Reserve the nonce BEFORE redirecting — bound to this exact org/user/
  // product so the callback's conditional consume can verify the nonce was
  // minted for the same context it's being redeemed in, not just that some
  // valid-looking signed state was presented. Only the hash is stored.
  const { error: nonceInsertErr } = await supabaseAdmin.from("meta_oauth_nonces").insert({
    nonce_hash: nonceHash,
    org_id: orgId,
    user_id: userId,
    product,
    expires_at: new Date(now + NONCE_TTL_MS).toISOString(),
  });
  if (nonceInsertErr) {
    console.error("[meta-oauth-start] nonce reservation failed:", nonceInsertErr.code);
    return { statusCode: 500, body: "Could not start the Meta connection — please try again" };
  }

  const siteUrl = process.env.URL || "https://connect.renometa.com";
  const redirectUri = `${siteUrl}/.netlify/functions/meta-oauth-callback`;

  const scopes = (PRODUCT_SCOPES[product] ?? PRODUCT_SCOPES.whatsapp).join(",");

  const fbAuthUrl =
    `https://www.facebook.com/v21.0/dialog/oauth` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&response_type=code`;

  return {
    statusCode: 302,
    headers: { Location: fbAuthUrl },
    body: "",
  };
};