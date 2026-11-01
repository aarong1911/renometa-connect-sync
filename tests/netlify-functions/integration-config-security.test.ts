// tests/netlify-functions/integration-config-security.test.ts
//
// Run:  node --test tests/netlify-functions/integration-config-security.test.ts
//
// Security regression tests for per-org integration credentials. Drives the
// REAL integration-config-{status,save,disconnect}.ts and
// smtp-{config-save,disconnect}.ts handlers (bundled with esbuild) with
// `@supabase/supabase-js` aliased to the in-memory fake client. Nothing
// reaches the network. All "secrets" below are obviously fake test strings.
//
// Also includes a static guard: browser code under src/ must never select
// organizations with "*" or read/write integration_settings directly.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.ENCRYPTION_KEY = "test-only-encryption-key";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "integration-config-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const noisy = ["log", "warn", "error", "info"] as const;
const saved = noisy.map((k) => (console as any)[k]);
const logged: string[] = [];
noisy.forEach((k) => ((console as any)[k] = (...args: unknown[]) => logged.push(JSON.stringify(args))));
after(() => noisy.forEach((k, i) => ((console as any)[k] = saved[i])));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: {
    status: path.join(repoRoot, "netlify/functions/integration-config-status.ts"),
    save: path.join(repoRoot, "netlify/functions/integration-config-save.ts"),
    disconnect: path.join(repoRoot, "netlify/functions/integration-config-disconnect.ts"),
    "smtp-save": path.join(repoRoot, "netlify/functions/smtp-config-save.ts"),
    "smtp-disconnect": path.join(repoRoot, "netlify/functions/smtp-disconnect.ts"),
  },
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  bundle: true, platform: "node", format: "esm", logLevel: "error",
  plugins: [{
    name: "fake-supabase",
    setup(build: any) {
      build.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "supabase", namespace: "fake" }));
      build.onLoad({ filter: /^supabase$/, namespace: "fake" }, () => ({
        loader: "js",
        contents: `
          export function createClient() {
            return {
              auth: {
                getUser: async (token) => {
                  const id = globalThis.__TEST_TOKENS[token];
                  return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "invalid" } };
                },
              },
              from: (t) => globalThis.__TEST_DB.from(t),
            };
          }`,
      }));
    },
  }],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const load = async (name: string): Promise<any> => (await import(pathToFileURL(path.join(outDir, `${name}.mjs`)).href)).handler;
const STATUS = await load("status");
const SAVE = await load("save");
const DISCONNECT = await load("disconnect");
const SMTP_SAVE = await load("smtp-save");
const SMTP_DISCONNECT = await load("smtp-disconnect");
const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href);
const { buildProviderConfig, redactIntegrationSettings }: any = await import(pathToFileURL(path.join(repoRoot, "netlify/functions/lib/integration-config.ts")).href);
const { INTEGRATION_OWNER_ONLY_ERROR, INTEGRATION_NO_ROLE_ERROR }: any = await import(pathToFileURL(path.join(repoRoot, "netlify/functions/lib/resolve-org.ts")).href);

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ORG_C = "33333333-3333-4333-8333-333333333333";
const USERS = {
  ownerA: "a0000000-0000-4000-8000-000000000001",
  adminA: "a0000000-0000-4000-8000-000000000002",
  salesA: "a0000000-0000-4000-8000-000000000003",
  fieldA: "a0000000-0000-4000-8000-000000000004",
  viewerA: "a0000000-0000-4000-8000-000000000005",
  ownerB: "b0000000-0000-4000-8000-000000000001",
  // Org C: legacy accounts with no org_memberships row at all.
  legacyOwnerC: "c0000000-0000-4000-8000-000000000001",
  noRoleC: "c0000000-0000-4000-8000-000000000002",
};
const TOKENS: Record<string, string> = Object.fromEntries(Object.entries(USERS).map(([k, id]) => [`tok-${k}`, id]));
(globalThis as any).__TEST_TOKENS = TOKENS;

