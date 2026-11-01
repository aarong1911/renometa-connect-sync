// tests/netlify-functions/membership-authorization.test.ts
//
// Run:  node --test tests/netlify-functions/membership-authorization.test.ts
//
// Emergency membership-authorization hotfix: update-user-by-id, remove-member and invite-member are owner-only, same-organization,
// supported-role-only, and never report success after a failed write. The real handlers run against the in-memory fake Supabase
// client with a stubbed Auth admin API and a stubbed nodemailer — no network, no live database, no email.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.SUPABASE_URL = "http://fake.local";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.SMTP_USER = "support@example.invalid";
const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("real network access is forbidden in this test file"); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "membership-authorization-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

const stubs = {
  name: "stubs",
  setup(build: any) {
    build.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "fake-supabase", namespace: "stub" }));
    build.onLoad({ filter: /^fake-supabase$/, namespace: "stub" }, () => ({
      contents: `export function createClient() { return new Proxy({}, { get: (_t, p) => { const a = globalThis.__admin; const v = a[p]; return typeof v === 'function' ? v.bind(a) : v; } }); }`, loader: "js" }));
    build.onResolve({ filter: /^nodemailer$/ }, () => ({ path: "fake-nodemailer", namespace: "stub" }));
    build.onLoad({ filter: /^fake-nodemailer$/, namespace: "stub" }, () => ({
      contents: `export default { createTransport: () => ({ sendMail: async (m) => { globalThis.__mail.push(m); return {}; } }) };`, loader: "js" }));
  },
};
const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export { handler as updateHandler } from "./netlify/functions/update-user-by-id";
      export { handler as removeHandler } from "./netlify/functions/remove-member";
      export { handler as inviteHandler } from "./netlify/functions/invite-member";
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

// ── fixtures ─────────────────────────────────────────────────────────────

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const OWNER_A = id(1), ADMIN_A = id(2), VIEWER_A = id(3), SALES_A = id(4), OWNER2_A = id(5);
const OWNER_B = id(11), SALES_B = id(12);
const MULTI = id(21);       // member of A and B
const NO_ORG = id(31);      // self sign-up: no profile organization, no membership
const PROFILE_ONLY = id(32); // profile says org A, no membership
const AMBIGUOUS = id(33);   // owner in A and B, no profile organization
const NEW_USER = id(99);
const INV_PENDING_A = "d0000000-0000-4000-8000-000000000001";
const INV_ROSTER_A = "d0000000-0000-4000-8000-000000000002";
const INV_B = "d0000000-0000-4000-8000-000000000003";
const INV_ACCEPTED_A = "d0000000-0000-4000-8000-000000000004";

type AuthUser = { id: string; email: string; email_confirmed_at: string | null; last_sign_in_at: string | null; user_metadata: Record<string, unknown> };
const confirmed = (uid: string, email: string): AuthUser => ({ id: uid, email, email_confirmed_at: "2026-01-01T00:00:00Z", last_sign_in_at: "2026-01-02T00:00:00Z", user_metadata: {} });
const placeholder = (uid: string, email: string, orgId: string): AuthUser => ({ id: uid, email, email_confirmed_at: null, last_sign_in_at: null, user_metadata: { roster_only: true, org_id: orgId, role: "field_worker" } });
const membership = (member_id: string, org_id: string, role: string) => ({ member_id, org_id, role, worker_type: "employee" });
const profile = (uid: string, organization_id: string | null, email: string) => ({ id: uid, organization_id, email, first_name: "First", last_name: "Last", ssn: "123-45-6789" });

