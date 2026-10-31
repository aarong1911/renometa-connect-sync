// src/components/integrations/gmail-connection-panel.test.ts
//
// Run:  node --test src/components/integrations/gmail-connection-panel.test.ts
//
// The Gmail card on Settings → Integrations, rendered for each kind of org:
// healthy Google connection, Google needing reconnect, legacy SMTP only, and
// no email connection at all. The normal card is Google-only — legacy SMTP
// management sits behind a collapsed "Advanced" section that only orgs which
// already have SMTP ever see, and no App Password form or instruction is part
// of Google onboarding.

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
      import { GmailConnectionPanel, LegacyEmailSettings } from "./src/components/integrations/gmail-connection-panel";
      const noop = () => {};
      const base = {
        status: null, loading: false, statusError: null, connecting: false, syncing: false,
        onConnect: noop, onSync: noop, onDisconnect: noop, onRetryStatus: noop,
        smtpEmail: null, onManageSmtp: noop, onRemoveSmtp: noop,
        formatTimestamp: (iso) => iso ?? "Never",
      };
      export const renderPanel = (over) => renderToStaticMarkup(createElement(GmailConnectionPanel, { ...base, ...over }));
      export const renderLegacy = (over) => renderToStaticMarkup(createElement(LegacyEmailSettings, {
        email: "office@contractor.test", googleSending: true, onManage: noop, onRemove: noop, ...over,
      }));
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

// Nothing in the card may suggest Google needs an App Password or SMTP form.
function assertNoAppPasswordForm(html: string) {
  assert.doesNotMatch(html, /App Password/i);
  assert.doesNotMatch(html, /apppasswords/i);
  assert.doesNotMatch(html, /<input/i);
  assert.doesNotMatch(html, /type="password"/i);
}

test("connected Google — account, authorization, sync, Sync now, Disconnect and the enabled features", () => {
  const html = S.renderPanel({ status: status() });
  const t = text(html);
  assert.match(t, /owner@contractor\.test/);
  assert.match(t, /Authorization Authorized/);
  assert.match(t, /Inbox sync Working/);
  assert.match(t, /Last synced 2026-10-30T12:00:00\.000Z/);
  assert.match(t, /Features enabled/);
  for (const feature of ["Conversations", "Estimates", "Change orders", "Small email campaigns"]) assert.ok(t.includes(feature), feature);
  assert.deepEqual(buttons(html), ["Sync now", "Disconnect"]);
  assertNoAppPasswordForm(html);
  assert.doesNotMatch(t, /SMTP|Advanced/);
});

test("connected Google on an org that still has SMTP — no SMTP panel, only a collapsed Advanced entry", () => {
  const html = S.renderPanel({ status: status(), smtpEmail: SMTP });
  const t = text(html);
  assert.deepEqual(buttons(html), ["Sync now", "Disconnect", "Advanced: legacy email settings"]);
  assert.match(html, /aria-expanded="false"/);
  // Collapsed: no SMTP address, status, Update or Remove.
  assert.doesNotMatch(t, /office@contractor\.test|Legacy SMTP sending|Standby|Update|Remove/);
  assertNoAppPasswordForm(html);
});

test("Advanced section expanded — legacy SMTP management stays available to the owner", () => {
  const standby = S.renderLegacy({ defaultOpen: true, googleSending: true });
  assert.match(standby, /aria-expanded="true"/);
  assert.match(text(standby), /Legacy SMTP sending Standby/);
  assert.match(text(standby), /office@contractor\.test/);
  assert.match(text(standby), /Not required for Google/);
  assert.deepEqual(buttons(standby), ["Advanced: legacy email settings", "Update", "Remove"]);
  assertNoAppPasswordForm(standby);

  const inUse = S.renderLegacy({ defaultOpen: true, googleSending: false });
  assert.match(text(inUse), /Legacy SMTP sending In use/);
  assert.match(text(inUse), /until your Google account is connected/);
});