// Obviously-fake values. Every one must never appear in any response.
const SECRET_A_TWILIO = "TESTONLYtwilioTokenOrgA0000000000";
const SECRET_B_TWILIO = "TESTONLYtwilioTokenOrgB0000000000";
const SECRET_A_STRIPE = "sk_test_TESTONLYstripeOrgA000000000";
const SECRET_A_GMAIL = "TESTONLYlegacyGmailAppPw";
const SID_A = "AC" + "a".repeat(32);
const SID_B = "AC" + "b".repeat(32);
const ALL_SECRETS = [SECRET_A_TWILIO, SECRET_B_TWILIO, SECRET_A_STRIPE, SECRET_A_GMAIL];
const NON_OWNERS = ["tok-adminA", "tok-salesA", "tok-fieldA", "tok-viewerA"];

function settingsA() {
  return {
    twilio: { accountSid: SID_A, authToken: SECRET_A_TWILIO, phoneNumber: "+15550000001" },
    stripe: { secretKey: SECRET_A_STRIPE },
    gmail: { email: "owner-a@example.com", appPassword: SECRET_A_GMAIL },
  };
}

let db: any;
function setDb() {
  const member = (id: string, org: string, role: string) => ({ member_id: id, org_id: org, role });
  db = createFakeSupabaseClient({
    profiles: [
      ...Object.entries(USERS).filter(([k]) => !k.endsWith("C")).map(([k, id]) => ({ id, organization_id: k.endsWith("B") ? ORG_B : ORG_A, role: "member" })),
      { id: USERS.legacyOwnerC, organization_id: ORG_C, role: "owner" },
      { id: USERS.noRoleC, organization_id: ORG_C, role: null },
    ],
    org_memberships: [
      member(USERS.ownerA, ORG_A, "owner"), member(USERS.adminA, ORG_A, "admin"), member(USERS.salesA, ORG_A, "sales"),
      member(USERS.fieldA, ORG_A, "field_worker"), member(USERS.viewerA, ORG_A, "viewer"), member(USERS.ownerB, ORG_B, "owner"),
    ],
    organizations: [
      { id: ORG_A, name: "Org A", integration_settings: settingsA() },
      { id: ORG_B, name: "Org B", integration_settings: { twilio: { accountSid: SID_B, authToken: SECRET_B_TWILIO, phoneNumber: "+15550000002" } } },
      { id: ORG_C, name: "Org C", integration_settings: {} },
    ],
    organization_integration_secrets: [],
  });
  (globalThis as any).__TEST_DB = db;
}
const orgSettings = (id: string) => db.__dumpTable("organizations").find((o: any) => o.id === id).integration_settings;

function call(handler: any, method: string, who: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who) headers.authorization = `Bearer ${who}`;
  return handler({ httpMethod: method, headers, body: body === undefined ? null : JSON.stringify(body) });
}

function assertNoSecrets(res: any) {
  const text = String(res.body ?? "");
  for (const s of ALL_SECRETS) assert.ok(!text.includes(s), `response leaked a stored secret (status ${res.statusCode})`);
  assert.ok(!/"(authToken|appPassword|secretKey|apiKey)"/.test(text), "response carries a secret field name");
}

// ── integration-config-status ─────────────────────────────────────────────

test("status: anonymous, invalid-token and every non-owner member (admin included) are refused", async () => {
  setDb();
  assert.equal((await call(STATUS, "GET", null)).statusCode, 401);
  assert.equal((await call(STATUS, "GET", "tok-forged")).statusCode, 401);
  for (const who of NON_OWNERS) {
    const res = await call(STATUS, "GET", who);
    assert.equal(res.statusCode, 403, who);
    assert.equal(JSON.parse(res.body).error, INTEGRATION_OWNER_ONLY_ERROR);
    assertNoSecrets(res);
  }
});

test("status: the owner gets a redacted view with no secret values", async () => {
  setDb();
  const res = await call(STATUS, "GET", "tok-ownerA");
  assert.equal(res.statusCode, 200);
  assertNoSecrets(res);
  const { integrations } = JSON.parse(res.body);
  assert.deepEqual(integrations.twilio, { configured: true, fields: { accountSid: SID_A, phoneNumber: "+15550000001" } });
  assert.deepEqual(integrations.stripe, { configured: true, fields: {} });
  assert.deepEqual(integrations.gmail, { configured: true, fields: { email: "owner-a@example.com" } });
});

