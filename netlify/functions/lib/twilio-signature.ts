// netlify/functions/lib/twilio-signature.ts
//
// AI-2A. Twilio webhook signature validation — did NOT exist anywhere in
// this repo before this pass (confirmed by a full-repo grep for
// "validateRequest"/"X-Twilio-Signature": zero hits, and the existing
// inbound webhook, marketing-sms-inbound.ts, performs no signature check
// at all). Implemented here from Twilio's own published algorithm using
// only Node's built-in `crypto` — no `twilio` npm package is added (this
// repo has no Twilio SDK dependency today and none is needed for this).
//
// Algorithm (https://www.twilio.com/docs/usage/webhooks/webhooks-security):
//   1. Take the exact URL Twilio POSTed to (scheme+host+path+querystring,
//      byte-for-byte identical to what's configured as the webhook URL in
//      the Twilio Console — trailing slashes and query strings matter).
//   2. Sort the POST body's parameters by key name, and append each
//      key+value pair (no separators) directly onto the URL string.
//   3. Compute HMAC-SHA1 of that string using the Twilio auth token as the
//      key, base64-encode the result.
//   4. Compare (constant-time) against the request's X-Twilio-Signature
//      header.
//
// The auth token used here is per-ORG (organizations.integration_settings.
// twilio.authToken — the same per-tenant credential send-inbox-message.ts
// already uses to send), not a single global secret — this file is
// deliberately parameter-only (no Supabase, no env var reads) so the
// caller decides which org's token to validate against, after resolving
// the destination number but before trusting anything else about the
// request.

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Returns true only if `signatureHeader` is a valid Twilio signature for
 * this exact URL + form-encoded params, computed with `authToken`. Never
 * throws — a malformed/missing signature header returns false, same as a
 * mismatched one.
 */
export function verifyTwilioSignature(
  authToken: string,
  fullUrl: string,
  params: URLSearchParams,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;

  const sortedKeys = Array.from(new Set(params.keys())).sort();
  let data = fullUrl;
  for (const key of sortedKeys) {
    // Twilio's algorithm appends each key+value once per key — a
    // multi-value key is not part of Twilio's own webhook payload shape
    // (From/To/Body/MessageSid are always single-valued), so the first
    // value is used, matching URLSearchParams.get()'s own behavior.
    data += key + (params.get(key) ?? "");
  }

  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  try {
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

/**
 * Reconstructs the request's own full URL from Netlify's HandlerEvent
 * fields — `event.rawUrl` (when present) is authoritative and used first;
 * otherwise falls back to the same x-forwarded-proto/x-forwarded-host/host
 * reconstruction already used by change-order-send.ts/estimate-send.ts.
 * IMPORTANT: this must byte-for-byte match the URL configured as the
 * number's webhook in the Twilio Console (including trailing slash and
 * query string) or every signature check will fail — see this file's
 * header.
 */
export function reconstructRequestUrl(event: {
  rawUrl?: string;
  path: string;
  headers: Record<string, string | undefined>;
  rawQuery?: string;
}): string {
  if (event.rawUrl) return event.rawUrl;
  const proto = event.headers["x-forwarded-proto"] ?? "https";
  const host = event.headers["x-forwarded-host"] ?? event.headers.host ?? "";
  const query = event.rawQuery ? `?${event.rawQuery}` : "";
  return `${proto}://${host}${event.path}${query}`;
}
