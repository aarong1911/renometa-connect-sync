// netlify/functions/lib/invitation-lookup.test.ts
//
// Run:  node --test netlify/functions/lib/invitation-lookup.test.ts
//
// S1 minimal invitation-security release. Covers: the server-side token lookup (minimal fields, no tax values, no ids/token, malformed
// input never reaches the database), its public handler, accept-invite end to end (blank SSN/EIN keeps the administrator's stored value,
// organization and role always come from the invitation, used/expired/unknown tokens create nothing), and static boundary checks (the
// invitee page no longer queries the invitations table, and the password-recovery redirect still runs before any token handling).
// Membership integrity: an unsupported role is rejected before any account exists; a failed profile, membership or invitation-status
// write returns an error, removes the partial account and leaves the invitation pending; a failed removal is reported without leaking
// secrets; concurrent attempts create one account; the server role list matches the app's and the migration's.
// Confirmation trigger: the fake createUser models Supabase Auth + on_invited_user_confirmed (a confirmed createUser carrying org_id
// metadata grants a membership from that metadata and accepts the invitation) — accept-invite must never trigger it.
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
      export * from "./netlify/functions/lib/member-roles";
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
  }, {}, { uniqueConstraints: { org_memberships: [["member_id", "org_id"]] } });
  const created: string[] = [];
  const deleted: string[] = [];
  const createCalls: any[] = [];
  const updateCalls: any[] = [];
  db.triggerFired = 0;
  db.failUserUpdates = 0; // how many updateUserById calls fail next
  const users = new Map<string, string>(); // email -> id; auth emails are unique, like Supabase Auth
  db.auth = {
    admin: {
      // Models Supabase Auth's admin createUser: INSERT the user, then — with email_confirm — UPDATE email_confirmed_at in the same
      // transaction. That UPDATE fires on_invited_user_confirmed: when the metadata carries org_id, handle_invited_user (as it runs in
      // production today) grants a membership from the metadata's org_id/role, moves the profile to that org and accepts the org's
      // pending invitations for that email. If its writes fail, the whole createUser fails and no user exists.
      createUser: async (params: { email: string; email_confirm?: boolean; user_metadata?: Record<string, any> }) => {
        createCalls.push(params);
        const { email } = params;
        if (users.has(email)) return { data: { user: null }, error: { code: "email_exists", message: "A user with this email address has already been registered" } };
        const meta = params.user_metadata ?? {};
        if (params.email_confirm && meta.org_id) {
          db.triggerFired++;
          const existing = (await rows(db, "org_memberships")).find((m) => m.member_id === NEW_USER && m.org_id === meta.org_id);
          if (!existing) {
            const { error } = await db.from("org_memberships").insert({ member_id: NEW_USER, org_id: meta.org_id, role: meta.role });
            if (error) return { data: { user: null }, error: { code: "unexpected_failure", message: "Database error creating new user" } };
          }
          await db.from("profiles").update({ organization_id: meta.org_id }).eq("id", NEW_USER);
          await db.from("invitations").update({ status: "accepted" }).eq("email", email).eq("organization_id", meta.org_id).eq("status", "pending");
        }
        users.set(email, NEW_USER);
        created.push(email);
        return { data: { user: { id: NEW_USER } }, error: null };
      },
      // Updating an already-confirmed user can't fire the trigger (email_confirmed_at doesn't go from NULL to a value).
      updateUserById: async (id: string, attrs: any) => {
        updateCalls.push({ id, attrs });
        if (db.failUserUpdates > 0) { db.failUserUpdates--; return { data: null, error: { code: "unexpected_failure", message: "SENTINEL auth detail" } }; }
        return { data: {}, error: null };
      },
      deleteUser: async (id: string) => {
        for (const [email, uid] of users) if (uid === id) users.delete(email);
        deleted.push(id);
        return { data: {}, error: null };
      },
    },
  };
  db.created = created;
  db.deleted = deleted;
  db.createCalls = createCalls;
  db.updateCalls = updateCalls;
  return db;
}

