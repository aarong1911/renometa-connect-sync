// netlify/functions/lib/meta-ads-context.ts
//
// Server-side resolution of "which Meta Ads connection/ad account does this
// request act on" — the security boundary future Meta Ads endpoints
// (campaigns, ad sets, ads, Insights — none built in this task) must reuse
// rather than each independently trusting a browser-supplied org_id or
// ad_account_id. Two exports:
//
//   loadMetaAdsConnection — loads THIS org's "ads" product meta_connections
//     row and decrypts its token, WITHOUT requiring an ad account to
//     already be selected. Used by meta-ads-accounts.ts (discovery) and
//     meta-ads-select-account.ts (selection), both of which must work
//     before a selection exists.
//
//   resolveMetaAdsContext — the same, but additionally requires a
//     currently-selected ad account (fails with no_ad_account_selected
//     otherwise). This is the one future campaign/Insights endpoints should
//     call — never accepts an org id or ad account id as an argument from
//     the caller's request, only derives both from the authenticated
//     bearer token.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./resolve-org";
import { decryptMetaAccessToken } from "./meta-token-crypto";

interface MetaConnectionRowForContext {
  id: string;
  access_token: string | null;
  ad_account_id: string | null;
  ad_account_name: string | null;
}

export interface LoadedMetaAdsConnection {
  connectionId: string;
  accessToken: string;
  selectedAdAccountId: string | null;
  selectedAdAccountName: string | null;
}

export type LoadMetaAdsConnectionResult =
  | { ok: true; connection: LoadedMetaAdsConnection }
  | { ok: false; errorCode: "not_connected" | "token_decrypt_failed" };

export async function loadMetaAdsConnection(
  supabaseAdmin: SupabaseClient,
  orgId: string,
): Promise<LoadMetaAdsConnectionResult> {
  const { data: conn } = (await supabaseAdmin
    .from("meta_connections")
    .select("id, access_token, ad_account_id, ad_account_name")
    .eq("org_id", orgId)
    .eq("product", "ads")
    .maybeSingle()) as unknown as { data: MetaConnectionRowForContext | null };

  if (!conn || !conn.access_token) return { ok: false, errorCode: "not_connected" };

  let accessToken: string;
  try {
    accessToken = decryptMetaAccessToken(conn.access_token);
  } catch {
    return { ok: false, errorCode: "token_decrypt_failed" };
  }

  return {
    ok: true,
    connection: {
      connectionId: conn.id,
      accessToken,
      selectedAdAccountId: conn.ad_account_id,
      selectedAdAccountName: conn.ad_account_name,
    },
  };
}

export type MetaAdsContextErrorCode = "unauthorized" | "not_connected" | "no_ad_account_selected" | "token_decrypt_failed";

export type ResolveMetaAdsContextResult =
  | {
      ok: true;
      userId: string;
      orgId: string;
      connectionId: string;
      accessToken: string;
      /** Canonical — numeric only, no "act_" prefix. Use toMetaAdAccountGraphId() before calling a Graph object path. */
      selectedAdAccountId: string;
      selectedAdAccountName: string | null;
    }
  | { ok: false; errorCode: MetaAdsContextErrorCode };

export async function resolveMetaAdsContext(
  supabaseAdmin: SupabaseClient,
  authHeader: string | undefined,
): Promise<ResolveMetaAdsContextResult> {
  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, authHeader);
  if (!resolved) return { ok: false, errorCode: "unauthorized" };
  const { userId, orgId } = resolved;

  const loaded = await loadMetaAdsConnection(supabaseAdmin, orgId);
  if (!loaded.ok) return { ok: false, errorCode: loaded.errorCode };

  if (!loaded.connection.selectedAdAccountId) {
    return { ok: false, errorCode: "no_ad_account_selected" };
  }

  return {
    ok: true,
    userId,
    orgId,
    connectionId: loaded.connection.connectionId,
    accessToken: loaded.connection.accessToken,
    selectedAdAccountId: loaded.connection.selectedAdAccountId,
    selectedAdAccountName: loaded.connection.selectedAdAccountName,
  };
}
