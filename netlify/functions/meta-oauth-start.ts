// netlify/functions/meta-oauth-start.ts
import type { Handler } from "@netlify/functions";
import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────
// meta-oauth-start.ts
//
// Entry point opened in a POPUP window (not a full-page redirect) from
// Settings → Integrations. Signs orgId + nonce into `state`, then 302s to
// Facebook's OAuth dialog. See .claude/skills/meta-integrations/SKILL.md.
//
// Required env vars: META_APP_ID, META_OAUTH_STATE_SECRET (or reuse
// ENCRYPTION_KEY), URL (Netlify's own deploy URL, used to build redirect_uri)
// ─────────────────────────────────────────────────────────────────────────

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

  const nonce = crypto.randomBytes(16).toString("hex");
  const statePayload = JSON.stringify({ orgId, userId, product, nonce, ts: Date.now() });
  const state = signState(statePayload, stateSecret);

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