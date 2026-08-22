// netlify/functions/lib/google-ads-oauth-state.ts
//
// Shared HMAC-signed `state` format for Google Ads OAuth
// (google-ads-oauth-start.ts and the future google-ads-oauth-callback.ts
// must both import from here — never re-derive the sign/verify logic
// per function, or the two can silently drift apart).
//
// IMPORTANT — this only proves the state wasn't forged or tampered with
// and hasn't expired. It does NOT make the nonce single-use. A captured,
// still-valid, correctly-signed state could be replayed until it expires
// unless the callback additionally enforces one-time nonce consumption
// (e.g. an atomic DB row insert/delete keyed on the nonce). That is left
// for the callback task — not implemented here.

import crypto from "node:crypto";

// Reconnect + Disconnect phase — `intent` distinguishes a normal first-time/
// routine connect from an EXPLICIT reconnect request (the user clicking
// "Reconnect" specifically to authorize a possibly-different Google
// identity/hierarchy). Signed into the state alongside the existing
// userId/orgId/nonce fields — never trusted as a bare `?reconnect=true`
// query param, which the callback could not distinguish from a forged one.
// Always present (oauth-start.ts sets it explicitly on every state it
// signs); defaults to "connect" only as a defensive fallback for
// verifyGoogleAdsOAuthState() reading a payload that somehow predates this
// field (never actually reachable given the 10-minute state TTL, but safer
// than a hard type assumption).
export type GoogleAdsOAuthIntent = "connect" | "reconnect";

export interface GoogleAdsOAuthStatePayload {
  userId: string;
  orgId: string;
  nonce: string;
  iat: number;
  exp: number;
  intent: GoogleAdsOAuthIntent;
}

const MAX_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CLOCK_SKEW_MS = 60 * 1000; // 60 seconds

export function signGoogleAdsOAuthState(
  payload: GoogleAdsOAuthStatePayload,
  secret: string,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// NOTE: a passing verification here only proves the state is authentic,
// well-formed, and unexpired — it does NOT prove the state hasn't been
// used before. The callback must independently enforce single-use nonce
// consumption (e.g. an atomic DB row insert/delete keyed on `nonce`,
// checked before the token exchange) or a captured, still-valid state
// could be replayed. Not implemented here — left for the callback task.
export function verifyGoogleAdsOAuthState(
  state: string,
  secret: string,
): GoogleAdsOAuthStatePayload {
  if (!isNonEmptyString(state) || !isNonEmptyString(secret)) {
    throw new Error("Invalid OAuth state");
  }

  const parts = state.split(".");
  if (parts.length !== 2 || !isNonEmptyString(parts[0]) || !isNonEmptyString(parts[1])) {
    throw new Error("Invalid OAuth state");
  }
  const [encodedPayload, submittedSignature] = parts;

  let submittedSigBuf: Buffer;
  let expectedSigBuf: Buffer;
  try {
    submittedSigBuf = Buffer.from(submittedSignature, "base64url");
    expectedSigBuf = crypto.createHmac("sha256", secret).update(encodedPayload).digest();
  } catch {
    throw new Error("Invalid OAuth state");
  }

  // timingSafeEqual throws on mismatched lengths — check first so a
  // length mismatch can't itself become a timing oracle, then compare.
  if (submittedSigBuf.length !== expectedSigBuf.length) {
    throw new Error("Invalid OAuth state signature");
  }
  if (!crypto.timingSafeEqual(submittedSigBuf, expectedSigBuf)) {
    throw new Error("Invalid OAuth state signature");
  }

  // Only decode/parse the payload after the signature has been verified.
  let parsed: unknown;
  try {
    const json = Buffer.from(encodedPayload, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid OAuth state");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid OAuth state");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.userId) ||
    !isNonEmptyString(candidate.orgId) ||
    !isNonEmptyString(candidate.nonce) ||
    !isFiniteNumber(candidate.iat) ||
    !isFiniteNumber(candidate.exp)
  ) {
    throw new Error("Invalid OAuth state");
  }
  // `intent` is validated against a strict whitelist rather than trusted as
  // any string — an unrecognized/tampered value (which the signature check
  // above would already have caught, but defense-in-depth costs nothing
  // here) falls back to the safe default "connect" rather than being
  // rejected outright, since a missing field is expected for the payload
  // shape's defensive-fallback case described above.
  const rawIntent = candidate.intent;
  const intent: GoogleAdsOAuthIntent = rawIntent === "reconnect" ? "reconnect" : "connect";

  const { userId, orgId, nonce, iat, exp } = candidate as unknown as GoogleAdsOAuthStatePayload;
  const now = Date.now();

  if (iat > now + MAX_CLOCK_SKEW_MS) {
    throw new Error("Invalid OAuth state");
  }
  if (exp <= iat) {
    throw new Error("Invalid OAuth state");
  }
  if (exp - iat > MAX_LIFETIME_MS) {
    throw new Error("Invalid OAuth state");
  }
  if (exp <= now) {
    throw new Error("Expired OAuth state");
  }

  return { userId, orgId, nonce, iat, exp, intent };
}
