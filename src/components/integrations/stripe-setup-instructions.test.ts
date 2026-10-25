// src/components/integrations/stripe-setup-instructions.test.ts
//
// Run:  node --test src/components/integrations/stripe-setup-instructions.test.ts
//
// Stripe drawer setup instructions: copy, the safe external link, Stripe-only rendering, neutral placeholder, and that the existing
// save flow / secret handling is untouched.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "stripe-setup-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      import { renderToStaticMarkup } from "react-dom/server";
      import { createElement } from "react";
      import { StripeSetupInstructions } from "./src/components/integrations/stripe-setup-instructions";
      export * from "./src/components/integrations/stripe-setup-instructions";
      export const render = () => renderToStaticMarkup(createElement(StripeSetupInstructions));
    `,
    resolveDir: repoRoot, loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error", jsx: "automatic",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);
const drawer = readFileSync(path.join(repoRoot, "src/components/integrations/integration-config-drawer.tsx"), "utf8");

test("instructions — all five steps, the heading and the security note render", () => {
  const html = S.render();
  assert.match(html, /How to connect Stripe/);
  for (const step of ["Open your Stripe Dashboard.", "Go to Developers → API keys.", "Copy the Secret key — not the Publishable key.", "Use an sk_live_… key for real payments. Use sk_test_… only for testing.", "Paste it below and click Save Credentials."]) {
    assert.ok(html.includes(step.replace("→", "→")), step);
  }
  assert.match(html, /Your Stripe secret key is stored securely and is never shown again after saving\./);
});

test("link — official Stripe API keys page, new tab, noopener noreferrer", () => {
  assert.equal(S.STRIPE_API_KEYS_URL, "https://dashboard.stripe.com/apikeys");
  const html = S.render();
  assert.match(html, /<a [^>]*href="https:\/\/dashboard\.stripe\.com\/apikeys"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /Open Stripe API Keys/);
});

test("component — renders no input and no secret value (presentation only)", () => {
  const html = S.render();
  assert.ok(!/<input|<textarea|value=/i.test(html));
  const src = readFileSync(path.join(repoRoot, "src/components/integrations/stripe-setup-instructions.tsx"), "utf8");
  assert.ok(!/useState|fetch\(|supabase|secretKey|localStorage/.test(src), "no state, network or storage access");
});

test("drawer — instructions render only for Stripe, only in the not-configured/reconfiguring form, immediately before the fields", () => {
  assert.equal((drawer.match(/<StripeSetupInstructions \/>/g) ?? []).length, 1);
  assert.match(drawer, /\{int\.id === "stripe" && <StripeSetupInstructions \/>\}\s*\r?\n\s*\{getApiKeyFields\(\)\.map\(/);
  const idx = drawer.indexOf("<StripeSetupInstructions />");
  const configured = drawer.lastIndexOf("isConfigured && !reconfiguring", idx);
  const fields = drawer.indexOf("getApiKeyFields().map", idx);
  assert.ok(configured > 0 && fields > idx, "sits in the credential-entry branch, not the 'configured' branch");
});

test("drawer — placeholder is neutral (live or test), field stays a password input; save behavior and secret handling unchanged", () => {
  assert.match(drawer, /key: "secretKey", label: "Secret Key", placeholder: "sk_live_… or sk_test_…", type: "password", secret: true, minLength: 20/);
  assert.match(drawer, /Save Credentials/);
  assert.match(drawer, /onClick=\{validateAndSave\}/);
  // a saved Stripe secret is never loaded back into the form
  assert.match(drawer, /if \(saved\.apiKey && currentId !== "stripe"\) safe\.apiKey = saved\.apiKey;/);
});

test("backend — no key-prefix validation exists, so test keys were already accepted and no backend change was needed", () => {
  const unsafe = ["netlify/functions/save-integration.ts"];
  for (const rel of unsafe) {
    try { assert.ok(!/startsWith\(["']sk_live/.test(readFileSync(path.join(repoRoot, rel), "utf8"))); } catch { /* file not present */ }
  }
});
