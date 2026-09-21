// netlify/functions/meta-whatsapp-validate-number.ts
//
// "I don't see my number" manual fallback for the WhatsApp OAuth candidate
// selector — the validation half. meta-whatsapp-select-number.ts remains
// the ONLY endpoint that ever writes meta_connections; this endpoint never
// does. It exists because a repo-wide, read-only audit (this session)
// found a real case where a healthy, GREEN-quality, CLOUD_API WhatsApp
// phone number was never returned by discoverWhatsAppCandidates()'s
// enumeration (/me/businesses -> owned_whatsapp_business_accounts ->
// phone_numbers), despite being directly, individually readable by node
// id with the exact same access token. No alternate generic Meta edge
// exists anywhere in this codebase (or documented locally) that can
// discover such a number automatically — see that audit's own report.
//
// Trust model (server-authorization skill) — identical to
// meta-whatsapp-select-number.ts:
//   - Authenticated via bearer token; org/role resolved server-side via
//     resolveOrgAndAuthority() — NEVER from the request body. Owner/admin
//     only, same requirement as completing a selection.
//   - The browser supplies ONLY selectionToken + phoneNumberId. It can
//     never supply an access token, a WABA id, a business id, or any
//     display metadata (name, platform, quality) — every one of those
//     fields is re-derived here from Meta's own live response using the
//     SAME already-granted access token stored (encrypted) on the pending
//     selection row that reservation already scoped to this exact
//     org/user/product.
//   - phoneNumberId is validated with a live, read-only Graph call
//     (validateWhatsAppPhoneNumberId, lib/meta-whatsapp-candidates.ts) —
//     fails closed on any Meta error, an id mismatch, a missing
//     display_phone_number, or a platform_type other than exactly
//     "CLOUD_API".
//   - On success, the validated candidate (server-derived fields only) is
//     appended to the pending selection's own candidate list
//     (appendValidatedManualCandidate, lib/meta-whatsapp-selection-store.ts)
//     — NOT written to meta_connections. The browser must still call the
//     existing, unmodified meta-whatsapp-select-number.ts /
//     finalize_meta_whatsapp_selection RPC to actually connect it, exactly
//     like any enumerated candidate. This endpoint alone can never create
//     a live connection.
//
// Calling this endpoint (Validate) never persists a connection by itself
// — only a subsequent, separate call to meta-whatsapp-select-number.ts
// does that, through the same atomic, unmodified RPC every other
// candidate goes through.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { resolveOrgAndAuthority } from "./lib/resolve-org";
import { decryptMetaAccessToken } from "./lib/meta-token-crypto";
import { validateWhatsAppPhoneNumberId } from "./lib/meta-whatsapp-candidates";
import { loadPendingSelectionAccessToken, appendValidatedManualCandidate } from "./lib/meta-whatsapp-selection-store";

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

// A Meta phone-number-id is a numeric Graph object id — reasonable,
// non-empty digit-string validation only (not a strict length check,
// since Meta doesn't document a fixed width). Rejects anything that isn't
// plausibly an id before ever making an outbound Graph call with it.
const PHONE_NUMBER_ID_PATTERN = /^\d{5,30}$/;

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const token = event.headers.authorization?.slice(7);
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };

  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Invalid token" }) };

  // Same authority requirement as meta-whatsapp-select-number.ts — org/role
  // resolved server-side only, never from the request body.
  const { orgId, isOwnerOrAdmin } = await resolveOrgAndAuthority(supabaseAdmin, user.id);
  if (!orgId) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Could not resolve your organization." }) };
  }
  if (!isOwnerOrAdmin) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Only an organization owner or admin may validate a WhatsApp number." }) };
  }

  let reqBody: unknown;
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }
  const isPlainObject = typeof reqBody === "object" && reqBody !== null && !Array.isArray(reqBody);
  const selectionToken = isPlainObject ? (reqBody as Record<string, unknown>).selectionToken : undefined;
  const phoneNumberIdRaw = isPlainObject ? (reqBody as Record<string, unknown>).phoneNumberId : undefined;
  if (typeof selectionToken !== "string" || !selectionToken || typeof phoneNumberIdRaw !== "string" || !phoneNumberIdRaw) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Body must include selectionToken and phoneNumberId." }) };
  }

  const phoneNumberId = phoneNumberIdRaw.trim();
  if (!PHONE_NUMBER_ID_PATTERN.test(phoneNumberId)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "That doesn't look like a valid Meta phone number ID — it should be a numeric ID from WhatsApp Manager." }) };
  }

  const selectionTokenHash = crypto.createHash("sha256").update(selectionToken).digest("hex");

  const tokenLookup = await loadPendingSelectionAccessToken(supabaseAdmin, {
    selectionTokenHash,
    orgId,
    userId: user.id,
    product: "whatsapp",
  });
  if (!tokenLookup.ok) {
    return { statusCode: 410, headers: CORS, body: JSON.stringify({ error: "This selection has expired or was already used — please reconnect WhatsApp." }) };
  }

  let accessToken: string;
  try {
    accessToken = decryptMetaAccessToken(tokenLookup.encryptedAccessToken);
  } catch (e: any) {
    console.error("[meta-whatsapp-validate-number] token decrypt failed:", e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not read stored credentials — please reconnect WhatsApp." }) };
  }

  const validation = await validateWhatsAppPhoneNumberId(accessToken, phoneNumberId);
  if (!validation.ok) {
    return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: validation.reason }) };
  }

  // Stage the server-derived candidate onto the SAME pending selection so
  // the browser's subsequent (separate) call to the existing
  // meta-whatsapp-select-number.ts endpoint can finalize it through the
  // unmodified, already-atomic RPC — this call itself persists nothing to
  // meta_connections.
  const appendResult = await appendValidatedManualCandidate(supabaseAdmin, {
    selectionTokenHash,
    orgId,
    userId: user.id,
    product: "whatsapp",
    candidate: {
      businessId: null,
      businessName: null,
      wabaId: null,
      wabaName: null,
      phoneNumberId: validation.phoneNumberId,
      displayPhoneNumber: validation.displayPhoneNumber,
      verifiedName: validation.verifiedName,
      qualityRating: validation.qualityRating,
    },
  });
  if (!appendResult.ok) {
    if (appendResult.reason === "not_found" || appendResult.reason === "consumed" || appendResult.reason === "expired") {
      return { statusCode: 410, headers: CORS, body: JSON.stringify({ error: "This selection has expired or was already used — please reconnect WhatsApp." }) };
    }
    console.error("[meta-whatsapp-validate-number] could not stage validated candidate:", appendResult.reason);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not save this number — please try again." }) };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      phoneNumberId: validation.phoneNumberId,
      displayPhoneNumber: validation.displayPhoneNumber,
      verifiedName: validation.verifiedName,
      codeVerificationStatus: validation.codeVerificationStatus,
      platformType: validation.platformType,
      qualityRating: validation.qualityRating,
    }),
  };
};