// A chain that resolves to { data, error } whatever is called on it — stands in for one failing (or empty) database request.
const settled = (result: { data: unknown; error: unknown }): any => {
  const chain: any = new Proxy({}, { get: (_t, p) => (p === "then" ? (resolve: any) => resolve(result) : () => chain) });
  return chain;
};
// Raw database text that must never reach a response or a log line.
const RAW_DB_ERROR = { code: "XX000", message: "SENTINEL raw detail 123-45-6789 " + TOK_PENDING };
// Makes `op` on `table` resolve to `result` (default: a database error); every other request still goes to the fake.
function override(db: any, table: string, op: "insert" | "upsert" | "update" | "delete", result: (payload: any) => { data: unknown; error: unknown } | null = () => ({ data: null, error: RAW_DB_ERROR })) {
  const from = db.from.bind(db);
  db.from = (t: string) => {
    const qb = from(t);
    if (t !== table) return qb;
    const original = qb[op].bind(qb);
    qb[op] = (payload: any, ...rest: any[]) => { const r = result(payload); return r ? settled(r) : original(payload, ...rest); };
    return qb;
  };
}
const EIGHT_LIVE_ROLES = ["owner", "admin", "project_manager", "sales", "estimator", "accountant", "field_worker", "viewer"];
// Models org_memberships_role_check: rejects an insert whose role is not allowed (Postgres check_violation, 23514).
const enforceRoleCheck = (db: any, allowed: string[]) =>
  override(db, "org_memberships", "insert", (row) => (allowed.includes(row.role) ? null : {
    data: null, error: { code: "23514", message: `new row for relation "org_memberships" violates check constraint "org_memberships_role_check" ${RAW_DB_ERROR.message}` },
  }));
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

// ── accept-invite: membership integrity ──────────────────────────────────

const PASSWORD = "pw-Secret-123456";
const acceptBody = { token: TOK_PENDING, password: PASSWORD, firstName: "Olive", lastName: "Manager", ssn: "" };
const officeManagerDb = () => makeAdmin({ invitations: [inv({ role: "office_manager" })] });
const pendingInvitation = async (db: any) => (await rows(db, "invitations")).find((r) => r.id === INV_A);

// Runs fn with console.error/log captured (they are silenced for the rest of this file).
async function withLogs(fn: () => Promise<any>): Promise<{ result: any; logs: string }> {
  const lines: string[] = [];
  const saved = [console.error, console.log];
  console.error = console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { return { result: await fn(), logs: lines.join("\n") }; }
  finally { [console.error, console.log] = saved; }
}
function assertNoSecrets(text: string, where: string) {
  for (const secret of ["SENTINEL", "123-45-6789", TOK_PENDING, PASSWORD]) assert.ok(!text.includes(secret), `${where} leaked ${secret}`);
}
// After a failed attempt: nothing of the new account is left, and the invitation can be used again.
async function assertRolledBack(db: any) {
  assert.deepEqual(db.deleted, [NEW_USER], "the new auth user is removed");
  assert.equal((await rows(db, "profiles")).length, 0, "no profile is left behind");
  assert.equal((await rows(db, "org_memberships")).length, 0, "no membership is left behind");
  assert.equal((await pendingInvitation(db)).status, "pending", "the invitation stays pending for a retry");
}

test("accept-invite — office_manager invitation (nine-role constraint): account, profile and membership in the invitation's org and role", async () => {
  const db = officeManagerDb();
  enforceRoleCheck(db, [...EIGHT_LIVE_ROLES, "office_manager"]);
  const res = await accept(db, { ...acceptBody, role: "owner", orgId: ORG_B });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { success: true, email: "pending-a@example.invalid" });
  const [profile] = await rows(db, "profiles");
  assert.deepEqual([profile.id, profile.organization_id], [NEW_USER, ORG_A]);
  const memberships = await rows(db, "org_memberships");
  assert.equal(memberships.length, 1);
  assert.deepEqual([memberships[0].member_id, memberships[0].org_id, memberships[0].role], [NEW_USER, ORG_A, "office_manager"]);
  const accepted = await pendingInvitation(db);
  assert.equal(accepted.status, "accepted");
  assert.ok(accepted.accepted_at);
  assert.deepEqual(db.deleted, []);
});

test("accept-invite — membership insert failure (the live eight-role constraint) returns an error, removes the account, and a retry succeeds once the role is allowed", async () => {
  const db = officeManagerDb();
  const plainFrom = db.from;
  enforceRoleCheck(db, EIGHT_LIVE_ROLES);
  const { result: res, logs } = await withLogs(() => accept(db, acceptBody));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /couldn't finish creating your account/);
  assert.ok(!/success/.test(res.body));
  await assertRolledBack(db);
  assertNoSecrets(res.body, "response");
  assertNoSecrets(logs, "logs");
  assert.match(logs, /org_memberships insert failed \(23514\)/);

  db.from = plainFrom;                                   // the migration is applied
  enforceRoleCheck(db, [...EIGHT_LIVE_ROLES, "office_manager"]);
  assert.equal((await accept(db, acceptBody)).statusCode, 200, "the still-pending invitation can be accepted on retry");
  assert.equal((await rows(db, "org_memberships"))[0].role, "office_manager");
});

test("accept-invite — an unsupported invitation role is rejected before any account is created", async () => {
  for (const role of ["superuser", "", null, "Office_Manager", "office manager"]) {
    const db = makeAdmin({ invitations: [inv({ role })] });
    const res = await accept(db, acceptBody);
    assert.equal(res.statusCode, 422, `role ${String(role)}`);
    assert.deepEqual(db.created, [], "no auth user");
    assert.equal((await rows(db, "profiles")).length, 0);
    assert.equal((await rows(db, "org_memberships")).length, 0);
    assert.equal((await pendingInvitation(db)).status, "pending");
  }
  assert.ok(S.isSupportedMemberRole("office_manager") && !S.isSupportedMemberRole("superuser"));
});

