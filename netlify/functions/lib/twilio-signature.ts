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

/** First value of a possibly comma-separated forwarded-header (a chain of
 * proxies appends its own value — the FIRST entry is the one closest to
 * the original client/edge, which is the one that matters here), trimmed.
 * Undefined/empty stays undefined. */
function firstForwardedValue(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const first = raw.split(",")[0]?.trim();
  return first || undefined;
}

/**
 * Reconstructs the request's own EXTERNALLY-VISIBLE full URL — the one
 * Twilio itself made the request to, which is what its signature was
 * computed against.
 *
 * ORDER OF PREFERENCE (bug fix — see below): x-forwarded-proto +
 * x-forwarded-host are checked FIRST, before event.rawUrl. A local
 * `netlify dev` instance behind an HTTPS-terminating tunnel (ngrok, and
 * anything shaped like it) receives the proxied request over plain HTTP
 * on localhost — event.rawUrl in that case reflects the LOCAL leg
 * (http://<tunnel-host>/...), even though the tunnel host itself is
 * correct, because rawUrl's scheme comes from the connection Netlify's
 * dev server actually terminated, not from the original external one.
 * ngrok (like Netlify's own production edge, and any standards-following
 * reverse proxy) sets x-forwarded-proto to the ORIGINAL external scheme
 * (https) and x-forwarded-host to the ORIGINAL external host — those are
 * the authoritative signal for what Twilio actually called, and must be
 * preferred over rawUrl whenever both are present, not just used as a
 * fallback. This fixes real production traffic identically to local
 * tunneled traffic (Netlify's own edge always sets both headers too), and
 * requires no ngrok-specific hostname/branching of any kind.
 *
 * rawUrl remains a fallback for a direct request with no forwarding
 * headers at all (e.g. hitting the function directly with no proxy in
 * front of it) — the same x-forwarded-proto/x-forwarded-host/host
 * reconstruction pattern already used by change-order-send.ts/
 * estimate-send.ts, generalized here to also cover rawUrl's own
 * proto/host in the same order of preference rather than trusting it
 * unconditionally.
 *
 * IMPORTANT: the result must byte-for-byte match the URL configured as
 * the number's webhook in the Twilio Console (including trailing slash
 * and query string) or every signature check will fail — see this file's
 * header.
 */
export function reconstructRequestUrl(event: {
  rawUrl?: string;
  path: string;
  headers: Record<string, string | undefined>;
  rawQuery?: string;
}): string {
  const forwardedProto = firstForwardedValue(event.headers["x-forwarded-proto"]);
  const forwardedHost = firstForwardedValue(event.headers["x-forwarded-host"]) ?? event.headers.host;

  if (forwardedProto && forwardedHost) {
    const query = event.rawQuery ? `?${event.rawQuery}` : "";
    return `${forwardedProto}://${forwardedHost}${event.path}${query}`;
  }

  if (event.rawUrl) return event.rawUrl;

  // No forwarding signal and no rawUrl at all — last-resort
  // reconstruction. "https" is the safe default (this is a webhook
  // endpoint; a legitimate direct-HTTP local call with no forwarded
  // headers and no rawUrl is not a realistic Twilio scenario), but never
  // reached for any case this file was actually built to handle (a
  // proxy/tunnel or Netlify's own edge, both of which set forwarded
  // headers; or netlify dev, which always populates rawUrl).
  const host = event.headers.host ?? "";
  const query = event.rawQuery ? `?${event.rawQuery}` : "";
  return `https://${host}${event.path}${query}`;
}
