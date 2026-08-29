// netlify/functions/lib/meta-page-access.ts
//
// Generic Meta Page-access utilities shared across every product that needs
// a transient Page access token or a Page webhook field subscription —
// extracted out of lib/meta-lead-ads.ts (Phase 1B / Step 2 Page Token Fix)
// so Messenger/Instagram subscription wiring (Meta Messaging Webhook
// Hardening) doesn't import a Lead-Ads-named helper into generic messaging
// code. Lead Ads still re-exports getMetaPageAccessToken/
// MetaPageTokenMissingError from here for backward compatibility with
// existing callers (meta-lead-forms.ts, meta-lead-reconcile.ts) — no call
// site outside this file changed.
//
// All Meta Graph API reads/writes go through the centralized
// netlify/functions/lib/meta-graph-api.ts client — no raw fetch() calls.
// Never logs or returns a Page access token.

import { metaGraphRequest, MetaGraphApiError } from "./meta-graph-api";

// Thrown when Meta returns a 2xx response that simply omits access_token
// (e.g. the connecting user no longer has admin access to this Page) —
// distinct from MetaGraphApiError (a Graph-level rejection, e.g. code 190
// for an expired/invalid user token).
export class MetaPageTokenMissingError extends Error {
  constructor() {
    super("Meta Page access token missing from Graph response");
    this.name = "MetaPageTokenMissingError";
  }
}

// Derives a transient Page access token from the given long-lived USER
// token. NEVER persisted — every caller uses the returned value only for
// the remainder of its own request/run and then discards it. NEVER logged.
export async function getMetaPageAccessToken(userAccessToken: string, pageId: string): Promise<string> {
  const resp = await metaGraphRequest<{ access_token?: string }>({
    path: `/${pageId}`,
    accessToken: userAccessToken,
    query: { fields: "access_token" },
  });
  if (!resp.access_token || typeof resp.access_token !== "string") {
    throw new MetaPageTokenMissingError();
  }
  return resp.access_token;
}

export type EnsurePageSubscriptionErrorCode = "permission_required" | "reconnect_required" | "subscription_failed";

export interface EnsurePageSubscriptionResult {
  ok: boolean;
  alreadySubscribed: boolean;
  errorCode?: EnsurePageSubscriptionErrorCode;
}

interface SubscribedAppsEntry {
  subscribed_fields?: string[];
}

// Idempotent by construction: reads the Page's CURRENT subscribed_fields
// first via GET, and only issues the POST if at least one of
// `requiredFields` isn't already present — preserving every other
// already-subscribed field (e.g. Lead Ads' "leadgen") rather than
// overwriting the set. Calling this twice in a row with the same
// requiredFields is always safe: the second call sees them all already
// present and returns alreadySubscribed:true without writing anything.
//
// Takes an already-derived PAGE access token (not a user token) — callers
// that only hold a user token should derive one first via
// getMetaPageAccessToken, exactly as reconcileMetaLeadAds does, so a
// caller needing multiple field groups in one flow can derive the Page
// token once and reuse it.
export async function ensureMetaPageFieldsSubscribed(
  pageAccessToken: string,
  pageId: string,
  requiredFields: string[],
): Promise<EnsurePageSubscriptionResult> {
  try {
    const current = await metaGraphRequest<{ data?: SubscribedAppsEntry[] }>({
      path: `/${pageId}/subscribed_apps`,
      accessToken: pageAccessToken,
    });
    const existingFields = new Set<string>(current.data?.[0]?.subscribed_fields ?? []);
    const missing = requiredFields.filter((f) => !existingFields.has(f));
    if (missing.length === 0) {
      return { ok: true, alreadySubscribed: true };
    }
    for (const f of missing) existingFields.add(f);

    // subscribed_fields is passed as a query param (not a JSON body) —
    // Graph API accepts scalar POST params via the querystring, and this
    // sidesteps whether a given endpoint parses a JSON POST body at all
    // (most classic Graph API write endpoints expect form/query params).
    await metaGraphRequest({
      path: `/${pageId}/subscribed_apps`,
      accessToken: pageAccessToken,
      method: "POST",
      query: { subscribed_fields: [...existingFields].join(",") },
    });
    return { ok: true, alreadySubscribed: false };
  } catch (e) {
    if (e instanceof MetaGraphApiError) {
      console.error("[meta-page-access] field subscription failed", {
        httpStatus: e.httpStatus,
        metaType: e.metaType,
        metaCode: e.metaCode,
        metaErrorSubcode: e.metaErrorSubcode,
        fbTraceId: e.fbTraceId,
      });
    }
    return { ok: false, alreadySubscribed: false, errorCode: "subscription_failed" };
  }
}

// Derives the Page token AND ensures the given fields are subscribed in one
// call — the shape every product-specific ensure*Subscription helper wants
// (Lead Ads, Messenger, Instagram): caller only ever holds the stored
// long-lived USER token.
export async function ensureMetaPageSubscriptionFromUserToken(
  userAccessToken: string,
  pageId: string,
  requiredFields: string[],
): Promise<EnsurePageSubscriptionResult> {
  let pageAccessToken: string;
  try {
    pageAccessToken = await getMetaPageAccessToken(userAccessToken, pageId);
  } catch (e) {
    const reconnect = e instanceof MetaGraphApiError && (e.metaType === "OAuthException" || e.metaCode === 190);
    return { ok: false, alreadySubscribed: false, errorCode: reconnect ? "reconnect_required" : "permission_required" };
  }
  return ensureMetaPageFieldsSubscribed(pageAccessToken, pageId, requiredFields);
}
