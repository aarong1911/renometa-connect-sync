// src/lib/pricing/pricing-evidence-reader.test.ts
//
// Run:  node --test src/lib/pricing/pricing-evidence-reader.test.ts
//
// Pricing Intelligence v1 (P2). The org-scoped, read-only evidence reader against the in-memory fake Supabase client.
// No live Supabase, no network. The clock is injected (NOW).

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "pricing-evidence-reader-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export * from "./src/lib/pricing/pricing-evidence-reader";
      export * from "./src/lib/pricing/project-type";
      export { suggestPricingForItem } from "./src/lib/pricing/pricing-engine";
    `,
    resolveDir: repoRoot, loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error",
});
const R: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);
const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href);

const noisy = ["log", "warn", "error"] as const;
const savedConsole = noisy.map((k) => (console as any)[k]);
noisy.forEach((k) => ((console as any)[k] = () => {}));
after(() => noisy.forEach((k, i) => ((console as any)[k] = savedConsole[i])));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-15T00:00:00.000Z");
const monthsAgo = (n: number) => { const d = new Date(NOW); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString(); };
const daysAhead = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

let seq = 0;
const uid = (p: string) => `${p}-${String(++seq).padStart(8, "0")}-0000-4000-8000-000000000000`;

function estimate(over: Record<string, unknown> = {}) {
  return { id: uid("e"), org_id: ORG_A, status: "approved", project_id: null, lead_id: null, approved_at: monthsAgo(2), converted_at: null, sent_at: null, created_at: monthsAgo(3), ...over };
}
function line(estimateId: string, over: Record<string, unknown> = {}) {
  return { id: uid("i"), estimate_id: estimateId, name: "Vanity installation", description: "SENTINEL-DESCRIPTION", item_type: "labor", unit: "each", quantity: 1, unit_price: 100, total: 100, is_heading: false, optional: false, metadata: {}, ...over };
}
function db(tables: Record<string, any[]> = {}) {
  return createFakeSupabaseClient({ estimates: [], estimate_items: [], projects: [], leads: [], project_change_orders: [], project_change_order_items: [], ...tables }, {}, {});
}
const read = (client: any, org = ORG_A) => R.readPricingEvidence(client, org, NOW);

// ── org isolation ────────────────────────────────────────────────────────

test("ORG ISOLATION — org A never receives org B's estimate, change-order, or project-type data", async () => {
  const eA = estimate({ org_id: ORG_A });
  const eB = estimate({ org_id: ORG_B });
  const coB = { id: uid("c"), org_id: ORG_B, project_id: null, status: "approved", approved_at: monthsAgo(1), created_at: monthsAgo(2) };
  const client = db({
    estimates: [eA, eB],
    estimate_items: [line(eA.id, { unit_price: 111 }), line(eB.id, { unit_price: 999, name: "ORG-B-SECRET-ITEM" })],
    project_change_orders: [coB],
    project_change_order_items: [{ id: uid("ci"), org_id: ORG_B, change_order_id: coB.id, name: "ORG-B-CO-ITEM", item_type: "service", unit: "each", quantity: 1, unit_price: 777 }],
  });
  const r = await read(client, ORG_A);
  assert.equal(r.ok, true);
  assert.deepEqual(r.evidence.map((l: any) => l.unitPrice), [111]);
  const json = JSON.stringify(r);
  assert.ok(!json.includes("ORG-B") && !json.includes("999") && !json.includes("777"));
  // and the reverse
  const rb = await read(client, ORG_B);
  assert.deepEqual(rb.evidence.map((l: any) => l.unitPrice).sort(), [777, 999]);
});

test("ORG ISOLATION — a change-order item whose org_id is another org is never returned even if its change order id is in scope", async () => {
  const coA = { id: uid("c"), org_id: ORG_A, project_id: null, status: "approved", approved_at: monthsAgo(1), created_at: monthsAgo(2) };
  const client = db({
    project_change_orders: [coA],
    project_change_order_items: [
      { id: uid("ci"), org_id: ORG_A, change_order_id: coA.id, name: "ok", item_type: "service", unit: "each", quantity: 1, unit_price: 50 },
      { id: uid("ci"), org_id: ORG_B, change_order_id: coA.id, name: "leak", item_type: "service", unit: "each", quantity: 1, unit_price: 5000 },
    ],
  });
  const r = await read(client);
  assert.deepEqual(r.evidence.map((l: any) => l.unitPrice), [50]);
});

test("ORG ISOLATION — project type comes only from this org's projects (a foreign project row is invisible)", async () => {
  const projB = { id: uid("p"), org_id: ORG_B, project_type: "kitchen_remodel" };
  const e = estimate({ project_id: projB.id });
  const r = await read(db({ estimates: [e], estimate_items: [line(e.id)], projects: [projB] }));
  assert.equal(r.evidence[0].projectType, null);
});

// ── estimate status / evidence strength inputs ───────────────────────────

test("STATUS — approved, converted, sent and viewed are read; draft, ready, rejected, expired, cancelled, archived and changes_requested never are", async () => {
  const all = ["approved", "converted", "sent", "viewed", "draft", "ready", "rejected", "expired", "cancelled", "archived", "changes_requested"];
  const ests = all.map((status) => estimate({ status, sent_at: monthsAgo(2) }));
  const items = ests.map((e, i) => line(e.id, { unit_price: 100 + i }));
  const r = await read(db({ estimates: ests, estimate_items: items }));
  assert.deepEqual(r.evidence.map((l: any) => l.estimateStatus).sort(), ["approved", "converted", "sent", "viewed"]);
});

test("STATUS — the reader reports the parent status so the engine can treat approved/converted as strong and sent/viewed as secondary", async () => {
  const ests = ["approved", "converted", "sent", "viewed"].map((status) => estimate({ status, sent_at: monthsAgo(2) }));
  const r = await read(db({ estimates: ests, estimate_items: ests.map((e) => line(e.id)) }));
  const s = R.suggestPricingForItem({ name: "Vanity installation", itemType: "labor", unit: "each" }, r.evidence, { now: NOW });
  assert.equal(s.evidence.strongSampleCount, 2);
  assert.equal(s.evidence.secondarySampleCount, 2);
});

// ── change orders ────────────────────────────────────────────────────────

test("CHANGE ORDERS — approved items are evidence; draft / sent / rejected / superseded / cancelled / expired change orders are not", async () => {
  const statuses = ["approved", "draft", "internal_review", "ready_to_send", "sent", "viewed", "rejected", "cancelled", "expired", "superseded"];
  const cos = statuses.map((status) => ({ id: uid("c"), org_id: ORG_A, project_id: null, status, approved_at: monthsAgo(2), created_at: monthsAgo(3) }));
  const items = cos.map((c, i) => ({ id: uid("ci"), org_id: ORG_A, change_order_id: c.id, name: "Extra outlet", item_type: "service", unit: "each", quantity: 1, unit_price: 100 + i }));
  const r = await read(db({ project_change_orders: cos, project_change_order_items: items }));
  assert.equal(r.evidence.length, 1);
  assert.equal(r.evidence[0].source, "change_order_item");
  assert.equal(r.evidence[0].changeOrderStatus, "approved");
  assert.equal(r.evidence[0].unitPrice, 100);
});

test("CHANGE ORDERS — zero-price items are not read", async () => {
  const co = { id: uid("c"), org_id: ORG_A, project_id: null, status: "approved", approved_at: monthsAgo(2), created_at: monthsAgo(3) };
  const r = await read(db({ project_change_orders: [co], project_change_order_items: [{ id: uid("ci"), org_id: ORG_A, change_order_id: co.id, name: "x", item_type: "service", unit: "each", quantity: 1, unit_price: 0 }] }));
  assert.equal(r.evidence.length, 0);
});

test("CHANGE ORDERS — an unreadable change-order source never breaks estimate evidence (it is reported unavailable)", async () => {
  const e = estimate();
  const base = db({ estimates: [e], estimate_items: [line(e.id)] });
  const failing = { ...base, from: (t: string) => { const b = base.from(t); if (t === "project_change_orders") b.select = () => ({ eq: () => ({ eq: () => ({ or: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { code: "42P01", message: "no such table" } }) }) }) }) }) }); return b; } };
  const r = await read(failing);
  assert.equal(r.ok, true);
  assert.equal(r.evidence.length, 1);
  assert.equal(r.diagnostics.changeOrderEvidenceAvailable, false);
});

// ── dates ────────────────────────────────────────────────────────────────

test("DATE PRIORITY — estimates: approved_at, then converted_at, then sent_at, then created_at", () => {
  const row = { approved_at: "2026-01-01T00:00:00Z", converted_at: "2026-02-01T00:00:00Z", sent_at: "2026-03-01T00:00:00Z", created_at: "2026-04-01T00:00:00Z" };
  assert.equal(R.pickDocumentDate(row, R.ESTIMATE_DATE_PRIORITY), "2026-01-01T00:00:00.000Z");
  assert.equal(R.pickDocumentDate({ ...row, approved_at: null }, R.ESTIMATE_DATE_PRIORITY), "2026-02-01T00:00:00.000Z");
  assert.equal(R.pickDocumentDate({ ...row, approved_at: null, converted_at: null }, R.ESTIMATE_DATE_PRIORITY), "2026-03-01T00:00:00.000Z");
  assert.equal(R.pickDocumentDate({ ...row, approved_at: null, converted_at: null, sent_at: null }, R.ESTIMATE_DATE_PRIORITY), "2026-04-01T00:00:00.000Z");
  assert.equal(R.pickDocumentDate({ approved_at: "garbage", created_at: "2026-04-01T00:00:00Z" }, R.ESTIMATE_DATE_PRIORITY), "2026-04-01T00:00:00.000Z");
  assert.equal(R.pickDocumentDate({}, R.ESTIMATE_DATE_PRIORITY), null);
});

test("DATE PRIORITY — change orders: approved_at, then created_at", () => {
  assert.equal(R.pickDocumentDate({ approved_at: "2026-01-01T00:00:00Z", created_at: "2026-04-01T00:00:00Z" }, R.CHANGE_ORDER_DATE_PRIORITY), "2026-01-01T00:00:00.000Z");
  assert.equal(R.pickDocumentDate({ approved_at: null, created_at: "2026-04-01T00:00:00Z" }, R.CHANGE_ORDER_DATE_PRIORITY), "2026-04-01T00:00:00.000Z");
});

test("DATE — the chosen date is normalized into documentDate (approved_at beats an older created_at; a long-lived draft approved recently is in-window)", async () => {
  const e = estimate({ created_at: monthsAgo(40), approved_at: monthsAgo(10) });
  const r = await read(db({ estimates: [e], estimate_items: [line(e.id)] }));
  assert.equal(r.evidence.length, 1);
  assert.equal(r.evidence[0].documentDate, monthsAgo(10));
});

test("DATE — evidence older than 36 months and future-dated evidence is excluded", async () => {
  const old = estimate({ approved_at: monthsAgo(37), created_at: monthsAgo(38) });
  const fresh = estimate({ approved_at: monthsAgo(35), created_at: monthsAgo(36) });
  const future = estimate({ approved_at: daysAhead(30), created_at: monthsAgo(1) });
  const r = await read(db({ estimates: [old, fresh, future], estimate_items: [line(old.id, { unit_price: 1 }), line(fresh.id, { unit_price: 2 }), line(future.id, { unit_price: 3 })] }));
  assert.deepEqual(r.evidence.map((l: any) => l.unitPrice), [2]);
});

// ── line eligibility ─────────────────────────────────────────────────────

test("LINES — price_pending, ai_proposed, headings, optional lines, zero/negative price and discount lines are never evidence", async () => {
  const e = estimate();
  const items = [
    line(e.id, { unit_price: 100 }),
    line(e.id, { unit_price: 101, metadata: { price_pending: true } }),
    line(e.id, { unit_price: 102, metadata: { ai_proposed: true } }),
    line(e.id, { unit_price: 103, is_heading: true }),
    line(e.id, { unit_price: 104, optional: true }),
    line(e.id, { unit_price: 0 }),
    line(e.id, { unit_price: -5 }),
    line(e.id, { unit_price: 105, item_type: "discount" }),
  ];
  const r = await read(db({ estimates: [e], estimate_items: items }));
  assert.deepEqual(r.evidence.map((l: any) => l.unitPrice), [100]);
});

test("LINES — a stale price_pending marker is still excluded (the marker is the source of truth for 'unpriced placeholder')", async () => {
  const e = estimate();
  const r = await read(db({ estimates: [e], estimate_items: [line(e.id, { unit_price: 250, metadata: { price_pending: true } })] }));
  assert.equal(r.evidence.length, 0);
});

// ── project type ─────────────────────────────────────────────────────────

test("PROJECT TYPE — passed through from estimate.project_id -> projects.project_type", async () => {
  const p = { id: uid("p"), org_id: ORG_A, project_type: "kitchen_remodel" };
  const e = estimate({ project_id: p.id });
  const r = await read(db({ estimates: [e], estimate_items: [line(e.id)], projects: [p] }));
  assert.equal(r.evidence[0].projectType, "kitchen_remodel");
});

test("PROJECT TYPE — missing stays null: no project, no lead, 'other', or an unknown value", async () => {
  const pOther = { id: uid("p"), org_id: ORG_A, project_type: "other" };
  const e1 = estimate();
  const e2 = estimate({ project_id: pOther.id });
  const e3 = estimate({ project_id: uid("p-missing") });
  const r = await read(db({ estimates: [e1, e2, e3], estimate_items: [line(e1.id), line(e2.id), line(e3.id)], projects: [pOther] }));
  assert.deepEqual(r.evidence.map((l: any) => l.projectType), [null, null, null]);
});

test("PROJECT TYPE — FALLBACK: the lead's service text classifies the evidence when no project type exists (no project link is created)", async () => {
  const lead = { id: uid("l"), org_id: ORG_A, custom_fields: { service: "Bathroom Remodel", address: "1 SENTINEL ST" } };
  const e = estimate({ lead_id: lead.id });
  const r = await read(db({ estimates: [e], estimate_items: [line(e.id)], leads: [lead] }));
  assert.equal(r.evidence[0].projectType, "bathroom_remodel");
  assert.ok(!JSON.stringify(r).includes("SENTINEL"));
});

test("PROJECT TYPE — the project's own type wins over the lead fallback; an unmappable lead service stays null", async () => {
  const p = { id: uid("p"), org_id: ORG_A, project_type: "roofing" };
  const lead = { id: uid("l"), org_id: ORG_A, custom_fields: { service: "Bathroom Remodel" } };
  const e = estimate({ project_id: p.id, lead_id: lead.id });
  const lead2 = { id: uid("l"), org_id: ORG_A, custom_fields: { service: "something unusual" } };
  const e2 = estimate({ lead_id: lead2.id });
  const r = await read(db({ estimates: [e, e2], estimate_items: [line(e.id), line(e2.id)], projects: [p], leads: [lead, lead2] }));
  assert.deepEqual(r.evidence.map((l: any) => l.projectType).sort((a: any, b: any) => String(a).localeCompare(String(b))), [null, "roofing"]);
});

test("classifyProjectTypeFromText / normalizeProjectType — exact phrases only; anything else is null", () => {
  assert.equal(R.classifyProjectTypeFromText("Bathroom Remodel"), "bathroom_remodel");
  assert.equal(R.classifyProjectTypeFromText("kitchen_remodel"), "kitchen_remodel");
  assert.equal(R.classifyProjectTypeFromText("Kitchen"), "kitchen_remodel");
  assert.equal(R.classifyProjectTypeFromText("Whole house remodel"), "full_home_remodel");
  assert.equal(R.classifyProjectTypeFromText("I want a new kitchen and also a deck"), null);
  assert.equal(R.classifyProjectTypeFromText(""), null);
  assert.equal(R.classifyProjectTypeFromText(42), null);
  assert.equal(R.normalizeProjectType("other"), null);
  assert.equal(R.normalizeProjectType("Roofing"), "roofing");
});

// ── output hygiene ───────────────────────────────────────────────────────

test("OUTPUT — evidence lines carry no database ids, customer fields, descriptions, notes or costs: only the engine's input fields", async () => {
  const lead = { id: uid("l"), org_id: ORG_A, custom_fields: { service: "Kitchen" } };
  const p = { id: uid("p"), org_id: ORG_A, project_type: "kitchen_remodel", name: "SENTINEL-CUSTOMER-NAME Residence" };
  const e = estimate({ project_id: p.id, lead_id: lead.id });
  const co = { id: uid("c"), org_id: ORG_A, project_id: p.id, status: "approved", approved_at: monthsAgo(1), created_at: monthsAgo(2) };
  const r = await read(db({
    estimates: [e], estimate_items: [line(e.id)], projects: [p], leads: [lead], project_change_orders: [co],
    project_change_order_items: [{ id: uid("ci"), org_id: ORG_A, change_order_id: co.id, name: "Extra", item_type: "service", unit: "each", quantity: 1, unit_price: 80, internal_cost: 12345, internal_markup: 678, description: "SENTINEL-CO-NOTE" }],
  }));
  const allowed = new Set(["source", "name", "itemType", "unit", "quantity", "unitPrice", "isHeading", "optional", "metadata", "estimateStatus", "changeOrderStatus", "documentDate", "projectType"]);
  for (const l of r.evidence) for (const k of Object.keys(l)) assert.ok(allowed.has(k), `unexpected field ${k}`);
  const json = JSON.stringify(r);
  for (const forbidden of ["SENTINEL", "12345", "678", e.id, p.id, lead.id, co.id]) assert.ok(!json.includes(forbidden), forbidden);
  assert.equal(r.evidence.length, 2);
});

// ── paging, bounds, failures ─────────────────────────────────────────────

test("PAGING — more than one page of lines for an estimate is read completely", async () => {
  const e = estimate();
  const items = Array.from({ length: 1250 }, (_, i) => line(e.id, { unit_price: 100 + (i % 7), name: `Item ${i}` }));
  const r = await read(db({ estimates: [e], estimate_items: items }));
  assert.equal(r.evidence.length, 1250);
  assert.equal(r.diagnostics.truncated, false);
});

test("BOUNDS — the line cap is enforced and reported as truncated", async () => {
  const e = estimate();
  const items = Array.from({ length: R.MAX_EVIDENCE_LINES + 50 }, (_, i) => line(e.id, { unit_price: 100, name: `Item ${i}` }));
  const r = await read(db({ estimates: [e], estimate_items: items }));
  assert.ok(r.evidence.length <= R.MAX_EVIDENCE_LINES);
  assert.equal(r.diagnostics.truncated, true);
});

test("FAILURE — an estimate read error returns a generic failure and logs only operation + code + message", async () => {
  const base = db();
  const failing = { ...base, from: (t: string) => { const b = base.from(t); if (t === "estimates") b.select = () => ({ eq: () => ({ in: () => ({ or: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { code: "XX000", message: "boom SENTINEL-ROW" } }) }) }) }) }) }); return b; } };
  const logged: unknown[][] = [];
  const prev = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  let r: any;
  try { r = await read(failing); } finally { console.error = prev; }
  assert.deepEqual(r, { ok: false, error: "Could not load pricing history." });
  assert.deepEqual(Object.keys(logged[0][1] as object).sort(), ["code", "message", "operation"]);
});

test("READ ONLY — the reader never calls insert / update / delete / upsert on any table", async () => {
  const e = estimate();
  const base = db({ estimates: [e], estimate_items: [line(e.id)] });
  const guarded = { ...base, from: (t: string) => { const b = base.from(t); for (const m of ["insert", "update", "delete", "upsert"]) b[m] = () => { throw new Error(`write ${m} on ${t}`); }; return b; } };
  const r = await read(guarded);
  assert.equal(r.ok, true);
});

test("an empty org id is refused", async () => {
  assert.deepEqual(await R.readPricingEvidence(db(), "", NOW), { ok: false, error: "Could not load pricing history." });
});