test("accept-invite — profile write failure returns an error and removes the auth user; no membership is created", async () => {
  const db = officeManagerDb();
  override(db, "profiles", "upsert");
  const { result: res, logs } = await withLogs(() => accept(db, acceptBody));
  assert.equal(res.statusCode, 500);
  await assertRolledBack(db);
  assertNoSecrets(res.body, "response");
  assertNoSecrets(logs, "logs");
  assert.match(logs, /profiles upsert failed \(XX000\)/);
});

test("accept-invite — invitation-status update failure removes the account (membership, profile, user) and keeps the invitation pending", async () => {
  const db = officeManagerDb();
  override(db, "invitations", "update");
  const { result: res, logs } = await withLogs(() => accept(db, acceptBody));
  assert.equal(res.statusCode, 500);
  await assertRolledBack(db);
  assertNoSecrets(res.body, "response");
  assertNoSecrets(logs, "logs");

  const revoked = officeManagerDb();                     // revoked/accepted elsewhere between lookup and update: nothing matched
  override(revoked, "invitations", "update", () => ({ data: [], error: null }));
  const conflict = await accept(revoked, acceptBody);
  assert.equal(conflict.statusCode, 409);
  assert.equal((await rows(revoked, "org_memberships")).length, 0);
  assert.deepEqual(revoked.deleted, [NEW_USER]);
});

test("accept-invite — a failed cleanup step is reported generically to the invitee and named (with the user id) in the server log", async () => {
  const db = officeManagerDb();
  override(db, "org_memberships", "insert");
  override(db, "profiles", "delete");
  db.auth.admin.deleteUser = async () => { throw new Error("SENTINEL network down"); };
  const { result: res, logs } = await withLogs(() => accept(db, acceptBody));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /contact your administrator before trying again/);
  assert.ok(!res.body.includes(NEW_USER) && !res.body.includes(INV_A) && !res.body.includes(ORG_A), "no ids in the response");
  assert.match(logs, /CLEANUP INCOMPLETE/);
  assert.ok(logs.includes(NEW_USER), "the log names the user to repair");
  assert.match(logs, /profiles, auth_user/);
  assert.ok(!/CLEANUP INCOMPLETE[^\n]*org_memberships/.test(logs), "the membership delete itself succeeded");
  assertNoSecrets(res.body, "response");
  assertNoSecrets(logs, "logs");
  assert.equal((await pendingInvitation(db)).status, "pending");
});

test("accept-invite — concurrent attempts on one invitation create one account; the other is refused before writing anything", async () => {
  const db = officeManagerDb();
  const results = await Promise.all([accept(db, acceptBody), accept(db, acceptBody)]);
  assert.deepEqual(results.map((r: any) => r.statusCode).sort(), [200, 409]);
  const loser = results.find((r: any) => r.statusCode === 409);
  assert.ok(!loser.body.includes("already been registered"), "the raw auth error is not returned");
  assert.equal((await rows(db, "org_memberships")).length, 1);
  assert.equal((await rows(db, "profiles")).length, 1);
  assert.deepEqual(db.deleted, [], "the refused attempt removes nothing");
  assert.equal((await pendingInvitation(db)).status, "accepted");
});

// ── accept-invite: the email-confirmation trigger (on_invited_user_confirmed / handle_invited_user) ──

test("trigger model — a confirmed createUser carrying org_id metadata fires the trigger: membership from metadata, invitation accepted early", async () => {
  // Sanity check of the simulation itself: this is exactly what accept-invite must never cause.
  const db = officeManagerDb();
  const r = await db.auth.admin.createUser({ email: "pending-a@example.invalid", password: "x", email_confirm: true, user_metadata: { org_id: ORG_A, role: "owner" } });
  assert.equal(r.error, null);
  assert.equal(db.triggerFired, 1);
  assert.deepEqual((await rows(db, "org_memberships")).map((m) => m.role), ["owner"], "the metadata role, not the invitation's, is granted");
  assert.equal((await pendingInvitation(db)).status, "accepted", "the invitation is consumed by the trigger, before any onboarding write");
  const unconfirmed = officeManagerDb();
  await unconfirmed.auth.admin.createUser({ email: "x@example.invalid", email_confirm: false, user_metadata: { org_id: ORG_A, role: "owner" } });
  assert.equal(unconfirmed.triggerFired, 0, "no confirmation, no trigger");
});

