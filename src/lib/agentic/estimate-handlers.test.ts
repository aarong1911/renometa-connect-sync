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
// idempotency, cross-org refusal with non-probing errors, compensation on
// partial failure, and the structural "no money fields" schema guarantee.

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

test("an unpriced placeholder row is reported as pricePending with NULL price/total — never as $0", async () => {
  const db = makeDb({ estimate_items: [itemRow({ id: "p1", name: "Backsplash", unit_price: 0, total: 0, quantity: 1 })] });
  const o = (await step(db, "get_estimate_context", { estimateId: EST_A })).output;
  assert.equal(o.items[0].pricePending, true);
  assert.equal(o.items[0].unitPrice, null);
  assert.equal(o.items[0].lineTotal, null);
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

test("TEST 14 — create_estimate_draft requires approval: the proposal creates an approval and writes NO estimate", async () => {
  const db = makeDb({ estimates: [], estimate_items: [] });
  const res = await step(db, "create_estimate_draft", CREATE_INPUT);
  assert.equal(res.status, "awaiting_approval", JSON.stringify(res));
  assert.ok(res.approvalRequestId);
  assert.equal(db.__dumpTable("estimates").length, 0, "no estimate before approval");
  assert.equal(db.__dumpTable("estimate_items").length, 0, "no items before approval");
  const approvals = db.__dumpTable("agent_approval_requests");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].action_key, "create_estimate_draft");
  assert.equal(approvals[0].status, "pending");
});

test("create at autonomy Level 1 is refused outright (floor 2) — never an approval, never a write", async () => {
  const db = makeDb({ estimates: [], estimate_items: [] });
  const res = await step(db, "create_estimate_draft", CREATE_INPUT, { autonomyLevel: 1 });
  assert.equal(res.status, "failed");
  assert.equal(db.__dumpTable("estimates").length, 0);
  assert.equal(db.__dumpTable("agent_approval_requests").length, 0);
});

test("TEST 15 / TEST 5 — approved create: exactly one DRAFT with the proposed STRUCTURE, unpriced, totals from the shared engine, authoritative server result", async () => {
  const db = makeDb({ estimates: [], estimate_items: [] });
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "create_estimate_draft:appr-1" });
  assert.equal(res.status, "succeeded", JSON.stringify(res));
  assert.equal(typeof res.output.estimateId, "string");
  assert.equal(res.output.status, "draft");
  assert.equal(res.output.itemCount, 3);
  assert.equal(res.output.pricePendingItemCount, 3);
  assert.equal(res.output.total, 0);
  assert.equal(res.output.alreadyCreated, false);

  const estimates = db.__dumpTable("estimates");
  assert.equal(estimates.length, 1);
  const e = estimates[0];
  assert.equal(e.id, res.output.estimateId);
  assert.equal(e.org_id, ORG_A);
  assert.equal(e.status, "draft");
  assert.equal(e.client_id, CONTACT_A);
  assert.equal(e.lead_id, LEAD_A);
  assert.equal(e.title, "Kitchen remodel");
  assert.equal(e.total, 0);
  assert.equal(e.client_total, e.total, "total and client_total are always written together (trg_sync_total)");
  assert.equal(e.deposit_amount, 0);
  assert.equal(e.tax_rate, 0, "tax is never invented");
  assert.equal(e.metadata.ai_execution_id, "exec-1");

  const items = db.__dumpTable("estimate_items");
  assert.deepEqual(items.map((i: any) => i.name), ["Cabinet replacement", "Countertop replacement", "Sink installation"]);
  for (const it of items) {
    assert.equal(it.estimate_id, e.id);
    assert.equal(it.unit_price, 0, "unpriced placeholder");
    assert.equal(it.total, 0);
    assert.equal(it.metadata.price_pending, true);
    assert.equal(it.metadata.quantity_pending, true);
    assert.equal(it.is_heading, false);
  }
  assert.deepEqual(items.map((i: any) => i.position), [0, 1, 2]);
});

