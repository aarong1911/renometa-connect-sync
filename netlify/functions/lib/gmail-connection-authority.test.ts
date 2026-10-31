// netlify/functions/lib/gmail-connection-authority.test.ts
//
// Run:  node --test netlify/functions/lib/gmail-connection-authority.test.ts
//
// Who may change an org's Gmail connection, and that the one-click Google
// flow is otherwise unchanged. The REAL handlers (gmail-oauth-start,
// gmail-oauth-callback, gmail-disconnect, gmail-connection-status,
// smtp-config-save, smtp-disconnect) are bundled with esbuild against the
// in-memory fake Supabase client; every Google endpoint is a stub. No
// network, no real Gmail, no email sent.

import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "gmail-connection-authority-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
process.env.SUPABASE_URL = "http://fake.local";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.ENCRYPTION_KEY = "test-only-encryption-key";
process.env.GOOGLE_OAUTH_CLIENT_ID = "client-123.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-only-client-secret";
process.env.GOOGLE_GMAIL_SCOPES = SCOPES;
process.env.GOOGLE_REDIRECT_BASE_URL = "https://connect.example.test";
process.env.APP_LOCAL_URL = "https://connect.example.test";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SALES_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const ADMIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
// Legacy-shaped orgs (no owner membership row).
const ORG_LEGACY = "33333333-3333-4333-8333-333333333333";
const LEGACY_PROFILE_OWNER = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1"; // profiles.role='owner', no membership row
const ORG_ORPHAN = "44444444-4444-4444-8444-444444444444";
const ORPHAN_CREATOR = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1"; // organizations.created_by only; no role anywhere
const ORPHAN_MEMBER = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2"; // profiles.role='member', no membership row
const DEMOTED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4"; // profiles.role='owner' but membership says admin

// Every handler builds its client at module load, so the fake delegates to
// whichever in-memory db the current test installed.
const fakeSupabase = `
  export function createClient() {
    return {
      auth: { getUser: async (token) => { const id = globalThis.__fakeUsers?.[token]; return { data: { user: id ? { id } : null }, error: null }; } },
      from: (table) => globalThis.__fakeDb.from(table),
      rpc: (...args) => globalThis.__fakeDb.rpc(...args),
    };
  }`;
