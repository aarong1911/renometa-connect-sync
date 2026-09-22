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
//   - selectionToken alone is NOT sufficient to act — the RPC additionally
//     scopes by org_id + user_id + product (never selectionToken alone),
//     so a leaked/guessed token still can't be redeemed by anyone other
//     than the exact owner/admin this selection was reserved for.
//   - phoneNumberId is validated INSIDE the RPC against the candidates
//     list stored server-side at OAuth-callback time — a tampered/
//     unlisted id can never reach the meta_connections write, and never
//     burns the selection token either.
//
// Atomicity fix (2026-09-18): consuming the pending selection and writing
// meta_connections used to be two separate Supabase calls — a failure
// between them could permanently burn a selection token with no
// connection ever saved. Both steps (plus candidate validation) now
// happen inside ONE Postgres transaction via the
// finalize_meta_whatsapp_selection(...) RPC (see supabase/migrations/
// 20260917_meta_whatsapp_pending_selections.sql) — a single call here,
// not consume-then-finalize. The RPC also owns copying the already-
// encrypted access token from the pending row into meta_connections, so
// this endpoint no longer decrypts/re-encrypts anything itself.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { resolveOrgAndAuthority } from "./lib/resolve-org";
import { finalizeMetaWhatsAppSelectionAtomic } from "./lib/meta-whatsapp-selection-store";
import { decryptMetaAccessToken } from "./lib/meta-token-crypto";
import { ensureWhatsAppAppSubscription } from "./lib/meta-whatsapp-subscription";

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
  // Authorization stays entirely in TypeScript — the RPC is never given
  // the ability to decide who's allowed to call it beyond its own
  // service-role-only grant (see the migration).
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

  const selectionTokenHash = crypto.createHash("sha256").update(selectionToken).digest("hex");

  const result = await finalizeMetaWhatsAppSelectionAtomic(supabaseAdmin, {
    selectionTokenHash,
    orgId,
    userId: user.id,
    phoneNumberId,
  });

  if (!result.ok) {
    console.error("[meta-whatsapp-select-number] finalize RPC failed:", result.error);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not complete the WhatsApp connection — please try again." }) };
  }

  if (result.status === "not_found_or_expired") {
    return { statusCode: 410, headers: CORS, body: JSON.stringify({ error: "This selection has expired or was already used — please reconnect WhatsApp." }) };
  }
  if (result.status === "invalid_candidate") {
    console.warn("[meta-whatsapp-select-number] submitted phoneNumberId did not match any reserved candidate — rejected by RPC.");
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "That WhatsApp number is not one of the available choices — please reconnect." }) };
  }

  // WhatsApp Embedded Signup / coexistence, Phase 2 — smallest safe
  // server-side integration point for the Phase 1 subscribed_apps helper:
  // this is the ONE place a real WhatsApp connection is ever finalized,
  // for every candidate source (enumerated OAuth selection, the manual
  // phoneNumberId fallback, and Embedded Signup coexistence alike) — so
  // it's the correct place to ensure the app is subscribed to the
  // resulting WABA's webhook events, rather than duplicating this in
  // multiple callers.
  //
  // Best-effort ONLY: a subscription failure (or a null waba_id, e.g. the
  // manual-fallback path, which never resolves a WABA at all) must never
  // fail or roll back a connection that Meta itself already confirmed —
  // the connection has already been atomically committed by the RPC
  // above by the time this runs. Never fabricates a waba_id; a null one
  // is reported as "verification_needed", not silently ignored or
  // treated as success.
  let subscriptionStatus: "subscribed" | "already_subscribed" | "verification_needed" | "check_failed" = "verification_needed";
  try {
    const { data: connRow, error: connErr } = await supabaseAdmin
      .from("meta_connections")
      .select("waba_id, access_token")
      .eq("org_id", orgId)
      .eq("product", "whatsapp")
      .maybeSingle();
    if (connErr) {
      console.error("[meta-whatsapp-select-number] post-finalize connection lookup failed:", connErr.message);
    } else if (connRow?.waba_id && connRow.access_token) {
      const accessToken = decryptMetaAccessToken(connRow.access_token as string);
      const subResult = await ensureWhatsAppAppSubscription(connRow.waba_id as string, accessToken);
      if (subResult.ok) {
        subscriptionStatus = subResult.alreadySubscribed ? "already_subscribed" : "subscribed";
      } else {
        console.warn("[meta-whatsapp-select-number] WhatsApp app subscription not established:", subResult.errorCode);
        subscriptionStatus = "check_failed";
      }
    }
    // connRow?.waba_id missing/null — leaves subscriptionStatus at its
    // "verification_needed" default (e.g. the manual phoneNumberId
    // fallback path, which never resolves a WABA id).
  } catch (e) {
    console.error("[meta-whatsapp-select-number] post-finalize subscription step failed (connection itself still succeeded):", e);
    subscriptionStatus = "check_failed";
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      connection: {
        businessName: result.businessName,
        wabaDisplayPhone: result.wabaDisplayPhone,
        verifiedName: result.verifiedName,
      },
      subscriptionStatus,
    }),
  };
};
