// src/lib/agentic/estimate-handlers.test.ts
//
// Run:  node --test src/lib/agentic/estimate-handlers.test.ts
//
// Estimate Assistant Foundation. Exercises the three estimate actions
// through the REAL action-executor.ts pipeline (executeStep for the proposal
// side, executeApprovedStep for the post-approval side — the exact two calls
// agent-approve-action.ts uses) against the REAL handlers in
// estimate-handlers.ts, on the in-memory fake Supabase client. No live
// Supabase, no network, no model.
//
// Covers: read-only context (no mutation, no approval, no internal fields,
// no cross-org), mutation-requires-approval (nothing written pre-approval),
// approved mutation (one intended write, authoritative server result,
// totals from the shared calculation engine), duplicate approval / replay
// idempotency, cross-org refusal with non-probing errors, the write handlers being thin RPC
// callers (no direct writes, no compensation), and the structural "no money fields" schema guarantee.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("real network access is forbidden in this test file"); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "estimate-handlers-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export * from "./src/lib/agentic/action-executor";
      export { getActionDefinition } from "./src/lib/agentic/action-registry";
      export { isPricePendingItem } from "./src/lib/estimate-pricing-gate";
    `,
    resolveDir: repoRoot,
    loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  external: ["@supabase/supabase-js"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const { createFakeSupabaseClient }: any = await import(
  pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href
);

const noisy = ["log", "warn", "error"] as const;
const saved = noisy.map((k) => (console as any)[k]);
noisy.forEach((k) => ((console as any)[k] = () => {}));
after(() => noisy.forEach((k, i) => ((console as any)[k] = saved[i])));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const CONTACT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CONTACT_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const LEAD_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const LEAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const PROJECT_A = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const PROJECT_B = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const EST_A = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const EST_B = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const ACTOR = { actorType: "user" as const, actorId: "user-1" };
const USER_B = "user-in-org-b";
const USER_M = "user-membership-only";
const GENERIC_NOT_FOUND = "The requested record was not found in this organization.";

function withApprovalDefaults(db: any) {
  return {
    ...db,
    from: (table: string) => {
      const builder = db.from(table);
      if (table !== "agent_approval_requests") return builder;
      const originalInsert = builder.insert.bind(builder);
      builder.insert = (row: any) => originalInsert({ status: "pending", requested_at: new Date().toISOString(), ...row });
      return builder;
    },
  };
}

/** A realistic priced estimate for Org A: 2 x $100 taxable item, 10% tax →
 * subtotal 200, tax 20, total 220. Carries every INTERNAL-ONLY column the
 * live table has, with loud sentinel values so a leak is unmistakable. */
function pricedEstimateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EST_A, org_id: ORG_A, number: "EST-000001", title: "Kitchen remodel", status: "draft",
    client_id: CONTACT_A, lead_id: LEAD_A, project_id: PROJECT_A, deal_id: null,
    scope: "Replace cabinets and countertops.", exclusions: null, assumptions: null, valid_until: null,
    tax_rate: 10, discount_type: null, discount_value: 0, deposit_type: null, deposit_value: 0,
    subtotal: 200, discount_total: 0, tax_total: 20, total: 220, client_total: 220, deposit_amount: 0, balance_due: 220,
    created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
    // INTERNAL ONLY — must never be selected / surfaced:
    cost_total: 87654, contingency: 4242, contractor_margin: 31337, notes: "INTERNAL-SECRET-NOTE", public_token: "tok_secret_xyz",
    metadata: {},
    ...overrides,
  };
}
function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-a1", estimate_id: EST_A, name: "Base cabinets", description: null, item_type: "material",
    quantity: 2, unit: "each", unit_price: 100, total: 200, position: 0, taxable: true, optional: false,
    selected_by_customer: true, is_heading: false, discount_type: null, discount_value: 0, metadata: {},
    ...overrides,
  };
}

function makeDb(overrides: Record<string, any[]> = {}, extraOptions: Record<string, unknown> = {}) {
  return withApprovalDefaults(
    createFakeSupabaseClient(
      {
        contacts: [
          { id: CONTACT_A, org_id: ORG_A, full_name: "Jane Homeowner" },
          { id: CONTACT_B, org_id: ORG_B, full_name: "Other Org Person" },
        ],
        leads: [
          { id: LEAD_A, org_id: ORG_A, contact_id: CONTACT_A },
          { id: LEAD_B, org_id: ORG_B, contact_id: CONTACT_B },
        ],
        projects: [{ id: PROJECT_A, org_id: ORG_A }, { id: PROJECT_B, org_id: ORG_B }],
        estimates: [pricedEstimateRow()],
        estimate_items: [itemRow()],
        organizations: [{ id: ORG_A, ai_center_settings: {} }, { id: ORG_B, ai_center_settings: {} }],
        agent_execution_steps: [],
        agent_approval_requests: [],
        agent_action_idempotency: [],
        marketing_contact_preferences: [],
        // Team members: "user-1" is a profile of Org A; USER_B only of Org B; USER_M is an Org A
        // member via org_memberships only (no profiles.organization_id) — both sources are canonical.
        profiles: [{ id: "user-1", organization_id: ORG_A }, { id: USER_B, organization_id: ORG_B }, { id: USER_M, organization_id: null }],
        org_memberships: [{ member_id: USER_M, org_id: ORG_A, role: "estimator" }],
        ...overrides,
      },
      {},
      {
        uniqueConstraints: { agent_action_idempotency: [["org_id", "action_key", "idempotency_key"]] },
        // The live column is NOT NULL (default auth.uid(), which is NULL for service-role writes).
        notNullColumns: { estimates: ["created_by"] },
        ...extraOptions,
      },
    ),
  );
}

const X_isPending = (row: any): boolean => S.isPricePendingItem(row);
const dump = (db: any, table: string) => JSON.stringify(db.__dumpTable(table));

function step(db: any, actionKey: string, rawInput: unknown, extra: Record<string, unknown> = {}) {
  return S.executeStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", sequence: 1,
    actionKey, rawInput, autonomyLevel: 2, ...extra,
  });
}
function approved(db: any, actionKey: string, approvedInput: unknown, extra: Record<string, unknown> = {}) {
  return S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: `step-${Math.random()}`,
    actionKey, approvedInput, ...extra,
  });
}

// ── Registry / approval policy ──────────────────────────────────────────

test("registry: get_estimate_context is a no-approval read; both mutations require approval at Level 2+, are 'high' risk, idempotent and executable", () => {
  const read = S.getActionDefinition("get_estimate_context");
  assert.equal(read.riskLevel, "read");
  assert.equal(read.requiresApproval, false);
  assert.equal(read.isExecutable, true);
  for (const key of ["create_estimate_draft", "add_estimate_line_items"]) {
    const a = S.getActionDefinition(key);
    assert.equal(a.requiresApproval, true, key);
    assert.equal(a.riskLevel, "high", key);
    assert.ok(a.minimumAutonomyLevel >= 2, key);
    assert.equal(a.idempotent, true, key);
    assert.equal(a.isExecutable, true, key);
    assert.equal(a.outboundChannel, undefined, `${key} must never be a customer send`);
  }
});

test("registry: pre-existing approval levels are untouched (no lowering)", () => {
  assert.equal(S.getActionDefinition("schedule_appointment").requiresApproval, true);
  assert.equal(S.getActionDefinition("schedule_appointment").minimumAutonomyLevel, 2);
  assert.equal(S.getActionDefinition("send_sms").requiresApproval, true);
  assert.equal(S.getActionDefinition("send_sms").minimumAutonomyLevel, 4);
  assert.equal(S.getActionDefinition("create_follow_up_task").requiresApproval, true);
  assert.equal(S.getActionDefinition("add_internal_note").requiresApproval, false);
});

test("input schemas have NO money/trust fields: price, quantity, unit, tax, discount, deposit, markup, status, orgId are all rejected", () => {
  const create = S.getActionDefinition("create_estimate_draft").inputSchema;
  const add = S.getActionDefinition("add_estimate_line_items").inputSchema;
  const bad = ["unitPrice", "price", "quantity", "unit", "taxRate", "discountValue", "depositValue", "markup", "total", "status", "orgId", "number"];
  for (const key of bad) {
    assert.throws(() => create.parse({ title: "T", [key]: 1 }), Error, `create must reject top-level ${key}`);
    assert.throws(() => create.parse({ title: "T", items: [{ name: "Cabinets", [key]: 1 }] }), Error, `create must reject item-level ${key}`);
    assert.throws(() => add.parse({ estimateId: EST_A, items: [{ name: "Backsplash", [key]: 1 }] }), Error, `add must reject item-level ${key}`);
  }
  assert.doesNotThrow(() => create.parse({ title: "T", scope: "s", items: [{ name: "Cabinets", description: "d", itemType: "material" }] }));
  assert.throws(() => create.parse({ title: "T", items: [{ name: "Discount", itemType: "discount" }] }), Error, "a discount is a price decision the assistant must never make");
});

// ── get_estimate_context: read-only ─────────────────────────────────────

test("TEST 13 — get_estimate_context is read-only: succeeds at Level 1 with NO approval, and mutates nothing", async () => {
  const db = makeDb();
  const before = { e: dump(db, "estimates"), i: dump(db, "estimate_items"), a: dump(db, "agent_approval_requests") };
  const res = await step(db, "get_estimate_context", { estimateId: EST_A }, { autonomyLevel: 1 });
  assert.equal(res.status, "succeeded", JSON.stringify(res));
  assert.equal(res.output.found, true);
  assert.equal(dump(db, "estimates"), before.e);
  assert.equal(dump(db, "estimate_items"), before.i);
  assert.equal(dump(db, "agent_approval_requests"), before.a, "a read must never create an approval");
});

test("TEST 4 — an existing priced estimate is reported exactly as stored (items, prices, stored totals) and never altered", async () => {
  const db = makeDb({ estimate_items: [itemRow(), itemRow({ id: "item-a2", name: "Quartz countertop", unit_price: 350, quantity: 1, total: 350, position: 1 })] });
  const res = await step(db, "get_estimate_context", { estimateId: EST_A });
  const o = res.output;
  assert.equal(o.estimate.title, "Kitchen remodel");
  assert.equal(o.estimate.status, "draft");
  assert.equal(o.estimate.total, 220);
  assert.equal(o.estimate.taxTotal, 20);
  assert.equal(o.estimate.editableByAssistant, true);
  assert.deepEqual(o.items.map((i: any) => [i.name, i.unitPrice, i.lineTotal, i.pricePending]), [
    ["Base cabinets", 100, 200, false],
    ["Quartz countertop", 350, 350, false],
  ]);
  assert.equal(o.items.length, 2, "no invented items");
  assert.equal(o.pricing.trustedCatalogAvailable, false);
});

test("an unpriced placeholder row (metadata.price_pending) is reported as pricePending with NULL price/total — never as $0", async () => {
  const db = makeDb({ estimate_items: [itemRow({ id: "p1", name: "Backsplash", unit_price: 0, total: 0, quantity: 1, metadata: { price_pending: true } })] });
  const o = (await step(db, "get_estimate_context", { estimateId: EST_A })).output;
  assert.equal(o.items[0].pricePending, true);
  assert.equal(o.items[0].unitPrice, null);
  assert.equal(o.items[0].lineTotal, null);
});

// ── get_estimate_context uses the SAME price_pending semantics as the send gate / editor ──
// pending iff metadata.price_pending === true AND no positive price; headings never; a reviewed $0 is a real $0.

async function readItems(rows: any[]) {
  const db = makeDb({ estimate_items: rows });
  const res = await step(db, "get_estimate_context", { estimateId: EST_A });
  assert.equal(res.status, "succeeded", JSON.stringify(res));
  return Object.fromEntries(res.output.items.map((i: any) => [i.name, i]));
}

test("READ SEMANTICS — price_pending=true + $0 => pending; price and line total are hidden (null), never surfaced as $0", async () => {
  const items = await readItems([itemRow({ id: "r1", name: "AI placeholder", unit_price: 0, total: 0, metadata: { price_pending: true, ai_proposed: true } })]);
  assert.equal(items["AI placeholder"].pricePending, true);
  assert.equal(items["AI placeholder"].unitPrice, null);
  assert.equal(items["AI placeholder"].lineTotal, null);
});

test("READ SEMANTICS — metadata={} + explicit $0 => NOT pending: a real zero price is surfaced (the owner reviewed it)", async () => {
  const items = await readItems([itemRow({ id: "r2", name: "Included at no charge", unit_price: 0, total: 0, metadata: {} })]);
  assert.equal(items["Included at no charge"].pricePending, false);
  assert.equal(items["Included at no charge"].unitPrice, 0);
  assert.equal(items["Included at no charge"].lineTotal, 0);
});

test("READ SEMANTICS — missing / null / non-object metadata + $0 => NOT pending (only the explicit marker makes a line pending)", async () => {
  const noKey = itemRow({ id: "r3", name: "No metadata key", unit_price: 0, total: 0 });
  delete (noKey as any).metadata;
  const items = await readItems([noKey, itemRow({ id: "r4", name: "Null metadata", unit_price: 0, total: 0, metadata: null }), itemRow({ id: "r5", name: "Array metadata", unit_price: 0, total: 0, metadata: [] }), itemRow({ id: "r6", name: "String marker", unit_price: 0, total: 0, metadata: { price_pending: "true" } })]);
  for (const name of ["No metadata key", "Null metadata", "Array metadata", "String marker"]) {
    assert.equal(items[name].pricePending, false, name);
    assert.equal(items[name].unitPrice, 0, name);
  }
});

test("READ SEMANTICS — a stale price_pending marker on a POSITIVE price => NOT pending: described as priced with its real figures", async () => {
  const items = await readItems([itemRow({ id: "r7", name: "Stale marker", unit_price: 250, quantity: 2, total: 500, metadata: { price_pending: true } })]);
  assert.equal(items["Stale marker"].pricePending, false);
  assert.equal(items["Stale marker"].unitPrice, 250);
  assert.equal(items["Stale marker"].lineTotal, 500);
});

test("READ SEMANTICS — a heading carrying the marker is NEVER pending (and exposes no price)", async () => {
  const items = await readItems([itemRow({ id: "r8", name: "Section", is_heading: true, unit_price: 0, total: 0, quantity: 0, metadata: { price_pending: true } })]);
  assert.equal(items["Section"].pricePending, false);
  assert.equal(items["Section"].isHeading, true);
  assert.equal(items["Section"].unitPrice, null);
  assert.equal(items["Section"].lineTotal, null);
});

test("READ SEMANTICS — consistent with the send gate on every case (single shared rule), and metadata itself is never copied into the output", async () => {
  const rows = [
    itemRow({ id: "c1", name: "pending", unit_price: 0, total: 0, metadata: { price_pending: true } }),
    itemRow({ id: "c2", name: "reviewed zero", unit_price: 0, total: 0, metadata: {} }),
    itemRow({ id: "c3", name: "stale", unit_price: 10, total: 10, metadata: { price_pending: true } }),
    itemRow({ id: "c4", name: "heading", is_heading: true, unit_price: 0, total: 0, metadata: { price_pending: true } }),
    itemRow({ id: "c5", name: "plain", unit_price: 5, total: 5, metadata: { secret_internal: "SENTINEL-META" } }),
  ];
  const db = makeDb({ estimate_items: rows });
  const res = await step(db, "get_estimate_context", { estimateId: EST_A });
  for (const out of res.output.items) {
    const row = rows.find((r) => r.name === out.name)!;
    assert.equal(out.pricePending, X_isPending(row), out.name);
  }
  assert.ok(!JSON.stringify(res).includes("SENTINEL-META"), "item metadata is not exposed to the model context");
  assert.ok(!("metadata" in res.output.items[0]));
});

test("TEST 18 — INTERNAL cost/margin/contingency/notes/public_token never appear in the context output", async () => {
  const db = makeDb();
  const res = await step(db, "get_estimate_context", { estimateId: EST_A });
  const json = JSON.stringify(res);
  for (const secret of ["87654", "4242", "31337", "INTERNAL-SECRET-NOTE", "tok_secret_xyz", "cost_total", "contractor_margin", "contingency", "public_token", "client_total"]) {
    assert.ok(!json.includes(secret), `output leaked ${secret}`);
  }
});

test("TEST 17 — Org A cannot read Org B's estimate by id or by project/lead/contact scope", async () => {
  const db = makeDb({
    estimates: [pricedEstimateRow(), pricedEstimateRow({ id: EST_B, org_id: ORG_B, client_id: CONTACT_B, lead_id: LEAD_B, project_id: PROJECT_B, title: "Org B secret job" })],
  });
  for (const input of [{ estimateId: EST_B }, { projectId: PROJECT_B }, { leadId: LEAD_B }, { contactId: CONTACT_B }]) {
    const res = await step(db, "get_estimate_context", input);
    assert.equal(res.status, "succeeded");
    assert.equal(res.output.found, false, JSON.stringify(input));
    assert.ok(!JSON.stringify(res).includes("Org B secret job"));
  }
});

test("lookup scope: project beats lead beats contact; archived/cancelled estimates are never 'the current estimate'; several active matches are flagged ambiguous", async () => {
  const db = makeDb({
    estimates: [
      pricedEstimateRow({ id: "e-old", status: "archived", created_at: "2026-09-01T00:00:00Z" }),
      pricedEstimateRow({ id: "e-cancel", status: "cancelled", created_at: "2026-09-02T00:00:00Z" }),
    ],
    estimate_items: [],
  });
  assert.equal((await step(db, "get_estimate_context", { leadId: LEAD_A })).output.found, false, "only archived/cancelled -> none");

  const db2 = makeDb({
    estimates: [pricedEstimateRow({ id: "e1", created_at: "2026-10-01T00:00:00Z" }), pricedEstimateRow({ id: "e2", created_at: "2026-10-02T00:00:00Z" })],
    estimate_items: [],
  });
  const o = (await step(db2, "get_estimate_context", { projectId: PROJECT_A })).output;
  assert.equal(o.found, true);
  assert.equal(o.ambiguous, true);
  assert.equal(o.estimate.id, "e2", "most recent first");
});

// ── create_estimate_draft ───────────────────────────────────────────────

const CREATE_INPUT = {
  contactId: CONTACT_A, leadId: LEAD_A, title: "Kitchen remodel", scope: "New cabinets, quartz countertops, new sink.",
  items: [
    { name: "Cabinet replacement", itemType: "material" },
    { name: "Countertop replacement", description: "Quartz", itemType: "material" },
    { name: "Sink installation", itemType: "labor" },
  ],
};

// ── Write handlers are THIN RPC CALLERS (transactional logic lives in SQL) ─────────────────
//
// TypeScript-level tests only. Atomicity itself (header+items all-or-nothing, locking, replay inside the
// transaction) is a property of PL/pgSQL and is NOT proven here: the fake client below merely RECORDS the RPC
// call and returns a canned result. SQL behavior is covered by supabase/verification/estimate_transactional_rpcs_verification.sql.

type RpcCall = { fn: string; args: any };
const WRITE_TABLES = ["estimates", "estimate_items", "estimate_activities"];

/** A db whose rpc() records calls and answers from `results`, and whose estimate tables THROW on any direct write. */
function makeRpcDb(results: Record<string, (args: any) => { data?: any; error?: any }> = {}, overrides: Record<string, any[]> = {}) {
  const calls: RpcCall[] = [];
  const base = makeDb(overrides);
  const db: any = {
    ...base,
    from: (table: string) => {
      const b = base.from(table);
      if (WRITE_TABLES.includes(table)) {
        for (const m of ["insert", "update", "delete", "upsert"]) {
          b[m] = () => { throw new Error(`direct ${m} on ${table} is forbidden for AI estimate handlers`); };
        }
      }
      return b;
    },
    rpc: async (fn: string, args: any) => {
      calls.push({ fn, args });
      const r = results[fn];
      if (!r) throw new Error(`unexpected rpc ${fn}`);
      const out = r(args);
      return { data: out.data ?? null, error: out.error ?? null };
    },
  };
  db.__rpcCalls = calls;
  return db;
}
const createOk = (args: any) => ({ data: { estimate_id: EST_A, number: "EST-000007", status: "draft", item_count: args.p_items.length, already_created: false } });
const addOk = (args: any) => ({ data: { estimate_id: EST_A, added_item_ids: args.p_items.map((_: any, i: number) => `new-${i}`), skipped_duplicate_names: [], item_count: 1 + args.p_items.length, total: 220, already_applied: false } });
const rpcErr = (code: string) => () => ({ error: { code: "P0001", message: `estimate_rpc:${code}` } });

test("create_estimate_draft — one RPC call with trusted org/actor ids and an items payload of {name, description?, itemType?} only", async () => {
  const db = makeRpcDb({ create_estimate_draft_transaction: createOk });
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "create_estimate_draft:appr-1" });
  assert.equal(res.status, "succeeded", JSON.stringify(res));
  assert.equal(db.__rpcCalls.length, 1);
  const { fn, args } = db.__rpcCalls[0];
  assert.equal(fn, "create_estimate_draft_transaction");
  assert.deepEqual(Object.keys(args).sort(), ["p_client_id", "p_created_by", "p_execution_id", "p_items", "p_lead_id", "p_org_id", "p_project_id", "p_scope", "p_title"]);
  assert.equal(args.p_org_id, ORG_A, "org comes from trusted server context");
  assert.equal(args.p_created_by, "user-1", "approver comes from the verified actor");
  assert.equal(args.p_execution_id, "exec-1");
  assert.equal(args.p_client_id, CONTACT_A);
  assert.equal(args.p_lead_id, LEAD_A);
  assert.equal(args.p_project_id, null);
  assert.deepEqual(args.p_items, [
    { name: "Cabinet replacement", itemType: "material" },
    { name: "Countertop replacement", description: "Quartz", itemType: "material" },
    { name: "Sink installation", itemType: "labor" },
  ]);
  assert.equal(res.output.estimateId, EST_A);
  assert.equal(res.output.number, "EST-000007");
  assert.equal(res.output.status, "draft");
  assert.equal(res.output.itemCount, 3);
  assert.equal(res.output.pricePendingItemCount, 3);
  assert.equal(res.output.total, 0);
  assert.equal(res.output.alreadyCreated, false);
});

test("create_estimate_draft — NO money field of any kind reaches the RPC", async () => {
  const db = makeRpcDb({ create_estimate_draft_transaction: createOk });
  await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-money" });
  const json = JSON.stringify(db.__rpcCalls[0].args);
  for (const forbidden of ["unit_price", "unitPrice", "quantity", "price", "total", "tax", "discount", "deposit", "markup", "status", "metadata"]) {
    assert.ok(!json.includes(`"${forbidden}"`), `payload contains ${forbidden}`);
  }
  for (const it of db.__rpcCalls[0].args.p_items) assert.ok(Object.keys(it).every((k) => ["name", "description", "itemType"].includes(k)));
});

test("create_estimate_draft — makes NO direct estimates / estimate_items / estimate_activities write (the proxy throws on any)", async () => {
  const db = makeRpcDb({ create_estimate_draft_transaction: createOk });
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-nodirect" });
  assert.equal(res.status, "succeeded", JSON.stringify(res));
});

test("create_estimate_draft — non-user / blank-actor approvers fail closed BEFORE any RPC call", async () => {
  for (const actor of [{ actorType: "agent", actorId: "a-1" }, { actorType: "system", actorId: null }, { actorType: "workflow", actorId: "w" }, { actorType: "integration", actorId: "i" }, { actorType: "user", actorId: "" }, { actorType: "user", actorId: "   " }, { actorType: "user" }]) {
    const db = makeRpcDb({ create_estimate_draft_transaction: createOk });
    const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { actor, idempotencyKey: `k-${JSON.stringify(actor)}` });
    assert.equal(res.status, "failed", JSON.stringify(actor));
    assert.equal(res.error, "An estimate must be attributed to a team member.");
    assert.equal(db.__rpcCalls.length, 0, `no rpc for ${JSON.stringify(actor)}`);
  }
});

test("create_estimate_draft — safe error mapping: attribution_required / not_found / contact_required / unknown (no raw DB text leaks)", async () => {
  const cases: Array<[string, string]> = [
    ["attribution_required", "An estimate must be attributed to a team member."],
    ["not_found", GENERIC_NOT_FOUND],
    ["contact_required", "An estimate needs a linked customer contact, and none is on file yet."],
    ["invalid_items", "Could not create the estimate draft."],
  ];
  for (const [code, expected] of cases) {
    const db = makeRpcDb({ create_estimate_draft_transaction: rpcErr(code) });
    const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: `k-${code}` });
    assert.equal(res.status, "failed", code);
    assert.equal(res.error, expected, code);
  }
  const db = makeRpcDb({ create_estimate_draft_transaction: () => ({ error: { code: "23502", message: 'null value in column "created_by" SECRET-ROW-DETAIL' } }) });
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-raw" });
  assert.equal(res.error, "Could not create the estimate draft.");
  assert.ok(!JSON.stringify(res).includes("SECRET-ROW-DETAIL"));
});

test("create_estimate_draft — an unexpected RPC failure logs operation + code + message ONLY and returns the safe message", async () => {
  const SECRET_TITLE = "Smith family kitchen — 123 Private Lane";
  const db = makeRpcDb({ create_estimate_draft_transaction: () => ({ error: { code: "XX000", message: "boom" } }) });
  const logged: unknown[][] = [];
  const prev = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  let res: any;
  try { res = await approved(db, "create_estimate_draft", { ...CREATE_INPUT, title: SECRET_TITLE }, { idempotencyKey: "k-log" }); } finally { console.error = prev; }
  assert.equal(res.error, "Could not create the estimate draft.");
  const entry = logged.find((a) => String(a[0]).includes("[estimate-handlers] db error"));
  assert.ok(entry);
  assert.deepEqual(Object.keys(entry![1] as object).sort(), ["code", "message", "operation"]);
  assert.equal((entry![1] as any).operation, "create_estimate_draft.rpc");
  for (const forbidden of [SECRET_TITLE, "Cabinet replacement", CONTACT_A, LEAD_A, "user-1", ORG_A]) assert.ok(!JSON.stringify(logged).includes(forbidden), forbidden);
});

test("create_estimate_draft — replay: the executor's idempotency key skips a duplicate approval before any second RPC; a lost slot reaches the RPC, whose already_created flag is surfaced", async () => {
  let n = 0;
  const db = makeRpcDb({ create_estimate_draft_transaction: (a) => { n++; const r = createOk(a); r.data.already_created = n > 1; return r; } });
  const key = "create_estimate_draft:appr-dup";
  const first = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: key });
  const second = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: key });
  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "skipped");
  assert.equal(db.__rpcCalls.length, 1, "duplicate approval never reaches the database function");
  const third = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "create_estimate_draft:other" });
  assert.equal(third.status, "succeeded");
  assert.equal(third.output.alreadyCreated, true);
  assert.equal(db.__rpcCalls.length, 2);
  assert.equal(db.__rpcCalls[1].args.p_execution_id, "exec-1");
});

test("create_estimate_draft — an RPC that returns no estimate id is a failure, never a success", async () => {
  const db = makeRpcDb({ create_estimate_draft_transaction: () => ({ data: {} }) });
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-empty" });
  assert.equal(res.status, "failed");
  assert.equal(res.error, "Could not create the estimate draft.");
});

test("create_estimate_draft — approval boundary unchanged: the proposal calls no RPC; Level 1 is refused", async () => {
  const db = makeRpcDb({ create_estimate_draft_transaction: createOk });
  const res = await step(db, "create_estimate_draft", CREATE_INPUT);
  assert.equal(res.status, "awaiting_approval", JSON.stringify(res));
  assert.equal(db.__rpcCalls.length, 0);
  const l1 = await step(db, "create_estimate_draft", CREATE_INPUT, { autonomyLevel: 1 });
  assert.equal(l1.status, "failed");
  assert.equal(db.__rpcCalls.length, 0);
});

const ADD_INPUT = { estimateId: EST_A, items: [{ name: "Backsplash", itemType: "material" }, { name: "Paint", description: "Two coats" }] };

test("add_estimate_line_items — one RPC call with trusted org id, the estimate id and name/description/itemType items only", async () => {
  const db = makeRpcDb({ add_estimate_line_items_transaction: addOk });
  const res = await approved(db, "add_estimate_line_items", ADD_INPUT, { idempotencyKey: "add_estimate_line_items:a1" });
  assert.equal(res.status, "succeeded", JSON.stringify(res));
  assert.equal(db.__rpcCalls.length, 1);
  const { fn, args } = db.__rpcCalls[0];
  assert.equal(fn, "add_estimate_line_items_transaction");
  assert.deepEqual(Object.keys(args).sort(), ["p_estimate_id", "p_execution_id", "p_items", "p_org_id"]);
  assert.equal(args.p_org_id, ORG_A);
  assert.equal(args.p_estimate_id, EST_A);
  assert.equal(args.p_execution_id, "exec-1");
  assert.deepEqual(args.p_items, [{ name: "Backsplash", itemType: "material" }, { name: "Paint", description: "Two coats" }]);
  assert.deepEqual(res.output.addedItemIds, ["new-0", "new-1"]);
  assert.equal(res.output.totalsUpdated, false, "placeholder $0 rows cannot change totals; the RPC never recomputes them");
  assert.equal(res.output.total, 220);
  assert.equal(res.output.alreadyApplied, false);
});

test("add_estimate_line_items — no direct estimate-table write, and no money field in the payload", async () => {
  const db = makeRpcDb({ add_estimate_line_items_transaction: addOk });
  const res = await approved(db, "add_estimate_line_items", ADD_INPUT, { idempotencyKey: "k-add-direct" });
  assert.equal(res.status, "succeeded");
  const json = JSON.stringify(db.__rpcCalls[0].args);
  for (const forbidden of ["unit_price", "unitPrice", "quantity", "price", "total", "tax", "discount", "status"]) assert.ok(!json.includes(`"${forbidden}"`), forbidden);
});

test("add_estimate_line_items — safe error mapping: not_found (same as a foreign org) / not_draft / unknown", async () => {
  const cases: Array<[string, string]> = [
    ["not_found", GENERIC_NOT_FOUND],
    ["not_draft", "This estimate is no longer a draft, so the assistant cannot change it. A team member can edit it directly."],
    ["invalid_item", "Could not add the line items."],
  ];
  for (const [code, expected] of cases) {
    const db = makeRpcDb({ add_estimate_line_items_transaction: rpcErr(code) });
    const res = await approved(db, "add_estimate_line_items", ADD_INPUT, { idempotencyKey: `k-${code}` });
    assert.equal(res.status, "failed", code);
    assert.equal(res.error, expected, code);
  }
});

test("add_estimate_line_items — replay: duplicate approval never reaches the database; a lost slot surfaces the RPC's already_applied flag", async () => {
  let n = 0;
  const db = makeRpcDb({ add_estimate_line_items_transaction: (a) => { n++; const r = addOk(a); r.data.already_applied = n > 1; return r; } });
  const key = "add_estimate_line_items:dup";
  const first = await approved(db, "add_estimate_line_items", ADD_INPUT, { idempotencyKey: key });
  const second = await approved(db, "add_estimate_line_items", ADD_INPUT, { idempotencyKey: key });
  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "skipped");
  assert.equal(db.__rpcCalls.length, 1);
  const lost = await approved(db, "add_estimate_line_items", ADD_INPUT, { idempotencyKey: "add_estimate_line_items:other" });
  assert.equal(lost.output.alreadyApplied, true);
});

test("add_estimate_line_items — the proposal calls no RPC (approval required)", async () => {
  const db = makeRpcDb({ add_estimate_line_items_transaction: addOk });
  const res = await step(db, "add_estimate_line_items", ADD_INPUT);
  assert.equal(res.status, "awaiting_approval", JSON.stringify(res));
  assert.equal(db.__rpcCalls.length, 0);
});

test("source guard — estimate-handlers.ts has NO direct write to estimates / estimate_items / estimate_activities and none of the removed compensation helpers", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(path.join(repoRoot, "src/lib/agentic/estimate-handlers.ts"), "utf8").replace(/\s+/g, " ");
  for (const table of WRITE_TABLES) {
    assert.ok(!new RegExp(`from\\(["']${table}["']\\) ?\\. ?(insert|update|delete|upsert)`).test(src), `direct write to ${table}`);
  }
  assert.ok(!/import[^;]*estimate-calculations/.test(src), "handlers must not import the totals engine");
  for (const gone of ["attributeCreatedActivity", "resolveAttributableUserId", "totalsPatch", "buildItemRows"]) {
    assert.ok(!src.includes(gone), `leftover: ${gone}`);
  }
});