test("TEST 16 — duplicate approval: a replay under the same idempotency key creates NO second estimate or item", async () => {
  const db = makeDb({ estimates: [], estimate_items: [] });
  const key = "create_estimate_draft:appr-dup";
  const first = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: key });
  const second = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: key });
  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "skipped");
  assert.equal(second.output.result.estimateId, first.output.estimateId, "replay reuses the real prior result");
  assert.equal(db.__dumpTable("estimates").length, 1);
  assert.equal(db.__dumpTable("estimate_items").length, 3);
});

test("TEST 16b — even with a LOST idempotency slot (different key, same execution), the handler's own guard prevents a duplicate estimate", async () => {
  const db = makeDb({ estimates: [], estimate_items: [] });
  const first = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "create_estimate_draft:k1" });
  const second = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "create_estimate_draft:k2" });
  assert.equal(second.status, "succeeded");
  assert.equal(second.output.alreadyCreated, true);
  assert.equal(second.output.estimateId, first.output.estimateId);
  assert.equal(db.__dumpTable("estimates").length, 1);
  assert.equal(db.__dumpTable("estimate_items").length, 3);
});

test("TEST 17 — create with another org's lead / project / contact fails with ONE generic message, identical to a nonexistent id (no cross-tenant probing), and writes nothing", async () => {
  const nonexistent = "99999999-9999-4999-8999-999999999999";
  const messages = new Set<string>();
  for (const input of [
    { ...CREATE_INPUT, leadId: LEAD_B },
    { ...CREATE_INPUT, leadId: undefined, projectId: PROJECT_B },
    { ...CREATE_INPUT, leadId: undefined, contactId: CONTACT_B },
    { ...CREATE_INPUT, leadId: nonexistent },
    { ...CREATE_INPUT, leadId: undefined, projectId: nonexistent },
    { ...CREATE_INPUT, leadId: undefined, contactId: nonexistent },
  ]) {
    const db = makeDb({ estimates: [], estimate_items: [] });
    const clean = JSON.parse(JSON.stringify(input));
    const res = await approved(db, "create_estimate_draft", clean, { idempotencyKey: `k-${Math.random()}` });
    assert.equal(res.status, "failed", JSON.stringify(input));
    messages.add(res.error);
    assert.equal(db.__dumpTable("estimates").length, 0);
    assert.equal(db.__dumpTable("estimate_items").length, 0);
  }
  assert.deepEqual([...messages], [GENERIC_NOT_FOUND]);
});

test("create resolves the contact from the lead when none is passed, and refuses (writing nothing) when none can be resolved", async () => {
  const db = makeDb({ estimates: [], estimate_items: [] });
  const ok = await approved(db, "create_estimate_draft", { leadId: LEAD_A, title: "From lead" }, { idempotencyKey: "k-lead" });
  assert.equal(ok.status, "succeeded");
  assert.equal(db.__dumpTable("estimates")[0].client_id, CONTACT_A);

  const db2 = makeDb({ estimates: [], estimate_items: [], leads: [{ id: LEAD_A, org_id: ORG_A, contact_id: null }] });
  const no = await approved(db2, "create_estimate_draft", { leadId: LEAD_A, title: "No contact" }, { idempotencyKey: "k-nocontact" });
  assert.equal(no.status, "failed");
  assert.equal(db2.__dumpTable("estimates").length, 0);
});

test("create compensates: if the line items cannot be written, the half-built estimate header is deleted", async () => {
  const base = makeDb({ estimates: [], estimate_items: [] });
  const db = {
    ...base,
    from: (table: string) => {
      const b = base.from(table);
      if (table === "estimate_items") b.insert = () => ({ then: (res: any) => res({ data: null, error: { message: "boom" } }) });
      return b;
    },
  };
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-comp" });
  assert.equal(res.status, "failed");
  assert.equal(base.__dumpTable("estimates").length, 0, "no orphan header");
});

// ── created_by attribution (live bug: estimates.created_by is NOT NULL, auth.uid() is NULL for service-role) ──

