// src/lib/estimate-item-rows.test.ts
//
// Run:  node --test src/lib/estimate-item-rows.test.ts
//
// Estimate editor metadata persistence + safer item replacement (live bug: saving
// EST-000006 raised 23502 on estimate_items.metadata AND, because the old save was
// delete-then-insert, erased the estimate's line items).
//
// Uses the in-memory fake Supabase client with two OPT-IN behaviors that reproduce
// the live database: `notNullColumns: { estimate_items: ["metadata"] }` and
// `bulkInsertMissingAsNull: ["estimate_items"]` (PostgREST bulk inserts take the
// UNION of row keys and NULL-fill the rest). No live Supabase, no network.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const outDir = mkdtempSync(path.join(tmpdir(), "estimate-item-rows-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const noisy = ["log", "warn", "error"] as const;
const saved = noisy.map((k) => (console as any)[k]);
noisy.forEach((k) => ((console as any)[k] = () => {}));
after(() => noisy.forEach((k, i) => ((console as any)[k] = saved[i])));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export * from "./src/lib/estimate-item-rows";
      export * from "./src/lib/estimate-pricing-gate";
    `,
    resolveDir: repoRoot, loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true, platform: "node", format: "esm", logLevel: "error",
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);
const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href);

const EST = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const AI_META = { price_pending: true, ai_proposed: true, quantity_pending: true, ai_execution_id: "exec-1" };

/** The editor's per-line row, exactly as estimates.tsx buildItemRows() shapes it (columns other than metadata are constant here). */
function editorRow(line: { name: string; unitPrice: string; metadata?: unknown; pricePending?: boolean; isHeading?: boolean }, position = 0) {
  const price = line.isHeading ? 0 : (parseFloat(line.unitPrice) || 0);
  return {
    estimate_id: EST, category: "Material", item_type: "material", name: line.name, description: null,
    quantity: 1, unit: "each", unit_price: price, total: price, position, taxable: true, optional: false, is_heading: !!line.isHeading,
    metadata: S.buildItemMetadata(line.metadata, { pricePending: line.pricePending, isHeading: line.isHeading, price }),
  };
}
/** The PRE-FIX row shape: metadata only on pending lines (what caused the 23502). */
function preFixRow(line: { name: string; unitPrice: string; pricePending?: boolean }, position = 0) {
  const price = parseFloat(line.unitPrice) || 0;
  const { metadata: _drop, ...base } = editorRow({ ...line }, position);
  return { ...base, ...(line.pricePending && price <= 0 ? { metadata: { price_pending: true } } : {}) };
}

function makeDb(items: any[] = []) {
  return createFakeSupabaseClient(
    { estimate_items: items },
    {},
    { notNullColumns: { estimate_items: ["metadata"] }, bulkInsertMissingAsNull: ["estimate_items"] },
  );
}
const oldItem = (id: string, name: string, meta: any = {}) => ({ id, estimate_id: EST, name, category: "Material", quantity: 1, unit_price: 100, total: 100, position: 0, taxable: true, optional: false, is_heading: false, selected_by_customer: true, metadata: meta });

// ── asMetadataObject ────────────────────────────────────────────────────

test("asMetadataObject: only a plain object is kept (as a COPY); null / arrays / primitives / undefined become {}", () => {
  const src = { a: 1 };
  const out = S.asMetadataObject(src);
  assert.deepEqual(out, { a: 1 });
  assert.notEqual(out, src);
  for (const bad of [null, undefined, [], [1], "x", 5, true]) assert.deepEqual(S.asMetadataObject(bad), {}, String(bad));
});

// ── buildItemMetadata ───────────────────────────────────────────────────

test("B — a NO-OP save of an untouched AI line keeps price_pending AND every other key", () => {
  assert.deepEqual(S.buildItemMetadata({ ...AI_META }, { pricePending: true, price: 0 }), AI_META);
});

test("C — a positive price edit (pricePending cleared) removes ONLY price_pending and preserves ai_proposed / quantity_pending / ai_execution_id / unrelated keys", () => {
  const out = S.buildItemMetadata({ ...AI_META, custom: { nested: 1 }, note: "keep" }, { pricePending: false, price: 250 });
  assert.deepEqual(out, { ai_proposed: true, quantity_pending: true, ai_execution_id: "exec-1", custom: { nested: 1 }, note: "keep" });
});

test("D — an explicit 0 (editor cleared pricePending on edit) removes price_pending and does NOT re-add it just because the price is 0", () => {
  const out = S.buildItemMetadata({ ...AI_META }, { pricePending: false, price: 0 });
  assert.ok(!("price_pending" in out));
  assert.equal(out.ai_proposed, true);
});

test("a stale marker on a line that now has a real price is dropped even if the flag was somehow still set", () => {
  assert.ok(!("price_pending" in S.buildItemMetadata({ price_pending: true }, { pricePending: true, price: 40 })));
});

test("E — a manual line (no metadata) is sent as {} — never null/undefined", () => {
  for (const existing of [undefined, null, {}, [], "x"]) assert.deepEqual(S.buildItemMetadata(existing, { pricePending: false, price: 10 }), {});
});

test("F — a heading never carries price_pending (other keys still preserved)", () => {
  assert.deepEqual(S.buildItemMetadata({ ...AI_META }, { pricePending: true, isHeading: true, price: 0 }), { ai_proposed: true, quantity_pending: true, ai_execution_id: "exec-1" });
});

test("buildItemMetadata never mutates its input", () => {
  const input = { ...AI_META };
  S.buildItemMetadata(input, { pricePending: false, price: 5 });
  assert.deepEqual(input, AI_META);
});

// ── duplicate + header metadata ─────────────────────────────────────────

test("H — duplicate item metadata: price_pending stays, unrelated keys stay, ai_execution_id is dropped; always an object", () => {
  const out = S.duplicateItemMetadata({ ...AI_META, other: 1 });
  assert.deepEqual(out, { price_pending: true, ai_proposed: true, quantity_pending: true, other: 1 });
  assert.deepEqual(S.duplicateItemMetadata(null), {});
  assert.deepEqual(S.duplicateItemMetadata({}), {});
});

test("H — duplicate header metadata keeps provenance (ai_generated) and drops ai_execution_id; no new execution id is invented", () => {
  const out = S.duplicateEstimateMetadata({ ai_generated: true, ai_source: "estimate_assistant", ai_execution_id: "exec-1", serviceAddress: "x" });
  assert.deepEqual(out, { ai_generated: true, ai_source: "estimate_assistant", serviceAddress: "x" });
  assert.ok(!("ai_execution_id" in out));
});

test("I + J — header save MERGES: serviceAddress is updated while ai_generated / ai_execution_id / unrelated keys survive; inputs are not mutated", () => {
  const existing = { ai_generated: true, ai_source: "estimate_assistant", ai_execution_id: "exec-1", extra: { a: 1 }, serviceAddress: "old" };
  const snapshot = JSON.stringify(existing);
  const out = S.mergeEstimateMetadata(existing, { serviceAddress: "123 New St" });
  assert.deepEqual(out, { ai_generated: true, ai_source: "estimate_assistant", ai_execution_id: "exec-1", extra: { a: 1 }, serviceAddress: "123 New St" });
  assert.equal(JSON.stringify(existing), snapshot);
  assert.deepEqual(S.mergeEstimateMetadata(null, { serviceAddress: null }), { serviceAddress: null });
});

// ── uniform bulk-insert shape vs. the live NOT NULL + NULL-fill behavior ─

test("A — mixed pending/priced lines: EVERY row carries a metadata object", () => {
  const rows = [
    editorRow({ name: "A", unitPrice: "", metadata: { ...AI_META }, pricePending: true }, 0),
    editorRow({ name: "B", unitPrice: "500", metadata: { ...AI_META }, pricePending: false }, 1),
    editorRow({ name: "C", unitPrice: "75" }, 2),
    editorRow({ name: "Heading", unitPrice: "", isHeading: true }, 3),
  ];
  for (const r of rows) assert.ok(r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata), r.name);
  assert.equal(new Set(rows.map((r) => Object.keys(r).sort().join(","))).size, 1, "all rows have the identical key set");
});

test("REGRESSION — the PRE-FIX mixed row shape fails with the live 23502 under NOT NULL + union-of-keys NULL fill; the fixed shape inserts cleanly", async () => {
  const lines = [{ name: "Pending", unitPrice: "", pricePending: true }, { name: "Priced", unitPrice: "500" }];
  const bad = await makeDb().from("estimate_items").insert(lines.map((l, i) => preFixRow(l, i))).select("id");
  assert.equal(bad.error.code, "23502");
  assert.match(bad.error.message, /null value in column "metadata" of relation "estimate_items" violates not-null constraint/);

  const db = makeDb();
  const good = await db.from("estimate_items").insert([
    editorRow({ ...lines[0], metadata: { ...AI_META } }, 0),
    editorRow({ ...lines[1] }, 1),
  ]).select("id");
  assert.equal(good.error, null);
  assert.equal(db.__dumpTable("estimate_items").length, 2);
});

test("G — a multi-row save with mixed states (pending / priced / explicit-zero / manual / heading) passes NOT NULL metadata enforcement and each row keeps the right metadata", async () => {
  const db = makeDb();
  const rows = [
    editorRow({ name: "Pending AI", unitPrice: "", metadata: { ...AI_META }, pricePending: true }, 0),
    editorRow({ name: "Priced AI", unitPrice: "900", metadata: { ...AI_META }, pricePending: false }, 1),
    editorRow({ name: "Explicit zero", unitPrice: "0", metadata: { ...AI_META }, pricePending: false }, 2),
    editorRow({ name: "Manual", unitPrice: "40" }, 3),
    editorRow({ name: "Section", unitPrice: "", isHeading: true, metadata: { price_pending: true } }, 4),
  ];
  const res = await db.from("estimate_items").insert(rows).select("id");
  assert.equal(res.error, null);
  const byName = Object.fromEntries(db.__dumpTable("estimate_items").map((r: any) => [r.name, r.metadata]));
  assert.deepEqual(byName["Pending AI"], AI_META);
  assert.deepEqual(byName["Priced AI"], { ai_proposed: true, quantity_pending: true, ai_execution_id: "exec-1" });
  assert.deepEqual(byName["Explicit zero"], { ai_proposed: true, quantity_pending: true, ai_execution_id: "exec-1" });
  assert.deepEqual(byName["Manual"], {});
  assert.deepEqual(byName["Section"], {});
});

// ── N / O: the Send gate follows the persisted markers ──────────────────

test("N + O — pending markers survive a no-op save (Send stays BLOCKED); once every line's price has been edited the markers are gone (Send is eligible again)", () => {
  const loaded = [{ name: "A", unitPrice: "0", metadata: { ...AI_META } }, { name: "B", unitPrice: "0", metadata: { ...AI_META } }];
  // No-op save: the editor model keeps pricePending=true for both.
  const noop = loaded.map((l, i) => editorRow({ ...l, pricePending: true }, i));
  assert.equal(S.hasPricePendingItems(noop), true);
  // Owner edits every price (or types an explicit 0): pricePending cleared on each.
  const priced = [editorRow({ ...loaded[0], unitPrice: "1200", pricePending: false }, 0), editorRow({ ...loaded[1], unitPrice: "0", pricePending: false }, 1)];
  assert.equal(S.hasPricePendingItems(priced), false);
  // Partially edited -> still blocked.
  assert.equal(S.hasPricePendingItems([priced[0], noop[1]]), true);
});

// ── K / L / M: safer replacement ────────────────────────────────────────

const newRows = () => [editorRow({ name: "New A", unitPrice: "", metadata: { ...AI_META }, pricePending: true }, 0), editorRow({ name: "New B", unitPrice: "300" }, 1)];
const names = (db: any) => db.__dumpTable("estimate_items").map((r: any) => r.name).sort();

test("L — successful replacement: the new rows exist and the old rows are gone (only this estimate's)", async () => {
  const other = { ...oldItem("other-1", "Other estimate item"), estimate_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1" };
  const db = makeDb([oldItem("o1", "Old 1"), oldItem("o2", "Old 2"), other]);
  const res = await S.replaceEstimateItems(db, EST, newRows());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.removedCount, 2);
  assert.equal(res.insertedIds.length, 2);
  assert.deepEqual(names(db), ["New A", "New B", "Other estimate item"]);
});

test("K — a FAILED replacement INSERT leaves the old items intact and deletes nothing (the EST-000006 data-loss bug)", async () => {
  const base = makeDb([oldItem("o1", "Old 1"), oldItem("o2", "Old 2")]);
  let deleteCalls = 0;
  const db = {
    from: (t: string) => {
      const b = base.from(t);
      if (t === "estimate_items") {
        b.insert = () => ({ select: () => ({ then: (res: any) => res({ data: null, error: { code: "23502", message: "null value in column \"metadata\" of relation \"estimate_items\" violates not-null constraint" } }) }) });
        const realDelete = b.delete.bind(b);
        b.delete = () => { deleteCalls += 1; return realDelete(); };
      }
      return b;
    },
  };
  const res = await S.replaceEstimateItems(db, EST, newRows());
  assert.equal(res.ok, false);
  assert.equal(res.phase, "insert_new");
  assert.equal(res.error.code, "23502");
  assert.equal(deleteCalls, 0, "nothing may be deleted when the insert fails");
  assert.deepEqual(names(base), ["Old 1", "Old 2"]);
});

test("K2 — the REAL pre-fix scenario end to end: mixed rows through the NOT-NULL / NULL-fill fake, old items survive", async () => {
  const db = makeDb([oldItem("o1", "Old 1")]);
  const mixedPreFix = [preFixRow({ name: "P", unitPrice: "", pricePending: true }, 0), preFixRow({ name: "Q", unitPrice: "10" }, 1)];
  const res = await S.replaceEstimateItems(db, EST, mixedPreFix);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "23502");
  assert.deepEqual(names(db), ["Old 1"], "old items intact");
});

test("M — insert OK but deleting the OLD rows fails: ONLY the newly inserted rows are removed (best-effort), the old rows are preserved, and the save reports failure", async () => {
  const base = makeDb([oldItem("o1", "Old 1"), oldItem("o2", "Old 2")]);
  let deleteCalls = 0;
  const db = {
    from: (t: string) => {
      const b = base.from(t);
      if (t === "estimate_items") {
        const realDelete = b.delete.bind(b);
        b.delete = () => {
          deleteCalls += 1;
          if (deleteCalls === 1) return { in: () => ({ then: (res: any) => res({ data: null, error: { code: "42501", message: "boom" } }) }) };
          return realDelete(); // the compensating delete of the NEW ids runs for real
        };
      }
      return b;
    },
  };
  const res = await S.replaceEstimateItems(db, EST, newRows());
  assert.equal(res.ok, false);
  assert.equal(res.phase, "delete_old");
  assert.equal(deleteCalls, 2, "one failed old-row delete + one compensating delete");
  assert.deepEqual(names(base), ["Old 1", "Old 2"], "old rows preserved, new rows cleaned up");
});

test("replacement edge cases: no rows -> old items removed (user deleted every line); first-time save (no old rows) just inserts; a failure loading existing ids aborts before any write", async () => {
  const db = makeDb([oldItem("o1", "Old 1")]);
  assert.equal((await S.replaceEstimateItems(db, EST, [])).ok, true);
  assert.deepEqual(names(db), []);

  const fresh = makeDb([]);
  const res = await S.replaceEstimateItems(fresh, EST, newRows());
  assert.equal(res.ok, true);
  assert.equal(res.removedCount, 0);
  assert.deepEqual(names(fresh), ["New A", "New B"]);

  const base = makeDb([oldItem("o1", "Old 1")]);
  const failingLoad = { from: (t: string) => { const b = base.from(t); if (t === "estimate_items") b.select = () => ({ eq: () => ({ then: (res: any) => res({ data: null, error: { code: "XX000", message: "down" } }) }) }); return b; } };
  const r = await S.replaceEstimateItems(failingLoad, EST, newRows());
  assert.equal(r.ok, false);
  assert.equal(r.phase, "load_existing");
  assert.deepEqual(names(base), ["Old 1"]);
});

test("replacement logs only operation + Postgres code/message — never row content", async () => {
  const logged: unknown[][] = [];
  const prev = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    const base = makeDb([oldItem("o1", "SECRET-OLD-ITEM")]);
    const db = { from: (t: string) => { const b = base.from(t); if (t === "estimate_items") b.insert = () => ({ select: () => ({ then: (res: any) => res({ data: null, error: { code: "23502", message: "null value in column \"metadata\"" } }) }) }); return b; } };
    await S.replaceEstimateItems(db, EST, [editorRow({ name: "SECRET-NEW-ITEM", unitPrice: "1" })]);
  } finally { console.error = prev; }
  const blob = JSON.stringify(logged);
  assert.match(blob, /replace_items\.insert_new/);
  assert.match(blob, /23502/);
  assert.ok(!blob.includes("SECRET"));
});

// ── editor wiring (source-level, repo precedent) ────────────────────────

test("the editor is wired to the helpers: uniform metadata via buildItemMetadata, safe replacement, header merge, duplicate helpers — and the old patterns are gone", () => {
  const src = readFileSync(path.join(repoRoot, "src/routes/estimates.tsx"), "utf8");
  assert.match(src, /metadata: buildItemMetadata\(it\.metadata, \{ pricePending: it\.pricePending, isHeading: it\.isHeading, price \}\)/);
  assert.match(src, /replaceEstimateItems\(supabase, estimate\.id, buildItemRows\(estimate\.id\)\)/);
  assert.match(src, /mergeEstimateMetadata\(estimate\?\.metadata, \{ serviceAddress:/);
  assert.match(src, /metadata: duplicateItemMetadata\(it\.metadata\)/);
  assert.match(src, /\.\.\.duplicateEstimateMetadata\(e\.metadata\)/);
  assert.doesNotMatch(src, /\.\.\.\(it\.pricePending && !it\.isHeading && price <= 0 \? \{ metadata/, "the conditional metadata spread must not come back");
  assert.doesNotMatch(src, /\.\.\.\(it\.price_pending \? \{ metadata/, "nor in the duplicate flow");
  assert.doesNotMatch(src, /phase = "delete existing line items"/, "the delete-first update flow must not come back");
  // The old header replacement:
  assert.doesNotMatch(src, /metadata: \{ serviceAddress: address\.trim\(\) \|\| null \}/);
  // New manual lines start with {} and loaded lines copy their metadata:
  assert.match(src, /isHeading: false, metadata: \{\},/);
  assert.match(src, /metadata: \{ \.\.\.i\.metadata \},/);
});
