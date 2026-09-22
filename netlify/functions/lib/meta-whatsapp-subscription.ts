// netlify/functions/lib/meta-whatsapp-subscription.ts
//
// WhatsApp Embedded Signup / coexistence, Phase 1 (2026-09). WABA-level
// counterpart to lib/meta-page-access.ts's ensureMetaPageFieldsSubscribed()
// — a WABA never receives ANY webhook delivery until the connecting app
// has explicitly subscribed via POST /{waba_id}/subscribed_apps, the same
// "granting permissions does NOT auto-subscribe" rule already documented
// for Pages (see meta-lead-ads.ts / meta-messaging.ts). Unlike the Page
// version, WABA-level subscription has no `subscribed_fields` concept to
// preserve — POST /{waba_id}/subscribed_apps with no body is what actually
// subscribes the app to that WABA's webhook events (messages, etc., as
// already configured at the app level in the Meta App Dashboard's
// WhatsApp product config) — so this helper is simpler than the Page one:
// no read-merge, just an idempotent POST.
//
// Uses the token the completion flow itself produced (a system-user token
// per the new WhatsApp Coexistence Embedded Signup config — see Phase 1's
// own report) — never a token this file derives or persists itself.
//
// NOT invoked against any live WABA in Phase 1 — wired up and ready for
// the Phase 2 live-onboarding completion path.

import { metaGraphRequest, MetaGraphApiError } from "./meta-graph-api";

export type EnsureWhatsAppSubscriptionErrorCode = "permission_required" | "subscription_failed";

export interface EnsureWhatsAppSubscriptionResult {
  ok: boolean;
  alreadySubscribed: boolean;
  errorCode?: EnsureWhatsAppSubscriptionErrorCode;
}

interface SubscribedAppsEntry {
  whatsapp_business_api_data?: { id?: string };
  id?: string;
}

/**
 * Idempotent: reads the WABA's current subscribed_apps list first, and
 * only issues the POST if this app isn't already present in it. Calling
 * this twice in a row is always safe — the second call sees the app
 * already subscribed and returns alreadySubscribed:true without writing
 * anything, matching the same idempotency contract
 * ensureMetaPageFieldsSubscribed() already provides for Pages.
 */
export async function ensureWhatsAppAppSubscription(
  wabaId: string,
  accessToken: string,
): Promise<EnsureWhatsAppSubscriptionResult> {
  try {
    const current = await getWhatsAppAppSubscriptionStatus(wabaId, accessToken);
    if (!current.ok) {
      // The status check itself failed (e.g. an expired/invalid token) —
      // this must propagate as a real failure, never fall through to
      // attempting the POST anyway. Found by this phase's own test suite:
      // without this check, a failed read silently proceeded to the write
      // path and could report false success.
      return { ok: false, alreadySubscribed: false, errorCode: current.errorCode };
    }
    if (current.subscribed) {
      return { ok: true, alreadySubscribed: true };
    }

    await metaGraphRequest({
      path: `/${wabaId}/subscribed_apps`,
      accessToken,
      method: "POST",
    });
    return { ok: true, alreadySubscribed: false };
  } catch (e) {
    if (e instanceof MetaGraphApiError) {
      console.error("[meta-whatsapp-subscription] subscription failed", {
        httpStatus: e.httpStatus,
        metaType: e.metaType,
        metaCode: e.metaCode,
        metaErrorSubcode: e.metaErrorSubcode,
        fbTraceId: e.fbTraceId,
      });
      const permission = e.metaType === "OAuthException" || e.metaCode === 190 || e.httpStatus === 403;
      return { ok: false, alreadySubscribed: false, errorCode: permission ? "permission_required" : "subscription_failed" };
    }
    console.error("[meta-whatsapp-subscription] subscription failed (non-Graph error):", e);
    return { ok: false, alreadySubscribed: false, errorCode: "subscription_failed" };
  }
}

export type WhatsAppSubscriptionStatus =
  | { ok: true; subscribed: boolean }
  | { ok: false; errorCode: EnsureWhatsAppSubscriptionErrorCode };

/** Read-only check — never writes. Used both by ensureWhatsAppAppSubscription's
 * own idempotency check and available standalone for status/diagnostic use. */
export async function getWhatsAppAppSubscriptionStatus(
  wabaId: string,
  accessToken: string,
): Promise<WhatsAppSubscriptionStatus> {
  try {
    const result = await metaGraphRequest<{ data?: SubscribedAppsEntry[] }>({
      path: `/${wabaId}/subscribed_apps`,
      accessToken,
    });
    return { ok: true, subscribed: Array.isArray(result.data) && result.data.length > 0 };
  } catch (e) {
    if (e instanceof MetaGraphApiError) {
      console.error("[meta-whatsapp-subscription] status check failed", {
        httpStatus: e.httpStatus,
        metaType: e.metaType,
        metaCode: e.metaCode,
        fbTraceId: e.fbTraceId,
      });
      const permission = e.metaType === "OAuthException" || e.metaCode === 190 || e.httpStatus === 403;
      return { ok: false, errorCode: permission ? "permission_required" : "subscription_failed" };
    }
    console.error("[meta-whatsapp-subscription] status check failed (non-Graph error):", e);
    return { ok: false, errorCode: "subscription_failed" };
  }
}