function world() {
  const users = new Map<string, AuthUser>([
    [OWNER_A, confirmed(OWNER_A, "owner-a@example.invalid")], [ADMIN_A, confirmed(ADMIN_A, "admin-a@example.invalid")],
    [VIEWER_A, confirmed(VIEWER_A, "viewer-a@example.invalid")], [SALES_A, confirmed(SALES_A, "sales-a@example.invalid")],
    [OWNER2_A, confirmed(OWNER2_A, "owner2-a@example.invalid")], [OWNER_B, confirmed(OWNER_B, "owner-b@example.invalid")],
    [SALES_B, confirmed(SALES_B, "sales-b@example.invalid")], [MULTI, confirmed(MULTI, "multi@example.invalid")],
    [NO_ORG, confirmed(NO_ORG, "no-org@example.invalid")], [PROFILE_ONLY, confirmed(PROFILE_ONLY, "profile-only@example.invalid")],
    [AMBIGUOUS, confirmed(AMBIGUOUS, "ambiguous@example.invalid")],
  ]);
  const db: any = createFakeSupabaseClient({
    organizations: [{ id: ORG_A, name: "Org A", phone: "" }, { id: ORG_B, name: "Org B", phone: "" }],
    profiles: [
      profile(OWNER_A, ORG_A, "owner-a@example.invalid"), profile(ADMIN_A, ORG_A, "admin-a@example.invalid"),
      profile(VIEWER_A, ORG_A, "viewer-a@example.invalid"), profile(SALES_A, ORG_A, "sales-a@example.invalid"),
      profile(OWNER2_A, ORG_A, "owner2-a@example.invalid"), profile(OWNER_B, ORG_B, "owner-b@example.invalid"),
      profile(SALES_B, ORG_B, "sales-b@example.invalid"), profile(MULTI, ORG_A, "multi@example.invalid"),
      profile(PROFILE_ONLY, ORG_A, "profile-only@example.invalid"),
    ],
    org_memberships: [
      membership(OWNER_A, ORG_A, "owner"), membership(ADMIN_A, ORG_A, "admin"), membership(VIEWER_A, ORG_A, "viewer"),
      membership(SALES_A, ORG_A, "sales"), membership(OWNER2_A, ORG_A, "owner"), membership(OWNER_B, ORG_B, "owner"),
      membership(SALES_B, ORG_B, "sales"), membership(MULTI, ORG_A, "sales"), membership(MULTI, ORG_B, "sales"),
      membership(AMBIGUOUS, ORG_A, "owner"), membership(AMBIGUOUS, ORG_B, "owner"),
    ],
    invitations: [
      { id: INV_PENDING_A, organization_id: ORG_A, email: "pending@example.invalid", role: "sales", status: "pending", project_id: null },
      { id: INV_ROSTER_A, organization_id: ORG_A, email: "roster@example.invalid", role: "field_worker", status: "roster_only", project_id: null },
      { id: INV_B, organization_id: ORG_B, email: "b-invite@example.invalid", role: "sales", status: "pending", project_id: null },
      { id: INV_ACCEPTED_A, organization_id: ORG_A, email: "sales-a@example.invalid", role: "sales", status: "accepted", project_id: null },
    ],
  }, {
    get_user_id_by_email: async ({ user_email }: { user_email: string }) => {
      const u = [...users.values()].find((x) => x.email.toLowerCase() === user_email.toLowerCase());
      return { data: u ? [{ id: u.id }] : [], error: null };
    },
  });

  // Every write, in order: database writes (table + op) and Auth admin writes.
  const writes: string[] = [];
  const from = db.from.bind(db);
  db.from = (table: string) => {
    const qb = from(table);
    for (const op of ["insert", "update", "upsert", "delete"]) {
      const original = qb[op].bind(qb);
      qb[op] = (...args: any[]) => { writes.push(`${table}.${op}`); return original(...args); };
    }
    return qb;
  };
  let nextId = 0;
  db.auth = {
    getUser: async (token: string) => {
      const uid = token.startsWith("tok-") ? token.slice(4) : "";
      return users.has(uid) ? { data: { user: { id: uid } }, error: null } : { data: { user: null }, error: { code: "bad_jwt" } };
    },
    admin: {
      getUserById: async (uid: string) => (users.has(uid) ? { data: { user: users.get(uid) }, error: null } : { data: { user: null }, error: { code: "user_not_found" } }),
      createUser: async (p: { email: string; user_metadata?: Record<string, unknown> }) => {
        writes.push("auth.createUser");
        if ([...users.values()].some((u) => u.email === p.email)) return { data: { user: null }, error: { code: "email_exists" } };
        const uid = nextId++ === 0 ? NEW_USER : id(100 + nextId);
        users.set(uid, { id: uid, email: p.email, email_confirmed_at: null, last_sign_in_at: null, user_metadata: p.user_metadata ?? {} });
        return { data: { user: { id: uid } }, error: null };
      },
      updateUserById: async (uid: string) => { writes.push(`auth.updateUserById:${uid}`); return { data: {}, error: null }; },
      deleteUser: async (uid: string) => { writes.push(`auth.deleteUser:${uid}`); users.delete(uid); return { data: {}, error: null }; },
    },
  };
  db.users = users;
  db.writes = writes;
  return db;
}