test("Google needs reconnecting — Reconnect and Disconnect, sync paused, no features claimed", () => {
  const html = S.renderPanel({ status: status({ hasRefreshToken: false }) });
  const t = text(html);
  assert.match(t, /Authorization Reconnect needed/);
  assert.match(t, /Inbox sync Paused/);
  assert.deepEqual(buttons(html), ["Reconnect Google", "Disconnect"]);
  assert.doesNotMatch(t, /Features enabled|Sync now/);
  assertNoAppPasswordForm(html);

  // With SMTP, the user is told where replies go meanwhile; SMTP controls stay collapsed.
  const withSmtp = S.renderPanel({ status: status({ hasRefreshToken: false }), smtpEmail: SMTP });
  assert.match(text(withSmtp), /Until then, replies and campaigns send from office@contractor\.test\./);
  assert.deepEqual(buttons(withSmtp), ["Reconnect Google", "Disconnect", "Advanced: legacy email settings"]);
});

test("legacy SMTP only — Connect with Google is the one primary action; SMTP is mentioned, not managed", () => {
  const html = S.renderPanel({ status: status({ connected: false }), smtpEmail: SMTP });
  const t = text(html);
  assert.match(t, /Replies and campaigns currently send from office@contractor\.test ?\./);
  assert.deepEqual(buttons(html), ["Connect with Google", "Advanced: legacy email settings"]);
  assert.doesNotMatch(t, /Update|Remove|Legacy SMTP sending/);
  assertNoAppPasswordForm(html);
});

test("no connection (new org) — one Connect with Google button, permissions note, no SMTP or Advanced", () => {
  for (const s of [null, status({ connected: false })]) {
    const html = S.renderPanel({ status: s });
    const t = text(html);
    assert.deepEqual(buttons(html), ["Connect with Google"]);
    assert.match(t, /Google will ask you to let RenoMeta/);
    assert.match(html, /href="https:\/\/renometa\.com\/privacy-policy"[^>]*rel="noopener noreferrer"/);
    assert.doesNotMatch(t, /SMTP|Advanced|currently send from/);
    assertNoAppPasswordForm(html);
  }
});

test("loading and status error — never show SMTP controls or the Advanced entry while unknown", () => {
  const loading = S.renderPanel({ status: null, loading: true, smtpEmail: SMTP });
  assert.match(text(loading), /Checking your Google connection/);
  assert.deepEqual(buttons(loading), []);

  const failed = S.renderPanel({ status: null, statusError: "Network error", smtpEmail: SMTP });
  assert.deepEqual(buttons(failed), ["Try again", "Advanced: legacy email settings"]);
  assertNoAppPasswordForm(failed);
});

test("mobile — action rows wrap, long addresses truncate or break, features stack on narrow screens", () => {
  const html = S.renderPanel({ status: status({ accountEmail: "a-very-long-mailbox-name@an-extremely-long-contractor-domain.test" }), smtpEmail: SMTP });
  assert.match(html, /class="flex flex-wrap gap-2"/);
  assert.match(html, /min-w-0 truncate[^"]*" title="a-very-long-mailbox-name@/);
  assert.match(html, /grid grid-cols-1 gap-1 sm:grid-cols-2/);
  const legacy = S.renderPanel({ status: status({ connected: false }), smtpEmail: SMTP });
  assert.match(legacy, /break-all/);
});

test("wiring — the SMTP drawer and remove dialog are labeled legacy and say Google doesn't need them", () => {
  const drawer = readFileSync(path.join(repoRoot, "src/components/integrations/integration-config-drawer.tsx"), "utf8");
  assert.match(drawer, /int\.id === "gmail" \? "Advanced: legacy email settings"/);
  assert.match(drawer, /It isn't needed when your Google account is connected/);
  const route = readFileSync(path.join(repoRoot, "src/routes/settings.integrations.tsx"), "utf8");
  assert.match(route, /onManageSmtp=\{\(\) => openDrawer\(i\)\}/);
  assert.match(route, /onRemoveSmtp=\{\(\) => setGmailSmtpDisconnectConfirmOpen\(true\)\}/);
  assert.match(route, /This deletes the saved SMTP credentials for/);
  assert.doesNotMatch(route.replace(/^\s*\/\/.*$/gm, ""), /App Password/);
});

test("wiring — SMTP changes stay owner-only server-side", () => {
  for (const fn of ["smtp-config-save.ts", "smtp-disconnect.ts"]) {
    const src = readFileSync(path.join(repoRoot, "netlify/functions", fn), "utf8");
    assert.match(src, /resolveIntegrationManager\(/, fn);
  }
});
