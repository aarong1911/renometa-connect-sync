// netlify/functions/lib/price-book-service.test.ts
//
// Run:  node --test netlify/functions/lib/price-book-service.test.ts
//
// Pricing Intelligence P4. Trusted Price Book CRUD, the price book READER, the estimate "Suggest Pricing" core, and the
// sensitive-data / security guarantees, on the in-memory fake Supabase client. No live database, no network, no model.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("real network access is forbidden in this test file"); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "price-book-service-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export * from "./netlify/functions/lib/price-book-service";
      export * from "./netlify/functions/lib/estimate-suggest-pricing";
      export * from "./src/lib/pricing/price-book-reader";
      export { createGetPricingSuggestions } from "./src/lib/agentic/pricing-handlers";
    `,
    resolveDir: repoRoot, loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error",
  external: ["@supabase/supabase-js"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);
const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href);

const noisy = ["log", "warn", "error"] as const;
const savedConsole = noisy.map((k) => (console as any)[k]);
noisy.forEach((k) => ((console as any)[k] = () => {}));
after(() => noisy.forEach((k, i) => ((console as any)[k] = savedConsole[i])));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const USER_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const CTX_A = { orgId: ORG_A, userId: USER_A };
const makeDb = (tables: Record<string, any[]> = {}) => createFakeSupabaseClient({ pricing_catalog_items: [], ...tables });
const NOW = () => new Date("2026-10-15T12:00:00.000Z");

const write = (over: Record<string, unknown> = {}) => ({ name: "Vanity installation", unit: "each", sellUnitPrice: 450, itemType: "labor", ...over });
const rows = (db: any) => (db as any).tables?.pricing_catalog_items ?? (db as any).store?.pricing_catalog_items ?? (db as any)._tables?.pricing_catalog_items;

// ── CRUD: trust boundary ─────────────────────────────────────────────────

test("create — org_id and reviewer come from the authenticated context; normalization is server-side", async () => {
  const db = makeDb();
  const r = await S.createPriceBookItem(db, CTX_A, write({ reviewed: true, aliases: ["Install vanity"] }), NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  const stored = (await db.from("pricing_catalog_items").select("*").eq("org_id", ORG_A)).data ?? [];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].org_id, ORG_A);
  assert.equal(stored[0].reviewed_by, USER_A);
  assert.equal(stored[0].reviewed_at, "2026-10-15T12:00:00.000Z");
  assert.equal(stored[0].source, "manual");
  assert.ok(stored[0].normalized_name && stored[0].normalized_name.length > 0, "normalized_name computed on the server");
});

test("create — rejects browser-supplied org_id / reviewed_by / normalized_name / id / source (nothing is stored)", async () => {
  const db = makeDb();
  for (const extra of [{ org_id: ORG_B }, { orgId: ORG_B }, { reviewed_by: USER_B }, { reviewedBy: USER_B }, { normalized_name: "evil" }, { id: "x" }, { source: "ai" }]) {
    const r = await S.createPriceBookItem(db, CTX_A, write(extra), NOW);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  }
  assert.equal(((await db.from("pricing_catalog_items").select("*")).data ?? []).length, 0);
});

test("create — an unreviewed entry has no reviewer stamped", async () => {
  const db = makeDb();
  const r = await S.createPriceBookItem(db, CTX_A, write(), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.value.reviewedAt, null);
  const stored = (await db.from("pricing_catalog_items").select("*")).data[0];
  assert.ok(stored.reviewed_by === undefined || stored.reviewed_by === null);
});

test("list — org scoped: another organization's entries are never returned; search + active filter work", async () => {
  const db = makeDb();
  await S.createPriceBookItem(db, CTX_A, write({ name: "Vanity installation", aliases: ["Install vanity"] }), NOW);
  await S.createPriceBookItem(db, CTX_A, write({ name: "Crown molding", itemType: "material", unit: "linear ft", active: false }), NOW);
  await S.createPriceBookItem(db, { orgId: ORG_B, userId: USER_B }, write({ name: "ORG-B-SECRET item" }), NOW);
  const all = await S.listPriceBook(db, ORG_A);
  assert.deepEqual(all.value.map((i: any) => i.name).sort(), ["Crown molding", "Vanity installation"]);
  assert.ok(!JSON.stringify(all).includes("ORG-B-SECRET"));
  assert.deepEqual((await S.listPriceBook(db, ORG_A, { active: "active" })).value.map((i: any) => i.name), ["Vanity installation"]);
  assert.deepEqual((await S.listPriceBook(db, ORG_A, { active: "inactive" })).value.map((i: any) => i.name), ["Crown molding"]);
  assert.deepEqual((await S.listPriceBook(db, ORG_A, { q: "install vanity" })).value.map((i: any) => i.name), ["Vanity installation"], "alias search");
});

test("update — a foreign organization's id is 'not found' and is never modified", async () => {
  const db = makeDb();
  const b = await S.createPriceBookItem(db, { orgId: ORG_B, userId: USER_B }, write({ name: "B item", sellUnitPrice: 10 }), NOW);
  const r = await S.updatePriceBookItem(db, CTX_A, b.value.id, { sellUnitPrice: 1 }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  const after = (await db.from("pricing_catalog_items").select("*").eq("id", b.value.id)).data[0];
  assert.equal(Number(after.sell_unit_price), 10);
  assert.equal((await S.updatePriceBookItem(db, CTX_A, "not-a-uuid", { active: false }, NOW)).status, 404);
});

test("update — activate / deactivate is a soft flag; nothing is deleted", async () => {
  const db = makeDb();
  const c = await S.createPriceBookItem(db, CTX_A, write(), NOW);
  const off = await S.setPriceBookItemActive(db, CTX_A, c.value.id, false);
  assert.equal(off.ok, true);
  assert.equal(off.value.active, false);
  assert.equal(((await db.from("pricing_catalog_items").select("*")).data ?? []).length, 1, "row still present");
  assert.equal((await S.setPriceBookItemActive(db, CTX_A, c.value.id, true)).value.active, true);
});

test("update — changing price/name clears the reviewed state unless re-reviewed; changing only notes/cost keeps it; reviewed stamps the CALLER", async () => {
  const db = makeDb();
  const c = await S.createPriceBookItem(db, CTX_A, write({ reviewed: true }), NOW);
  assert.ok(c.value.reviewedAt);
  const notes = await S.updatePriceBookItem(db, CTX_A, c.value.id, { notes: "supplier changed", internalUnitCost: 200 }, NOW);
  assert.ok(notes.value.reviewedAt, "non-pricing edits keep the review");
  const price = await S.updatePriceBookItem(db, CTX_A, c.value.id, { sellUnitPrice: 500 }, NOW);
  assert.equal(price.value.reviewedAt, null, "a price change clears the review");
  const rereview = await S.updatePriceBookItem(db, { orgId: ORG_A, userId: USER_B }, c.value.id, { reviewed: true }, NOW);
  assert.ok(rereview.value.reviewedAt);
  assert.equal((await db.from("pricing_catalog_items").select("*").eq("id", c.value.id)).data[0].reviewed_by, USER_B);
  const cleared = await S.updatePriceBookItem(db, CTX_A, c.value.id, { reviewed: false }, NOW);
  assert.equal(cleared.value.reviewedAt, null);
});

test("update — cross-field validation runs on the MERGED entry (low <= sell <= high)", async () => {
  const db = makeDb();
  const c = await S.createPriceBookItem(db, CTX_A, write({ sellUnitPrice: 450, lowUnitPrice: 400, highUnitPrice: 500 }), NOW);
  const bad = await S.updatePriceBookItem(db, CTX_A, c.value.id, { sellUnitPrice: 600 }, NOW);
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.equal(Number((await db.from("pricing_catalog_items").select("*").eq("id", c.value.id)).data[0].sell_unit_price), 450);
});

test("update — strict patch: org_id / reviewed_by / normalized_name / id are rejected", async () => {
  const db = makeDb();
  const c = await S.createPriceBookItem(db, CTX_A, write(), NOW);
  for (const extra of [{ org_id: ORG_B }, { reviewed_by: USER_B }, { normalized_name: "x" }, { id: "x" }, { source: "ai" }]) {
    assert.equal((await S.updatePriceBookItem(db, CTX_A, c.value.id, extra, NOW)).status, 400);
  }
});

test("service — a missing table (migration not applied) is reported as a clear 501, not a crash; no values are logged", async () => {
  const logged: unknown[] = [];
  const saved = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    const failing = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { code: "42P01", message: 'relation "pricing_catalog_items" does not exist SENTINEL-ROW' } }) }) }) }) }) };
    const r = await S.listPriceBook(failing, ORG_A);
    assert.equal(r.ok, false);
    assert.equal(r.status, 501);
    assert.match(r.error, /pending migration/);
    assert.ok(!JSON.stringify(logged).includes("SENTINEL-ROW"), "db message text is not logged");
  } finally { console.error = saved; }
});

// ── Reader: org scope, active only, sensitive columns never selected ─────

test("reader — SELECT LIST is explicit and excludes id, internal cost, markup, notes, reviewer and source", () => {
  const cols = S.PRICE_BOOK_READ_COLUMNS.split(",").map((c: string) => c.trim());
  for (const forbidden of ["id", "internal_unit_cost", "default_markup_percent", "notes", "reviewed_by", "source", "org_id", "created_at", "updated_at", "*"]) {
    assert.ok(!cols.includes(forbidden), `reader selects ${forbidden}`);
  }
});

test("reader — org scoped and active only; entries never carry cost/markup/notes/ids even if the row had them", async () => {
  const db = makeDb({
    pricing_catalog_items: [
      { id: "ID-A1", org_id: ORG_A, name: "Vanity installation", normalized_name: "vanity installation", aliases: [], project_types: [], item_type: "labor", unit: "each", sell_unit_price: 450, low_unit_price: null, high_unit_price: null, internal_unit_cost: 77777, default_markup_percent: 4321, notes: "SENTINEL-NOTE", reviewed_by: "SENTINEL-USER", reviewed_at: "2026-10-01T00:00:00Z", active: true },
      { id: "ID-A2", org_id: ORG_A, name: "Inactive thing", normalized_name: "inactive thing", aliases: [], project_types: [], item_type: "labor", unit: "each", sell_unit_price: 1, active: false },
      { id: "ID-B1", org_id: ORG_B, name: "ORG-B-SECRET", normalized_name: "org-b-secret", aliases: [], project_types: [], item_type: "labor", unit: "each", sell_unit_price: 9, active: true },
    ],
  });
  const r = await S.readPriceBook(db, ORG_A);
  assert.equal(r.available, true);
  assert.deepEqual(r.items.map((i: any) => i.name), ["Vanity installation"]);
  const json = JSON.stringify(r);
  for (const forbidden of ["ID-A1", "ID-A2", "ID-B1", "77777", "4321", "SENTINEL", "ORG-B-SECRET", "Inactive thing"]) assert.ok(!json.includes(forbidden), `reader leaked ${forbidden}`);
  assert.equal(r.items[0].reviewed, true);
});

test("reader — a failing read (e.g. the table does not exist yet) is 'unavailable', never a throw", async () => {
  const failing = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { code: "42P01", message: "missing" } }) }) }) }) }) }) };
  assert.deepEqual(await S.readPriceBook(failing, ORG_A), { available: false, items: [] });
  assert.deepEqual(await S.readPriceBook(makeDb(), ""), { available: false, items: [] });
});

// ── Suggest Pricing core (estimate UI entry point) ───────────────────────

const EST = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const EST_B = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const estimateRow = (over: Record<string, unknown> = {}) => ({ id: EST, org_id: ORG_A, number: "EST-1", title: "Bath", status: "draft", client_id: null, lead_id: null, project_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", tax_rate: 0, subtotal: 0, total: 0, ...over });
let n = 0;
const itemRow = (over: Record<string, unknown> = {}) => ({ id: `item-${++n}`, estimate_id: EST, name: "Vanity installation", description: null, item_type: "labor", quantity: 2, unit: "each", unit_price: 0, total: 0, optional: false, taxable: true, is_heading: false, position: n, metadata: {}, ...over });
const book = (over: Record<string, unknown> = {}) => ({ id: `pb-${++n}`, org_id: ORG_A, name: "Vanity installation", normalized_name: "vanity installation", aliases: [], project_types: [], item_type: "labor", unit: "each", sell_unit_price: 450, low_unit_price: null, high_unit_price: null, reviewed_at: "2026-10-01T00:00:00Z", active: true, ...over });

test("suggest — resolves price_pending and $0 lines server-side; a positive reviewed line is excluded; read-only", async () => {
  const db = makeDb({
    estimates: [estimateRow()],
    estimate_items: [
      itemRow({ name: "Vanity installation", unit_price: 0 }),
      itemRow({ name: "Crown molding", item_type: "material", unit: "linear ft", unit_price: 0, metadata: { price_pending: true } }),
      itemRow({ name: "Priced demolition", item_type: "labor", unit_price: 800 }),
      itemRow({ name: "Heading", is_heading: true, unit_price: 0 }),
    ],
    pricing_catalog_items: [book(), book({ name: "Crown molding", normalized_name: "crown molding", item_type: "material", unit: "linear ft", sell_unit_price: 6.5 })],
  });
  const before = JSON.stringify(await db.from("estimate_items").select("*"));
  const r = await S.suggestPricingForEstimate(db, CTX_A, EST, { now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.kind, "suggestions");
  const names = r.pricing.suggestions.map((s: any) => s.itemName).sort();
  assert.deepEqual(names, ["Crown molding", "Vanity installation"], "priced line and heading excluded");
  const vanity = r.pricing.suggestions.find((s: any) => s.itemName === "Vanity installation");
  assert.equal(vanity.unitPrice ?? vanity.suggestedUnitPrice, 450);
  assert.equal(JSON.stringify(await db.from("estimate_items").select("*")), before, "estimate items untouched");
  assert.deepEqual(((await db.from("estimates").select("*")).data ?? []).map((e: any) => e.status), ["draft"]);
});

test("suggest — all lines already priced -> the 'all priced' response, no suggestions", async () => {
  const db = makeDb({ estimates: [estimateRow()], estimate_items: [itemRow({ unit_price: 100 }), itemRow({ name: "Tile", unit_price: 50 })] });
  const r = await S.suggestPricingForEstimate(db, CTX_A, EST, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.kind, "all_priced");
  assert.equal(r.message, "All estimate items already have reviewed pricing.");
});

test("suggest — a foreign organization's estimate (or a malformed id) is 'not found'; nothing leaks", async () => {
  const db = makeDb({ estimates: [estimateRow({ id: EST_B, org_id: ORG_B, title: "ORG-B-SECRET" })], estimate_items: [itemRow({ estimate_id: EST_B, name: "ORG-B-SECRET line" })] });
  const r = await S.suggestPricingForEstimate(db, CTX_A, EST_B, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.ok(!JSON.stringify(r).includes("ORG-B-SECRET"));
  assert.equal((await S.suggestPricingForEstimate(db, CTX_A, "nope", { now: NOW })).status, 404);
  assert.equal((await S.suggestPricingForEstimate(db, CTX_A, undefined, { now: NOW })).status, 404);
});

test("suggest — another organization's price book is never used", async () => {
  const db = makeDb({
    estimates: [estimateRow()],
    estimate_items: [itemRow({ unit_price: 0 })],
    pricing_catalog_items: [book({ org_id: ORG_B, sell_unit_price: 9999 })],
  });
  const r = await S.suggestPricingForEstimate(db, CTX_A, EST, { now: NOW });
  assert.equal(r.ok, true);
  assert.ok(!JSON.stringify(r).includes("9999"));
  assert.equal(r.pricing.suggestions[0].status, "no_history");
});

test("suggest — no quantity -> no total and 'quantity' is a missing input; the engine never guesses a quantity", async () => {
  const db = makeDb({
    estimates: [estimateRow()],
    estimate_items: [itemRow({ unit_price: 0, quantity: 0 })],
    pricing_catalog_items: [book()],
  });
  const r = await S.suggestPricingForEstimate(db, CTX_A, EST, { now: NOW });
  const s = r.pricing.suggestions[0];
  assert.ok(s.missingInputs.includes("quantity"));
  assert.ok(s.total === null || s.suggestedTotal === null || s.total === undefined);
});

test("suggest — the staff payload carries no estimate/customer text, no ids, and no cost/markup/notes", async () => {
  const db = makeDb({
    estimates: [estimateRow({ title: "SENTINEL-TITLE" })],
    estimate_items: [itemRow({ unit_price: 0, description: "SENTINEL-DESC" })],
    pricing_catalog_items: [{ ...book(), internal_unit_cost: 77777, default_markup_percent: 4321, notes: "SENTINEL-NOTE" }],
  });
  const r = await S.suggestPricingForEstimate(db, CTX_A, EST, { now: NOW });
  const json = JSON.stringify(r);
  for (const forbidden of ["SENTINEL", "77777", "4321", EST, ORG_A, USER_A, "pb-", "item-"]) assert.ok(!json.includes(forbidden), `leaked ${forbidden}`);
});

// ── Static guarantees (source + migration) ───────────────────────────────

const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

test("static — internal_unit_cost / default_markup_percent / pricing_catalog_items appear ONLY in the allowed files", () => {
  const allowed = new Set([
    "netlify/functions/lib/price-book-service.ts", "src/lib/pricing/price-book.ts", "src/lib/pricing/price-book-reader.ts", "src/lib/price-book-api.ts", "src/routes/settings.price-book.tsx",
    "src/lib/pricing/price-book-fields.ts",
  ]);
  const offenders: string[] = [];
  for (const file of [...walk(path.join(repoRoot, "src")), ...walk(path.join(repoRoot, "netlify"))]) {
    const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
    if (rel.endsWith("routeTree.gen.ts") || allowed.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    if (/internal_unit_cost|internalUnitCost|default_markup_percent|defaultMarkupPercent/.test(src) || /pricing_catalog_items/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `sensitive price-book fields referenced outside the allowed files: ${offenders.join(", ")}`);
});

test("static — customer-facing surfaces never reference the price book or staff pricing", () => {
  for (const rel of ["src/lib/ai-estimate-proposal.ts", "src/components/ai-center/ai-approvals-tab.tsx", "netlify/functions/estimate-public.ts", "netlify/functions/estimate-data.ts"]) {
    let src = "";
    try { src = read(rel); } catch { continue; }
    assert.ok(!/pricing_catalog_items|price-book|priceBook|staff-pricing|pricingIntelligence/.test(src), `${rel} must not reference the price book / staff pricing`);
  }
});

test("static — the model-visible tool registry exposes no cost/markup/ids and the Suggest Pricing path makes no model call and no writes", () => {
  const core = read("netlify/functions/lib/estimate-suggest-pricing.ts");
  assert.ok(!/anthropic|ModelProvider|\.insert\(|\.update\(|\.upsert\(|\.delete\(|createApproval|approval_request/i.test(core), "suggest-pricing core is read only and model free");
  const fn = read("netlify/functions/estimate-suggest-pricing.ts");
  assert.ok(!/\.insert\(|\.update\(|\.upsert\(|\.delete\(/.test(fn));
  const reader = read("src/lib/pricing/price-book-reader.ts");
  assert.ok(!/\.insert\(|\.update\(|\.upsert\(|\.delete\(/.test(reader), "the reader is read only");
  const ui = read("src/components/pricing/suggest-pricing-panel.tsx") + read("src/components/pricing/staff-pricing-view.tsx");
  const uiCode = ui.replace(/^[ \t]*[/][/].*$/gm, "");
  assert.ok(!/apply|accept/i.test(uiCode.replace(/not applied|never applied|applied to the estimate|Nothing is applied/gi, "")), "no apply/accept control in the staff panel");
});

test("static — the endpoints derive org and user from the token, restrict roles, and take no org/reviewer from the body", () => {
  const book = read("netlify/functions/price-book.ts");
  assert.match(book, /auth\.getUser\(token\)/);
  assert.match(book, /resolveOrgAndAuthority/);
  assert.match(book, /isOwnerOrAdmin/);
  assert.ok(!/body\.org|body\.user|orgId\s*=\s*.*body|reviewed_by/.test(book));
  const suggest = read("netlify/functions/estimate-suggest-pricing.ts");
  assert.match(suggest, /auth\.getUser\(token\)/);
  assert.match(suggest, /resolveOrgAndAuthority/);
  assert.match(suggest, /Body must be exactly \{ estimateId \}/);
  const roles = S === null ? [] : (suggest.match(/SUGGEST_PRICING_ROLES = \[([^\]]*)\]/)?.[1] ?? "");
  assert.ok(!/viewer|field_worker/.test(String(roles)), "portal viewers and field workers cannot call it");
});

test("migration — additive, RLS enabled, constraints + guard trigger present, no delete policy, nothing destructive", () => {
  const sql = read("supabase/migrations/20261026_pricing_catalog_items.sql");
  assert.match(sql, /create table (if not exists )?public\.pricing_catalog_items/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /set search_path\s*=\s*pg_catalog, pg_temp/i);
  assert.match(sql, /security definer/i);
  for (const c of ["sell_unit_price", "low_unit_price", "high_unit_price", "internal_unit_cost", "default_markup_percent", "normalized_name", "reviewed_by", "project_types", "aliases"]) assert.match(sql, new RegExp(c));
  assert.match(sql, /check\s*\(/i);
  assert.ok(!/drop table|drop column|truncate|delete from|alter table public\.(?!pricing_catalog_items)/i.test(sql.replace(/--.*$/gm, "").replace(/^[ \t]*revoke[^;]*;/gim, "")), "no destructive statements and no other tables altered");
  assert.ok(!/for delete/i.test(sql.replace(/--.*$/gm, "")), "no delete policy (soft disable only)");
  assert.match(sql, /org_memberships/);
});

// ── P4.1: an explicit estimate-line unit is a KNOWN unit (regression: "each" was treated as missing) ──

async function suggestOne(line: Record<string, unknown>, bookOver: Record<string, unknown> = {}, extraTables: Record<string, any[]> = {}) {
  const db = makeDb({
    estimates: [estimateRow()],
    estimate_items: [itemRow({ name: "Mirror Installation", unit_price: 0, ...line })],
    pricing_catalog_items: [book({ name: "Mirror Installation", normalized_name: "mirror installation", unit: "each", sell_unit_price: 250, project_types: [], ...bookOver })],
    ...extraTables,
  });
  const r = await S.suggestPricingForEstimate(db, CTX_A, EST, { now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.kind, "suggestions");
  return r.pricing.suggestions[0];
}

test("P4.1 explicit 'each' (qty 1) — price book match, total = sell x qty, high confidence, NO unit assumption, NO missing unit", async () => {
  const s = await suggestOne({ unit: "each", quantity: 1 });
  assert.equal(s.pricingSource, "price_book");
  assert.equal(s.suggestedUnitPrice, 250);
  assert.equal(s.suggestedTotal, 250);
  assert.equal(s.confidence, "high");
  assert.deepEqual(s.missingInputs.filter((m: string) => m === "unit"), []);
  assert.ok(!s.assumptions.some((a: string) => /No unit was specified/.test(a)), JSON.stringify(s.assumptions));
});

test("P4.1 explicit alias 'ea' normalizes to 'each' and matches a price book 'each' entry", async () => {
  const s = await suggestOne({ unit: "ea", quantity: 2 });
  assert.equal(s.pricingSource, "price_book");
  assert.equal(s.suggestedTotal, 500);
  assert.ok(!s.missingInputs.includes("unit"));
  assert.ok(!s.assumptions.some((a: string) => /No unit was specified/.test(a)));
});

test("P4.1 truly missing unit (null / blank) — safe fallback to the price book unit, 'unit' reported missing, assumption kept", async () => {
  for (const unit of [null, "", "   "]) {
    const s = await suggestOne({ unit, quantity: 1 });
    assert.equal(s.pricingSource, "price_book", String(unit));
    assert.ok(s.missingInputs.includes("unit"), String(unit));
    assert.ok(s.assumptions.some((a: string) => /No unit was specified/.test(a)), String(unit));
  }
});

test("P4.1 incompatible explicit unit — 'sqft' line never matches an 'each' entry and the price book unit is NOT substituted", async () => {
  const s = await suggestOne({ unit: "sqft", quantity: 1 });
  assert.notEqual(s.pricingSource, "price_book");
  assert.equal(s.status, "no_history");
  assert.equal(s.suggestedUnitPrice, null);
  assert.ok(!s.assumptions.some((a: string) => /No unit was specified|price book's unit/.test(a)));
});

test("P4.1 explicit compatible unit + missing quantity — unit price suggested, total null, only 'quantity' is missing", async () => {
  const s = await suggestOne({ unit: "each", quantity: 0 });
  assert.equal(s.suggestedUnitPrice, 250);
  assert.equal(s.suggestedTotal, null);
  assert.deepEqual(s.missingInputs.filter((m: string) => ["quantity", "unit"].includes(m)), ["quantity"]);
});

test("P4.1 other explicit units still match their own price book unit (sqft, lump_sum) and reject mismatches", async () => {
  const sqft = await suggestOne({ unit: "sf", quantity: 10 }, { unit: "sqft", sell_unit_price: 8 });
  assert.equal(sqft.pricingSource, "price_book");
  assert.equal(sqft.suggestedTotal, 80);
  assert.ok(!sqft.missingInputs.includes("unit"));
  const mismatch = await suggestOne({ unit: "hour", quantity: 1 }, { unit: "sqft" });
  assert.notEqual(mismatch.pricingSource, "price_book");
});

test("P4.1 the entry point no longer special-cases 'each' (source)", () => {
  const src = read("netlify/functions/lib/estimate-suggest-pricing.ts");
  assert.ok(!/toLowerCase\(\)\s*===\s*["']each["']/.test(src), "no 'each' special case");
});
