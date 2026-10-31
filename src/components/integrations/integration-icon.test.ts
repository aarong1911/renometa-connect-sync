// src/components/integrations/integration-icon.test.ts
//
// Run:  node --test src/components/integrations/integration-icon.test.ts
//
// Provider logos on Settings → Integrations: every registered integration
// renders its provider's mark (or is explicitly listed as having no licensed
// mark available), unknown ids get the generic fallback, and logos keep
// their contrast in dark mode.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "integration-icon-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      import { renderToStaticMarkup } from "react-dom/server";
      import { createElement } from "react";
      import { IntegrationIcon } from "./src/components/integrations/integration-icon";
      export * from "./src/components/integrations/integration-icon";
      export { INTEGRATIONS } from "./src/lib/integrations-data";
      export const render = (id, size) => renderToStaticMarkup(createElement(IntegrationIcon, { id, size }));
    `,
    resolveDir: repoRoot, loader: "tsx",
  },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error", jsx: "automatic",
  loader: { ".svg": "dataurl" },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

// No licensed mark exists for these in the installed icon sets — they keep
// the generic fallback rather than an invented logo.
const NO_LICENSED_MARK = new Set(["jotform", "docusign", "angi", "home-depot"]);

const EXPECTED: Record<string, { kind: string; color?: string }> = {
  gmail: { kind: "brand", color: "#EA4335" },
  twilio: { kind: "brand", color: "#F22F46" },
  whatsapp: { kind: "brand", color: "#25D366" },
  "fb-messenger": { kind: "brand", color: "#0084FF" },
  "instagram-direct": { kind: "brand", color: "#E4405F" },
  slack: { kind: "brand", color: "#4A154B" },
  "google-calendar": { kind: "brand", color: "#4285F4" },
  calendly: { kind: "brand", color: "#006BFF" },
  "native-form": { kind: "glyph" },
  stripe: { kind: "brand", color: "#635BFF" },
  paypal: { kind: "brand", color: "#003087" },
  quickbooks: { kind: "brand", color: "#2CA01C" },
  "google-drive": { kind: "brand", color: "#4285F4" },
  "meta-ads": { kind: "asset" },
  "meta-lead-ads": { kind: "asset" },
  "google-ads": { kind: "asset" },
  thumbtack: { kind: "brand", color: "#009FD9" },
  "google-business": { kind: "brand", color: "#4285F4" },
};

test("every integration in the registry is covered — a logo, or an explicit no-licensed-mark fallback", () => {
  const ids: string[] = S.INTEGRATIONS.map((i: any) => i.id);
  for (const id of ids) {
    assert.ok(EXPECTED[id] || NO_LICENSED_MARK.has(id), `${id} has no expected icon`);
    if (NO_LICENSED_MARK.has(id)) assert.equal(S.integrationIconSpec(id), null, id);
  }
  // No icon is registered for an integration that doesn't exist.
  for (const id of Object.keys(S.INTEGRATION_ICONS)) assert.ok(ids.includes(id), `stray icon ${id}`);
});

test("each provider renders its own mark in its brand color", () => {
  for (const [id, want] of Object.entries(EXPECTED)) {
    const spec = S.integrationIconSpec(id);
    assert.equal(spec?.kind, want.kind, id);
    const html = S.render(id);
    assert.match(html, new RegExp(`data-integration-icon="${id}"`), id);
    assert.match(html, /aria-hidden="true"/, id);
    if (want.kind === "brand") {
      assert.equal(spec.color, want.color, id);
      assert.match(html, /<svg/, id);
      assert.ok(html.toLowerCase().includes(`color:${want.color!.toLowerCase()}`), `${id} color`);
    }
    if (want.kind === "asset") assert.match(html, /<img src="data:image\/svg\+xml[^"]*" alt=""/, id);
  }
  // Same provider, same mark: both Meta products use the Meta asset.
  assert.equal(S.integrationIconSpec("meta-ads").src, S.integrationIconSpec("meta-lead-ads").src);
});

test("unknown and unlicensed providers use the safe generic fallback", () => {
  for (const id of ["unknown-provider", "custom-123", "__proto__", "constructor", ...NO_LICENSED_MARK]) {
    assert.equal(S.integrationIconSpec(id), null, id);
    const html = S.render(id);
    assert.match(html, /data-integration-icon="fallback"/, id);
    assert.match(html, /bg-secondary/, id);
    assert.match(html, /lucide-link2|lucide-link-2/, id);
  }
});

test("dark mode — logos sit on a white tile with a theme-aware ring; sizes are consistent", () => {
  const html = S.render("gmail");
  assert.match(html, /bg-white ring-black\/5 dark:ring-white\/10/);
  assert.match(html, /h-9 w-9 rounded-lg/);
  assert.match(S.render("gmail", "md"), /h-10 w-10 rounded-lg/);
  assert.match(S.render("unknown"), /dark:ring-white\/10/);
});

test("cards and the config drawer use the shared icon; the generic link icon is gone from both", () => {
  const route = readFileSync(path.join(repoRoot, "src/routes/settings.integrations.tsx"), "utf8");
  const drawer = readFileSync(path.join(repoRoot, "src/components/integrations/integration-config-drawer.tsx"), "utf8");
  assert.match(route, /<IntegrationIcon id=\{i\.id\} \/>/);
  assert.match(drawer, /<IntegrationIcon id=\{int\.id\} size="md" \/>/);
  assert.doesNotMatch(route, /<Link2 /);
  assert.doesNotMatch(drawer, /<Link2 /);
});
