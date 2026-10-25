// src/lib/pricing/line-item-normalizer.test.ts
//
// Run:  node --test src/lib/pricing/line-item-normalizer.test.ts
//
// Pricing Intelligence v1 (P1). Pure unit tests for unit / name normalization and line-item matching.
// No database, no network, no model.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "line-item-normalizer-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: { contents: `export * from "./src/lib/pricing/line-item-normalizer";`, resolveDir: repoRoot, loader: "ts" },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error",
});
const N: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

// ── units ────────────────────────────────────────────────────────────────

test("units — each / ea / blank / unit / pc normalize to 'each' (blank = the editor's default unit)", () => {
  for (const u of ["each", "EA", "ea.", " Each ", "", null, undefined, "unit", "pcs"]) assert.equal(N.normalizeUnit(u), "each", String(u));
});

test("units — sf / sq ft / sqft / square feet / square foot normalize to 'sqft'", () => {
  for (const u of ["sf", "SF", "sq ft", "sq. ft.", "sqft", "square feet", "Square Foot", "sq feet"]) assert.equal(N.normalizeUnit(u), "sqft", u);
});

test("units — lf / linear ft / linear feet normalize to 'lf'", () => {
  for (const u of ["lf", "LF", "linear ft", "linear feet", "Linear Foot", "lin ft"]) assert.equal(N.normalizeUnit(u), "lf", u);
});

test("units — hr / hour / hours normalize to 'hour'; ls / lump sum normalize to 'lump_sum'", () => {
  for (const u of ["hr", "hrs", "Hour", "hours"]) assert.equal(N.normalizeUnit(u), "hour", u);
  for (const u of ["ls", "LS", "lump sum", "Lump Sum", "lumpsum"]) assert.equal(N.normalizeUnit(u), "lump_sum", u);
});

test("units — an unknown unit is kept as its own distinct unit and matches only itself", () => {
  assert.equal(N.normalizeUnit("Box"), "other:box");
  assert.equal(N.unitsCompatible("box", "BOX"), true);
  assert.equal(N.unitsCompatible("box", "each"), false);
});

test("units — INCOMPATIBLE units never match: each vs sqft, sqft vs lf, hour vs lump sum", () => {
  assert.equal(N.unitsCompatible("each", "sqft"), false);
  assert.equal(N.unitsCompatible("sf", "lf"), false);
  assert.equal(N.unitsCompatible("hr", "ls"), false);
  assert.equal(N.unitsCompatible("ea", "each"), true);
  assert.equal(N.unitsCompatible("sf", "square feet"), true);
});

// ── item types ───────────────────────────────────────────────────────────

test("item types — labor and service are compatible; material vs labor is not; unknown/custom/missing are neutral", () => {
  assert.equal(N.itemTypesCompatible("labor", "service"), true);
  assert.equal(N.itemTypesCompatible("material", "labor"), false);
  assert.equal(N.itemTypesCompatible("material", "equipment"), false);
  assert.equal(N.itemTypesCompatible("custom", "material"), true);
  assert.equal(N.itemTypesCompatible(null, "labor"), true);
  assert.equal(N.itemTypesCompatible("material", "material"), true);
});

// ── names ────────────────────────────────────────────────────────────────

test("names — lowercase, punctuation cleanup and whitespace normalization", () => {
  assert.equal(N.normalizeItemName("  Vanity   Installation!! "), N.normalizeItemName("vanity installation"));
  assert.equal(N.normalizeItemName("Tile (Floor), 12x24"), "tile floor 12x24");
  assert.equal(N.normalizeItemName("Cabinets & Countertops"), "cabinet countertop");
});

test("names — harmless filler such as 'install of' / 'installation of' is removed", () => {
  assert.equal(N.normalizeItemName("Install of vanity"), N.normalizeItemName("vanity"));
  assert.equal(N.normalizeItemName("Installation of the new vanity"), N.normalizeItemName("new vanity"));
  assert.equal(N.normalizeItemName("Supply and install of backsplash"), N.normalizeItemName("backsplash"));
});

test("names — conservative singularization (regular plurals only; exceptions untouched)", () => {
  assert.equal(N.singularize("tiles"), "tile");
  assert.equal(N.singularize("boxes"), "box");
  assert.equal(N.singularize("supplies"), "supply");
  assert.equal(N.singularize("glass"), "glass");
  assert.equal(N.singularize("gas"), "gas");
  assert.equal(N.singularize("hardwood"), "hardwood");
  assert.equal(N.singularize("bus"), "bus");
  assert.equal(N.normalizeItemName("Cabinets"), N.normalizeItemName("Cabinet"));
});

test("names — installation / installing / installed collapse to one token", () => {
  assert.equal(N.normalizeItemName("Vanity installation"), N.normalizeItemName("Vanity install"));
  assert.equal(N.normalizeItemName("Vanity installing"), N.normalizeItemName("Vanity install"));
});

