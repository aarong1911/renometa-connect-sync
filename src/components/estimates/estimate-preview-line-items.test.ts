// src/components/estimates/estimate-preview-line-items.test.ts
//
// Run:  node --test src/components/estimates/estimate-preview-line-items.test.ts
//
// Estimates → Preview Proposal key warning. Production (index-DbGMusM8.js,
// minified component `Tst` = EstimateViewDialog) rendered each section as an
// UNKEYED <></> inside groups.map(), so React logged "Each child in a list
// should have a unique "key" prop" on every preview open.
//
// Bundled with React's development JSX transform (jsxDev — the same transform
// the production bundle shipped with) so React's own key validation runs.
// console.error is RECORDED, never silenced: any key warning fails the test.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "estimate-preview-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      import { renderToStaticMarkup } from "react-dom/server";
      import { createElement } from "react";
      import { EstimatePreviewLineItems } from "./src/components/estimates/estimate-preview-line-items";
      export * from "./src/components/estimates/estimate-preview-line-items";
      const money = (n) => "$" + Number(n).toFixed(2);
      export const element = (items) => createElement(EstimatePreviewLineItems, { items, formatMoney: money });
      export const render = (items) => renderToStaticMarkup(createElement("table", null, createElement("tbody", null, element(items))));
      export const callComponent = (items) => EstimatePreviewLineItems({ items, formatMoney: money });
    `,
    resolveDir: repoRoot, loader: "tsx",
  },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error",
  jsx: "automatic", jsxDev: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

function line(id: string, name: string, over: Record<string, unknown> = {}) {
  return { id, name, description: null, quantity: 1, unit: "each", unit_price: 100, total: 100, optional: false, is_heading: false, ...over };
}
const heading = (id: string, name: string) => line(id, name, { is_heading: true, unit_price: 0, total: 0 });

const SECTIONED = [
  line("i0", "Site prep"),
  heading("h1", "Kitchen"),
  line("i1", "Cabinets", { quantity: 2, unit_price: 1500, total: 3000 }),
  line("i2", "Countertop", { description: "Quartz", optional: true }),
  heading("h2", "Bathroom"),
  line("i3", "Vanity"),
  line("i4", "Tile", { quantity: 40, unit: "sqft", unit_price: 12.5, total: 500 }),
];

/** Renders with console.error recorded (not suppressed); returns the HTML and any React warnings. */
function renderRecording(items: unknown[]) {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    return { html: S.render(items) as string, errors };
  } finally {
    console.error = original;
  }
}

/** Keys of every row element, walking nested fragments the way React sees them. */
function rowKeys(items: unknown[]) {
  const keys: { section: string | null; rows: (string | null)[] }[] = [];
  const root = S.callComponent(items);
  const sections = root.props.children;
  if (!Array.isArray(sections)) return { root, keys };
  for (const section of sections) {
    const rows = ([] as any[]).concat(section.props.children).flat().filter(Boolean);
    keys.push({ section: section.key, rows: rows.map((r: any) => r.key) });
  }
  return { root, keys };
}

test("multiple sections + line items render with no React key warning", () => {
  const { html, errors } = renderRecording(SECTIONED);
  assert.deepEqual(errors.filter((e) => /unique "key" prop/.test(e)), [], errors.join("\n"));
  assert.deepEqual(errors, [], "no React warnings of any kind");
  for (const text of ["Site prep", "Kitchen", "Cabinets", "Countertop", "Quartz", "optional", "Bathroom", "Vanity", "Tile", "40 sqft", "$3000.00", "$12.50"]) {
    assert.ok(html.includes(text), text);
  }
  // Ordering preserved: rows appear in item order, headings before their items.
  const order = ["Site prep", "Kitchen", "Cabinets", "Countertop", "Bathroom", "Vanity", "Tile"].map((t) => html.indexOf(t));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("single ungrouped list (no headings) renders with no key warning", () => {
  const { errors, html } = renderRecording([line("a", "One"), line("b", "Two"), line("c", "Three")]);
  assert.deepEqual(errors, []);
  assert.equal((html.match(/<tr/g) ?? []).length, 3);
});

test("empty estimate renders the 'No line items' row", () => {
  const { errors, html } = renderRecording([]);
  assert.deepEqual(errors, []);
  assert.match(html, /No line items/);
});

test("every section is keyed at the list level, from stable ids (not indices)", () => {
  const { keys } = rowKeys(SECTIONED);
  assert.deepEqual(keys.map((k) => k.section), ["section-ungrouped", "section-h1", "section-h2"]);
  assert.deepEqual(keys[1].rows, ["heading-h1", "i1", "i2"]);
  assert.deepEqual(keys[2].rows, ["heading-h2", "i3", "i4"]);
  const all = keys.flatMap((k) => [k.section, ...k.rows]);
  assert.equal(new Set(all).size, all.length, "keys are unique");
});

test("keys stay attached to the same items after reorder and removal", () => {
  const before = rowKeys(SECTIONED).keys;
  // Swap the two sections and drop one item.
  const reordered = [
    line("i0", "Site prep"),
    heading("h2", "Bathroom"), line("i4", "Tile"), line("i3", "Vanity"),
    heading("h1", "Kitchen"), line("i1", "Cabinets"),
  ];
  const after = rowKeys(reordered).keys;
  assert.deepEqual(after.map((k) => k.section), ["section-ungrouped", "section-h2", "section-h1"]);
  assert.deepEqual(after[1].rows, ["heading-h2", "i4", "i3"]);
  assert.deepEqual(after[2].rows, ["heading-h1", "i1"]);
  assert.equal(before.find((k) => k.section === "section-h1")!.rows[1], after[2].rows[1], "Cabinets keeps its key");
  assert.deepEqual(renderRecording(reordered).errors, []);
});

test("groupBySection keeps grouping/ordering semantics used by print and the detail sheet", () => {
  const groups = S.groupBySection(SECTIONED);
  assert.deepEqual(groups.map((g: any) => g.heading), [null, "Kitchen", "Bathroom"]);
  assert.deepEqual(groups.map((g: any) => g.items.map((i: any) => i.id)), [["i0"], ["i1", "i2"], ["i3", "i4"]]);
  // An empty trailing heading still renders as its own section.
  assert.deepEqual(S.groupBySection([line("a", "A"), heading("h", "Extras")]).map((g: any) => g.heading), [null, "Extras"]);
});