// A chain that resolves to { data, error } whatever is called on it — stands in for one failing database request.
const settled = (result: { data: unknown; error: unknown }): any => {
  const chain: any = new Proxy({}, { get: (_t, p) => (p === "then" ? (resolve: any) => resolve(result) : () => chain) });
  return chain;
};
const DB_ERROR = { code: "XX000", message: "SENTINEL raw detail 123-45-6789" };
// Makes `op` on `table` fail (after recording the attempt); every other request still goes to the fake.
function failOn(db: any, table: string, op: "select" | "insert" | "update" | "upsert" | "delete") {
  const from = db.from;
  db.from = (t: string) => {
    const qb = from(t);
    if (t === table) qb[op] = () => { if (op !== "select") db.writes.push(`${t}.${op}`); return settled({ data: null, error: DB_ERROR }); };
    return qb;
  };
}

const rows = async (db: any, table: string) => ((await (db.from(table) as any).select("*")).data ?? []) as any[];
const memberRole = async (db: any, uid: string, org: string) => (await rows(db, "org_memberships")).find((m) => m.member_id === uid && m.org_id === org)?.role;
const mailbox: any[] = ((globalThis as any).__mail = []);

async function call(handler: any, db: any, caller: string | null, body: unknown, method = "POST") {
  (globalThis as any).__admin = db;
  mailbox.length = 0;
  const res = await handler({ httpMethod: method, headers: caller ? { authorization: `Bearer tok-${caller}` } : {}, body: JSON.stringify(body) });
  return { status: res.statusCode as number, body: JSON.parse(res.body || "{}") };
}
const update = (db: any, caller: string | null, body: unknown) => call(S.updateHandler, db, caller, body);
const remove = (db: any, caller: string | null, body: unknown) => call(S.removeHandler, db, caller, body);
const invite = (db: any, caller: string | null, body: unknown) => call(S.inviteHandler, db, caller, body);
const ROSTER = { email: "new-crew@example.invalid", role: "field_worker", name: "New Crew", rosterOnly: true };

// ── authorization: who may call ──────────────────────────────────────────

test("non-owners (admin, viewer, sales) cannot update, remove or invite — 403 and nothing is written", async () => {
  for (const caller of [ADMIN_A, VIEWER_A, SALES_A]) {
    const db = world();
    assert.equal((await update(db, caller, { targetUserId: SALES_A, role: "admin" })).status, 403);
    assert.equal((await update(db, caller, { targetUserId: caller, role: "owner" })).status, 403, "self-promotion");
    assert.equal((await remove(db, caller, { memberId: SALES_A })).status, 403);
    assert.equal((await remove(db, caller, { invitationId: INV_PENDING_A })).status, 403);
    assert.equal((await invite(db, caller, { email: "x@example.invalid", role: "admin" })).status, 403);
    assert.equal((await invite(db, caller, { ...ROSTER })).status, 403);
    assert.deepEqual(db.writes, [], `caller ${caller} wrote nothing`);
    assert.equal(mailbox.length, 0);
    assert.equal(await memberRole(db, caller, ORG_A), caller === ADMIN_A ? "admin" : caller === VIEWER_A ? "viewer" : "sales");
  }
});