test("created_by — the REAL failure reproduced: without an attributed user the insert hits the not-null violation the live database raised", async () => {
  // Simulates the pre-fix handler payload by inserting directly into the NOT-NULL-enforcing fake.
  const db = makeDb({ estimates: [], estimate_items: [] });
  const r = await db.from("estimates").insert({ org_id: ORG_A, client_id: CONTACT_A, title: "x", status: "draft" }).select("id").single();
  assert.equal(r.error.code, "23502");
  assert.match(r.error.message, /null value in column "created_by" of relation "estimates" violates not-null constraint/);
});

test("created_by (a/e) — approved create writes created_by = the approving user; a valid same-org user (profiles.organization_id) proceeds", async () => {
  const db = makeDb({ estimates: [], estimate_items: [] });
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-cb-1" });
  assert.equal(res.status, "succeeded", JSON.stringify(res));
  const e = db.__dumpTable("estimates");
  assert.equal(e.length, 1);
  assert.equal(e[0].created_by, "user-1");
  assert.equal(e[0].org_id, ORG_A);
});

test("created_by (e) — a same-org user known ONLY via org_memberships is also accepted (the repo's other canonical membership source)", async () => {
  const db = makeDb({ estimates: [], estimate_items: [] });
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-cb-2", actor: { actorType: "user", actorId: USER_M } });
  assert.equal(res.status, "succeeded", JSON.stringify(res));
  assert.equal(db.__dumpTable("estimates")[0].created_by, USER_M);
});

test("created_by (b) — non-user actors (agent / workflow / system / integration) fail closed with the specific message and write NOTHING", async () => {
  for (const actorType of ["agent", "workflow", "system", "integration"]) {
    const db = makeDb({ estimates: [], estimate_items: [] });
    const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: `k-nu-${actorType}`, actor: { actorType, actorId: "user-1" } });
    assert.equal(res.status, "failed", actorType);
    assert.equal(res.error, "An estimate must be attributed to a team member.", actorType);
    assert.equal(db.__dumpTable("estimates").length, 0, actorType);
    assert.equal(db.__dumpTable("estimate_items").length, 0, actorType);
  }
});

test("created_by (c) — a user actor with a missing / blank actorId fails closed and writes nothing", async () => {
  for (const actorId of [undefined, null, "", "   "]) {
    const db = makeDb({ estimates: [], estimate_items: [] });
    const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: `k-noid-${String(actorId)}`, actor: { actorType: "user", actorId } });
    assert.equal(res.status, "failed", String(actorId));
    assert.equal(res.error, "An estimate must be attributed to a team member.");
    assert.equal(db.__dumpTable("estimates").length, 0);
    assert.equal(db.__dumpTable("estimate_items").length, 0);
  }
});

test("created_by (d) — a user from ANOTHER org (or unknown) is rejected and writes nothing, even though the other-org profile row exists", async () => {
  for (const actorId of [USER_B, "99999999-9999-4999-8999-999999999999"]) {
    const db = makeDb({ estimates: [], estimate_items: [] });
    const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: `k-x-${actorId}`, actor: { actorType: "user", actorId } });
    assert.equal(res.status, "failed", actorId);
    assert.equal(res.error, "An estimate must be attributed to a team member.");
    assert.equal(db.__dumpTable("estimates").length, 0);
    assert.equal(db.__dumpTable("estimate_items").length, 0);
  }
});

test("created_by — a rejected attribution leaves no idempotency claim behind: a corrected retry by a real member succeeds", async () => {
  const db = makeDb({ estimates: [], estimate_items: [] });
  await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-order", actor: { actorType: "user", actorId: USER_B } });
  assert.equal(db.__dumpTable("estimates").length, 0);
  const retry = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-order" });
  assert.equal(retry.status, "succeeded", JSON.stringify(retry));
  assert.equal(db.__dumpTable("estimates").length, 1);
});