test("names — alias map collapses known synonyms to a canonical phrase (and is NOT applied to unrelated words)", () => {
  assert.equal(N.toNormalizedName("Sheetrock").canonical, "drywall");
  assert.equal(N.toNormalizedName("Gypsum board").canonical, "drywall");
  assert.equal(N.toNormalizedName("Counter top").canonical, "countertop");
  assert.equal(N.toNormalizedName("Bathroom Vanity").canonical, "vanity");
  assert.equal(N.toNormalizedName("Back splash tile").canonical, "backsplash tile");
  assert.equal(N.toNormalizedName("Kitchen sink").canonical, "kitchen sink");
});

// ── similarity primitives ────────────────────────────────────────────────

test("similarity — Jaccard token-set and edit similarity behave as expected", () => {
  assert.equal(N.tokenSetSimilarity(["a", "b"], ["a", "b"]), 1);
  assert.equal(N.tokenSetSimilarity(["a", "b"], ["c", "d"]), 0);
  assert.equal(N.tokenSetSimilarity(["a", "b", "c"], ["a", "b"]), 2 / 3);
  assert.equal(N.tokenSetSimilarity([], ["a"]), 0);
  assert.equal(N.editSimilarity("tile", "tile"), 1);
  assert.ok(N.editSimilarity("vanity", "vanitty") > 0.8);
  assert.ok(N.editSimilarity("vanity", "shower") < 0.4);
});

// ── matching tiers ───────────────────────────────────────────────────────

const req = (name: string, extra: Record<string, unknown> = {}) => ({ name, itemType: "labor", unit: "each", ...extra });

test("match — EXACT: identical after normalization", () => {
  assert.equal(N.matchLineItem(req("Vanity installation"), req("vanity   Installation!")), "exact");
  assert.equal(N.matchLineItem(req("Install of vanity"), req("Vanity")), "exact");
});

test("match — ALIAS: identical only after the alias map", () => {
  assert.equal(N.matchLineItem(req("Sheetrock repair"), req("Drywall repair")), "alias");
  assert.equal(N.matchLineItem(req("Bathroom vanity install"), req("Vanity installation")), "alias");
});

test("match — TOKEN: high token-set similarity between multi-word names", () => {
  // 3 of 4 tokens shared => Jaccard 0.75
  assert.equal(N.matchLineItem(req("Remove old kitchen cabinet"), req("Remove kitchen cabinet")), "token");
});

test("match — FUZZY: weaker similarity only qualifies as fuzzy (low confidence)", () => {
  assert.equal(N.matchLineItem(req("Install tile floor bathroom shower"), req("Install tile floor")), "fuzzy");
  assert.equal(N.matchLineItem(req("Quartz countertopp"), req("Quartz countertop")), "fuzzy", "a typo is fuzzy, never exact");
  assert.equal(N.MATCH_TIER_RANK.exact > N.MATCH_TIER_RANK.alias && N.MATCH_TIER_RANK.alias > N.MATCH_TIER_RANK.token && N.MATCH_TIER_RANK.token > N.MATCH_TIER_RANK.fuzzy, true);
});

test("match — unrelated names do not match at any tier", () => {
  assert.equal(N.matchLineItem(req("Vanity installation"), req("Roof shingle replacement")), null);
  assert.equal(N.matchLineItem(req("Tile"), req("Tile installation labor")), null, "a one-word name never token-matches a longer phrase");
});

test("match — an incompatible UNIT never matches, even for identical names", () => {
  assert.equal(N.matchLineItem(req("Tile install", { unit: "sqft" }), req("Tile install", { unit: "each" })), null);
  assert.equal(N.matchLineItem(req("Tile install", { unit: "sf" }), req("Tile install", { unit: "square feet" })), "exact");
  assert.equal(N.matchLineItem(req("Tile install", { unit: "sqft" }), req("Tile install", { unit: "each" }), { ignoreUnit: true }), "exact", "only when the caller explicitly leaves the unit open");
});

test("match — an incompatible ITEM TYPE never matches, even for identical names", () => {
  assert.equal(N.matchLineItem(req("Vanity", { itemType: "material" }), req("Vanity", { itemType: "labor" })), null);
  assert.equal(N.matchLineItem(req("Vanity", { itemType: "labor" }), req("Vanity", { itemType: "service" })), "exact");
});

test("match — empty names never match", () => {
  assert.equal(N.matchLineItem(req(""), req("")), null);
  assert.equal(N.matchLineItem(req("   "), req("Vanity")), null);
});

test("determinism — the same inputs always produce the same output", () => {
  const run = () => JSON.stringify([N.toNormalizedName("Sheet Rock Install"), N.matchLineItem(req("Sheetrock install"), req("Drywall installation"))]);
  assert.equal(run(), run());
});