const stubs = {
  name: "stubs",
  setup(build: any) {
    build.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "fake-supabase", namespace: "stub" }));
    build.onLoad({ filter: /^fake-supabase$/, namespace: "stub" }, () => ({ contents: fakeSupabase, loader: "js" }));
  },
};

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export { handler as startHandler } from "./netlify/functions/gmail-oauth-start";
      export { handler as callbackHandler, missingGmailScopes } from "./netlify/functions/gmail-oauth-callback";
      export { handler as disconnectHandler } from "./netlify/functions/gmail-disconnect";
      export { handler as statusHandler } from "./netlify/functions/gmail-connection-status";
      export { handler as smtpSaveHandler } from "./netlify/functions/smtp-config-save";
      export { handler as smtpDisconnectHandler } from "./netlify/functions/smtp-disconnect";
      export { encryptToBytea, decryptBytea } from "./netlify/functions/lib/gmail-token-crypto";
    `,
    resolveDir: repoRoot, loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error",
  plugins: [stubs],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);
const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(here, "test-support/fake-supabase-client.mjs")).href);

(globalThis as any).__fakeUsers = {
  "t-owner-a": OWNER_A, "t-sales-a": SALES_A, "t-admin-a": ADMIN_A, "t-owner-b": OWNER_B,
  "t-legacy-owner": LEGACY_PROFILE_OWNER, "t-orphan-creator": ORPHAN_CREATOR, "t-orphan-member": ORPHAN_MEMBER, "t-demoted": DEMOTED,
};

// Google stub: token exchange + userinfo + revoke. Anything else fails the test.
const realFetch = globalThis.fetch;
let googleCalls: string[] = [];
let tokenResponse: Record<string, unknown> = {};
let userinfoBody: Record<string, unknown> = {};
let gmailProfileEmail: string | null = null;
globalThis.fetch = (async (input: any) => {
  const url = String(input);
  googleCalls.push(url.split("?")[0]);
  if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify(tokenResponse), { status: 200 });
  if (url === "https://www.googleapis.com/oauth2/v2/userinfo") return new Response(JSON.stringify(userinfoBody), { status: 200 });
  if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
    return gmailProfileEmail
      ? new Response(JSON.stringify({ emailAddress: gmailProfileEmail }), { status: 200 })
      : new Response("{}", { status: 403 });
  }
  if (url.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("{}", { status: 200 });
  throw new Error(`unexpected network call in test: ${url}`);
}) as typeof fetch;
const quiet = { log: console.log, warn: console.warn, error: console.error };
console.log = () => {}; console.warn = () => {}; console.error = () => {};
after(() => { globalThis.fetch = realFetch; Object.assign(console, quiet); });

const gmailRow = (orgId: string, extra: Record<string, unknown> = {}) => ({
  id: `int-${orgId.slice(0, 4)}`,
  org_id: orgId,
  provider: "gmail",
  status: "connected",
  provider_account_email: `mailbox@${orgId.slice(0, 4)}.test`,
  access_token_encrypted: S.encryptToBytea(`access-${orgId}`),
  refresh_token_encrypted: S.encryptToBytea(`refresh-${orgId}`),
  token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  last_sync_at: null, last_sync_status: "ok", sync_error: null, config: {},
  ...extra,
});

let db: any;
beforeEach(() => {
  googleCalls = [];
  tokenResponse = { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: SCOPES };
  userinfoBody = { email: "owner@contractor.test" };
  gmailProfileEmail = null;
  db = createFakeSupabaseClient({
    profiles: [
      { id: OWNER_A, organization_id: ORG_A, role: "owner" },
      { id: SALES_A, organization_id: ORG_A, role: "member" },
      { id: ADMIN_A, organization_id: ORG_A, role: "member" },
      { id: OWNER_B, organization_id: ORG_B, role: "owner" },
      { id: LEGACY_PROFILE_OWNER, organization_id: ORG_LEGACY, role: "owner" },
      { id: ORPHAN_CREATOR, organization_id: ORG_ORPHAN, role: null },
      { id: ORPHAN_MEMBER, organization_id: ORG_ORPHAN, role: "member" },
      { id: DEMOTED, organization_id: ORG_A, role: "owner" },
    ],
    org_memberships: [
      { member_id: OWNER_A, org_id: ORG_A, role: "owner" },
      { member_id: SALES_A, org_id: ORG_A, role: "sales" },
      { member_id: ADMIN_A, org_id: ORG_A, role: "admin" },
      { member_id: OWNER_B, org_id: ORG_B, role: "owner" },
      { member_id: DEMOTED, org_id: ORG_A, role: "admin" },
    ],
    integrations: [gmailRow(ORG_A), gmailRow(ORG_B), gmailRow(ORG_LEGACY), gmailRow(ORG_ORPHAN)],
    oauth_states: [],
    integration_sync_logs: [],
    organizations: [
      { id: ORG_A, integration_settings: { gmail: { email: "smtp@a.test", configured: true } } },
      { id: ORG_B, integration_settings: { gmail: { email: "smtp@b.test", configured: true } } },
      { id: ORG_LEGACY, integration_settings: {} },
      { id: ORG_ORPHAN, created_by: ORPHAN_CREATOR, integration_settings: {} },
    ],
    organization_integration_secrets: [
      { id: "sec-a", organization_id: ORG_A, provider: "gmail", secret_type: "smtp_app_password", encrypted_value: "x" },
    ],
  });
  (globalThis as any).__fakeDb = db;
});

const req = (method: string, token?: string, body?: unknown) => ({
  httpMethod: method,
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: body === undefined ? null : JSON.stringify(body),
  queryStringParameters: {},
});
const callback = (params: Record<string, string>) => S.callbackHandler({ httpMethod: "GET", headers: {}, body: null, queryStringParameters: params });
const redirectParams = (res: any) => new URL(res.headers.Location).searchParams;
const row = (orgId: string) => db.__dumpTable("integrations").find((r: any) => r.org_id === orgId);

// ── who may change the connection ────────────────────────────────────────

test("connect, disconnect and SMTP changes require sign-in (401)", async () => {
  for (const h of [S.startHandler, S.disconnectHandler, S.smtpSaveHandler, S.smtpDisconnectHandler]) {
    assert.equal((await h(req("POST"))).statusCode, 401);
    assert.equal((await h(req("POST", "not-a-session"))).statusCode, 401);
  }
});

test("non-owners (sales, admin) cannot connect, disconnect, or change SMTP for the org (403, nothing written)", async () => {
  const before = JSON.stringify([db.__dumpTable("integrations"), db.__dumpTable("organizations"), db.__dumpTable("organization_integration_secrets")]);
  for (const token of ["t-sales-a", "t-admin-a"]) {
    for (const [h, body] of [
      [S.startHandler, {}],
      [S.disconnectHandler, {}],
      [S.smtpSaveHandler, { email: "attacker@evil.test", appPassword: "abcdabcdabcdabcd" }],
      [S.smtpDisconnectHandler, undefined],
    ] as const) {
      const res = await h(req("POST", token, body));
      assert.equal(res.statusCode, 403, token);
      assert.match(JSON.parse(res.body).error, /organization owner/);
    }
  }
  assert.equal(db.__dumpTable("oauth_states").length, 0, "no OAuth state minted for a non-owner");
  assert.equal(JSON.stringify([db.__dumpTable("integrations"), db.__dumpTable("organizations"), db.__dumpTable("organization_integration_secrets")]), before);
  assert.deepEqual(googleCalls, [], "no token revoked on Google's side");
});

test("any org member can still READ connection status — tokens are never in the response", async () => {
  const res = await S.statusHandler(req("GET", "t-sales-a"));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.connected, true);
  assert.equal(body.accountEmail, `mailbox@${ORG_A.slice(0, 4)}.test`);
  assert.doesNotMatch(res.body, /access-|refresh-|\\\\x|_encrypted/);
});

// ── the Google request is unchanged ──────────────────────────────────────

test("owner connect builds the same Google consent URL (client, redirect URI, scopes, offline + consent)", async () => {
  const res = await S.startHandler(req("POST", "t-owner-a", {}));
  assert.equal(res.statusCode, 200);
  const url = new URL(JSON.parse(res.body).url);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const p = url.searchParams;
  assert.equal(p.get("client_id"), process.env.GOOGLE_OAUTH_CLIENT_ID);
  assert.equal(p.get("redirect_uri"), "https://connect.example.test/.netlify/functions/gmail-oauth-callback");
  assert.equal(p.get("scope"), SCOPES);
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("access_type"), "offline");
  assert.equal(p.get("prompt"), "consent");
  assert.equal(p.get("include_granted_scopes"), "true");
  const [state] = db.__dumpTable("oauth_states");
  assert.equal(p.get("state"), state.state);
  assert.equal(state.org_id, ORG_A);
  assert.equal(state.user_id, OWNER_A);
});

// ── callback ─────────────────────────────────────────────────────────────

async function mintState(token = "t-owner-a") {
  const res = await S.startHandler(req("POST", token, {}));
  return new URL(JSON.parse(res.body).url).searchParams.get("state")!;
}

test("callback: owner reconnect keeps the stored refresh token when Google doesn't return a new one, and stays encrypted", async () => {
  const originalRefresh = row(ORG_A).refresh_token_encrypted;
  tokenResponse = { access_token: "new-access", expires_in: 3600, scope: SCOPES };
  const res = await callback({ code: "c", state: await mintState() });
  assert.equal(res.statusCode, 302);
  assert.equal(redirectParams(res).get("gmail"), "success");
  const r = row(ORG_A);
  assert.equal(r.status, "connected");
  assert.equal(r.refresh_token_encrypted, originalRefresh, "existing refresh token untouched");
  assert.match(r.access_token_encrypted, /^\\x[0-9a-f]+$/, "same bytea hex storage format");
  assert.equal(S.decryptBytea(r.access_token_encrypted), "new-access");
  assert.equal(db.__dumpTable("oauth_states").length, 0, "state is single-use");
});

test("callback: a user who stopped being owner after starting cannot complete the connection", async () => {
  const state = await mintState();
  await db.from("org_memberships").update({ role: "sales" }).eq("member_id", OWNER_A);
  const before = JSON.stringify(row(ORG_A));
  const res = await callback({ code: "c", state });
  assert.equal(redirectParams(res).get("gmail"), "error");
  assert.match(redirectParams(res).get("gmail_message")!, /organization owner/);
  assert.equal(JSON.stringify(row(ORG_A)), before);
  assert.ok(!googleCalls.includes("https://oauth2.googleapis.com/token"), "code never exchanged");
});

test("callback: unticking a Gmail permission still saves the connection but redirects with a clear warning", async () => {
  tokenResponse = { access_token: "a", refresh_token: "r", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly" };
  const res = await callback({ code: "c", state: await mintState() });
  const p = redirectParams(res);
  assert.equal(p.get("gmail"), "partial");
  assert.match(p.get("gmail_message")!, /send email.*estimates and change orders/);
  assert.equal(row(ORG_A).status, "connected");
});

test("callback: a cancelled consent never writes anything", async () => {
  const before = JSON.stringify(db.__dumpTable("integrations"));
  const res = await callback({ error: "access_denied" });
  assert.equal(redirectParams(res).get("gmail"), "error");
  assert.equal(redirectParams(res).get("gmail_message"), "access_denied");
  assert.equal(JSON.stringify(db.__dumpTable("integrations")), before);
});

test("missingGmailScopes compares against the requested Gmail scopes only", () => {
  assert.deepEqual(S.missingGmailScopes(SCOPES, SCOPES), []);
  assert.deepEqual(S.missingGmailScopes(`openid email ${SCOPES}`, `${SCOPES}`), [], "identity scopes are not Gmail scopes");
  assert.deepEqual(S.missingGmailScopes(SCOPES, "https://www.googleapis.com/auth/gmail.send"), ["https://www.googleapis.com/auth/gmail.readonly"]);
  assert.deepEqual(S.missingGmailScopes(SCOPES, undefined), [], "no scope field: nothing to compare");
});

// ── disconnect isolation ─────────────────────────────────────────────────

test("owner disconnect deactivates only their own org's connection; the other org stays connected", async () => {
  const orgBBefore = JSON.stringify(row(ORG_B));
  const res = await S.disconnectHandler(req("POST", "t-owner-a", {}));
  assert.equal(res.statusCode, 200);
  const a = row(ORG_A);
  assert.equal(a.status, "disconnected");
  assert.equal(a.access_token_encrypted, null);
  assert.equal(a.refresh_token_encrypted, null);
  assert.equal(a.provider_account_email, `mailbox@${ORG_A.slice(0, 4)}.test`, "history kept");
  assert.equal(JSON.stringify(row(ORG_B)), orgBBefore);
  assert.deepEqual(googleCalls, ["https://oauth2.googleapis.com/revoke"]);
});

test("Gmail disconnect leaves legacy SMTP sending untouched", async () => {
  await S.disconnectHandler(req("POST", "t-owner-a", {}));
  assert.equal(db.__dumpTable("organization_integration_secrets").length, 1);
  assert.deepEqual(db.__dumpTable("organizations").find((o: any) => o.id === ORG_A).integration_settings.gmail, { email: "smtp@a.test", configured: true });
});

// ── legacy / incomplete ownership data ───────────────────────────────────

test("legacy owner with NO membership row but profiles.role='owner' keeps Gmail management (pre-existing fallback)", async () => {
  const start = await S.startHandler(req("POST", "t-legacy-owner", {}));
  assert.equal(start.statusCode, 200, start.body);
  assert.equal(db.__dumpTable("oauth_states")[0].org_id, ORG_LEGACY);
  const res = await callback({ code: "c", state: new URL(JSON.parse(start.body).url).searchParams.get("state")! });
  assert.equal(redirectParams(res).get("gmail"), "success");
  assert.equal((await S.disconnectHandler(req("POST", "t-legacy-owner", {}))).statusCode, 200);
  assert.equal(row(ORG_LEGACY).status, "disconnected");
});

test("a membership row always wins over a stale profiles.role='owner' (demoted to admin -> refused)", async () => {
  const res = await S.startHandler(req("POST", "t-demoted", {}));
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /Only your organization owner/);
});

test("no role at all: organizations.created_by alone is NOT accepted; the message points to support, nothing is written", async () => {
  for (const token of ["t-orphan-creator", "t-orphan-member"]) {
    for (const h of [S.startHandler, S.disconnectHandler, S.smtpSaveHandler, S.smtpDisconnectHandler]) {
      const res = await h(req("POST", token, {}));
      assert.equal(res.statusCode, 403, token);
    }
  }
  const creator = JSON.parse((await S.startHandler(req("POST", "t-orphan-creator", {}))).body);
  assert.match(creator.error, /isn't set up with a role .* Contact RenoMeta support/);
  const member = JSON.parse((await S.startHandler(req("POST", "t-orphan-member", {}))).body);
  assert.match(member.error, /Only your organization owner/, "a real non-owner role keeps the ask-the-owner message");
  assert.equal(db.__dumpTable("oauth_states").length, 0);
  assert.equal(row(ORG_ORPHAN).status, "connected");
});

// ── connected account identity ───────────────────────────────────────────

test("callback: when userinfo returns no email, the address comes from Gmail's own profile", async () => {
  userinfoBody = {}; // no identity scope granted
  gmailProfileEmail = "mailbox@contractor.test";
  const res = await callback({ code: "c", state: await mintState() });
  assert.equal(redirectParams(res).get("gmail"), "success");
  assert.equal(row(ORG_A).provider_account_email, "mailbox@contractor.test");
});

test("callback: when neither source has an address the connection still saves (sending uses the token's own mailbox)", async () => {
  userinfoBody = {};
  gmailProfileEmail = null;
  const res = await callback({ code: "c", state: await mintState() });
  assert.equal(redirectParams(res).get("gmail"), "success");
  assert.equal(row(ORG_A).status, "connected");
  assert.equal(row(ORG_A).provider_account_email, null);
});