test("created_by (f) — idempotency intact with attribution: replay is a no-op, and a lost slot is still caught by the execution guard (one estimate, original created_by)", async () => {
  const db = makeDb({ estimates: [], estimate_items: [] });
  const first = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-id-1" });
  const replay = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-id-1" });
  const lostSlot = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-id-2", actor: { actorType: "user", actorId: USER_M } });
  assert.equal(first.status, "succeeded");
  assert.equal(replay.status, "skipped");
  assert.equal(lostSlot.output.alreadyCreated, true);
  assert.equal(db.__dumpTable("estimates").length, 1);
  assert.equal(db.__dumpTable("estimates")[0].created_by, "user-1", "a replay never re-attributes the estimate");
  assert.equal(db.__dumpTable("estimate_items").length, 3);
});

test("created_by (g) — price_pending behavior is unchanged: items remain unpriced placeholders with the marker, totals stay 0", async () => {
  const db = makeDb({ estimates: [], estimate_items: [] });
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-pp" });
  assert.equal(res.status, "succeeded");
  assert.ok(db.__dumpTable("estimate_items").every((i: any) => i.unit_price === 0 && i.metadata.price_pending === true && i.metadata.quantity_pending === true));
  assert.equal(db.__dumpTable("estimates")[0].total, 0);
  assert.equal(db.__dumpTable("estimates")[0].tax_rate, 0);
});

test("created_by (h) — a database failure logs the OPERATION + Postgres code/message server-side, never the row payload / customer content; the outward message stays the safe one", async () => {
  const base = makeDb({ estimates: [], estimate_items: [] });
  const SECRET_TITLE = "Smith family kitchen — 123 Private Lane";
  const failing = {
    ...base,
    from: (table: string) => {
      const b = base.from(table);
      if (table === "estimates") {
        const realInsert = b.insert.bind(b);
        // Drops created_by so the NOT-NULL-enforcing fake raises the same 23502 the live database did.
        b.insert = (row: any) => realInsert({ ...row, created_by: undefined });
      }
      return b;
    },
  };
  const logged: unknown[][] = [];
  const prevError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  let res: any;
  try {
    res = await approved(failing, "create_estimate_draft", { ...CREATE_INPUT, title: SECRET_TITLE, scope: "gate code 4821" }, { idempotencyKey: "k-log" });
  } finally { console.error = prevError; }

  assert.equal(res.status, "failed");
  assert.equal(res.error, "Could not create the estimate draft.", "outward message unchanged");
  const entry = logged.find((a) => String(a[0]).includes("[estimate-handlers] db error"));
  assert.ok(entry, "a server-side log line was written");
  const detail = entry![1] as { operation: string; code: string; message: string };
  assert.equal(detail.operation, "create_estimate_draft.insert_estimate");
  assert.equal(detail.code, "23502");
  assert.match(detail.message, /created_by/);
  assert.deepEqual(Object.keys(detail).sort(), ["code", "message", "operation"]);
  const everything = JSON.stringify(logged);
  for (const forbidden of [SECRET_TITLE, "gate code 4821", "Cabinet replacement", "Jane Homeowner", CONTACT_A, LEAD_A, "user-1", ORG_A]) {
    assert.ok(!everything.includes(forbidden), `log leaked: ${forbidden}`);
  }
  assert.equal(base.__dumpTable("estimates").length, 0);
});

// ── "Estimate created" activity attribution (trigger writes actor_type='system' under service-role) ──

/** Simulates log_estimate_activity()'s AFTER INSERT behavior for a SERVICE-ROLE write: auth.uid() is NULL, so actor is 'system'. */
const systemCreatedTrigger = {
  afterInsert: {
    estimates: (row: any, store: Map<string, any[]>) => {
      const rows = store.get("estimate_activities") ?? [];
      rows.push({ id: globalThis.crypto.randomUUID(), org_id: row.org_id, estimate_id: row.id, version_number: row.version_number ?? 1, activity_type: "created", actor_id: null, actor_type: "system", title: "Estimate created", description: null, metadata: {} });
      store.set("estimate_activities", rows);
    },
  },
};
const createdActivities = (db: any) => db.__dumpTable("estimate_activities").filter((a: any) => a.activity_type === "created");

