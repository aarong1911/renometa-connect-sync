// netlify/functions/meta-ads-accounts.ts
//
// Read-only Meta Ads Business/ad-account discovery — Phase 1A / Step 1
// (Part C). Authenticated RenoMeta user only; org and Meta connection are
// both resolved server-side, never from the browser. Never returns
// access_token, encrypted token, app secret, OAuth state, or nonce.
//
// GET, no request body. Response shape:
//   connected: false                                  -> not connected yet
//   connected: true, selectionState: "connected"       -> selectedAdAccountId is usable
//   connected: true, selectionState: "needs_account_selection" | "needs_account_sync"
//                                                       -> selectedAdAccountId is null
//
// Auto-persists a selection ONLY for the "first connection, exactly one
// accessible account" case (see deriveMetaAdsSelectionState in
// lib/meta-ads-api.ts) — never silently switches between two previously-
// valid accounts, and never clears a stale-but-previously-selected account
// from the database on its own (previousSelectionStale is surfaced in the
// response instead, so the caller/UI can decide what to do about it).

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { metaAdsCorsHeaders } from "./lib/meta-ads-cors";
import { loadMetaAdsConnection } from "./lib/meta-ads-context";
import { discoverMetaAdsAccounts, deriveMetaAdsSelectionState } from "./lib/meta-ads-api";
import { MetaGraphApiError } from "./lib/meta-graph-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export const handler: Handler = async (event) => {
  const headers = metaAdsCorsHeaders(event, "GET, OPTIONS");
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  const connResult = await loadMetaAdsConnection(supabaseAdmin, orgId);
  if (!connResult.ok) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        connected: false,
        selectionState: null,
        selectedAdAccountId: null,
        businesses: [],
        adAccounts: [],
      }),
    };
  }

  let discovery;
  try {
    discovery = await discoverMetaAdsAccounts(connResult.connection.accessToken);
  } catch (e) {
    const safe = e instanceof MetaGraphApiError ? e.toSafeJSON() : { message: "unknown" };
    console.error("[meta-ads-accounts] discovery failed", safe);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: "Could not read your Meta ad accounts right now — please try again" }),
    };
  }

  const derivation = deriveMetaAdsSelectionState(discovery.adAccounts, connResult.connection.selectedAdAccountId);

  if (derivation.shouldPersistAutoSelection && derivation.selectedAdAccountId) {
    const matched = discovery.adAccounts.find((a) => a.id === derivation.selectedAdAccountId);
    const { error: persistErr } = await supabaseAdmin
      .from("meta_connections")
      .update({
        ad_account_id: derivation.selectedAdAccountId,
        ad_account_name: matched?.name ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connResult.connection.connectionId)
      .eq("org_id", orgId)
      .eq("product", "ads");
    if (persistErr) {
      // Non-fatal — the auto-selection just doesn't stick this run; the
      // response below still reflects the correct derived state, and the
      // next call will attempt the same auto-selection again.
      console.warn("[meta-ads-accounts] auto-selection persist failed:", persistErr.code);
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      connected: true,
      selectionState: derivation.state,
      selectedAdAccountId: derivation.selectedAdAccountId,
      previousSelectionStale: derivation.previousSelectionStale,
      businesses: discovery.businesses,
      adAccounts: discovery.adAccounts,
    }),
  };
};