test("accept-invite — createUser carries no org_id/role metadata, so confirmation never fires the trigger; metadata is written only after onboarding", async () => {
  const db = officeManagerDb();
  const statusWhenMetadataWritten: string[] = [];
  const update = db.auth.admin.updateUserById;
  db.auth.admin.updateUserById = async (id: string, attrs: any) => {
    if (attrs.user_metadata) statusWhenMetadataWritten.push((await pendingInvitation(db)).status, String((await rows(db, "org_memberships")).length));
    return update(id, attrs);
  };
  const res = await accept(db, { ...acceptBody, phone: "(305) 555-0100" });
  assert.equal(res.statusCode, 200);
  assert.equal(db.createCalls.length, 1);
  const [create] = db.createCalls;
  assert.equal(create.email_confirm, true);
  assert.ok(!create.user_metadata || (create.user_metadata.org_id === undefined && create.user_metadata.role === undefined), "createUser must not carry org_id/role");
  assert.equal(db.triggerFired, 0, "the confirmation trigger must not run for accept-invite accounts");
  assert.deepEqual(statusWhenMetadataWritten, ["accepted", "1"], "metadata is written after the membership exists and the invitation is accepted");
  const meta = db.updateCalls.find((c: any) => c.attrs.user_metadata).attrs.user_metadata;
  assert.deepEqual([meta.org_id, meta.role, meta.first_name], [ORG_A, "office_manager", "Olive"]);
  assert.ok(db.updateCalls.some((c: any) => c.attrs.phone === "+13055550100"), "the E.164 phone is still set");
  const memberships = await rows(db, "org_memberships");
  assert.deepEqual(memberships.map((m) => [m.org_id, m.role]), [[ORG_A, "office_manager"]]);
});

test("accept-invite — a metadata update failure is retried once, then logged with the user id; the completed account is kept", async () => {
  const once = officeManagerDb();
  once.failUserUpdates = 1;
  const { result: ok, logs: quiet } = await withLogs(() => accept(once, acceptBody));
  assert.equal(ok.statusCode, 200);
  assert.ok(!/update failed/.test(quiet), "a failure that the retry fixes is not reported");
  assert.equal(once.updateCalls.filter((c: any) => c.attrs.user_metadata).length, 2);

  const db = officeManagerDb();
  db.failUserUpdates = 2;
  const { result: res, logs } = await withLogs(() => accept(db, acceptBody));
  assert.equal(res.statusCode, 200);
  assert.match(logs, /account complete, but the metadata update failed \(unexpected_failure\)/);
  assert.ok(logs.includes(NEW_USER));
  assertNoSecrets(logs, "logs");
  assertNoSecrets(res.body, "response");
  assert.deepEqual(db.deleted, [], "a working account is not removed for a display-only update");
  assert.equal((await rows(db, "org_memberships")).length, 1);
  assert.equal((await pendingInvitation(db)).status, "accepted");
});

test("accept-invite — a membership or profile write that reports success but did not persist is caught by the read-back", async () => {
  for (const [table, op] of [["org_memberships", "insert"], ["profiles", "upsert"]] as const) {
    const db = officeManagerDb();
    override(db, table, op, () => ({ data: null, error: null })); // "succeeds", writes nothing
    const { result: res, logs } = await withLogs(() => accept(db, acceptBody));
    assert.equal(res.statusCode, 500, `${table}.${op}`);
    assert.match(logs, new RegExp(`${table} read-back mismatch`));
    await assertRolledBack(db);
  }
  const wrongRole = officeManagerDb();                   // the stored membership ends up with a different role than the invitation's
  const from = wrongRole.from.bind(wrongRole);
  wrongRole.from = (t: string) => {
    const qb = from(t);
    if (t === "org_memberships") { const ins = qb.insert.bind(qb); qb.insert = (row: any) => ins({ ...row, role: "viewer" }); }
    return qb;
  };
  const res = await accept(wrongRole, acceptBody);
  assert.equal(res.statusCode, 500);
  assert.equal((await rows(wrongRole, "org_memberships")).length, 0, "the mismatched membership is removed");
});

test("static — the server role list matches the app's Role list and the migration's constraint", () => {
  const app = read("src/lib/organization.ts").match(/export const ALL_ROLES: Role\[\] = \[([^\]]*)\]/)?.[1] ?? "";
  const migration = read("supabase/migrations/20261031_org_memberships_role_office_manager.sql")
    .match(/add constraint org_memberships_role_check\s+check \(role in \(([^)]*)\)\)/)?.[1] ?? "";
  const list = (s: string) => [...s.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]).sort();
  const server = [...S.SUPPORTED_MEMBER_ROLES].sort();
  assert.equal(server.length, 9);
  assert.deepEqual(list(app), server);
  assert.deepEqual(list(migration), server);
  assert.deepEqual(server.filter((r: string) => !EIGHT_LIVE_ROLES.includes(r)), ["office_manager"]);
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