test("legacy org: an owner with no org_memberships row (profiles.role = owner) can still manage integrations", async () => {
  setDb();
  assert.equal((await call(STATUS, "GET", "tok-legacyOwnerC")).statusCode, 200);
  const sid = "AC" + "c".repeat(32);
  const res = await call(SAVE, "POST", "tok-legacyOwnerC", { provider: "twilio", fields: { accountSid: sid, authToken: "TESTONLYlegacyOwnerToken0000", phoneNumber: "+15550000003" } });
  assert.equal(res.statusCode, 200);
  assert.equal(orgSettings(ORG_C).twilio.accountSid, sid);
  assert.equal((await call(DISCONNECT, "POST", "tok-legacyOwnerC", { provider: "twilio" })).statusCode, 200);
  assert.equal(orgSettings(ORG_C).twilio, undefined);
});

test("legacy org: an account with no membership row and no profile role is refused with the support message", async () => {
  setDb();
  const attempts: [any, string, unknown][] = [
    [STATUS, "GET", undefined],
    [SAVE, "POST", { provider: "jotform", fields: { apiKey: "TESTONLYjotform" } }],
    [DISCONNECT, "POST", { provider: "twilio" }],
  ];
  for (const [handler, method, body] of attempts) {
    const res = await call(handler, method, "tok-noRoleC", body);
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, INTEGRATION_NO_ROLE_ERROR);
  }
  assert.deepEqual(orgSettings(ORG_C), {});
});

test("status: each org only ever sees its own integrations", async () => {
  setDb();
  const a = JSON.parse((await call(STATUS, "GET", "tok-ownerA")).body).integrations;
  const b = JSON.parse((await call(STATUS, "GET", "tok-ownerB")).body).integrations;
  assert.equal(a.twilio.fields.accountSid, SID_A);
  assert.equal(b.twilio.fields.accountSid, SID_B);
  assert.equal(b.stripe, undefined);
});

// ── integration-config-save ───────────────────────────────────────────────

test("save: anonymous and non-owner members cannot write", async () => {
  setDb();
  const body = { provider: "twilio", fields: { accountSid: SID_A, authToken: "TESTONLYattackerToken000000", phoneNumber: "+15559999999" } };
  assert.equal((await call(SAVE, "POST", null, body)).statusCode, 401);
  for (const who of NON_OWNERS) assert.equal((await call(SAVE, "POST", who, body)).statusCode, 403, who);
  assert.deepEqual(orgSettings(ORG_A), settingsA());
});

test("save: blank secret keeps the stored secret; non-secret fields update; response is redacted", async () => {
  setDb();
  const res = await call(SAVE, "POST", "tok-ownerA", { provider: "twilio", fields: { accountSid: SID_A, authToken: "", phoneNumber: "+15550000099" } });
  assert.equal(res.statusCode, 200);
  assertNoSecrets(res);
  assert.deepEqual(JSON.parse(res.body).status, { configured: true, fields: { accountSid: SID_A, phoneNumber: "+15550000099" } });
  const after = orgSettings(ORG_A);
  assert.equal(after.twilio.authToken, SECRET_A_TWILIO);
  assert.equal(after.twilio.phoneNumber, "+15550000099");
  assert.deepEqual(after.stripe, settingsA().stripe);
  assert.deepEqual(after.gmail, settingsA().gmail);
});

test("save: a new secret replaces the stored one", async () => {
  setDb();
  const fresh = "TESTONLYrotatedToken00000000000";
  const res = await call(SAVE, "POST", "tok-ownerA", { provider: "twilio", fields: { accountSid: SID_A, authToken: fresh, phoneNumber: "+15550000001" } });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes(fresh));
  assert.equal(orgSettings(ORG_A).twilio.authToken, fresh);
});

