// src/lib/meta-embedded-signup-session.ts
//
// WhatsApp Embedded Signup / coexistence, Phase 2 (2026-09). Pure logic
// only — no DOM, no fetch, no React — deliberately separated out so it's
// directly unit-testable without a browser environment, matching this
// codebase's established pattern of extracting the trust-relevant logic
// out of the DOM/network-touching glue around it (see
// meta-whatsapp-embedded-signup-complete.ts's own exchangeEmbeddedSignupCode
// extraction for the same reasoning).
//
// Two independent responsibilities live here:
//   1. isTrustedMetaOrigin() — origin validation for the window `message`
//      listener.
//   2. parseEmbeddedSignupMessage() — safe parsing of the WA_EMBEDDED_SIGNUP
//      session-logging event payload into a small discriminated result.
//   3. createEmbeddedSignupCompletionCoordinator() — race-safe "fire
//      exactly once, regardless of which of {auth code, session event}
//      arrives first" state machine.

// ── Origin validation ─────────────────────────────────────────────────────
//
// Meta's own sample code for the message listener uses
// `event.origin.endsWith('facebook.com')` — that is NOT safe on its own:
// `"https://notfacebook.com".endsWith("facebook.com")` is also true, since
// a bare suffix match has no host boundary. This checks the actual parsed
// hostname against `facebook.com` (exact) or `*.facebook.com` (subdomain,
// with an explicit dot boundary), which a spoofed lookalike domain cannot
// satisfy.
export function isTrustedMetaOrigin(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === "facebook.com" || hostname.endsWith(".facebook.com");
}

// ── Session event parsing ─────────────────────────────────────────────────

export type EmbeddedSignupSessionResult =
  | { kind: "success"; phoneNumberId: string; wabaId: string | null; businessId: string | null }
  | { kind: "cancel" }
  | { kind: "error"; message: string }
  // Untrusted origin, malformed payload, unrelated message type, or an
  // intermediate/unrecognized Embedded Signup step event this flow
  // doesn't act on — all handled identically: ignored, never treated as
  // completion, cancellation, or a user-facing error.
  | { kind: "ignored" };

/**
 * `originTrusted` must already be the result of isTrustedMetaOrigin() on
 * the REAL event.origin — this function never re-derives it, so a caller
 * can't accidentally skip the origin check by calling this directly with
 * a raw event.
 *
 * Handles Meta sending the payload as either a real object or a JSON
 * string (both shapes appear across Meta's own documentation examples).
 * Never throws.
 */
export function parseEmbeddedSignupMessage(originTrusted: boolean, rawData: unknown): EmbeddedSignupSessionResult {
  if (!originTrusted) return { kind: "ignored" };

  let data: unknown = rawData;
  if (typeof rawData === "string") {
    try {
      data = JSON.parse(rawData);
    } catch {
      return { kind: "ignored" };
    }
  }
  if (typeof data !== "object" || data === null) return { kind: "ignored" };

  const payload = data as Record<string, unknown>;
  if (payload.type !== "WA_EMBEDDED_SIGNUP") return { kind: "ignored" };

  const eventName = typeof payload.event === "string" ? payload.event : "";

  // Matched loosely (contains "FINISH") rather than an exact string —
  // Meta's documented coexistence completion event is
  // "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", but the exact event name
  // has not been independently confirmed against a live completion in
  // this codebase (see Phase 2's own report, "live assumptions still
  // unverified") — a loose match is the safer choice against a possible
  // future/slightly-different exact string, while still requiring the
  // WA_EMBEDDED_SIGNUP envelope type and a real phone_number_id below.
  if (/finish/i.test(eventName)) {
    const inner = payload.data;
    const phoneNumberId = typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>).phone_number_id : undefined;
    if (typeof phoneNumberId !== "string" || !phoneNumberId) {
      return { kind: "error", message: "Meta did not return a phone number for this connection." };
    }
    const innerRecord = inner as Record<string, unknown>;
    const wabaId = typeof innerRecord.waba_id === "string" && innerRecord.waba_id ? innerRecord.waba_id : null;
    const businessId = typeof innerRecord.business_id === "string" && innerRecord.business_id ? innerRecord.business_id : null;
    return { kind: "success", phoneNumberId, wabaId, businessId };
  }

  if (/cancel/i.test(eventName)) return { kind: "cancel" };
  if (/error/i.test(eventName)) return { kind: "error", message: "The WhatsApp connection could not be completed." };

  // Any other event name (e.g. an intermediate step-progress event) —
  // ignored, not treated as completion/cancel/error.
  return { kind: "ignored" };
}

// ── Race-safe completion coordinator ───────────────────────────────────────

export type EmbeddedSignupSession = { phoneNumberId: string; wabaId: string | null; businessId: string | null };
export type EmbeddedSignupCompletionInput = EmbeddedSignupSession & { code: string };

/**
 * The FB.login() callback (carrying `authResponse.code`) and the
 * WA_EMBEDDED_SIGNUP `message` event (carrying the session data) arrive
 * independently and in EITHER order — Meta's own docs don't guarantee
 * one before the other. This coordinator fires `onReady` exactly once,
 * only once BOTH pieces have arrived, regardless of order, and ignores
 * anything submitted after it has already fired (a duplicate/late message
 * event, a duplicate login callback invocation, etc. can never trigger a
 * second completion).
 */
export function createEmbeddedSignupCompletionCoordinator(onReady: (input: EmbeddedSignupCompletionInput) => void) {
  let code: string | null = null;
  let session: EmbeddedSignupSession | null = null;
  let fired = false;

  function tryFire() {
    if (fired || !code || !session) return;
    fired = true;
    onReady({ code, ...session });
  }

  return {
    submitCode(value: string): void {
      if (fired || !value) return;
      code = value;
      tryFire();
    },
    submitSession(value: EmbeddedSignupSession): void {
      if (fired) return;
      session = value;
      tryFire();
    },
    get hasFired(): boolean {
      return fired;
    },
  };
}