test("ATTRIBUTION — the trigger-written 'created' row is corrected to the approving user: still exactly ONE row, original title kept, provenance recorded honestly", async () => {
  const db = makeDb({ estimates: [], estimate_items: [], estimate_activities: [] }, systemCreatedTrigger);
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-attr-1" });
  assert.equal(res.status, "succeeded", JSON.stringify(res));
  const acts = createdActivities(db);
  assert.equal(acts.length, 1, "no duplicate 'Estimate created'");
  assert.equal(db.__dumpTable("estimate_activities").length, 1, "and no other activity rows were invented");
  const a = acts[0];
  assert.equal(a.actor_type, "user");
  assert.equal(a.actor_id, "user-1");
  assert.equal(a.actor_id, db.__dumpTable("estimates")[0].created_by, "same verified user as created_by — nothing fabricated");
  assert.equal(a.title, "Estimate created");
  assert.equal(a.estimate_id, res.output.estimateId);
  assert.equal(a.description, "Drafted by the Estimate Assistant and approved by a team member.");
  assert.deepEqual(a.metadata, { attributed_via: "estimate_assistant_approval", originally_recorded_as: "system", ai_execution_id: "exec-1" });
});

test("ATTRIBUTION — a membership-only approver (org_memberships, no profile org) is attributed too", async () => {
  const db = makeDb({ estimates: [], estimate_items: [], estimate_activities: [] }, systemCreatedTrigger);
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-attr-2", actor: { actorType: "user", actorId: USER_M } });
  assert.equal(res.status, "succeeded");
  assert.equal(createdActivities(db)[0].actor_id, USER_M);
});

test("ATTRIBUTION — a row that ALREADY names a user is never overwritten (guarded to unattributed system rows only)", async () => {
  const userTrigger = { afterInsert: { estimates: (row: any, store: Map<string, any[]>) => { store.set("estimate_activities", [...(store.get("estimate_activities") ?? []), { id: "pre-1", org_id: row.org_id, estimate_id: row.id, activity_type: "created", actor_id: "someone-else", actor_type: "user", title: "Estimate created", description: null, metadata: {} }]); } } };
  const db = makeDb({ estimates: [], estimate_items: [], estimate_activities: [] }, userTrigger);
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-attr-3" });
  assert.equal(res.status, "succeeded");
  const acts = createdActivities(db);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].actor_id, "someone-else");
  assert.deepEqual(acts[0].metadata, {});
});

test("ATTRIBUTION — if no unattributed 'created' row exists (e.g. no trigger), the create still succeeds and NOTHING is fabricated or inserted", async () => {
  const db = makeDb({ estimates: [], estimate_items: [], estimate_activities: [] }); // no simulated trigger
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-attr-4" });
  assert.equal(res.status, "succeeded");
  assert.equal(db.__dumpTable("estimate_activities").length, 0);
});

test("ATTRIBUTION — only THIS org's and THIS estimate's row is touched: other estimates' system rows (and other orgs') stay exactly as they were", async () => {
  const foreign = [
    { id: "f1", org_id: ORG_A, estimate_id: "other-estimate-a", activity_type: "created", actor_id: null, actor_type: "system", title: "Estimate created", description: null, metadata: {} },
    { id: "f2", org_id: ORG_B, estimate_id: "other-estimate-b", activity_type: "created", actor_id: null, actor_type: "system", title: "Estimate created", description: null, metadata: {} },
  ];
  const db = makeDb({ estimates: [], estimate_items: [], estimate_activities: foreign.map((f) => ({ ...f })) }, systemCreatedTrigger);
  const res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-attr-5" });
  assert.equal(res.status, "succeeded");
  const acts = db.__dumpTable("estimate_activities");
  assert.equal(acts.length, 3);
  for (const f of foreign) assert.deepEqual(acts.find((a: any) => a.id === f.id), f, `foreign row ${f.id} untouched`);
  assert.equal(acts.filter((a: any) => a.actor_type === "user").length, 1);
});

