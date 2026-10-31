// src/components/integrations/gmail-connection-panel.test.ts
//
// Run:  node --test src/components/integrations/gmail-connection-panel.test.ts
//
// The Gmail card on Settings → Integrations, rendered for each kind of org:
// healthy Google connection, Google needing reconnect, a failing sync, legacy
// SMTP only, and no email connection at all. The card is Google-only and
// compact: Disconnect and the legacy SMTP drawer sit behind "Manage", legacy
// SMTP is only offered to orgs that already have it, and no App Password
// form or instruction is part of Google onboarding.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "gmail-panel-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      import { renderToStaticMarkup } from "react-dom/server";
      import { createElement } from "react";
      import { GmailConnectionPanel } from "./src/components/integrations/gmail-connection-panel";
      export * from "./src/components/integrations/gmail-connection-panel";
      const noop = () => {};
      const base = {
        status: null, loading: false, statusError: null, connecting: false, syncing: false,
        onConnect: noop, onSync: noop, onDisconnect: noop, onRetryStatus: noop,
        smtpEmail: null, onOpenLegacySettings: noop,
        formatTimestamp: (iso) => iso ?? "Never",
      };
      export const renderPanel = (over) => renderToStaticMarkup(createElement(GmailConnectionPanel, { ...base, ...over }));
    `,
    resolveDir: repoRoot, loader: "tsx",
  },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error", jsx: "automatic",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const status = (over: Record<string, unknown> = {}) => ({
  connected: true, accountEmail: "owner@contractor.test", hasRefreshToken: true,
  tokenExpiresAt: null, lastSyncAt: null, lastSyncStatus: "ok", syncError: null,
  syncHealth: "ok", lastSuccessfulSyncAt: "2026-10-30T12:00:00.000Z", lastFailedSyncAt: null, ...over,
});
const SMTP = "office@contractor.test";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]).trim());

// Nothing in the card may ask for SMTP credentials or an App Password.
function assertNoSmtpSetup(html: string) {
  assert.doesNotMatch(html, /App Password|apppasswords/i);
  assert.doesNotMatch(html, /Add credentials|Update credentials|SMTP/i);
  assert.doesNotMatch(html, /Sync Inbox \(OAuth\)|Send Email \(SMTP\)|Account: Unknown/i);
  assert.doesNotMatch(html, /<input|type="password"/i);
}

test("connected — account, authorization, sync health, last sync; Sync now + Manage, no red Disconnect", () => {
  const html = S.renderPanel({ status: status() });
  const t = text(html);
  assert.match(t, /owner@contractor\.test/);
  assert.match(t, /Authorization Authorized/);
  assert.match(t, /Inbox sync Working/);
  assert.match(t, /Last synced 2026-10-30T12:00:00\.000Z/);
  assert.deepEqual(buttons(html), ["Sync now", "Manage"]);
  assert.match(html, /aria-label="Manage Gmail connection"/);
  assert.doesNotMatch(html, /variant="destructive"|bg-destructive text/);
  assertNoSmtpSetup(html);
});

test("connected with legacy SMTP saved — the card still shows no SMTP controls", () => {
  const html = S.renderPanel({ status: status(), smtpEmail: SMTP });
  assert.deepEqual(buttons(html), ["Sync now", "Manage"]);
  assert.doesNotMatch(text(html), /office@contractor\.test|Legacy/);
  assertNoSmtpSetup(html);
});

test("connected without a known address — 'Connected Google account', never 'Unknown'", () => {
  const html = S.renderPanel({ status: status({ accountEmail: null }) });
  assert.match(text(html), /Connected Google account/);
  assert.doesNotMatch(text(html), /Unknown/);
});

test("authorization and sync health are independent", () => {
  const failing = text(S.renderPanel({ status: status({ syncHealth: "failing", syncError: "Gmail API 500" }) }));
  assert.match(failing, /Authorization Authorized/);
  assert.match(failing, /Inbox sync Failing/);
  assert.match(failing, /Gmail API 500/);
  assert.match(failing, /reconnecting won(&#x27;|')t help/);

  const waiting = text(S.renderPanel({ status: status({ syncHealth: "pending", lastSuccessfulSyncAt: null }) }));
  assert.match(waiting, /Authorization Authorized/);
  assert.match(waiting, /Inbox sync Waiting/);
  assert.match(waiting, /Last synced Never/);

  const reconnectHtml = S.renderPanel({ status: status({ hasRefreshToken: false }) });
  assert.match(text(reconnectHtml), /Authorization Reconnect needed/);
  assert.match(text(reconnectHtml), /Inbox sync Paused/);
  assert.deepEqual(buttons(reconnectHtml), ["Reconnect Google", "Manage"]);
});

test("Manage menu — Disconnect always; legacy email settings only for orgs that have SMTP", () => {
  assert.deepEqual(S.gmailManageActions({ state: "connected", hasSmtp: false }).map((a: any) => a.id), ["disconnect"]);
  assert.deepEqual(S.gmailManageActions({ state: "connected", hasSmtp: true }).map((a: any) => a.id), ["legacy", "disconnect"]);
  assert.deepEqual(S.gmailManageActions({ state: "reconnect", hasSmtp: true }).map((a: any) => a.id), ["legacy", "disconnect"]);
  for (const s of ["loading", "status_error", "not_connected"]) assert.deepEqual(S.gmailManageActions({ state: s, hasSmtp: true }), []);
  const disconnect = S.gmailManageActions({ state: "connected", hasSmtp: false })[0];
  assert.equal(disconnect.destructive, true);
  assert.equal(S.gmailManageActions({ state: "connected", hasSmtp: true })[0].label, "Advanced: legacy email settings");
});

test("not connected (new org) — two benefits, one Connect with Google, one short permission sentence", () => {
  for (const s of [null, status({ connected: false })]) {
    const html = S.renderPanel({ status: s });
    const t = text(html);
    assert.match(t, /Sync customer emails into Conversations/);
    assert.match(t, /Send replies, estimates, change orders and campaigns/);
    assert.deepEqual(buttons(html), ["Connect with Google"]);
    assert.match(t, /RenoMeta requests permission to read and send email\. Learn how we use Google data/);
    assert.match(html, /href="https:\/\/renometa\.com\/privacy-policy" target="_blank" rel="noopener noreferrer"/);
    assert.doesNotMatch(t, /Legacy|currently send from/);
    assertNoSmtpSetup(html);
  }
});

test("legacy SMTP only — keeps working, Connect with Google is the upgrade, owners can still open legacy settings", () => {
  const html = S.renderPanel({ status: status({ connected: false }), smtpEmail: SMTP });
  const t = text(html);
  assert.match(t, /Replies and campaigns currently send from office@contractor\.test/);
  assert.deepEqual(buttons(html), ["Legacy email settings", "Connect with Google"]);
  assert.doesNotMatch(html, /App Password|<input/i);
});

test("loading and status error — no SMTP controls while the connection is unknown", () => {
  const loading = S.renderPanel({ status: null, loading: true, smtpEmail: SMTP });
  assert.match(text(loading), /Checking your Google connection/);
  assert.deepEqual(buttons(loading), []);
  const failed = S.renderPanel({ status: null, statusError: "Network error", smtpEmail: SMTP });
  assert.deepEqual(buttons(failed), ["Try again", "Legacy email settings"]);
  assertNoSmtpSetup(failed);
});

test("layout — pinned to the card footer, wrapping actions, safe truncation on long addresses", () => {
  const long = "a-very-long-mailbox-name@an-extremely-long-contractor-domain.test";
  const html = S.renderPanel({ status: status({ accountEmail: long }) });
  assert.match(html, /^<div class="mt-auto /);
  assert.match(html, /class="flex flex-wrap items-center gap-2"/);
  assert.match(html, new RegExp(`class="min-w-0 truncate" title="${long}"`));
  assert.match(S.renderPanel({ status: null, smtpEmail: SMTP }), /break-all/);
});

const route = readFileSync(path.join(repoRoot, "src/routes/settings.integrations.tsx"), "utf8");
const drawer = readFileSync(path.join(repoRoot, "src/components/integrations/integration-config-drawer.tsx"), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

test("wiring — Gmail always renders the Google panel (mock mode included); legacy UI strings are gone", () => {
  assert.match(route, /\{i\.id === "gmail" \? \(\s*<GmailConnectionPanel/);
  assert.doesNotMatch(route, /i\.id === "gmail" && !MOCK_MODE/);
  assert.match(route, /onOpenLegacySettings=\{\(\) => openDrawer\(i\)\}/);
  for (const legacy of [/Send Email \(SMTP\)/, /Sync Inbox \(OAuth\)/, /Add credentials/, /"Unknown"/, /Requires a Gmail App Password/]) {
    assert.doesNotMatch(strip(route), legacy);
  }
  const catalog = readFileSync(path.join(repoRoot, "src/lib/integrations-data.ts"), "utf8");
  const gmail = catalog.split("\n").find((l) => l.includes('id: "gmail"'))!;
  assert.match(gmail, /description: "Connect Gmail to manage customer emails directly in RenoMeta\."/);
  assert.match(gmail, /syncBadges: \["Conversations", "Estimates", "Campaigns"\]/);
  assert.doesNotMatch(gmail, /App Password/i);
});

test("wiring — the SMTP drawer is labeled legacy and removing SMTP still asks for confirmation", () => {
  assert.match(drawer, /int\.id === "gmail" \? "Advanced: legacy email settings"/);
  assert.match(drawer, /It isn't needed when your Google account is connected/);
  assert.match(drawer, /onClick=\{int\.id === "gmail" && onGmailSmtpRemoveRequest \? onGmailSmtpRemoveRequest : handleDisconnect\}/);
  assert.match(route, /onGmailSmtpRemoveRequest=\{\(\) => \{\s*setDrawerOpen\(false\);\s*setGmailSmtpDisconnectConfirmOpen\(true\);/);
  assert.match(route, /This deletes the saved SMTP credentials for/);
  assert.doesNotMatch(strip(route), /App Password/);
});

test("security — SMTP passwords never reach the browser; integration changes stay owner-only server-side", () => {
  const status = readFileSync(path.join(repoRoot, "netlify/functions/smtp-config-status.ts"), "utf8");
  const body = status.slice(status.indexOf("body: JSON.stringify({"));
  assert.doesNotMatch(body.slice(0, body.indexOf("})")), /appPassword:|password:|secret/i);
  // The drawer pre-fills only the address, never the password.
  assert.match(drawer, /if \(json\.email\) setFields\(\{ email: json\.email \}\);/);
  for (const fn of ["smtp-config-save.ts", "smtp-disconnect.ts", "gmail-oauth-start.ts", "gmail-disconnect.ts"]) {
    const src = readFileSync(path.join(repoRoot, "netlify/functions", fn), "utf8");
    assert.match(src, /resolveIntegrationManager\(/, fn);
  }
});