test("missing or ambiguous membership, missing or invalid token, and a failed authorization lookup all deny before any write", async () => {
  const cases: [string | null, number][] = [[NO_ORG, 403], [PROFILE_ONLY, 403], [AMBIGUOUS, 403], [null, 401], ["not-a-user", 401]];
  for (const [caller, status] of cases) {
    const db = world();
    assert.equal((await update(db, caller, { targetUserId: SALES_A, firstName: "X" })).status, status, `update ${caller}`);
    assert.equal((await remove(db, caller, { memberId: SALES_A })).status, status, `remove ${caller}`);
    assert.equal((await invite(db, caller, { email: "x@example.invalid", role: "sales" })).status, status, `invite ${caller}`);
    assert.deepEqual(db.writes, []);
  }
  const db = world();
  failOn(db, "org_memberships", "select");                // the caller's role can't be read: deny, never assume
  assert.equal((await update(db, OWNER_A, { targetUserId: SALES_A, firstName: "X" })).status, 500);
  assert.equal((await remove(db, OWNER_A, { memberId: SALES_A })).status, 500);
  assert.equal((await invite(db, OWNER_A, { email: "x@example.invalid", role: "sales" })).status, 500);
  assert.deepEqual(db.writes, []);
});

// ── tenant isolation ─────────────────────────────────────────────────────

test("cross-tenant targets can't be modified or deleted", async () => {
  const db = world();
  const u = await update(db, OWNER_A, { targetUserId: SALES_B, role: "viewer", firstName: "Hacked", ssn: "000-00-0000", phone: "3055550100" });
  assert.equal(u.status, 404);
  assert.equal((await update(db, OWNER_A, { targetUserId: OWNER_B, role: "viewer" })).status, 404, "another org's owner can't be demoted");
  assert.equal((await remove(db, OWNER_A, { memberId: SALES_B })).status, 404);
  assert.equal((await remove(db, OWNER_A, { memberId: OWNER_B })).status, 404);
  assert.equal((await remove(db, OWNER_A, { invitationId: INV_B })).status, 404);
  assert.deepEqual(db.writes, [], "no profile, membership, invitation or Auth write");
  assert.ok(db.users.has(SALES_B) && db.users.has(OWNER_B), "no account deleted");
  assert.equal(await memberRole(db, OWNER_B, ORG_B), "owner");
  assert.equal((await rows(db, "invitations")).filter((r) => r.id === INV_B).length, 1);
});

test("a member who also belongs to another organization can't be edited (shared profile/Auth); removal keeps their account", async () => {
  const db = world();
  assert.equal((await update(db, OWNER_A, { targetUserId: MULTI, firstName: "X" })).status, 409);
  assert.deepEqual(db.writes, []);
  const r = await remove(db, OWNER_A, { memberId: MULTI });
  assert.equal(r.status, 200);
  assert.equal(await memberRole(db, MULTI, ORG_A), undefined, "removed from A");
  assert.equal(await memberRole(db, MULTI, ORG_B), "sales", "still in B");
  assert.ok(db.users.has(MULTI), "their login is NOT deleted");
  assert.ok(!db.writes.some((w: string) => w.startsWith("auth.")));
});

// ── roles ────────────────────────────────────────────────────────────────

test("unsupported roles and worker types are rejected before any write", async () => {
  for (const role of ["superuser", "", "Owner", "office manager"]) {
    const db = world();
    assert.equal((await update(db, OWNER_A, { targetUserId: SALES_A, role })).status, 422, `update role ${role}`);
    assert.ok([400, 422].includes((await invite(db, OWNER_A, { email: "x@example.invalid", role })).status), `invite role ${role}`);
    assert.deepEqual(db.writes, []);
  }
  const db = world();
  assert.equal((await update(db, OWNER_A, { targetUserId: SALES_A, role: 7 })).status, 400);
  assert.equal((await update(db, OWNER_A, { targetUserId: SALES_A, workerType: "boss" })).status, 422);
  assert.equal((await invite(db, OWNER_A, { email: "x@example.invalid", role: "sales", workerType: "boss" })).status, 422);
  assert.equal((await invite(db, OWNER_A, { email: "not an email", role: "sales" })).status, 422);
  assert.deepEqual(db.writes, []);
});