test("ATTRIBUTION — best effort: an activity-update failure never fails the create; it is logged as operation + code + message ONLY", async () => {
  const base = makeDb({ estimates: [], estimate_items: [], estimate_activities: [] }, systemCreatedTrigger);
  const db = { ...base, from: (t: string) => { const b = base.from(t); if (t === "estimate_activities") b.update = () => ({ eq() { return this; }, is() { return this; }, select() { return this; }, then: (r: any) => r({ data: null, error: { code: "42501", message: "permission denied for table estimate_activities" } }) }); return b; } };
  const logged: unknown[][] = [];
  const prev = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  let res: any;
  try { res = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-attr-6" }); } finally { console.error = prev; }
  assert.equal(res.status, "succeeded", "the estimate was created and stays created");
  assert.equal(base.__dumpTable("estimates").length, 1);
  assert.equal(createdActivities(base)[0].actor_type, "system", "unchanged (still the honest trigger value)");
  const entry = logged.find((a) => String(a[0]).includes("[estimate-handlers] db error"));
  assert.ok(entry);
  const d = entry![1] as any;
  assert.deepEqual(Object.keys(d).sort(), ["code", "message", "operation"]);
  assert.equal(d.operation, "create_estimate_draft.attribute_created_activity");
  assert.equal(d.code, "42501");
  const blob = JSON.stringify(logged);
  for (const forbidden of ["user-1", "Kitchen remodel", "Jane Homeowner", ORG_A, LEAD_A]) assert.ok(!blob.includes(forbidden), `log leaked ${forbidden}`);
});

test("ATTRIBUTION — refused creates (non-user / foreign-org actor) attribute nothing and create nothing; a replayed approval never re-touches the activity", async () => {
  const db = makeDb({ estimates: [], estimate_items: [], estimate_activities: [] }, systemCreatedTrigger);
  for (const actor of [{ actorType: "agent", actorId: "user-1" }, { actorType: "user", actorId: USER_B }]) {
    const r = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: `k-attr-${actor.actorType}`, actor });
    assert.equal(r.status, "failed");
  }
  assert.equal(db.__dumpTable("estimates").length, 0);
  assert.equal(db.__dumpTable("estimate_activities").length, 0);

  const first = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-attr-7" });
  const afterFirst = JSON.stringify(db.__dumpTable("estimate_activities"));
  const replay = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-attr-7" });
  const lostSlot = await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-attr-8", actor: { actorType: "user", actorId: USER_M } });
  assert.equal(first.status, "succeeded");
  assert.equal(replay.status, "skipped");
  assert.equal(lostSlot.output.alreadyCreated, true);
  assert.equal(JSON.stringify(db.__dumpTable("estimate_activities")), afterFirst, "no re-attribution, no duplicates");
  assert.equal(createdActivities(db).length, 1);
});

test("ATTRIBUTION — scope: the handler only ever UPDATES the trigger row; it never inserts into estimate_activities, and an ordinary (non-handler) insert keeps the trigger's own attribution", async () => {
  const base = makeDb({ estimates: [], estimate_items: [], estimate_activities: [] }, systemCreatedTrigger);
  let activityInserts = 0;
  const db = { ...base, from: (t: string) => { const b = base.from(t); if (t === "estimate_activities") { const ins = b.insert.bind(b); b.insert = (...a: any[]) => { activityInserts += 1; return ins(...a); }; } return b; } };
  await approved(db, "create_estimate_draft", CREATE_INPUT, { idempotencyKey: "k-attr-9" });
  assert.equal(activityInserts, 0);

  // An estimate inserted by something other than this handler (e.g. a browser user) is not touched by it.
  const plain = makeDb({ estimates: [], estimate_items: [], estimate_activities: [] }, systemCreatedTrigger);
  await plain.from("estimates").insert({ org_id: ORG_A, client_id: CONTACT_A, title: "Manual", status: "draft", created_by: "user-1" }).select("id").single();
  assert.equal(createdActivities(plain)[0].actor_type, "system", "the simulated trigger's own value is left alone by the handler path");
});

