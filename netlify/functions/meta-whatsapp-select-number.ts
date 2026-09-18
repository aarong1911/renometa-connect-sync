// netlify/functions/meta-whatsapp-select-number.ts
//
// WhatsApp OAuth connection-quality fix — the completion endpoint for the
// "multiple candidates" branch added to meta-oauth-callback.ts. That file
// no longer silently picks `data[0]` when Meta returns more than one
// business/WABA/phone-number combination; instead it reserves a
// short-lived meta_whatsapp_pending_selections row (encrypted token +
// full candidate list) and hands the browser only a safe candidate list
// plus an opaque selectionToken. This endpoint is where the owner/admin's
// actual choice gets turned into the real meta_connections write — the
// ONLY place that write happens for the multi-candidate path.
//
// Trust model (server-authorization skill):
//   - Authenticated via bearer token, org/role resolved server-side via
//     resolveOrgAndAuthority() — NEVER from the request body. Owner/admin
//     only, matching every other privileged integration-connection action
//     in this codebase (Google Ads' select-account endpoint, AI Center's
//     settings endpoints).
//   - selectionToken alone is NOT sufficient to act — the caller must ALSO
//     be an authenticated owner/admin of the SAME org/user the pending
//     selection was reserved for (see the conditional UPDATE below, scoped
//     by org_id + user_id + product, not selectionToken alone).
//   - phoneNumberId is validated against the candidates list STORED
//     server-side at OAuth-callback time, in the same reserved row — a
//     tampered/unlisted id can never reach the meta_connections upsert.
//   - The Meta access token was already encrypted before this row was
//     ever written; it's decrypted here only long enough to write it into
//     meta_connections in the same encrypted form other Meta OAuth code
//     already uses. Never returned to the browser.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { resolveOrgAndAuthority } from "./lib/resolve-org";
import { consumePendingSelection, finalizeWhatsAppConnection, matchCandidateByPhoneNumberId } from "./lib/meta-whatsapp-selection-store";

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

// Same AES-256-GCM scheme meta-oauth-callback.ts uses to write
// meta_connections.access_token — this endpoint decrypts the token stored
// in meta_whatsapp_pending_selections.encrypted_access_token (encrypted
// the same way) only long enough to re-write it, encrypted, into
// meta_connections.
function decryptToken(stored: string): string {
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) throw new Error("ENCRYPTION_KEY env var is not set — cannot decrypt Meta token");
  if (!stored.startsWith("enc:")) throw new Error("Unexpected token format");
  const raw = Buffer.from(stored.slice(4), "base64");
  const key = crypto.createHash("sha256").update(encKey).digest();
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

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

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const token = event.headers.authorization?.slice(7);
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };

  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Invalid token" }) };

  // Org/role ALWAYS resolved server-side from the authenticated user —
  // never accepted from the request body (server-authorization skill).
  const { orgId, isOwnerOrAdmin } = await resolveOrgAndAuthority(supabaseAdmin, user.id);
  if (!orgId) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Could not resolve your organization." }) };
  }
  if (!isOwnerOrAdmin) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Only an organization owner or admin may complete a WhatsApp connection." }) };
  }

  let reqBody: unknown;
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }
  const isPlainObject = typeof reqBody === "object" && reqBody !== null && !Array.isArray(reqBody);
  const selectionToken = isPlainObject ? (reqBody as Record<string, unknown>).selectionToken : undefined;
  const phoneNumberId = isPlainObject ? (reqBody as Record<string, unknown>).phoneNumberId : undefined;
  if (typeof selectionToken !== "string" || !selectionToken || typeof phoneNumberId !== "string" || !phoneNumberId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Body must include selectionToken and phoneNumberId." }) };
  }

  // Atomically consume the reserved selection — a conditional UPDATE, not
  // a SELECT-then-UPDATE, so two concurrent submissions of the same
  // selectionToken can never both succeed. Scoped to org_id + user_id +
  // product (never selectionToken alone) so a leaked/guessed token still
  // can't be redeemed by anyone other than the exact owner/admin this
  // selection was reserved for in the same org.
  const selectionTokenHash = crypto.createHash("sha256").update(selectionToken).digest("hex");
  const nowIso = new Date().toISOString();
  const consumeResult = await consumePendingSelection(supabaseAdmin, {
    selectionTokenHash,
    orgId,
    userId: user.id,
    product: "whatsapp",
    nowIso,
  });

  if (!consumeResult.ok) {
    if (consumeResult.reason === "db_error") {
      console.error("[meta-whatsapp-select-number] selection consume query failed:", consumeResult.error);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not complete the WhatsApp connection — please try again." }) };
    }
    return { statusCode: 410, headers: CORS, body: JSON.stringify({ error: "This selection has expired or was already used — please reconnect WhatsApp." }) };
  }
  const row = consumeResult.row;

  // Fail closed if the submitted phoneNumberId isn't literally one of the
  // candidates discovered for THIS exact OAuth transaction — never trust
  // a client-supplied id beyond matching it against trusted server data.
  const matched = matchCandidateByPhoneNumberId(row.candidates, phoneNumberId);
  if (!matched) {
    console.warn("[meta-whatsapp-select-number] submitted phoneNumberId did not match any reserved candidate — rejecting.");
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "That WhatsApp number is not one of the available choices — please reconnect." }) };
  }

  let accessToken: string;
  try {
    accessToken = decryptToken(row.encrypted_access_token);
  } catch (e: any) {
    console.error("[meta-whatsapp-select-number] token decrypt failed:", e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not complete the WhatsApp connection — please try again." }) };
  }

  // Same final write meta-oauth-callback.ts performs for the
  // single-candidate case — ONE ROW PER (org_id, product), never touches
  // Messenger/Instagram/Ads/Lead Ads rows (those are separate rows under
  // the per-product schema).
  const finalizeResult = await finalizeWhatsAppConnection(supabaseAdmin, {
    orgId,
    userId: user.id,
    metaUserId: row.meta_user_id,
    metaUserName: row.meta_user_name,
    metaUserPictureUrl: row.meta_user_picture_url,
    businessId: matched.businessId,
    businessName: matched.businessName,
    fallbackPageId: row.page_id,
    fallbackPageName: row.page_name,
    wabaId: matched.wabaId,
    wabaPhoneNumberId: matched.phoneNumberId,
    wabaDisplayPhone: matched.displayPhoneNumber,
    encryptedAccessToken: encryptToken(accessToken),
    tokenType: row.token_type,
    tokenExpiresAt: row.token_expires_at,
    grantedScopes: row.granted_scopes,
    nowIso,
  });

  if (!finalizeResult.ok) {
    console.error("[meta-whatsapp-select-number] meta_connections upsert failed:", finalizeResult.error);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not save the WhatsApp connection — please try again." }) };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      connection: {
        businessName: matched.businessName,
        wabaDisplayPhone: matched.displayPhoneNumber,
        verifiedName: matched.verifiedName,
      },
    }),
  };
};