test("owner promotion, owner invitations, demoting/editing another owner and removing an owner are all blocked", async () => {
  const db = world();
  assert.equal((await update(db, OWNER_A, { targetUserId: SALES_A, role: "owner" })).status, 403);
  assert.equal((await invite(db, OWNER_A, { email: "x@example.invalid", role: "owner" })).status, 403);
  assert.equal((await invite(db, OWNER_A, { ...ROSTER, role: "owner" })).status, 403);
  assert.equal((await update(db, OWNER_A, { targetUserId: OWNER2_A, role: "viewer" })).status, 403);
  assert.equal((await update(db, OWNER_A, { targetUserId: OWNER2_A, firstName: "X" })).status, 403);
  assert.equal((await update(db, OWNER_A, { targetUserId: OWNER_A, role: "viewer" })).status, 403, "the owner can't demote themselves");
  assert.equal((await remove(db, OWNER_A, { memberId: OWNER2_A })).status, 403);
  assert.equal((await remove(db, OWNER_A, { memberId: OWNER_A })).status, 403);
  assert.deepEqual(db.writes, []);
  assert.equal(await memberRole(db, SALES_A, ORG_A), "sales");
});

// ── failed writes never return success ───────────────────────────────────

test("update-user-by-id: a failed membership, profile or Auth write returns an error, never { ok: true }", async () => {
  for (const [table, op] of [["org_memberships", "update"], ["profiles", "update"]] as const) {
    const db = world();
    failOn(db, table, op);
    const r = await update(db, OWNER_A, { targetUserId: SALES_A, role: "estimator", firstName: "New" });
    assert.equal(r.status, 500, `${table}.${op}`);
    assert.ok(!r.body.ok);
    assert.ok(!JSON.stringify(r.body).includes("SENTINEL"), "no raw database error in the response");
  }
  const db = world();
  db.auth.admin.updateUserById = async () => ({ data: null, error: { code: "unexpected_failure" } });
  const r = await update(db, OWNER_A, { targetUserId: SALES_A, firstName: "New" });
  assert.equal(r.status, 500);
  assert.ok(!r.body.ok);
});

test("remove-member: a failed membership delete, profile detach or Auth delete returns an error", async () => {
  for (const [table, op] of [["org_memberships", "delete"], ["profiles", "update"]] as const) {
    const db = world();
    failOn(db, table, op);
    assert.equal((await remove(db, OWNER_A, { memberId: SALES_A })).status, 500, `${table}.${op}`);
    if (table === "org_memberships") assert.ok(db.users.has(SALES_A), "the login is not deleted when the membership delete failed");
  }
  const db = world();
  db.auth.admin.deleteUser = async () => ({ data: null, error: { code: "unexpected_failure" } });
  assert.equal((await remove(db, OWNER_A, { memberId: SALES_A })).status, 500);
  const inv = world();
  failOn(inv, "invitations", "delete");
  assert.equal((await remove(inv, OWNER_A, { invitationId: INV_PENDING_A })).status, 500);
});

test("invite-member: a failed invitation insert returns an error and sends no email", async () => {
  const db = world();
  failOn(db, "invitations", "insert");
  const r = await invite(db, OWNER_A, { email: "x@example.invalid", role: "sales" });
  assert.equal(r.status, 500);
  assert.equal(mailbox.length, 0);
});

// ── roster-only ──────────────────────────────────────────────────────────

test("roster-only: a failed placeholder, profile or membership write returns an error and leaves nothing behind", async () => {
  const scenarios: [string, (db: any) => void][] = [
    ["createUser", (db) => { db.auth.admin.createUser = async () => ({ data: { user: null }, error: { code: "unexpected_failure" } }); }],
    ["profiles.upsert", (db) => failOn(db, "profiles", "upsert")],
    ["org_memberships.insert", (db) => failOn(db, "org_memberships", "insert")],
  ];
  for (const [label, inject] of scenarios) {
    const db = world();
    inject(db);
    const r = await invite(db, OWNER_A, { ...ROSTER });
    assert.equal(r.status, 500, label);
    assert.ok(!r.body.success, `${label}: no apparent success`);
    assert.equal((await rows(db, "invitations")).filter((i) => i.email === ROSTER.email).length, 0, `${label}: invitation removed`);
    assert.ok(![...db.users.values()].some((u: AuthUser) => u.email === ROSTER.email), `${label}: placeholder account removed`);
    assert.equal((await rows(db, "profiles")).filter((p) => p.email === ROSTER.email).length, 0, `${label}: no profile left`);
    assert.equal((await rows(db, "org_memberships")).filter((m) => m.member_id === NEW_USER).length, 0, `${label}: no membership left`);
  }
});

