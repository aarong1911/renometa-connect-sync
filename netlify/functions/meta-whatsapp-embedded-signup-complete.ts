// netlify/functions/meta-whatsapp-embedded-signup-complete.ts
//
// WhatsApp Embedded Signup / coexistence, Phase 1 (2026-09). Backend
// completion of the FB.login({config_id, extras:{featureType:
// "whatsapp_business_app_onboarding"}}) flow the Phase 2 frontend will
// launch — NOT wired to any live UI yet in Phase 1 (see that phase's own
// report: no JS SDK, no FB.login(), no message listener exist in the
// frontend today).
//
// This is deliberately a SEPARATE endpoint from meta-oauth-callback.ts —
// that file handles the classic server-redirect `dialog/oauth` flow used
// by every other Meta product (Messenger, Instagram, Lead Ads, Ads, and
// WhatsApp's own non-coexistence candidate-enumeration path); Embedded
// Signup coexistence is a JS-SDK-driven, client-side popup flow with a
// completely different completion mechanism (a `postMessage` event, not a
// server-side redirect) — mixing the two into one file would blur two
// genuinely different trust/data flows.
//
// ── TRUST MODEL ───────────────────────────────────────────────────────────
//
// The browser supplies ONLY:
//   - `code` — the short-lived (30s TTL, per Meta's own documentation)
//     authorization code from FB.login()'s response.authResponse.code
//   - `phoneNumberId` — from the WA_EMBEDDED_SIGNUP completion event's
//     `data.phone_number_id`
//   - `wabaId` (optional) — from the same event's `data.waba_id`
//   - `businessId` (optional) — from the same event's `data.business_id`,
//     if Meta returned one
//
// The browser NEVER supplies an access token, the app secret, or any
// display/name/quality/platform metadata as trusted values — every one of
// those is re-derived here from Meta's own live Graph response using the
// token THIS endpoint obtains server-side, exactly the same discipline
// meta-whatsapp-validate-number.ts already applies to the manual-fallback
// phoneNumberId. wabaId/businessId from the completion event are
// best-effort validated (a failed WABA validation does not block
// completion — the candidate proceeds with wabaId: null, exactly like the
// manual-fallback path already tolerates) since phoneNumberId is the one
// value this whole architecture treats as load-bearing (see the
// coexistence-architecture audit's own report for why waba_id is metadata
// only).
//
// ── WRITE PATH ────────────────────────────────────────────────────────────
//
// This endpoint NEVER writes meta_connections directly. It stages the
// validated result into meta_whatsapp_pending_selections (the SAME table
// the multi-candidate OAuth-redirect flow already uses) via
// reservePendingSelection() — completely unchanged code — and returns a
// selectionToken + one safe candidate to the browser. The browser then
// completes the connection through the EXISTING, unmodified
// meta-whatsapp-select-number.ts endpoint (finalize_meta_whatsapp_selection
// RPC), the same call every enumerated-candidate and manually-validated
// connection already goes through. This keeps the atomic write path,
// replay protection, and org/user scoping entirely centralized in code
// that has already been tested and empirically validated against a real
// Postgres instance in an earlier pass — nothing about it is touched or
// re-implemented here.
//
// ── CODE REPLAY PROTECTION ───────────────────────────────────────────────
//
// No separate nonce table is used here (unlike meta-oauth-start.ts's
// meta_oauth_nonces for the redirect flow) — Meta's own OAuth code
// exchange endpoint is documented as single-use per authorization code;
// a replayed `code` is rejected by Meta itself at the exchange step
// (caught as a failed exchange below), which is what the Phase 1 test
// suite exercises. This should be re-confirmed against Meta's live
// behavior during Phase 2's controlled test, not assumed with certainty
// until then.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { resolveOrgAndAuthority } from "./lib/resolve-org";
import { getAppConfigs } from "./lib/app-config-store";
import { validateWhatsAppPhoneNumberId, validateWhatsAppWabaId, type WhatsAppCandidate } from "./lib/meta-whatsapp-candidates";
import { reservePendingSelection } from "./lib/meta-whatsapp-selection-store";

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Same AES-256-GCM scheme as meta-oauth-callback.ts's own encryptToken()
// — duplicated rather than imported, matching this codebase's established
// pattern of keeping each crypto call site self-contained (see
// whatsapp-transport.ts's own header for the same reasoning applied to
// the decrypt half).
function encryptToken(plaintext: string): string {
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) throw new Error("ENCRYPTION_KEY env var is not set — cannot encrypt Meta token");
  const key = crypto.createHash("sha256").update(encKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "enc:" + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

const PHONE_NUMBER_ID_PATTERN = /^\d{5,30}$/;
const WABA_ID_PATTERN = /^\d{5,30}$/;

export type EmbeddedSignupCodeExchangeResult =
  | { ok: true; accessToken: string; expiresInSec?: number; tokenType: string }
  | { ok: false; reason: string };

// Extracted as its own exported function ONLY so it can be unit-tested
// with a mocked Meta response (test-network-guard.mjs) without needing a
// real Supabase Auth session — same "small, justified extraction, not a
// broad refactor" pattern already used for agent-approve-action.ts's
// verifyActionSuccess()/idempotencyKeyFor(). Called by the handler below
// with no behavior change from having it inline.
export async function exchangeEmbeddedSignupCode(
  appId: string,
  appSecret: string,
  code: string,
): Promise<EmbeddedSignupCodeExchangeResult> {
  try {
    const tokenRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token` +
        `?client_id=${encodeURIComponent(appId)}` +
        `&client_secret=${encodeURIComponent(appSecret)}` +
        `&code=${encodeURIComponent(code)}`,
    );
    const tokenJson: any = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || typeof tokenJson.access_token !== "string" || !tokenJson.access_token) {
      console.error("[meta-whatsapp-embedded-signup-complete] code exchange failed:", {
        httpStatus: tokenRes.status,
        metaError: tokenJson?.error?.type,
        metaCode: tokenJson?.error?.code,
      });
      return { ok: false, reason: "Could not complete the WhatsApp connection — the authorization code was invalid or expired. Please try again." };
    }
    return {
      ok: true,
      accessToken: tokenJson.access_token,
      expiresInSec: typeof tokenJson.expires_in === "number" ? tokenJson.expires_in : undefined,
      tokenType: typeof tokenJson.token_type === "string" ? tokenJson.token_type : "bearer",
    };
  } catch (e) {
    console.error("[meta-whatsapp-embedded-signup-complete] code exchange request failed:", e);
    return { ok: false, reason: "Could not reach Meta to complete the WhatsApp connection — please try again." };
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const token = event.headers.authorization?.slice(7);
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };

  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Invalid token" }) };

  const { orgId, isOwnerOrAdmin } = await resolveOrgAndAuthority(supabaseAdmin, user.id);
  if (!orgId) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Could not resolve your organization." }) };
  }
  if (!isOwnerOrAdmin) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Only an organization owner or admin may connect WhatsApp." }) };
  }

  let reqBody: unknown;
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }
  const isPlainObject = typeof reqBody === "object" && reqBody !== null && !Array.isArray(reqBody);
  const body = isPlainObject ? (reqBody as Record<string, unknown>) : {};
  const code = body.code;
  const phoneNumberIdRaw = body.phoneNumberId;
  const wabaIdRaw = body.wabaId;
  const businessIdRaw = body.businessId;

  if (typeof code !== "string" || !code) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Body must include the Embedded Signup authorization code." }) };
  }
  if (typeof phoneNumberIdRaw !== "string" || !phoneNumberIdRaw) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Body must include phoneNumberId from the Embedded Signup completion event." }) };
  }
  const phoneNumberId = phoneNumberIdRaw.trim();
  if (!PHONE_NUMBER_ID_PATTERN.test(phoneNumberId)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "phoneNumberId does not look like a valid Meta phone number ID." }) };
  }
  const wabaIdCandidate = typeof wabaIdRaw === "string" && WABA_ID_PATTERN.test(wabaIdRaw.trim()) ? wabaIdRaw.trim() : null;
  const businessIdCandidate = typeof businessIdRaw === "string" && businessIdRaw.trim() ? businessIdRaw.trim() : null;

  const metaConfig = await getAppConfigs(supabaseAdmin, ["META_APP_ID", "META_APP_SECRET"]);
  const appId = metaConfig.META_APP_ID;
  const appSecret = metaConfig.META_APP_SECRET;
  if (!appId || !appSecret) {
    console.error("[meta-whatsapp-embedded-signup-complete] Meta app not configured");
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "WhatsApp is not configured on the server." }) };
  }

  // ── Exchange the Embedded Signup authorization code server-side ───────
  //
  // The JS-SDK Embedded Signup flow is NOT a redirect — FB.login() runs
  // entirely client-side in a popup, so there is no redirect_uri to match
  // here the way meta-oauth-callback.ts's redirect-based exchange needs
  // one. This is a documented assumption based on Meta's Embedded Signup
  // integration guide (the code-exchange step is not fully detailed in
  // what's publicly available); it must be re-confirmed the first time
  // this is exercised against a real Embedded Signup completion in
  // Phase 2 — if Meta's response indicates a redirect_uri IS required for
  // this code type, that's a one-line fix here, not an architecture
  // change.
  //
  // Also: the new WhatsApp Coexistence config is configured to issue a
  // system-user token with a 60-day expiration directly (see Phase 1's
  // own report) — unlike the personal-user token the classic redirect
  // flow exchanges, there is no separate short-lived-to-long-lived
  // upgrade step here; this is a single exchange call.
  const exchangeResult = await exchangeEmbeddedSignupCode(appId, appSecret, code);
  if (!exchangeResult.ok) {
    return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: exchangeResult.reason }) };
  }
  const { accessToken, expiresInSec, tokenType } = exchangeResult;

  // ── Validate the phone number Meta actually granted access to ─────────
  // Never trust phoneNumberId from the completion event beyond using it
  // as a lookup key — this call proves it's real, accessible with the
  // token just obtained, and genuinely CLOUD_API.
  const phoneValidation = await validateWhatsAppPhoneNumberId(accessToken, phoneNumberId);
  if (!phoneValidation.ok) {
    return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: phoneValidation.reason }) };
  }

  // ── Best-effort WABA validation — never blocks completion ──────────────
  let validatedWabaId: string | null = null;
  let validatedWabaName: string | null = null;
  if (wabaIdCandidate) {
    const wabaValidation = await validateWhatsAppWabaId(accessToken, wabaIdCandidate);
    if (wabaValidation.ok) {
      validatedWabaId = wabaValidation.wabaId;
      validatedWabaName = wabaValidation.name;
    } else {
      console.warn("[meta-whatsapp-embedded-signup-complete] WABA validation failed, proceeding with wabaId: null:", wabaValidation.reason);
    }
  }

  // ── Best-effort identity for the pending-selection row's metaUserId ────
  // Mirrors meta-oauth-callback.ts's own /me fetch — a system-user token
  // still resolves to a real Graph node (the system user itself), so this
  // is the same call, not a new pattern.
  let metaUserId = "unknown";
  let metaUserName: string | null = null;
  try {
    const meRes = await fetch(`https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`);
    const me: any = await meRes.json().catch(() => ({}));
    if (meRes.ok && typeof me.id === "string" && me.id) {
      metaUserId = me.id;
      metaUserName = typeof me.name === "string" ? me.name : null;
    }
  } catch (e) {
    console.warn("[meta-whatsapp-embedded-signup-complete] /me fetch failed (non-fatal):", e);
  }

  const candidate: WhatsAppCandidate = {
    businessId: businessIdCandidate,
    businessName: null,
    wabaId: validatedWabaId,
    wabaName: validatedWabaName,
    phoneNumberId: phoneValidation.phoneNumberId,
    displayPhoneNumber: phoneValidation.displayPhoneNumber,
    verifiedName: phoneValidation.verifiedName,
    qualityRating: phoneValidation.qualityRating,
  };

  const selectionToken = crypto.randomBytes(32).toString("hex");
  const selectionTokenHash = crypto.createHash("sha256").update(selectionToken).digest("hex");
  const selectionExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const reserveResult = await reservePendingSelection(supabaseAdmin, {
    selectionTokenHash,
    orgId,
    userId: user.id,
    product: "whatsapp",
    encryptedAccessToken: encryptToken(accessToken),
    tokenType,
    tokenExpiresAt: expiresInSec ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null,
    grantedScopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
    metaUserId,
    metaUserName,
    metaUserPictureUrl: null,
    pageId: null,
    pageName: null,
    candidates: [candidate],
    expiresAt: selectionExpiresAt,
  });
  if (!reserveResult.ok) {
    console.error("[meta-whatsapp-embedded-signup-complete] pending selection reservation failed:", reserveResult.error);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not stage the WhatsApp connection — please try again." }) };
  }

  // Safe subset only — no access token, no encrypted value, no raw Meta
  // payload. The browser completes the connection by POSTing
  // { selectionToken, phoneNumberId } to the EXISTING
  // meta-whatsapp-select-number.ts endpoint, exactly like any other
  // candidate.
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      selectionToken,
      candidate: {
        phoneNumberId: candidate.phoneNumberId,
        displayPhoneNumber: candidate.displayPhoneNumber,
        verifiedName: candidate.verifiedName,
        qualityRating: candidate.qualityRating,
        wabaName: candidate.wabaName,
      },
    }),
  };
};
