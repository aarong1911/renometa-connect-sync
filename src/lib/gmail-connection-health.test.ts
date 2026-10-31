// src/lib/gmail-connection-health.test.ts
//
// Run:  node --test src/lib/gmail-connection-health.test.ts
//
// Behavior of the Gmail card's state derivation and OAuth-return messages,
// plus source-level wiring checks for Settings → Integrations (the repo has
// no DOM test harness — see gmail-auto-sync-wiring.test.ts for the same
// approach).

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { describeGmailOAuthReturn, gmailCardState, type GmailConnectionStatus } from "./gmail-connection-health.ts";

const status = (over: Partial<GmailConnectionStatus> = {}): GmailConnectionStatus => ({
  connected: true, accountEmail: "owner@contractor.test", hasRefreshToken: true,
  tokenExpiresAt: "2000-01-01T00:00:00.000Z", lastSyncAt: null, lastSyncStatus: "ok", syncError: null,
  syncHealth: "ok", lastSuccessfulSyncAt: null, lastFailedSyncAt: null, ...over,
});

test("card state: loading / status error only while nothing is known yet", () => {
  assert.equal(gmailCardState({ loading: true, error: null, status: null }), "loading");
  assert.equal(gmailCardState({ loading: false, error: "Network error", status: null }), "status_error");
  // A refetch in flight or failing never hides a known connection.
  assert.equal(gmailCardState({ loading: true, error: null, status: status() }), "connected");
  assert.equal(gmailCardState({ loading: false, error: "Network error", status: status() }), "connected");
});

test("card state: not connected covers never-connected and disconnected rows", () => {
  assert.equal(gmailCardState({ loading: false, error: null, status: status({ connected: false }) }), "not_connected");
});

test("card state: reconnect only for genuine authorization failures", () => {
  // An expired access token with a refresh token is fine — gmail-sync renews it.
  assert.equal(gmailCardState({ loading: false, error: null, status: status() }), "connected");
  assert.equal(gmailCardState({ loading: false, error: null, status: status({ hasRefreshToken: false }) }), "reconnect");
  assert.equal(gmailCardState({ loading: false, error: null, status: status({ syncHealth: "auth_error" }) }), "reconnect");
  // A failing sync for any other reason is NOT a reconnect prompt.
  assert.equal(gmailCardState({ loading: false, error: null, status: status({ syncHealth: "failing", syncError: "batch rejected" }) }), "connected");
  assert.equal(gmailCardState({ loading: false, error: null, status: status({ syncHealth: "pending" }) }), "connected");
});

test("OAuth return: success, partial grant, cancel and server errors each get a next step", () => {
  assert.deepEqual(describeGmailOAuthReturn("success", null), { tone: "success", text: "Google account connected" });
  assert.equal(describeGmailOAuthReturn("partial", "Google connected, but …")!.tone, "warning");
  assert.equal(describeGmailOAuthReturn("partial", null)!.tone, "warning");
  assert.match(describeGmailOAuthReturn("error", "access_denied")!.text, /cancelled.*Connect with Google/);
  assert.match(describeGmailOAuthReturn("error", "Only your organization owner can change this connection.")!.text, /organization owner/);
  assert.equal(describeGmailOAuthReturn("error", null)!.tone, "error");
  assert.equal(describeGmailOAuthReturn("something-else", null), null);
  assert.equal(describeGmailOAuthReturn(null, null), null);
});

// ── wiring ───────────────────────────────────────────────────────────────

const route = readFileSync(new URL("../routes/settings.integrations.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("../components/integrations/gmail-connection-panel.tsx", import.meta.url), "utf8");
const catalog = readFileSync(new URL("./integrations-data.ts", import.meta.url), "utf8");

test("wiring: the Gmail card renders the one-click panel wired to the real OAuth handlers", () => {
  assert.match(route, /<GmailConnectionPanel[\s\S]*?onConnect=\{handleConnectGmail\}[\s\S]*?onSync=\{handleSyncGmail\}/);
  assert.match(route, /fetch\("\/\.netlify\/functions\/gmail-oauth-start"/);
  assert.match(panel, /Connect with Google/);
  assert.match(panel, /Sync now/);
});

test("wiring: App Password setup is not part of the normal onboarding copy", () => {
  const gmailEntry = catalog.split("\n").find((l) => l.includes('id: "gmail"'))!;
  assert.doesNotMatch(gmailEntry, /App Password/i);
  // The only App Password mention in the panel is inside the legacy section.
  const legacyStart = panel.indexOf("function LegacySmtpSection");
  assert.ok(legacyStart > 0);
  assert.doesNotMatch(panel.slice(0, legacyStart).replace(/^\s*\/\/.*$/gm, ""), /App Password/);
  // Orgs without SMTP are never offered App Password setup at all.
  assert.match(panel, /function LegacySmtpSection[\s\S]*?\{\s*if \(!email\) return null;/);
  assert.doesNotMatch(panel, /Set up SMTP/i);
});

test("wiring: the panel no longer claims replies or campaigns skip the Google connection", () => {
  assert.doesNotMatch(panel, /don't use your Google connection/);
  assert.match(panel, /Replies, estimates, change orders and email campaigns send from your own Gmail address/);
});

test("wiring: the Gmail 'connected' count comes from the OAuth status, never the legacy SMTP settings key", () => {
  assert.match(route, /if \(i\.id === "gmail"\) return i;/);
  assert.match(route, /i\.id === "gmail" \? \{ \.\.\.i, connected: status\.connected === true \}/);
});