test("roster-only: a failed cleanup is reported as an error asking for support, never success", async () => {
  const db = world();
  failOn(db, "org_memberships", "insert");
  failOn(db, "invitations", "delete");
  const r = await invite(db, OWNER_A, { ...ROSTER });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /contact support/);
});

test("roster-only never deletes an existing account unless it is this organization's own placeholder", async () => {
  const OTHER_PLACEHOLDER = id(41), REAL_UNCONFIRMED = id(42), OWN_PLACEHOLDER = id(43);
  const db = world();
  db.users.set(OTHER_PLACEHOLDER, placeholder(OTHER_PLACEHOLDER, "b-crew@example.invalid", ORG_B));
  db.users.set(REAL_UNCONFIRMED, { ...placeholder(REAL_UNCONFIRMED, "signup@example.invalid", ORG_A), user_metadata: {} });
  for (const email of ["sales-b@example.invalid", "b-crew@example.invalid", "signup@example.invalid"]) {
    const r = await invite(db, OWNER_A, { ...ROSTER, email });
    assert.equal(r.status, 409, email);
  }
  assert.deepEqual(db.writes, [], "nothing deleted or created");
  assert.ok(db.users.has(SALES_B) && db.users.has(OTHER_PLACEHOLDER) && db.users.has(REAL_UNCONFIRMED));

  // This organization's own placeholder (with its membership and profile in A) is replaced.
  const own = world();
  own.users.set(OWN_PLACEHOLDER, placeholder(OWN_PLACEHOLDER, ROSTER.email, ORG_A));
  await own.from("org_memberships").insert(membership(OWN_PLACEHOLDER, ORG_A, "field_worker"));
  await own.from("profiles").insert(profile(OWN_PLACEHOLDER, ORG_A, ROSTER.email));
  const r = await invite(own, OWNER_A, { ...ROSTER });
  assert.equal(r.status, 200);
  assert.ok(!own.users.has(OWN_PLACEHOLDER), "the old placeholder is replaced");
  assert.equal(await memberRole(own, NEW_USER, ORG_A), "field_worker");
});

test("cancelling an invitation deletes only this organization's roster placeholder, never an unrelated account", async () => {
  const PH = id(51);
  const db = world();
  db.users.set(PH, placeholder(PH, "roster@example.invalid", ORG_A));
  await db.from("org_memberships").insert(membership(PH, ORG_A, "field_worker"));
  assert.equal((await remove(db, OWNER_A, { invitationId: INV_ROSTER_A })).status, 200);
  assert.ok(!db.users.has(PH), "this org's placeholder is removed");
  assert.equal(await memberRole(db, PH, ORG_A), undefined);

  // An invitation whose email belongs to a real account (here: an accepted invitee) never deletes that account.
  const real = world();
  assert.equal((await remove(real, OWNER_A, { invitationId: INV_ACCEPTED_A })).status, 200);
  assert.ok(real.users.has(SALES_A), "the real member keeps their login");
  assert.equal(await memberRole(real, SALES_A, ORG_A), "sales");
  assert.ok(!real.writes.some((w: string) => w.startsWith("auth.")));
});

// ── legitimate owner workflows ───────────────────────────────────────────