test("save: a client-supplied org id is ignored — only the caller's org changes", async () => {
  setDb();
  const res = await call(SAVE, "POST", "tok-ownerA", {
    provider: "twilio", orgId: ORG_B, org_id: ORG_B,
    fields: { accountSid: SID_A, authToken: "", phoneNumber: "+15550000077" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(orgSettings(ORG_A).twilio.phoneNumber, "+15550000077");
  assert.equal(orgSettings(ORG_B).twilio.phoneNumber, "+15550000002");
  assert.equal(orgSettings(ORG_B).twilio.authToken, SECRET_B_TWILIO);
});

test("save: validation failures and unsupported providers leave storage untouched", async () => {
  setDb();
  const cases: [unknown, RegExp][] = [
    [{ provider: "twilio", fields: { accountSid: "ACnope", authToken: "", phoneNumber: "+15550000001" } }, /Account SID/],
    [{ provider: "twilio", fields: { accountSid: SID_A, authToken: "", phoneNumber: "5550000001" } }, /E\.164/],
    [{ provider: "twilio", fields: { accountSid: SID_A, authToken: 12345, phoneNumber: "+15550000001" } }, /Auth Token/],
    [{ provider: "stripe", fields: { secretKey: "pk_live_notasecretkey000000" } }, /Secret Key/],
    [{ provider: "gmail", fields: { email: "x@example.com", appPassword: "TESTONLYabcdefghijkl" } }, /Unsupported/],
    [{ provider: "__proto__", fields: {} }, /Unsupported/],
    [{ provider: "twilio", fields: "not-an-object" }, /Invalid fields/],
  ];
  for (const [body, msg] of cases) {
    const res = await call(SAVE, "POST", "tok-ownerA", body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.match(JSON.parse(res.body).error, msg);
  }
  assert.deepEqual(orgSettings(ORG_A), settingsA());
});

test("save: a first-time config requires the secret (blank is not 'keep existing' when nothing is stored)", async () => {
  setDb();
  const res = await call(SAVE, "POST", "tok-ownerB", { provider: "jotform", fields: { apiKey: "" } });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /API Key is required/);
  assert.equal(orgSettings(ORG_B).jotform, undefined);
});

// ── integration-config-disconnect ─────────────────────────────────────────

test("disconnect: non-owner members are refused and nothing is removed", async () => {
  setDb();
  assert.equal((await call(DISCONNECT, "POST", null, { provider: "twilio" })).statusCode, 401);
  for (const who of NON_OWNERS) assert.equal((await call(DISCONNECT, "POST", who, { provider: "twilio" })).statusCode, 403, who);
  assert.deepEqual(orgSettings(ORG_A), settingsA());
});

test("disconnect: removes only that provider, only in the caller's org", async () => {
  setDb();
  const res = await call(DISCONNECT, "POST", "tok-ownerA", { provider: "twilio", orgId: ORG_B });
  assert.equal(res.statusCode, 200);
  const a = orgSettings(ORG_A);
  assert.equal(a.twilio, undefined);
  assert.deepEqual(a.stripe, settingsA().stripe);
  assert.deepEqual(a.gmail, settingsA().gmail);
  assert.equal(orgSettings(ORG_B).twilio.authToken, SECRET_B_TWILIO);
  assert.equal((await call(DISCONNECT, "POST", "tok-ownerA", { provider: "gmail" })).statusCode, 400);
});

// ── SMTP endpoint hardening ───────────────────────────────────────────────

test("smtp-config-save / smtp-disconnect: every non-owner member (admin included) is refused", async () => {
  setDb();
  for (const who of NON_OWNERS) {
    assert.equal((await call(SMTP_SAVE, "POST", who, { email: "attacker@example.com", appPassword: "TESTONLYattackerAppPw" })).statusCode, 403);
    assert.equal((await call(SMTP_DISCONNECT, "POST", who)).statusCode, 403);
  }
  assert.equal((await call(SMTP_SAVE, "POST", null, { email: "a@example.com" })).statusCode, 401);
  assert.deepEqual(orgSettings(ORG_A).gmail, settingsA().gmail);
  assert.equal(db.__dumpTable("organization_integration_secrets").length, 0);
});

test("smtp-config-save: owner saves (legacy plaintext cleared, password encrypted, never echoed)", async () => {
  setDb();
  const pw = "TESTONLYnewAppPassw0rd";
  const res = await call(SMTP_SAVE, "POST", "tok-ownerA", { email: "owner-a@example.com", appPassword: pw });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes(pw));
  assert.deepEqual(orgSettings(ORG_A).gmail, { email: "owner-a@example.com", configured: true });
  const secrets = db.__dumpTable("organization_integration_secrets");
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].organization_id, ORG_A);
  assert.ok(!String(secrets[0].encrypted_value).includes(pw));
  assert.equal(orgSettings(ORG_A).twilio.authToken, SECRET_A_TWILIO);
});

