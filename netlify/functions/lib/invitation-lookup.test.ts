// netlify/functions/lib/invitation-lookup.test.ts
//
// Run:  node --test netlify/functions/lib/invitation-lookup.test.ts
//
// S1 minimal invitation-security release. Covers: the server-side token lookup (minimal fields, no tax values, no ids/token, malformed
// input never reaches the database), its public handler, accept-invite end to end (blank SSN/EIN keeps the administrator's stored value,
// organization and role always come from the invitation, used/expired/unknown tokens create nothing), and static boundary checks (the
// invitee page no longer queries the invitations table, and the password-recovery redirect still runs before any token handling).
// Real code against the in-memory fake Supabase client; no network, no live database.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.SUPABASE_URL = "http://fake.local";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("real network access is forbidden in this test file"); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "invitation-lookup-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

const stubs = {
  name: "stubs",
  setup(build: any) {
    build.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "fake-supabase", namespace: "stub" }));
    build.onLoad({ filter: /^fake-supabase$/, namespace: "stub" }, () => ({
      contents: `export function createClient() { return new Proxy({}, { get: (_t, p) => { const a = globalThis.__admin; const v = a[p]; return typeof v === 'function' ? v.bind(a) : v; } }); }`, loader: "js" }));
  },
};
const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export * from "./netlify/functions/lib/invitation-lookup";
      export { handler as lookupHandler } from "./netlify/functions/invitation-lookup";
      export { handler as acceptHandler } from "./netlify/functions/accept-invite";
    `,
    resolveDir: repoRoot, loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error", plugins: [stubs],
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
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const NEW_USER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const TOK_PENDING = "11111111-aaaa-4aaa-8aaa-000000000001";
const TOK_USED = "11111111-aaaa-4aaa-8aaa-000000000002";
const TOK_EXPIRED = "11111111-aaaa-4aaa-8aaa-000000000003";
const TOK_SUB = "11111111-bbbb-4bbb-8bbb-000000000001";
const INV_A = "d1111111-aaaa-4aaa-8aaa-000000000001";
const INV_SUB = "d2222222-bbbb-4bbb-8bbb-000000000001";
const FUTURE = "2099-01-01T00:00:00.000Z";

const inv = (over: Record<string, unknown>) => ({
  id: INV_A, organization_id: ORG_A, email: "pending-a@example.invalid", first_name: "Pat", last_name: "Ending", primary_phone: "555-0100", role: "sales",
  worker_type: "employee", status: "pending", token: TOK_PENDING, expires_at: FUTURE, invited_by: OWNER_A, project_id: null,
  address_line1: "1 Main St", address_line2: null, city: "Miami", state: "FL", postal_code: "33101", ssn: "123-45-6789", ein: null, company_name: null, ...over,
});
function makeAdmin(extra: { invitations?: any[] } = {}) {
  const db: any = createFakeSupabaseClient({
    invitations: extra.invitations ?? [
      inv({}),
      inv({ id: "d1111111-aaaa-4aaa-8aaa-000000000002", token: TOK_USED, status: "accepted", email: "used@example.invalid" }),
      inv({ id: "d1111111-aaaa-4aaa-8aaa-000000000003", token: TOK_EXPIRED, expires_at: "2000-01-01T00:00:00.000Z", email: "expired@example.invalid" }),
      inv({ id: INV_SUB, organization_id: ORG_B, token: TOK_SUB, email: "b@example.invalid", ssn: null, ein: "98-7654321", worker_type: "subcontractor", company_name: "Bee LLC", role: "admin" }),
    ],
    profiles: [],
    org_memberships: [],
  });
  const created: string[] = [];
  db.auth = {
    admin: {
      createUser: async ({ email }: { email: string }) => { created.push(email); return { data: { user: { id: NEW_USER } }, error: null }; },
      updateUserById: async () => ({ data: {}, error: null }),
    },
  };
  db.created = created;
  return db;
}
const rows = async (db: any, table: string) => ((await db.from(table).select("*")).data ?? []) as any[];

// ── token lookup ─────────────────────────────────────────────────────────

test("lookup — returns ONE invitation with minimal fields: no id / organization / token / tax numbers; tax only as last-four hints", async () => {
  const r = await S.lookupInvitation(makeAdmin(), TOK_PENDING);
  assert.equal(r.status, "ok");
  assert.deepEqual(Object.keys(r.invitation).sort(), [
    "address_line1", "address_line2", "city", "company_name", "ein_last4", "email", "first_name", "last_name", "postal_code", "primary_phone", "role", "ssn_last4", "state", "worker_type",
  ]);
  assert.equal(r.invitation.ssn_last4, "6789");
  assert.equal(r.invitation.ein_last4, null);
  const json = JSON.stringify(r);
  for (const forbidden of ["123-45-6789", "12345", TOK_PENDING, INV_A, ORG_A, OWNER_A, "invited_by", "organization_id"]) assert.ok(!json.includes(forbidden), `lookup leaked ${forbidden}`);
  const sub = await S.lookupInvitation(makeAdmin(), TOK_SUB);
  assert.equal(sub.invitation.ein_last4, "4321");
  assert.ok(!JSON.stringify(sub).includes("98-7654321"));
});

test("lookup — used / expired / unknown tokens are reported without any invitation data", async () => {
  const db = makeAdmin();
  assert.deepEqual(await S.lookupInvitation(db, TOK_USED), { status: "used" });
  assert.deepEqual(await S.lookupInvitation(db, TOK_EXPIRED), { status: "expired" });
  assert.deepEqual(await S.lookupInvitation(db, "ffffffff-ffff-4fff-8fff-ffffffffffff"), { status: "invalid" });
  const roster = makeAdmin({ invitations: [inv({ status: "roster_only" })] });
  assert.deepEqual(await S.lookupInvitation(roster, TOK_PENDING), { status: "used" });
  const failing = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom SENTINEL" } }) }) }) }) };
  assert.deepEqual(await S.lookupInvitation(failing, TOK_PENDING), { status: "invalid" });
});

test("lookup — a malformed token never reaches the database (no enumeration / injection surface)", async () => {
  const touched: string[] = [];
  const spy = { from: (t: string) => { touched.push(t); throw new Error("must not be called"); } };
  for (const bad of [undefined, null, 42, {}, [], "", "x", "' or 1=1 --", TOK_PENDING + "x", "*", "%", TOK_PENDING.toUpperCase().replace(/-/g, "")]) {
    assert.deepEqual(await S.lookupInvitation(spy, bad as any), { status: "invalid" }, String(bad));
  }
  assert.deepEqual(touched, []);
  assert.equal((await S.lookupInvitation(makeAdmin(), TOK_PENDING.toUpperCase())).status, "ok", "an upper-case UUID is still a valid UUID");
});

test("lookup handler — public POST { token } only; extra keys, wrong method and bad JSON are rejected; responses carry no secrets", async () => {
  (globalThis as any).__admin = makeAdmin();
  const call = (method: string, body?: unknown, raw?: string) => S.lookupHandler({ httpMethod: method, headers: {}, body: raw ?? (body === undefined ? null : JSON.stringify(body)) });
  const ok = await call("POST", { token: TOK_PENDING });
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).status, "ok");
  assert.ok(!ok.body.includes("123-45-6789") && !ok.body.includes(TOK_PENDING) && !ok.body.includes(ORG_A));
  assert.equal((await call("POST", { token: TOK_PENDING, organizationId: ORG_A })).statusCode, 400);
  assert.equal(JSON.parse((await call("POST", {})).body).status, "invalid", "a missing token is simply an invalid lookup");
  assert.equal((await call("GET")).statusCode, 405);
  assert.equal((await call("OPTIONS")).statusCode, 200);
  assert.equal((await call("POST", undefined, "{not json")).statusCode, 400);
  assert.equal((await call("POST", [TOK_PENDING])).statusCode, 400);
  assert.equal(ok.headers["Cache-Control"], "no-store");
});

// ── accept-invite ────────────────────────────────────────────────────────

test("accept-invite tax fields — blank keeps the administrator's stored value; a typed value wins; nothing is invented", () => {
  const stored = { ssn: "123-45-6789", ein: "98-7654321", company_name: "Bee LLC" };
  assert.deepEqual(S.resolveAcceptedTaxFields({}, stored), { ssn: "123-45-6789", ein: "98-7654321", company_name: "Bee LLC" });
  assert.deepEqual(S.resolveAcceptedTaxFields({ ssn: "   ", ein: "", companyName: undefined }, stored), { ssn: "123-45-6789", ein: "98-7654321", company_name: "Bee LLC" });
  assert.deepEqual(S.resolveAcceptedTaxFields({ ssn: " 000-11-2222 ", companyName: "New Co" }, stored), { ssn: "000-11-2222", ein: "98-7654321", company_name: "New Co" });
  assert.deepEqual(S.resolveAcceptedTaxFields({}, { ssn: null, ein: undefined, company_name: "" }), { ssn: null, ein: null, company_name: null });
});

const accept = (db: any, body: Record<string, unknown>, method = "POST") => {
  (globalThis as any).__admin = db;
  return S.acceptHandler({ httpMethod: method, headers: {}, body: JSON.stringify(body) });
};

test("accept-invite — blank SSN keeps the stored value; organization and role come from the invitation, never the request body", async () => {
  const db = makeAdmin();
  const res = await accept(db, { token: TOK_PENDING, password: "pw-123456", firstName: "Pat", lastName: "Ending", ssn: "", ein: "",
    role: "owner", orgId: ORG_B, organization_id: ORG_B });
  assert.equal(res.statusCode, 200);
  const [profile] = await rows(db, "profiles");
  assert.equal(profile.id, NEW_USER);
  assert.equal(profile.ssn, "123-45-6789", "a blank SSN must not overwrite the administrator's stored value");
  assert.equal(profile.organization_id, ORG_A);
  const [membership] = await rows(db, "org_memberships");
  assert.deepEqual([membership.org_id, membership.member_id, membership.role], [ORG_A, NEW_USER, "sales"]);
  const accepted = (await rows(db, "invitations")).find((r) => r.id === INV_A);
  assert.equal(accepted.status, "accepted");
});

test("accept-invite — subcontractor: blank EIN/company keep stored values; a typed SSN/EIN wins", async () => {
  const db = makeAdmin();
  assert.equal((await accept(db, { token: TOK_SUB, password: "pw-123456", firstName: "Bo", lastName: "Bee" })).statusCode, 200);
  const [profile] = await rows(db, "profiles");
  assert.deepEqual([profile.ein, profile.company_name, profile.ssn], ["98-7654321", "Bee LLC", null]);
  const [membership] = await rows(db, "org_memberships");
  assert.deepEqual([membership.org_id, membership.role], [ORG_B, "admin"]);

  const typed = makeAdmin();
  await accept(typed, { token: TOK_PENDING, password: "pw-123456", firstName: "Pat", lastName: "Ending", ssn: "000-11-2222" });
  assert.equal((await rows(typed, "profiles"))[0].ssn, "000-11-2222");
});

test("accept-invite — used, expired, unknown or missing tokens create no user, profile or membership", async () => {
  for (const [token, status] of [[TOK_USED, 404], [TOK_EXPIRED, 410], ["ffffffff-ffff-4fff-8fff-ffffffffffff", 404], ["", 400]] as const) {
    const db = makeAdmin();
    const res = await accept(db, { token, password: "pw-123456", firstName: "X", lastName: "Y" });
    assert.equal(res.statusCode, status, `token ${token || "(empty)"}`);
    assert.deepEqual(db.created, []);
    assert.equal((await rows(db, "profiles")).length, 0);
    assert.equal((await rows(db, "org_memberships")).length, 0);
  }
  assert.equal((await accept(makeAdmin(), { token: TOK_PENDING, password: "pw" }, "GET")).statusCode, 405);
});

// ── static boundary checks ───────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
const rel = (f: string) => path.relative(repoRoot, f).replace(/\\/g, "/");

test("static — the invitee page uses the server lookup, never the invitations table, and never pre-fills tax numbers", () => {
  const cb = code(read("src/routes/auth.callback.tsx"));
  assert.ok(!/from\(["']invitations["']\)/.test(cb), "the invitee page must not query the invitations table");
  assert.match(cb, /functions\/invitation-lookup/);
  assert.match(cb, /functions\/accept-invite/);
  assert.ok(!/setSsn\(data\.ssn|setEin\(data\.ein|data\.ssn|data\.ein/.test(cb), "the page must not pre-fill tax numbers from the response");
  assert.match(code(read("netlify/functions/accept-invite.ts")), /resolveAcceptedTaxFields\(\{ ssn, ein, companyName \}, invitation\)/);
});

test("static — the password-recovery redirect still runs before any invitation-token handling", () => {
  const cb = code(read("src/routes/auth.callback.tsx"));
  const recovery = cb.search(/navigate\(\{ to: RESET_PASSWORD_PATH/);
  const lookup = cb.search(/functions\/invitation-lookup/);
  assert.ok(recovery > 0, "the recovery redirect must be present");
  assert.ok(recovery < lookup, "the recovery redirect must come before the invitation lookup");
  assert.match(cb, /readRecoveryState\(\) === "active"/);
});

test("static — no browser code looks an invitation up by token", () => {
  const offenders: string[] = [];
  for (const file of walk(path.join(repoRoot, "src"))) {
    const src = code(readFileSync(file, "utf8")).replace(/\s+/g, " ");
    if (/from\(["']invitations["']\)[^;]*\.eq\(\s*["']token["']/.test(src)) offenders.push(rel(file));
  }
  assert.deepEqual(offenders, []);
});