// ── add_estimate_line_items ─────────────────────────────────────────────

const ADD_INPUT = { estimateId: EST_A, items: [{ name: "Tile backsplash", itemType: "material" }] };

test("TEST 14 — add_estimate_line_items requires approval: the proposal writes NOTHING to the estimate or its items", async () => {
  const db = makeDb();
  const before = { e: dump(db, "estimates"), i: dump(db, "estimate_items") };
  const res = await step(db, "add_estimate_line_items", ADD_INPUT);
  assert.equal(res.status, "awaiting_approval", JSON.stringify(res));
  assert.equal(dump(db, "estimates"), before.e);
  assert.equal(dump(db, "estimate_items"), before.i);
});

test("TEST 15 — approved add: existing items/prices untouched, new row is an UNPRICED placeholder, header totals recomputed by the shared engine (existing figures preserved), total === client_total", async () => {
  const db = makeDb();
  const res = await approved(db, "add_estimate_line_items", ADD_INPUT, { idempotencyKey: "add_estimate_line_items:appr-1" });
  assert.equal(res.status, "succeeded", JSON.stringify(res));
  assert.equal(res.output.estimateId, EST_A);
  assert.equal(res.output.addedItemIds.length, 1);
  assert.equal(res.output.itemCount, 2);
  assert.equal(res.output.totalsUpdated, true);
  assert.equal(res.output.total, 220, "adding an unpriced placeholder cannot change the total");

  const items = db.__dumpTable("estimate_items");
  const original = items.find((i: any) => i.id === "item-a1");
  assert.equal(original.unit_price, 100, "existing price untouched");
  assert.equal(original.quantity, 2);
  const added = items.find((i: any) => i.name === "Tile backsplash");
  assert.equal(added.unit_price, 0);
  assert.equal(added.metadata.price_pending, true);
  assert.equal(added.position, 1, "appended after the existing max position");

  const e = db.__dumpTable("estimates")[0];
  assert.equal(e.subtotal, 200);
  assert.equal(e.tax_total, 20);
  assert.equal(e.total, 220);
  assert.equal(e.client_total, e.total);
  assert.equal(e.status, "draft", "status never changed");
  assert.equal(e.tax_rate, 10, "tax rate never touched");
});

test("TEST 16 — duplicate approval of add: replay inserts NO second row; and a lost slot is still safe via the execution-stamped guard", async () => {
  const db = makeDb();
  const key = "add_estimate_line_items:appr-dup";
  const first = await approved(db, "add_estimate_line_items", ADD_INPUT, { idempotencyKey: key });
  const second = await approved(db, "add_estimate_line_items", ADD_INPUT, { idempotencyKey: key });
  assert.equal(second.status, "skipped");
  assert.equal(db.__dumpTable("estimate_items").filter((i: any) => i.name === "Tile backsplash").length, 1);

  const third = await approved(db, "add_estimate_line_items", ADD_INPUT, { idempotencyKey: "add_estimate_line_items:other-key" });
  assert.equal(third.status, "succeeded");
  assert.equal(third.output.alreadyApplied, true);
  assert.deepEqual(third.output.addedItemIds, first.output.addedItemIds);
  assert.equal(db.__dumpTable("estimate_items").filter((i: any) => i.name === "Tile backsplash").length, 1);
});

test("add skips a name already on the estimate (case/whitespace-insensitive) and still reports success with the skipped name", async () => {
  const db = makeDb();
  const res = await approved(db, "add_estimate_line_items", { estimateId: EST_A, items: [{ name: "  base   CABINETS " }, { name: "Island" }] }, { idempotencyKey: "k-dedupe" });
  assert.equal(res.status, "succeeded");
  // The input schema trims names, so the reported name is the trimmed one.
  assert.deepEqual(res.output.skippedDuplicateNames, ["base   CABINETS"]);
  assert.equal(res.output.addedItemIds.length, 1);
  assert.equal(db.__dumpTable("estimate_items").length, 2);
});