test("owner workflows still work: edit a member, edit own details, remove a member, invite, add to roster", async () => {
  const db = world();
  const edit = await update(db, OWNER_A, { targetUserId: SALES_A, role: "office_manager", workerType: "employee", firstName: "Sam", lastName: "Seller", phone: "(305) 555-0100" });
  assert.deepEqual([edit.status, edit.body], [200, { ok: true }]);
  assert.equal(await memberRole(db, SALES_A, ORG_A), "office_manager");
  assert.equal((await rows(db, "profiles")).find((p) => p.id === SALES_A).first_name, "Sam");
  assert.ok(db.writes.includes(`auth.updateUserById:${SALES_A}`));

  // The Team dialog re-sends the owner's current role and worker type when the owner edits their own details.
  db.writes.length = 0;
  const self = await update(db, OWNER_A, { targetUserId: OWNER_A, role: "owner", workerType: "employee", firstName: "Olive" });
  assert.equal(self.status, 200);
  assert.ok(!db.writes.includes("org_memberships.update"), "no membership write for the owner");
  assert.equal(await memberRole(db, OWNER_A, ORG_A), "owner");

  const rm = await remove(db, OWNER_A, { memberId: VIEWER_A });
  assert.equal(rm.status, 200);
  assert.equal(await memberRole(db, VIEWER_A, ORG_A), undefined);
  assert.equal((await rows(db, "profiles")).find((p) => p.id === VIEWER_A).organization_id, null);
  assert.ok(!db.users.has(VIEWER_A), "a member whose only organization was this one loses their login, as before");

  const cancel = await remove(db, OWNER_A, { invitationId: INV_PENDING_A });
  assert.equal(cancel.status, 200);

  const inv = await invite(db, OWNER_A, { email: "new-sales@example.invalid", role: "sales", name: "New Seller" });
  assert.equal(inv.status, 200);
  assert.equal(mailbox.length, 1);
  const saved = (await rows(db, "invitations")).find((i) => i.email === "new-sales@example.invalid");
  assert.deepEqual([saved.organization_id, saved.role, saved.invited_by, saved.status], [ORG_A, "sales", OWNER_A, "pending"]);

  const roster = await invite(db, OWNER_A, { ...ROSTER });
  assert.equal(roster.status, 200);
  assert.equal(roster.body.success, true);
  assert.equal(await memberRole(db, NEW_USER, ORG_A), "field_worker");
});

test("invitation email escapes user-controlled values", async () => {
  const db = world();
  await db.from("organizations").update({ name: `Acme <script>x</script>` }).eq("id", ORG_A);
  const r = await invite(db, OWNER_A, { email: "victim@example.invalid", role: "sales", name: `<img src=x onerror=alert(1)> "Q"` });
  assert.equal(r.status, 200);
  const [mail] = mailbox;
  assert.ok(!mail.html.includes("<img") && !mail.html.includes("<script>"), "no injected markup");
  assert.ok(mail.html.includes("&lt;img src=x onerror=alert(1)&gt; &quot;Q&quot;"));
  assert.ok(mail.html.includes("Acme &lt;script&gt;x&lt;/script&gt;"));
  assert.ok(!/[\r\n]/.test(mail.subject));
});

// ── static: authorization runs before every write ────────────────────────

test("static — in each endpoint, the owner check comes before every write, and no write path returns success on error", () => {
  for (const file of ["update-user-by-id", "remove-member", "invite-member"]) {
    const src = read(`netlify/functions/${file}.ts`);
    const handlerStart = src.indexOf("export const handler");
    const gate = src.indexOf("requireOrgOwner(", handlerStart);
    assert.ok(gate > handlerStart, `${file}: requireOrgOwner is called in the handler`);
    for (const write of [".insert(", ".update(", ".upsert(", ".delete(", "updateUserById(", "deleteUser(", "createUser(", "removeRosterPlaceholder("]) {
      const at = src.indexOf(write, handlerStart);
      if (at !== -1) assert.ok(at > gate, `${file}: ${write} appears after the owner check`);
    }
    assert.ok(!/Non-fatal/.test(src), `${file}: no "non-fatal" success after a failed write`);
  }
  assert.ok(!/from\("profiles"\)\.select\("organization_id"\)\.eq\("id", user\.id\)/.test(read("netlify/functions/invite-member.ts")),
    "invite-member no longer derives authority from the caller's profile alone");
});
