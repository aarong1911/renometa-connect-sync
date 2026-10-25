// netlify/functions/lib/test-console-access.test.ts
//
// Run:  node --test netlify/functions/lib/test-console-access.test.ts
//
// Internal Test Console gate: allowlist parsing (fail closed), the access endpoint (auth required, boolean only, no allowlist
// exposure), the server-side gate on ai-orchestrate (403 for non-allowlisted callers, allowlisted callers still reach the normal
// pipeline), the client helper, and the AI Center UI gating. The REAL handlers run with a fake Supabase client; no network, no model.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("real network access is forbidden in this test file"); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "test-console-access-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

const ALLOWED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const ORG = "11111111-1111-4111-8111-111111111111";
process.env.SUPABASE_URL = "http://fake.local";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// Fake @supabase/supabase-js (tokens map to users via globalThis.__fakeUsers) and a stub for the browser supabase client.
const fakeSupabase = `
  export function createClient() {
    return {
      auth: { getUser: async (token) => { const u = globalThis.__fakeUsers?.[token]; return { data: { user: u ? { id: u } : null }, error: null }; } },
      from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { organization_id: "${ORG}" }, error: null }) }; return q; },
    };
  }`;
const stubs = {
  name: "stubs",
  setup(build: any) {
    build.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "fake-supabase", namespace: "stub" }));
    build.onResolve({ filter: /^@\/lib\/supabase$/ }, () => ({ path: "browser-supabase", namespace: "stub" }));
    build.onLoad({ filter: /^fake-supabase$/, namespace: "stub" }, () => ({ contents: fakeSupabase, loader: "js" }));
    build.onLoad({ filter: /^browser-supabase$/, namespace: "stub" }, () => ({ contents: `export const supabase = { auth: { getSession: async () => globalThis.__fakeSession ?? { data: { session: null } } } };`, loader: "js" }));
  },
};

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export * from "./netlify/functions/lib/test-console-access";
      export { handler as accessHandler } from "./netlify/functions/ai-test-console-access";
      export { handler as orchestrateHandler } from "./netlify/functions/ai-orchestrate";
      export * as client from "./src/lib/test-console-access";
    `,
    resolveDir: repoRoot, loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error",
  plugins: [stubs],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

(globalThis as any).__fakeUsers = { "token-allowed": ALLOWED, "token-other": OTHER };
const ENV = S.TEST_CONSOLE_ALLOWLIST_ENV;
const req = (method: string, token?: string, body?: unknown) => ({ httpMethod: method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? null : JSON.stringify(body) });
const savedConsole = console.error; console.error = () => {};
after(() => { console.error = savedConsole; delete process.env[ENV]; });

// ── allowlist parsing ────────────────────────────────────────────────────

test("allowlist — fails closed: unset / empty / garbage allows nobody", () => {
  for (const raw of [undefined, null, "", "   ", ",,,", "not-a-uuid", "*", "all", "true"]) {
    assert.equal(S.isTestConsoleUser(ALLOWED, { [ENV]: raw as any }), false, JSON.stringify(raw));
  }
  assert.equal(S.parseTestConsoleAllowlist(undefined).size, 0);
});

test("allowlist — comma separated, trimmed, case-insensitive; non-UUID entries are ignored; unlisted ids are denied", () => {
  const env = { [ENV]: ` ${ALLOWED.toUpperCase()} , junk , ${OTHER}x ` };
  assert.equal(S.isTestConsoleUser(ALLOWED, env), true);
  assert.equal(S.isTestConsoleUser(OTHER, env), false, "a near-miss id is not allowed");
  assert.equal(S.isTestConsoleUser(undefined, env), false);
  assert.equal(S.isTestConsoleUser("", env), false);
  assert.equal(S.isTestConsoleUser(`${ALLOWED} `, env), true);
});

// ── access endpoint ──────────────────────────────────────────────────────

test("access endpoint — requires authentication (no token / bad token -> 401)", async () => {
  process.env[ENV] = ALLOWED;
  assert.equal((await S.accessHandler(req("GET"))).statusCode, 401);
  assert.equal((await S.accessHandler(req("GET", "bogus"))).statusCode, 401);
  assert.equal((await S.accessHandler(req("DELETE", "token-allowed"))).statusCode, 405);
});

test("access endpoint — returns ONLY { allowed } and never the allowlist, ids or configuration", async () => {
  process.env[ENV] = `${ALLOWED},cccccccc-cccc-4ccc-8ccc-ccccccccccc3`;
  const yes = await S.accessHandler(req("GET", "token-allowed"));
  const no = await S.accessHandler(req("GET", "token-other"));
  assert.equal(yes.statusCode, 200);
  assert.deepEqual(JSON.parse(yes.body), { allowed: true });
  assert.deepEqual(JSON.parse(no.body), { allowed: false });
  for (const res of [yes, no]) {
    const text = JSON.stringify(res);
    for (const forbidden of [ALLOWED, OTHER, "cccccccc", ENV, "ALLOWED_USER"]) assert.ok(!text.includes(forbidden), `response leaked ${forbidden}`);
  }
});

test("access endpoint — nobody is allowed when the env var is unset", async () => {
  delete process.env[ENV];
  assert.deepEqual(JSON.parse((await S.accessHandler(req("GET", "token-allowed"))).body), { allowed: false });
});

// ── server-side enforcement on the test-only runtime entry point ─────────

const consoleBody = { event: { channel: "internal", eventType: "manual_test", content: { type: "text", text: "hello" } } };

test("ai-orchestrate — unauthenticated is still 401", async () => {
  process.env[ENV] = ALLOWED;
  assert.equal((await S.orchestrateHandler(req("POST", undefined, consoleBody))).statusCode, 401);
});

test("ai-orchestrate — an authenticated but NON-allowlisted user gets a generic 403 for the Test Console request shape (and variants)", async () => {
  process.env[ENV] = ALLOWED;
  for (const body of [
    consoleBody,
    { event: { channel: "internal", eventType: "new_lead", content: { type: "text", text: "x" } }, context: { leadId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1" } },
    { event: { channel: "sms", eventType: "message_received", content: { type: "text", text: "x" } } },
    { not: "even valid" },
  ]) {
    const res = await S.orchestrateHandler(req("POST", "token-other", body));
    assert.equal(res.statusCode, 403, JSON.stringify(body));
    assert.deepEqual(JSON.parse(res.body), { error: "Test Console access is not enabled for this account." });
    const text = JSON.stringify(res);
    for (const forbidden of [ALLOWED, OTHER, ENV, ORG]) assert.ok(!text.includes(forbidden), `403 leaked ${forbidden}`);
  }
});

test("ai-orchestrate — with no allowlist configured everyone is denied (fail closed)", async () => {
  delete process.env[ENV];
  assert.equal((await S.orchestrateHandler(req("POST", "token-allowed", consoleBody))).statusCode, 403);
});

test("ai-orchestrate — an allowlisted user passes the gate and reaches the normal pipeline (request validation, not 403)", async () => {
  process.env[ENV] = ALLOWED;
  const res = await S.orchestrateHandler(req("POST", "token-allowed", { not: "a valid request" }));
  assert.equal(res.statusCode, 400, "reached request validation, so the gate let the allowlisted user through");
  assert.match(JSON.parse(res.body).error, /Invalid request/);
  const bad = await S.orchestrateHandler({ httpMethod: "POST", headers: { authorization: "Bearer token-allowed" }, body: "{not json" });
  assert.equal(bad.statusCode, 400);
});

test("production AI runtime is unaffected — no production caller uses the HTTP endpoint or the allowlist", () => {
  const productionCallers = [
    "netlify/functions/lib/twilio-sms-inbound.ts", "netlify/functions/lib/meta-whatsapp-background.ts", "netlify/functions/ai-whatsapp-orchestrate-background.ts",
    "netlify/functions/lib/ai/lead-qualification-background.ts", "netlify/functions/lib/ai/lead-qualification-dispatch.ts", "netlify/functions/lib/ai/lead-trigger.ts",
    "netlify/functions/lib/ai/orchestrator.ts",
  ];
  for (const rel of productionCallers) {
    const src = read(rel);
    assert.ok(!/functions\/ai-orchestrate/.test(src), `${rel} must not call the Test Console endpoint over HTTP`);
    assert.ok(!/test-console-access|AI_TEST_CONSOLE/.test(src), `${rel} must not be gated by the Test Console allowlist`);
  }
  // The only HTTP caller of /ai-orchestrate in the whole frontend + functions tree is the Test Console component.
  const consoleSrc = read("src/components/ai-center/ai-test-console.tsx");
  assert.match(consoleSrc, /\.netlify\/functions\/ai-orchestrate/);
});

// ── client helper ────────────────────────────────────────────────────────

function withFetch(impl: (url: string, init?: any) => Promise<any>, fn: () => Promise<void>) {
  const saved = globalThis.fetch;
  globalThis.fetch = impl as any;
  return fn().finally(() => { globalThis.fetch = saved; });
}
const session = { data: { session: { access_token: "token-allowed" } } };

test("client — fetchTestConsoleAccess: true only for an explicit { allowed: true }; every failure is denied", async () => {
  (globalThis as any).__fakeSession = session;
  await withFetch(async () => ({ ok: true, json: async () => ({ allowed: true }) }), async () => assert.equal(await S.client.fetchTestConsoleAccess(), true));
  await withFetch(async () => ({ ok: true, json: async () => ({ allowed: false }) }), async () => assert.equal(await S.client.fetchTestConsoleAccess(), false));
  await withFetch(async () => ({ ok: true, json: async () => ({ allowed: "true" }) }), async () => assert.equal(await S.client.fetchTestConsoleAccess(), false));
  await withFetch(async () => ({ ok: false, json: async () => ({ allowed: true }) }), async () => assert.equal(await S.client.fetchTestConsoleAccess(), false));
  await withFetch(async () => { throw new Error("network"); }, async () => assert.equal(await S.client.fetchTestConsoleAccess(), false));
  (globalThis as any).__fakeSession = { data: { session: null } };
  await withFetch(async () => ({ ok: true, json: async () => ({ allowed: true }) }), async () => assert.equal(await S.client.fetchTestConsoleAccess(), false, "no session -> denied without calling the endpoint"));
});

test("client — resolveRequestedTab: console only for allowed users; unresolved/denied fall back to the default tab", () => {
  const r = S.client.resolveRequestedTab;
  assert.equal(r("console", "allowed", "agents"), "console");
  assert.equal(r("console", "denied", "agents"), "agents");
  assert.equal(r("console", "loading", "agents"), "agents", "no flash of the console while access resolves");
  assert.equal(r("approvals", "denied", "agents"), "approvals");
  assert.equal(r(undefined, "allowed", "agents"), "agents");
});

// ── AI Center UI gating (source) ─────────────────────────────────────────

test("AI Center — the Test Console tab and content render only when allowed; other tabs are unchanged", () => {
  const src = read("src/routes/ai-center.tsx");
  assert.match(src, /const consoleAllowed = testConsoleAccess === "allowed"/);
  assert.match(src, /TOP_TABS\.filter\(\(t\) => t\.value !== "console" \|\| consoleAllowed\)/);
  assert.match(src, /visibleTabs\.map\(\(t\)/);
  assert.ok(!/\{TOP_TABS\.map/.test(src), "the unfiltered tab list is not rendered");
  assert.match(src, /\{consoleAllowed && \([\s\S]*?<AITestConsole \/>[\s\S]*?\)\}/, "AITestConsole is only rendered for an allowed user");
  assert.equal((src.match(/<AITestConsole/g) ?? []).length, 1);
  assert.match(src, /useState<TopTab>\(resolveRequestedTab<TopTab>\(urlTab, testConsoleAccess, "agents"\)\)/, "initial tab can never be the console for a non-allowed user");
  assert.match(src, /urlTab === "console" && testConsoleAccess === "denied"/);
  for (const label of ["Autonomous Agents", "AI Tools", "Voice Agent", "Agentic (Beta)", "Business Knowledge", "Approvals"]) assert.ok(src.includes(`label: "${label}"`), label);
});

test("no allowlist value, env name or user id appears in any client (src) file", () => {
  for (const rel of ["src/lib/test-console-access.ts", "src/routes/ai-center.tsx", "src/components/ai-center/ai-test-console.tsx"]) {
    const src = read(rel);
    assert.ok(!/AI_TEST_CONSOLE_ALLOWED_USER_IDS/.test(src), `${rel} references the allowlist env var`);
    // (the console's all-zero input placeholder is not an id)
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(src.replace(/00000000-0000-0000-0000-000000000000/g, "")), `${rel} hard-codes a UUID`);
    assert.ok(!/@[a-z0-9-]+\.(com|net|org)/i.test(src.replace(/support@renometa\.com/g, "")) || rel.endsWith("ai-test-console.tsx"), `${rel} hard-codes an email`);
  }
});