// ── Restored invariants, at the correct (handler ↔ RPC contract) layer ─────────────────────
// Fake-RPC tests: they prove what the handler SENDS and how it maps what comes BACK. They do not execute SQL.

test("create_estimate_draft — attribution_failed (strict created-activity attribution rolled the create back) maps to the generic safe failure; nothing raw leaks and only code/message/operation are logged", async () => {
  const db = makeRpcDb({ create_estimate_draft_transaction: () => ({ error: { code: "P0001", message: "estimate_rpc:attribution_failed SECRET-DETAIL" } }) });
  const logged: unknown[][] = [];
  const prev = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  let res: any;
  try { res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-attr-failed" }); } finally { console.error = prev; }
  assert.equal(res.status, "failed");
  assert.equal(res.error, "Could not create the estimate draft.");
  assert.ok(!JSON.stringify(res).includes("SECRET-DETAIL") && !JSON.stringify(res).includes("estimate_rpc"));
  const entry = logged.find((a) => String(a[0]).includes("[estimate-handlers] db error"));
  assert.ok(entry, "the failure is logged server-side");
  assert.deepEqual(Object.keys(entry![1] as object).sort(), ["code", "message", "operation"]);
  assert.equal(db.__rpcCalls.length, 1, "no retry, no fallback write");
});

test("create_estimate_draft — a membership-only approver (org_memberships, no profile org) is forwarded as p_created_by; the handler does not pre-judge membership (SQL decides, and a foreign/unknown approver comes back as attribution_required)", async () => {
  const ok = makeRpcDb({ create_estimate_draft_transaction: createOk });
  const viaMembership = await approved(ok, "create_estimate_draft", CREATE_INPUT, { actor: { actorType: "user", actorId: USER_M }, idempotencyKey: "k-member" });
  assert.equal(viaMembership.status, "succeeded", JSON.stringify(viaMembership));
  assert.equal(ok.__rpcCalls[0].args.p_created_by, USER_M);
  assert.equal(ok.__rpcCalls[0].args.p_org_id, ORG_A, "tenant is still the trusted context org, never the approver's own org");

  const foreign = makeRpcDb({ create_estimate_draft_transaction: rpcErr("attribution_required") });
  const res = await approved(foreign, "create_estimate_draft", CREATE_INPUT, { actor: { actorType: "user", actorId: USER_B }, idempotencyKey: "k-foreign" });
  assert.equal(res.status, "failed");
  assert.equal(res.error, "An estimate must be attributed to a team member.");
  assert.equal(foreign.__rpcCalls[0].args.p_org_id, ORG_A);
  assert.equal(foreign.__rpcCalls[0].args.p_created_by, USER_B);
});

test("create_estimate_draft — cross-org relationship refusal: foreign contact/lead/project ids are forwarded as-is with the TRUSTED org, and a not_found comes back as the SAME generic message as a nonexistent id", async () => {
  for (const input of [
    { ...CREATE_INPUT, contactId: CONTACT_B, leadId: undefined },
    { ...CREATE_INPUT, leadId: LEAD_B },
    { ...CREATE_INPUT, projectId: PROJECT_B },
  ]) {
    const db = makeRpcDb({ create_estimate_draft_transaction: rpcErr("not_found") });
    const res = await approved(db, "create_estimate_draft", input, { idempotencyKey: `k-x-${Math.random()}` });
    assert.equal(res.error, GENERIC_NOT_FOUND);
    assert.equal(db.__rpcCalls[0].args.p_org_id, ORG_A);
  }
  // A missing contact is its own safe message (not an org-probing signal).
  const none = makeRpcDb({ create_estimate_draft_transaction: rpcErr("contact_required") });
  const res = await approved(none, "create_estimate_draft", { title: "T", leadId: LEAD_A }, { idempotencyKey: "k-nocontact" });
  assert.equal(res.error, "An estimate needs a linked customer contact, and none is on file yet.");
});

test("add_estimate_line_items — cross-org estimate refusal: the foreign estimate id is sent WITH the trusted org and not_found is the same generic message as a nonexistent estimate", async () => {
  const foreign = makeRpcDb({ add_estimate_line_items_transaction: rpcErr("not_found") });
  const a = await approved(foreign, "add_estimate_line_items", { estimateId: EST_B, items: [{ name: "Backsplash" }] }, { idempotencyKey: "k-add-foreign" });
  const missing = makeRpcDb({ add_estimate_line_items_transaction: rpcErr("not_found") });
  const b = await approved(missing, "add_estimate_line_items", { estimateId: "99999999-9999-4999-8999-999999999999", items: [{ name: "Backsplash" }] }, { idempotencyKey: "k-add-missing" });
  assert.equal(a.error, GENERIC_NOT_FOUND);
  assert.equal(a.error, b.error);
  assert.equal(foreign.__rpcCalls[0].args.p_org_id, ORG_A);
  assert.equal(foreign.__rpcCalls[0].args.p_estimate_id, EST_B);
});

test("price_pending behavior unchanged — a created draft reports every item as price-pending with a zero total, and the same shared rule still classifies stored rows", async () => {
  const db = makeRpcDb({ create_estimate_draft_transaction: createOk });
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-pp" });
  assert.equal(res.output.itemCount, 3);
  assert.equal(res.output.pricePendingItemCount, res.output.itemCount);
  assert.equal(res.output.total, 0);
  // The row shape the SQL writes (unit_price 0 + metadata.price_pending true) is pending under the shared gate; a reviewed $0 is not.
  assert.equal(X_isPending(itemRow({ unit_price: 0, total: 0, metadata: { ai_proposed: true, price_pending: true, quantity_pending: true } })), true);
  assert.equal(X_isPending(itemRow({ unit_price: 0, total: 0, metadata: {} })), false);
  assert.equal(X_isPending(itemRow({ unit_price: 50, total: 50, metadata: { price_pending: true } })), false);
  assert.equal(X_isPending(itemRow({ unit_price: 0, total: 0, is_heading: true, metadata: { price_pending: true } })), false);
});