test("add refuses an estimate that is no longer a draft (sent/ready/approved…) and writes nothing", async () => {
  for (const status of ["ready", "sent", "viewed", "approved", "converted", "changes_requested"]) {
    const db = makeDb({ estimates: [pricedEstimateRow({ status })] });
    const before = dump(db, "estimate_items");
    const res = await approved(db, "add_estimate_line_items", ADD_INPUT, { idempotencyKey: `k-${status}` });
    assert.equal(res.status, "failed", status);
    assert.equal(dump(db, "estimate_items"), before, status);
  }
});

test("TEST 17 — add to another org's estimate fails with the SAME generic message as a nonexistent id, and inserts nothing", async () => {
  const db = makeDb({ estimates: [pricedEstimateRow(), pricedEstimateRow({ id: EST_B, org_id: ORG_B })] });
  const cross = await approved(db, "add_estimate_line_items", { estimateId: EST_B, items: [{ name: "x item" }] }, { idempotencyKey: "k-x1" });
  const ghost = await approved(db, "add_estimate_line_items", { estimateId: "99999999-9999-4999-8999-999999999999", items: [{ name: "x item" }] }, { idempotencyKey: "k-x2" });
  assert.equal(cross.status, "failed");
  assert.equal(cross.error, GENERIC_NOT_FOUND);
  assert.equal(ghost.error, GENERIC_NOT_FOUND);
  assert.equal(db.__dumpTable("estimate_items").length, 1);
});

test("legacy 'quick estimate' guard: a stored total with ZERO item rows is NOT zeroed by adding the first placeholder rows", async () => {
  const db = makeDb({
    estimates: [pricedEstimateRow({ subtotal: 4600, tax_total: 400, total: 5000, client_total: 5000, balance_due: 5000 })],
    estimate_items: [],
  });
  const res = await approved(db, "add_estimate_line_items", ADD_INPUT, { idempotencyKey: "k-quick" });
  assert.equal(res.status, "succeeded");
  assert.equal(res.output.totalsUpdated, false);
  assert.equal(res.output.total, 5000);
  const e = db.__dumpTable("estimates")[0];
  assert.equal(e.total, 5000);
  assert.equal(e.subtotal, 4600);
});

test("add compensates: if the totals update fails, the just-inserted items are removed (no orphan rows)", async () => {
  const base = makeDb();
  const db = {
    ...base,
    from: (table: string) => {
      const b = base.from(table);
      if (table === "estimates") b.update = () => ({ eq() { return this; }, then: (res: any) => res({ data: null, error: { message: "boom" } }) });
      return b;
    },
  };
  const res = await approved(db, "add_estimate_line_items", ADD_INPUT, { idempotencyKey: "k-comp2" });
  assert.equal(res.status, "failed");
  assert.deepEqual(base.__dumpTable("estimate_items").map((i: any) => i.name), ["Base cabinets"]);
});

test("totals are recomputed by the SHARED engine over existing priced items + optional/heading rules (a deselected optional item adds nothing)", async () => {
  const db = makeDb({
    estimate_items: [
      itemRow(),
      itemRow({ id: "item-a2", name: "Optional island", unit_price: 1000, quantity: 1, total: 1000, position: 1, optional: true, selected_by_customer: false }),
    ],
  });
  const res = await approved(db, "add_estimate_line_items", ADD_INPUT, { idempotencyKey: "k-engine" });
  assert.equal(res.status, "succeeded");
  const e = db.__dumpTable("estimates")[0];
  assert.equal(e.subtotal, 200, "deselected optional item excluded, exactly as the editor's engine does");
  assert.equal(e.total, 220);
});
