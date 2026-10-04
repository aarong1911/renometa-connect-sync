// netlify/functions/lib/twilio-signature.test.ts
//
// Run:  node --test netlify/functions/lib/twilio-signature.test.ts
//
// AI-3I. Pure, dependency-free: Twilio's own HMAC-SHA1 signature algorithm
// and URL reconstruction. No Supabase, no network.

import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { verifyTwilioSignature, reconstructRequestUrl } from "./twilio-signature.ts";

const AUTH_TOKEN = "test-auth-token-s3cret";
const URL_UNDER_TEST = "https://deploy-preview-15--renoconnect.netlify.app/.netlify/functions/ai-twilio-sms-inbound";

function computeRealSignature(authToken: string, fullUrl: string, params: URLSearchParams): string {
  const sortedKeys = Array.from(new Set(params.keys())).sort();
  let data = fullUrl;
  for (const key of sortedKeys) data += key + (params.get(key) ?? "");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

test("A. a valid Twilio signature (computed with Twilio's own algorithm) is accepted", () => {
  const params = new URLSearchParams({ From: "+17547048148", To: "+17545818861", Body: "hello", MessageSid: "SMtest123" });
  const sig = computeRealSignature(AUTH_TOKEN, URL_UNDER_TEST, params);
  assert.equal(verifyTwilioSignature(AUTH_TOKEN, URL_UNDER_TEST, params, sig), true);
});

test("A. an invalid signature (wrong auth token, tampered body, wrong URL) is rejected", () => {
  const params = new URLSearchParams({ From: "+17547048148", To: "+17545818861", Body: "hello", MessageSid: "SMtest123" });
  const sig = computeRealSignature(AUTH_TOKEN, URL_UNDER_TEST, params);

  assert.equal(verifyTwilioSignature("wrong-token", URL_UNDER_TEST, params, sig), false, "wrong auth token");

  const tamperedParams = new URLSearchParams({ From: "+17547048148", To: "+17545818861", Body: "tampered!", MessageSid: "SMtest123" });
  assert.equal(verifyTwilioSignature(AUTH_TOKEN, URL_UNDER_TEST, tamperedParams, sig), false, "tampered body");

  assert.equal(verifyTwilioSignature(AUTH_TOKEN, "https://attacker.example.com/ai-twilio-sms-inbound", params, sig), false, "wrong URL");
});

test("A. a missing signature header is rejected", () => {
  const params = new URLSearchParams({ From: "+17547048148", To: "+17545818861", Body: "hi", MessageSid: "SM1" });
  assert.equal(verifyTwilioSignature(AUTH_TOKEN, URL_UNDER_TEST, params, undefined), false);
});

test("a signature of a different length than expected is rejected without throwing", () => {
  const params = new URLSearchParams({ From: "+1", To: "+1", Body: "x", MessageSid: "SM1" });
  assert.equal(verifyTwilioSignature(AUTH_TOKEN, URL_UNDER_TEST, params, "short"), false);
});

test("reconstructRequestUrl prefers x-forwarded-proto/x-forwarded-host over rawUrl (Deploy Preview edge sets these correctly)", () => {
  const url = reconstructRequestUrl({
    rawUrl: "http://127.0.0.1:9999/.netlify/functions/ai-twilio-sms-inbound",
    path: "/.netlify/functions/ai-twilio-sms-inbound",
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "deploy-preview-15--renoconnect.netlify.app" },
  });
  assert.equal(url, "https://deploy-preview-15--renoconnect.netlify.app/.netlify/functions/ai-twilio-sms-inbound");
});

test("reconstructRequestUrl takes the FIRST value of a comma-separated forwarded header (proxy chain)", () => {
  const url = reconstructRequestUrl({
    path: "/.netlify/functions/ai-twilio-sms-inbound",
    headers: { "x-forwarded-proto": "https, http", "x-forwarded-host": "deploy-preview-15--renoconnect.netlify.app, internal-proxy" },
  });
  assert.equal(url, "https://deploy-preview-15--renoconnect.netlify.app/.netlify/functions/ai-twilio-sms-inbound");
});

test("reconstructRequestUrl falls back to rawUrl when no forwarded headers are present", () => {
  const url = reconstructRequestUrl({
    rawUrl: "https://example.netlify.app/.netlify/functions/ai-twilio-sms-inbound",
    path: "/.netlify/functions/ai-twilio-sms-inbound",
    headers: {},
  });
  assert.equal(url, "https://example.netlify.app/.netlify/functions/ai-twilio-sms-inbound");
});

test("reconstructRequestUrl includes the query string when present", () => {
  const url = reconstructRequestUrl({
    path: "/.netlify/functions/ai-twilio-sms-inbound",
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "example.netlify.app" },
    rawQuery: "foo=bar",
  });
  assert.equal(url, "https://example.netlify.app/.netlify/functions/ai-twilio-sms-inbound?foo=bar");
});