test("smtp-disconnect: the owner removes only Gmail SMTP for their own org", async () => {
  setDb();
  const res = await call(SMTP_DISCONNECT, "POST", "tok-ownerA");
  assert.equal(res.statusCode, 200);
  assert.equal(orgSettings(ORG_A).gmail, undefined);
  assert.equal(orgSettings(ORG_A).twilio.authToken, SECRET_A_TWILIO);
  assert.ok(orgSettings(ORG_B).twilio);
});

// ── Pure helpers ──────────────────────────────────────────────────────────

test("redactIntegrationSettings: unknown keys expose only a configured flag", () => {
  const out = redactIntegrationSettings({
    slack: { botToken: "TESTONLYslack" }, twilio: { authToken: "TESTONLYx" }, empty: {}, scalar: "x", "bad key!": { a: 1 },
  });
  assert.deepEqual(out.slack, { configured: true, fields: {} });
  assert.deepEqual(out.twilio, { configured: true, fields: {} });
  assert.deepEqual(out.empty, { configured: false, fields: {} });
  assert.deepEqual(out.scalar, { configured: false, fields: {} });
  assert.equal(out["bad key!"], undefined);
  assert.deepEqual(redactIntegrationSettings(null), {});
});

test("buildProviderConfig: preserves server-written extra keys, ignores unknown submitted keys", () => {
  const r = buildProviderConfig("twilio",
    { accountSid: SID_A, authToken: "TESTONLYstored00000000", phoneNumber: "+15550000001", messagingServiceSid: "MG1" },
    { accountSid: SID_A, authToken: "", phoneNumber: "+15550000001", injected: "nope" });
  assert.equal(r.ok, true);
  assert.equal(r.next.messagingServiceSid, "MG1");
  assert.equal(r.next.authToken, "TESTONLYstored00000000");
  assert.equal(r.next.injected, undefined);
});

// ── Static guard on browser code ──────────────────────────────────────────

// src/lib/agentic/ holds server-only modules that are imported by Netlify
// functions (never by a route/component) and receive a service-role client.
const SERVER_ONLY_UNDER_SRC = [path.join("src", "lib", "agentic") + path.sep];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("browser code never selects organizations.*, ein, or touches integration_settings", () => {
  const offenders: string[] = [];
  for (const file of walk(path.join(repoRoot, "src"))) {
    const rel = path.relative(repoRoot, file);
    if (SERVER_ONLY_UNDER_SRC.some((p) => rel.startsWith(p))) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    // select("*") or a bare select() — both return every column.
    if (/from\(\s*["'`]organizations["'`]\s*\)\s*\.select\(\s*(?:["'`]\s*\*\s*["'`])?\s*\)/.test(code)) {
      offenders.push(`${rel}: organizations select("*")`);
    }
    // an embedded organizations(*) in another table's select
    if (/organizations\s*\(\s*\*\s*\)/.test(code)) offenders.push(`${rel}: organizations(*) embed`);
    // explicit organizations column lists must not name ein (the migration revokes it)
    for (const m of code.matchAll(/from\(\s*["'`]organizations["'`]\s*\)\s*\.select\(\s*["'`]([^"'`]*)["'`]/g)) {
      if (/\bein\b/.test(m[1])) offenders.push(`${rel}: organizations select of ein`);
    }
    if (/integration_settings/.test(code)) offenders.push(`${rel}: integration_settings`);
  }
  assert.deepEqual(offenders, []);
});

test("no handler logged a secret value", () => {
  const text = logged.join("\n");
  for (const s of ALL_SECRETS) assert.ok(!text.includes(s));
});
