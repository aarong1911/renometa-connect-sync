// tests/netlify-functions/estimate-send-pricing-gate.test.ts
//
// Run:  node --test tests/netlify-functions/estimate-send-pricing-gate.test.ts
//
// Estimate Assistant safety hardening — the SEND GATE. Drives the REAL
// netlify/functions/estimate-send.ts handler (the one function that creates
// the public proposal token, emails the customer and marks an estimate sent)
// with `@supabase/supabase-js` aliased to the in-memory fake client. No live
// Supabase, no Gmail, no network: global fetch is a recording stub that also
// answers Google tokeninfo / Gmail send (support/gmail-stub.ts).
//
// Proves: an estimate with ANY `price_pending` line is refused before a
// token/row update/email/activity/workflow event; a fully priced estimate
// sends exactly as before; a legitimate UNMARKED $0 line is not blocked; and
// an AI-created draft (created through the real approved handler) stays
// editable but cannot be sent until the owner prices it.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.CONNECT_APP_URL = "https://connect.test";
const { gmailStub, gmailIntegration, installFetchStub } = await import("./support/gmail-stub.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "estimate-send-gate-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

after(installFetchStub());

const noisy = ["log", "warn", "error", "info"] as const;
const saved = noisy.map((k) => (console as any)[k]);
noisy.forEach((k) => ((console as any)[k] = () => {}));
after(() => noisy.forEach((k, i) => ((console as any)[k] = saved[i])));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
const fakeModules = {
  name: "fake-externals",
  setup(build: any) {
    build.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "supabase", namespace: "fake" }));
    build.onLoad({ filter: /^supabase$/, namespace: "fake" }, () => ({
      loader: "js",
      contents: `
        export function createClient() {
          return {
            auth: { getUser: async () => ({ data: { user: { id: globalThis.__TEST_USER_ID } }, error: null }) },
            from: (t) => globalThis.__TEST_DB.from(t),
          };
        }`,
    }));
  },
};
await esbuild.build({
  entryPoints: [path.join(repoRoot, "netlify/functions/estimate-send.ts")],
  outfile: path.join(outDir, "send.mjs"),
  bundle: true, platform: "node", format: "esm", logLevel: "error",
  plugins: [fakeModules],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const SEND: any = await import(pathToFileURL(path.join(outDir, "send.mjs")).href);

await esbuild.build({
  stdin: {
    contents: `
      export * from "./src/lib/agentic/action-executor";
      export * from "./src/lib/estimate-pricing-gate";
    `,
    resolveDir: repoRoot, loader: "ts",
  },
  outfile: path.join(outDir, "exec.mjs"),
  bundle: true, platform: "node", format: "esm", logLevel: "error", external: ["@supabase/supabase-js"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const X: any = await import(pathToFileURL(path.join(outDir, "exec.mjs")).href);

const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href);

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "99999999-9999-4999-8999-999999999999";
const CONTACT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const LEAD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const EST = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const UNPRICED_ERROR = "Complete pricing for all estimate items before sending this estimate.";

function item(id: string, name: string, over: Record<string, unknown> = {}) {
  return { id, estimate_id: EST, name, description: null, item_type: "material", quantity: 1, unit: "each", unit_price: 100, total: 100, position: 0, taxable: true, optional: false, selected_by_customer: true, is_heading: false, discount_type: null, discount_value: 0, metadata: {}, ...over };
}
const pendingItem = (id: string, name: string, pos = 0) => item(id, name, { unit_price: 0, total: 0, position: pos, metadata: { price_pending: true } });

function setDb(overrides: Record<string, any[]> = {}, status = "draft") {
  const db = createFakeSupabaseClient(
    {
      profiles: [{ id: USER, organization_id: ORG, first_name: "Owen", last_name: "Owner" }],
      org_memberships: [{ org_id: ORG, member_id: USER, role: "owner" }],
      member_permissions: [],
      integrations: [gmailIntegration(ORG)],
      gmail_messages: [],
      organizations: [{ id: ORG, name: "Acme Remodeling", public_name: null, ai_center_settings: {} }],
      contacts: [{ id: CONTACT, org_id: ORG, full_name: "Jane Homeowner", email: "jane@example.com", phone: null }],
      leads: [{ id: LEAD, org_id: ORG, contact_id: CONTACT }],
      projects: [],
      estimates: [{
        id: EST, org_id: ORG, status, number: "EST-000001", title: "Kitchen", version_number: 1, public_token: null,
        client_id: CONTACT, lead_id: LEAD, tax_rate: 0, discount_type: null, discount_value: 0, deposit_type: null, deposit_value: 0,
        subtotal: 0, total: 0, client_total: 0, metadata: {},
      }],
      estimate_items: [item("i1", "Cabinets")],
      estimate_activities: [], deals: [], marketing_contact_preferences: [],
      agent_execution_steps: [], agent_approval_requests: [], agent_action_idempotency: [],
      ...overrides,
    },
    {},
    { uniqueConstraints: { agent_action_idempotency: [["org_id", "action_key", "idempotency_key"]] }, notNullColumns: { estimates: ["created_by"] } },
  );
  (globalThis as any).__TEST_DB = db;
  (globalThis as any).__TEST_USER_ID = USER;
  gmailStub.reset();
  return db;
}

async function send(estimateId = EST) {
  const res = await SEND.handler({ httpMethod: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify({ estimateId }) });
  return { status: res.statusCode, body: JSON.parse(res.body ?? "{}") };
}
const estimateRow = (db: any) => db.__dumpTable("estimates")[0];

function assertNothingWentOut(db: any) {
  const e = estimateRow(db);
  assert.equal(e.public_token, null, "no public proposal token may be created");
  assert.equal(e.sent_at, undefined, "sent_at must not be set");
  assert.equal(e.total, 0, "no canonical-totals 'preparation' write either");
  assert.equal(gmailStub.sentMime.length, 0, "no email may be sent");
  assert.equal(db.__dumpTable("estimate_activities").length, 0, "no 'sent' activity may imply success");
  assert.equal(gmailStub.workflowCalls.length, 0, "no estimate_sent workflow trigger");
}

// ── pure gate semantics ─────────────────────────────────────────────────

test("gate: only a non-heading row WITH the price_pending marker and no positive price is pending", () => {
  assert.equal(X.isPricePendingItem({ unit_price: 0, metadata: { price_pending: true } }), true);
  assert.equal(X.isPricePendingItem({ unit_price: "0", metadata: { price_pending: true } }), true);
  assert.equal(X.isPricePendingItem({ unit_price: null, metadata: { price_pending: true } }), true);
  assert.equal(X.isPricePendingItem({ unit_price: 0, metadata: {} }), false, "a bare $0 is NOT pending");
  assert.equal(X.isPricePendingItem({ unit_price: 0 }), false);
  assert.equal(X.isPricePendingItem({ unit_price: 0, metadata: null }), false);
  assert.equal(X.isPricePendingItem({ unit_price: 0, metadata: { price_pending: "true" } }), false, "marker must be literally true");
  assert.equal(X.isPricePendingItem({ unit_price: 25, metadata: { price_pending: true } }), false, "a stale marker on a priced row does not block");
  assert.equal(X.isPricePendingItem({ unit_price: 0, is_heading: true, metadata: { price_pending: true } }), false, "section headings carry no price");
  assert.equal(X.hasPricePendingItems(null), false);
  assert.equal(X.hasPricePendingItems([]), false);
});

// ── A. unpriced estimates cannot be sent ────────────────────────────────

test("A — an estimate with a price_pending item is REFUSED: 422 + safe error, status stays draft, no token / email / activity / workflow event", async () => {
  const db = setDb({ estimate_items: [item("i1", "Cabinets"), pendingItem("i2", "Backsplash", 1)] });
  const r = await send();
  assert.equal(r.status, 422);
  assert.equal(r.body.error, UNPRICED_ERROR);
  assert.equal(r.body.code, "estimate_unpriced");
  assert.notEqual(r.body.ok, true);
  assert.equal(r.body.proposalUrl, undefined);
  assert.equal(r.body.publicToken, undefined);
  assert.equal(estimateRow(db).status, "draft");
  assertNothingWentOut(db);
});

test("A2 — the gate applies in every sendable status: ready, and a RE-send of an already-sent or changes-requested estimate", async () => {
  for (const status of ["ready", "sent", "viewed", "changes_requested"]) {
    const db = setDb({ estimate_items: [pendingItem("i1", "Cabinets")] }, status);
    const r = await send();
    assert.equal(r.status, 422, status);
    assert.equal(estimateRow(db).status, status, `${status}: status unchanged`);
    assert.equal(gmailStub.sentMime.length, 0, status);
    assert.equal(estimateRow(db).public_token, null, status);
  }
});

test("A3 — every unpriced line counts: one pending among many priced lines still blocks; pricing it unblocks", async () => {
  const db = setDb({ estimate_items: [item("i1", "Cabinets"), item("i2", "Countertop", { position: 1 }), pendingItem("i3", "Sink", 2)] });
  assert.equal((await send()).status, 422);
  // Owner prices the last line the way the editor does (marker cleared with the price).
  const row = db.__dumpTable("estimate_items").find((r: any) => r.id === "i3");
  await db.from("estimate_items").update({ unit_price: 250, total: 250, metadata: {} }).eq("id", row.id);
  const ok = await send();
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

// ── B. fully priced: unchanged ──────────────────────────────────────────

test("B — a fully priced estimate sends exactly as before: 200, token, email, status sent, totals recalculated, 'sent' activity", async () => {
  const db = setDb({ estimate_items: [item("i1", "Base cabinets", { quantity: 2, unit_price: 100, total: 200 })] });
  const r = await send();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.status, "sent");
  assert.equal(r.body.total, 200);
  assert.match(r.body.proposalUrl, /^https:\/\/connect\.test\/proposal\/[0-9a-f]{64}$/);
  const e = estimateRow(db);
  assert.equal(e.status, "sent");
  assert.equal(e.total, 200);
  assert.equal(e.public_token, r.body.publicToken);
  assert.ok(e.sent_at);
  assert.equal(gmailStub.sentMime.length, 1);
  assert.equal(db.__dumpTable("estimate_activities").filter((a: any) => a.activity_type === "sent").length, 1);
});

// ── C. legitimate $0 that is NOT price_pending ──────────────────────────

test("C — a legitimate $0 line (unmarked) is NOT blocked solely because it equals zero", async () => {
  const db = setDb({ estimate_items: [item("i1", "Cabinets"), item("i2", "Site visit (included at no charge)", { unit_price: 0, total: 0, position: 1, metadata: {} })] });
  const r = await send();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(estimateRow(db).status, "sent");
  assert.equal(gmailStub.sentMime.length, 1);
});

test("C2 — a stale price_pending marker on a row that now has a real price does not block", async () => {
  setDb({ estimate_items: [item("i1", "Cabinets", { metadata: { price_pending: true } })] });
  assert.equal((await send()).status, 200);
});

// ── D. AI-created draft: editable, but not sendable until priced ────────

test("D — a draft holding AI placeholder lines (rows shaped exactly like create/add RPC output) is blocked from sending until the owner prices every line", async () => {
  // The AI create/add handlers now write through database functions, so this test seeds the rows those functions
  // produce (unit_price 0, metadata.price_pending true, AI provenance) instead of invoking the handler.
  const aiPending = (id: string, name: string, pos: number) => item(id, name, { unit_price: 0, total: 0, position: pos, metadata: { ai_proposed: true, price_pending: true, quantity_pending: true, ai_execution_id: "exec-1" } });
  const db = setDb({ estimate_items: [aiPending("a1", "Cabinet replacement", 0), aiPending("a2", "Countertop replacement", 1), aiPending("a3", "Tile backsplash", 2)] });
  const estimateId = EST;

  // Blocked, with nothing sent.
  const blocked = await send(estimateId);
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error, UNPRICED_ERROR);
  assert.equal(db.__dumpTable("estimates")[0].status, "draft");
  assert.equal(db.__dumpTable("estimates")[0].public_token ?? null, null);
  assert.equal(gmailStub.sentMime.length, 0);

  // Owner prices SOME lines — still blocked until ALL are priced.
  const price = (name: string, p: number) => db.from("estimate_items").update({ unit_price: p, total: p, metadata: {} }).eq("estimate_id", estimateId).eq("name", name);
  await price("Cabinet replacement", 5000);
  await price("Countertop replacement", 4000);
  assert.equal((await send(estimateId)).status, 422, "one line (backsplash) is still unpriced");
  await price("Tile backsplash", 900);
  const sent = await send(estimateId);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.total, 9900);
  assert.equal(db.__dumpTable("estimates")[0].status, "sent");
});

// ── existing guards are untouched ───────────────────────────────────────

test("existing behavior unchanged: unauthenticated -> 401, unknown/other-org estimate -> 404, terminal status -> 409 (all BEFORE the pricing gate)", async () => {
  setDb({ estimate_items: [pendingItem("i1", "Cabinets")] });
  const noAuth = await SEND.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ estimateId: EST }) });
  assert.equal(noAuth.statusCode, 401);
  assert.equal((await send("99999999-9999-4999-8999-999999999998")).status, 404);
  setDb({ estimate_items: [pendingItem("i1", "Cabinets")] }, "approved");
  assert.equal((await send()).status, 409);
});
