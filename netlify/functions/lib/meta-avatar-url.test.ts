// netlify/functions/lib/meta-avatar-url.test.ts
//
// Run:  node --test netlify/functions/lib/meta-avatar-url.test.ts
// (Node 20.6+/22/24 native TypeScript type-stripping + built-in test
//  runner — same convention as app-config-store.test.ts /
//  voice-scheduling.test.ts. No dependencies, no network, no DB.)
//
// This repo has no configured test runner (no vitest/jest, no "test"
// script in package.json) — this file follows the existing
// node:test-based convention already present for other lib/ helpers so it
// can be run manually (or wired into a runner later) without adding a new
// dependency.

import assert from "node:assert/strict";
import test from "node:test";
import { isMetaCdnAvatarUrl, shouldRefreshMetaAvatar } from "./meta-avatar-url.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function fbcdnUrlWithExpiry(expiryMs: number): string {
  const oe = Math.floor(expiryMs / 1000).toString(16);
  return `https://scontent.fna.fbcdn.net/v/t1.30497-1/s150x150/photo.jpg?oe=${oe}&oh=abc123`;
}

test("isMetaCdnAvatarUrl: recognizes fbcdn.net and its subdomains", () => {
  assert.equal(isMetaCdnAvatarUrl("https://scontent.fna.fbcdn.net/v/photo.jpg"), true);
  assert.equal(isMetaCdnAvatarUrl("https://fbcdn.net/photo.jpg"), true);
});

test("isMetaCdnAvatarUrl: recognizes cdninstagram.com and its subdomains", () => {
  assert.equal(isMetaCdnAvatarUrl("https://instagram.flhr1-1.fna.cdninstagram.com/photo.jpg"), true);
  assert.equal(isMetaCdnAvatarUrl("https://cdninstagram.com/photo.jpg"), true);
});

test("isMetaCdnAvatarUrl: false for a custom/non-Meta host", () => {
  assert.equal(isMetaCdnAvatarUrl("https://my-project.supabase.co/storage/v1/object/public/avatars/a.jpg"), false);
  assert.equal(isMetaCdnAvatarUrl("https://example.com/fbcdn.net-lookalike/a.jpg"), false);
});

test("isMetaCdnAvatarUrl: false for null/empty/unparseable", () => {
  assert.equal(isMetaCdnAvatarUrl(null), false);
  assert.equal(isMetaCdnAvatarUrl(undefined), false);
  assert.equal(isMetaCdnAvatarUrl(""), false);
  assert.equal(isMetaCdnAvatarUrl("not a url"), false);
});

test("shouldRefreshMetaAvatar: false for a current/valid (far-future expiry) Meta CDN URL", () => {
  const url = fbcdnUrlWithExpiry(Date.now() + 7 * DAY_MS);
  assert.equal(shouldRefreshMetaAvatar(url), false);
});

test("shouldRefreshMetaAvatar: true for an already-expired Meta CDN URL", () => {
  const url = fbcdnUrlWithExpiry(Date.now() - DAY_MS);
  assert.equal(shouldRefreshMetaAvatar(url), true);
});

test("shouldRefreshMetaAvatar: true for a Meta CDN URL expiring within the safety window", () => {
  const url = fbcdnUrlWithExpiry(Date.now() + 5 * 60 * 1000); // 5 minutes out
  assert.equal(shouldRefreshMetaAvatar(url), true);
});

test("shouldRefreshMetaAvatar: false for a Meta URL without a usable oe param (fail closed)", () => {
  assert.equal(shouldRefreshMetaAvatar("https://scontent.fna.fbcdn.net/v/photo.jpg"), false);
  assert.equal(shouldRefreshMetaAvatar("https://scontent.fna.fbcdn.net/v/photo.jpg?oe=not-hex"), false);
  // Implausible decoded value (e.g. year ~5138) — rejected as unreliable rather than trusted.
  assert.equal(shouldRefreshMetaAvatar("https://scontent.fna.fbcdn.net/v/photo.jpg?oe=ffffffff"), false);
});

test("shouldRefreshMetaAvatar: false for a custom/non-Meta avatar URL — never replaced", () => {
  assert.equal(shouldRefreshMetaAvatar("https://my-project.supabase.co/storage/v1/object/public/avatars/a.jpg"), false);
});

test("shouldRefreshMetaAvatar: false for null/empty avatar", () => {
  assert.equal(shouldRefreshMetaAvatar(null), false);
  assert.equal(shouldRefreshMetaAvatar(undefined), false);
  assert.equal(shouldRefreshMetaAvatar(""), false);
});

test("shouldRefreshMetaAvatar: a freshly-refreshed Meta URL does not immediately re-trigger", () => {
  // Simulates the exact bug this fix targets: a URL Meta just returned a
  // moment ago is still Meta-hosted, but its own expiry is far in the
  // future, so it must NOT be flagged for another refresh right away.
  const freshlyIssued = fbcdnUrlWithExpiry(Date.now() + 3 * DAY_MS);
  assert.equal(isMetaCdnAvatarUrl(freshlyIssued), true); // still Meta-hosted
  assert.equal(shouldRefreshMetaAvatar(freshlyIssued), false); // but not stale
});
