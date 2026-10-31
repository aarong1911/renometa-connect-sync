// netlify/functions/lib/gmail-history-sync.test.ts
//
// Run:  node --test netlify/functions/lib/gmail-history-sync.test.ts
// (Node 22/24 native TypeScript type stripping + built-in test runner. The
//  module under test is bundled with esbuild only because its relative
//  imports have no extension — no network, no side effects at import time.)
//
// SAFETY: the in-memory fake Supabase (test-support/fake-supabase-client.mjs)
// and a hand-written fake GmailApi only — no live Gmail, SMTP or Supabase.
// Global fetch is replaced with a function that throws, so any accidental
// network call fails the test.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const realFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("Network access is not allowed in gmail-history-sync.test.ts");
}) as typeof fetch;

const req = createRequire(import.meta.url);
const esbuild = createRequire(req.resolve("vite/package.json"))("esbuild");
const outDir = mkdtempSync(path.join(tmpdir(), "gmail-history-sync-"));
await esbuild.build({
  entryPoints: [path.join(here, "gmail-history-sync.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);
const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(here, "test-support/fake-supabase-client.mjs")).href);

after(() => {
  globalThis.fetch = realFetch;
  rmSync(outDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const INTEGRATION_A = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaa1";
const ACCOUNT = "sales@renometa.com";
const OTHER_ACCOUNT = "other@renometa.com";

// Same uniqueness production enforces: the primary key, plus the partial
// unique index gmail_messages_org_rfc_message_id_uq (20260728). strictUpsert
// makes the bulk upsert behave like the real single ON CONFLICT statement.
function makeDb(rows: any[] = [], integrationsRows: any[] = []) {
  return createFakeSupabaseClient(
    { gmail_messages: rows, integrations: integrationsRows },
    {},
    { uniqueConstraints: { gmail_messages: [["id"], ["org_id", "rfc_message_id"]] }, strictUpsert: ["gmail_messages"] },
  ) as any;
}
/** A Gmail message carrying an explicit Message-ID header (and optional labels / receive time). */
function detailWithRfc(id: string, rfc: string, over: Record<string, unknown> = {}): any {
  return detail(id, {
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: "sam@example.com" }, { name: "Message-ID", value: rfc }], body: { data: b64u(`Body of ${id}`) } },
    ...over,
  });
}
const b64u = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
function detail(id: string, over: Record<string, unknown> = {}): any {
  return {
    id,
    threadId: over.threadId ?? `thr-${id}`,
    internalDate: String(Date.now()),
    snippet: "hello",
    labelIds: over.labelIds ?? ["INBOX"],
    payload: over.payload ?? { mimeType: "text/plain", headers: [{ name: "From", value: "sam@example.com" }, { name: "Message-ID", value: `<${id}@example.com>` }], body: { data: b64u(`Body of ${id}`) } },
    ...over,
  };
}

/** A scriptable fake GmailApi: fixed pages/messages, with call counters for assertions. */
function fakeGmail(opts: {
  listPages?: Array<{ ids: string[]; nextPageToken?: string }>;
  historyPages?: Array<{ messageIds: string[]; nextPageToken?: string; historyId?: string } | "invalid">;
  messages?: Record<string, any>;
  profile?: { historyId: string; emailAddress: string | null };
  infiniteListPage?: boolean;
  infiniteHistoryPage?: boolean;
} = {}) {
  const calls = { listMessages: 0, listHistory: 0, getMessage: [] as string[], getProfile: 0 };
  let listIdx = 0;
  let historyIdx = 0;
  return {
    calls,
    api: {
      async listMessages(_pageToken?: string) {
        calls.listMessages++;
        if (opts.infiniteListPage) return { ids: [`inf-${calls.listMessages}`], nextPageToken: "more" };
        const page = opts.listPages?.[listIdx++] ?? { ids: [] };
        return page;
      },
      async listHistory(_start: string, _pageToken?: string) {
        calls.listHistory++;
        if (opts.infiniteHistoryPage) return { messageIds: [], nextPageToken: "more", historyId: "999" };
        const page = opts.historyPages?.[historyIdx++];
        if (page === "invalid") throw new S.GmailHistoryInvalidError();
        return page ?? { messageIds: [] };
      },
      async getMessage(id: string) {
        calls.getMessage.push(id);
        return opts.messages?.[id] ?? null;
      },
      async getProfile() {
        calls.getProfile++;
        return opts.profile ?? { historyId: "500", emailAddress: ACCOUNT };
      },
    },
  };
}
const integrationsOf = (db: any) => db.__dumpTable("integrations") as any[];
const messagesOf = (db: any) => db.__dumpTable("gmail_messages") as any[];

// ── BOOTSTRAP ────────────────────────────────────────────────────────────────

test("1. no stored cursor -> bootstrap mode", async () => {
  const db = makeDb();
  const { api, calls } = fakeGmail({ listPages: [{ ids: ["m1"] }], messages: { m1: detail("m1") } });
  const r = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: null, accountEmail: null }, ACCOUNT, api);
  assert.equal(r.mode, "bootstrap");
  assert.equal(calls.listMessages, 1);
  assert.equal(calls.listHistory, 0);
});

test("2. bootstrap paginates across multiple pages via nextPageToken", async () => {
  const db = makeDb();
  const { api, calls } = fakeGmail({
    listPages: [{ ids: ["m1"], nextPageToken: "p2" }, { ids: ["m2"], nextPageToken: "p3" }, { ids: ["m3"] }],
    messages: { m1: detail("m1"), m2: detail("m2"), m3: detail("m3") },
  });
  const r = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: null, accountEmail: null }, ACCOUNT, api);
  assert.equal(calls.listMessages, 3);
  assert.equal(r.fetched, 3);
  assert.deepEqual(messagesOf(db).map((m) => m.id).sort(), ["m1", "m2", "m3"]);
});

test("3. bootstrap respects the hard message cap", async () => {
  const db = makeDb();
  const many = Array.from({ length: 5 }, (_, i) => `m${i}`);
  const { api } = fakeGmail({ listPages: [{ ids: many, nextPageToken: "more" }, { ids: ["m5", "m6"] }], messages: Object.fromEntries(many.map((id) => [id, detail(id)])) });
  const r: any = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: null, accountEmail: null }, ACCOUNT, api, { maxMessages: 3 });
  assert.equal(r.fetched, 3);
  assert.equal(r.cappedAt, 3);
  assert.equal(messagesOf(db).length, 3);
});

test("4. cursor is saved (with the account email) after a successful bootstrap", async () => {
  const db = makeDb([], [{ id: INTEGRATION_A, org_id: ORG_A, gmail_history_id: null, gmail_history_id_account_email: null }]);
  const { api } = fakeGmail({ listPages: [{ ids: ["m1"] }], messages: { m1: detail("m1") }, profile: { historyId: "777", emailAddress: ACCOUNT } });
  const r: any = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: null, accountEmail: null }, ACCOUNT, api);
  assert.equal(r.cursorAdvanced, true);
  const row = integrationsOf(db).find((x) => x.id === INTEGRATION_A);
  assert.equal(row.gmail_history_id, "777");
  assert.equal(row.gmail_history_id_account_email, ACCOUNT);
});

test("5. a processing failure leaves the cursor untouched (never saved on a partial bootstrap)", async () => {
  const db = makeDb([], [{ id: INTEGRATION_A, org_id: ORG_A, gmail_history_id: null, gmail_history_id_account_email: null }]);
  const failingDb = { ...db, from: (t: string) => { const b = db.from(t); if (t === "gmail_messages") { const upsert = b.upsert.bind(b); b.upsert = () => Promise.resolve({ data: null, error: { message: "db down" } }); } return b; } };
  const { api, calls } = fakeGmail({ listPages: [{ ids: ["m1"] }], messages: { m1: detail("m1") } });
  await assert.rejects(S.runGmailMessageSync(failingDb, ORG_A, INTEGRATION_A, { historyId: null, accountEmail: null }, ACCOUNT, api));
  assert.equal(calls.getProfile, 0, "profile/cursor step never reached");
  assert.equal(integrationsOf(db)[0].gmail_history_id, null);
});

// ── INCREMENTAL ──────────────────────────────────────────────────────────────

test("6. a usable stored cursor selects incremental mode (history endpoint, not the bootstrap list)", async () => {
  const db = makeDb();
  const { api, calls } = fakeGmail({ historyPages: [{ messageIds: [], historyId: "150" }] });
  const r = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(r.mode, "incremental");
  assert.equal(calls.listHistory, 1);
  assert.equal(calls.listMessages, 0);
});

test("7. one history page is processed", async () => {
  const db = makeDb();
  const { api } = fakeGmail({ historyPages: [{ messageIds: ["m1"], historyId: "150" }], messages: { m1: detail("m1") } });
  const r: any = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(r.pages, 1);
  assert.equal(r.fetched, 1);
});

test("8. multiple history pages are all followed via nextPageToken", async () => {
  const db = makeDb();
  const { api, calls } = fakeGmail({
    historyPages: [{ messageIds: ["m1"], nextPageToken: "h2" }, { messageIds: ["m2"], nextPageToken: "h3" }, { messageIds: ["m3"], historyId: "300" }],
    messages: { m1: detail("m1"), m2: detail("m2"), m3: detail("m3") },
  });
  const r: any = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(calls.listHistory, 3);
  assert.equal(r.pages, 3);
  assert.equal(r.newHistoryId, "300", "the LAST page's historyId is the new cursor");
});

test("9. duplicate message ids across history pages are deduped", async () => {
  const db = makeDb();
  const { api, calls } = fakeGmail({
    historyPages: [{ messageIds: ["m1", "m2"], nextPageToken: "h2" }, { messageIds: ["m2", "m1"], historyId: "300" }],
    messages: { m1: detail("m1"), m2: detail("m2") },
  });
  const r: any = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(r.fetched, 2, "each id fetched once");
  assert.equal(calls.getMessage.length, 2);
  assert.equal(messagesOf(db).length, 2);
});

test("10. a newly added inbound message is processed and stored with direction 'in'", async () => {
  const db = makeDb();
  const { api } = fakeGmail({ historyPages: [{ messageIds: ["in1"], historyId: "150" }], messages: { in1: detail("in1", { labelIds: ["INBOX"] }) } });
  await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(messagesOf(db)[0].direction, "in");
});

test("11. a newly added sent message is processed and reconciled against its temporary SMTP row", async () => {
  const rfc = "<CAF+xyz@mail.gmail.com>";
  const db = makeDb([{ id: "smtp:CAF+xyz@mail.gmail.com", org_id: ORG_A, thread_id: "smtp-thread:x", snippet: "Hi there", body_text: "Hi there", labels: ["SENT"], direction: "out", rfc_message_id: rfc }]);
  const { api } = fakeGmail({
    historyPages: [{ messageIds: ["gm-real-1"], historyId: "150" }],
    messages: { "gm-real-1": detail("gm-real-1", { labelIds: ["SENT"], payload: { mimeType: "text/plain", headers: [{ name: "Message-ID", value: rfc }], body: { data: b64u("") } } }) },
  });
  await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  const rows = messagesOf(db);
  assert.equal(rows.length, 1, "re-keyed in place, not duplicated");
  assert.equal(rows[0].id, "gm-real-1");
  assert.equal(rows[0].body_text, "Hi there", "SMTP-time body preserved since Gmail's own body was empty");
});

test("12. no message changes -> changed:false", async () => {
  const db = makeDb();
  const { api } = fakeGmail({ historyPages: [{ messageIds: [], historyId: "150" }] });
  const r: any = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(r.changed, 0);
});

test("13. visible changes -> changed:true (changed equals rows actually written)", async () => {
  const db = makeDb();
  const { api } = fakeGmail({ historyPages: [{ messageIds: ["m1"], historyId: "150" }], messages: { m1: detail("m1") } });
  const r: any = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(r.changed, 1);
});

// ── CURSOR SAFETY ────────────────────────────────────────────────────────────

test("14. the cursor advances only after processing succeeds", async () => {
  const db = makeDb([], [{ id: INTEGRATION_A, org_id: ORG_A, gmail_history_id: "100", gmail_history_id_account_email: ACCOUNT }]);
  const { api } = fakeGmail({ historyPages: [{ messageIds: ["m1"], historyId: "150" }], messages: { m1: detail("m1") } });
  await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(integrationsOf(db)[0].gmail_history_id, "150");
});

test("15. a failed page fetch keeps the old cursor (next sync safely retries)", async () => {
  const db = makeDb([], [{ id: INTEGRATION_A, org_id: ORG_A, gmail_history_id: "100", gmail_history_id_account_email: ACCOUNT }]);
  const api = { ...fakeGmail().api, listHistory: async () => { throw new Error("network blip"); } };
  await assert.rejects(S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api));
  assert.equal(integrationsOf(db)[0].gmail_history_id, "100");
});

test("16. an overlapping OLDER sync cannot regress a cursor a concurrent sync already advanced", async () => {
  const db = makeDb([], [{ id: INTEGRATION_A, org_id: ORG_A, gmail_history_id: "100", gmail_history_id_account_email: ACCOUNT }]);
  // Sync A reads cursor "100"... then sync B (concurrent) finishes first and advances it to "300".
  const advancedByB = await S.advanceHistoryCursor(db, INTEGRATION_A, "100", "300", ACCOUNT);
  assert.equal(advancedByB, true);
  // Sync A now tries to advance from its OWN stale read ("100") to "150" (older than B's "300").
  const advancedByA = await S.advanceHistoryCursor(db, INTEGRATION_A, "100", "150", ACCOUNT);
  assert.equal(advancedByA, false, "the stale CAS write is rejected");
  assert.equal(integrationsOf(db)[0].gmail_history_id, "300", "never regressed");
});

test("17. history ids are handled as strings end to end — no precision loss for values beyond Number.MAX_SAFE_INTEGER", async () => {
  const huge1 = "9007199254740993"; // 2^53 + 1 — not exactly representable as a JS number
  const huge2 = "9007199254740992"; // 2^53 — Number(huge1) rounds down to exactly this value
  assert.equal(Number(huge1), Number(huge2), "sanity: this is EXACTLY why historyId must never be parsed as a JS number — precision is lost");
  const db = makeDb([], [{ id: INTEGRATION_A, org_id: ORG_A, gmail_history_id: huge1, gmail_history_id_account_email: ACCOUNT }]);
  const { api } = fakeGmail({ historyPages: [{ messageIds: [], historyId: huge2 }] });
  await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: huge1, accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(integrationsOf(db)[0].gmail_history_id, huge2);
  assert.equal(typeof integrationsOf(db)[0].gmail_history_id, "string");
  // buildGmailHistoryPath must never coerce through Number either.
  assert.ok(S.buildGmailHistoryPath(huge1).includes(huge1));
});

// ── RECOVERY ─────────────────────────────────────────────────────────────────

test("18. an expired/invalid historyId triggers a bounded bootstrap in the same call (never fails forever)", async () => {
  const db = makeDb();
  const { api, calls } = fakeGmail({ historyPages: ["invalid"], listPages: [{ ids: ["m1"] }], messages: { m1: detail("m1") } });
  const r: any = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(r.mode, "bootstrap");
  assert.equal(r.recoveredFromInvalidCursor, true);
  assert.equal(calls.listHistory, 1);
  assert.equal(calls.listMessages, 1);
});

test("19. recovery establishes a fresh cursor", async () => {
  const db = makeDb([], [{ id: INTEGRATION_A, org_id: ORG_A, gmail_history_id: "100", gmail_history_id_account_email: ACCOUNT }]);
  const { api } = fakeGmail({ historyPages: ["invalid"], listPages: [{ ids: ["m1"] }], messages: { m1: detail("m1") }, profile: { historyId: "999", emailAddress: ACCOUNT } });
  await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(integrationsOf(db)[0].gmail_history_id, "999");
});

test("20. recovery never duplicates an existing row", async () => {
  const existing = { id: "m1", org_id: ORG_A, thread_id: "t1", body_text: "already here", labels: ["INBOX"], direction: "in" };
  const db = makeDb([existing]);
  const { api } = fakeGmail({ historyPages: ["invalid"], listPages: [{ ids: ["m1"] }], messages: { m1: detail("m1") } });
  await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(messagesOf(db).length, 1, "no duplicate row");
});

// ── ACCOUNT SAFETY ───────────────────────────────────────────────────────────

test("21. reconnecting the SAME account keeps using its existing cursor (incremental, no re-bootstrap)", async () => {
  const db = makeDb();
  const { api, calls } = fakeGmail({ historyPages: [{ messageIds: [], historyId: "150" }] });
  const r = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(r.mode, "incremental");
  assert.equal(calls.listMessages, 0);
});

test("22. a DIFFERENT connected Gmail account cannot inherit the old account's cursor", async () => {
  const db = makeDb();
  const { api, calls } = fakeGmail({ listPages: [{ ids: [] }] });
  const r = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: OTHER_ACCOUNT }, ACCOUNT, api);
  assert.equal(r.mode, "bootstrap", "the stale cursor belongs to a different mailbox and is never trusted");
  assert.equal(calls.listHistory, 0);
});

test("23. org isolation: the 'already has a body, skip fetching' optimization is scoped by org_id, never by message id alone", async () => {
  // gmail_messages.id is the bare Gmail message id (no org_id in the primary
  // key, per the existing schema) — a message id genuinely existing for
  // another org must never be mistaken for "already synced" by THIS org.
  // Since 2026-10-31 it can't be stored for this org either (that would move
  // org B's row), so the sync fails explicitly instead (see C13).
  const db = makeDb([{ id: "shared-id", org_id: ORG_B, thread_id: "t", body_text: "org B's body", labels: [], direction: "in" }]);
  const { api, calls } = fakeGmail({ historyPages: [{ messageIds: ["shared-id"], historyId: "150" }], messages: { "shared-id": detail("shared-id") } });
  await assert.rejects(
    S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api),
    (err: any) => err instanceof S.GmailMessageOwnedByAnotherOrgError,
    "not reported as an org-A row that already had a body",
  );
  assert.equal(calls.getMessage.length, 0, "fails before fetching anything from Gmail");
});

// ── PAGINATION / API COST ────────────────────────────────────────────────────

test("25a. bootstrap never crawls unboundedly even if Gmail keeps returning a nextPageToken", async () => {
  const db = makeDb();
  const { api, calls } = fakeGmail({ infiniteListPage: true });
  const r: any = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: null, accountEmail: null }, ACCOUNT, api, { maxBootstrapPages: 5 });
  assert.equal(calls.listMessages, 5);
  assert.ok(r.pages <= 5);
});

test("25b. incremental history fetch never crawls unboundedly even if Gmail keeps returning a nextPageToken", async () => {
  const db = makeDb();
  const { api, calls } = fakeGmail({ infiniteHistoryPage: true });
  const r: any = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "1", accountEmail: ACCOUNT }, ACCOUNT, api, { maxHistoryPages: 4 });
  assert.equal(calls.listHistory, 4);
  assert.equal(r.pages, 4);
});

test("26. detail fetch happens only for message ids that actually need it (new, or a legacy row with no body yet)", async () => {
  const done = { id: "done1", org_id: ORG_A, body_text: "already extracted", labels: [], direction: "in" };
  const legacy = { id: "legacy1", org_id: ORG_A, body_text: null, snippet: "old", labels: [], direction: "in" };
  const db = makeDb([done, legacy]);
  const { api, calls } = fakeGmail({
    historyPages: [{ messageIds: ["done1", "legacy1", "new1"], historyId: "150" }],
    messages: { legacy1: detail("legacy1"), new1: detail("new1") },
  });
  await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.deepEqual(calls.getMessage.sort(), ["legacy1", "new1"], "done1 already has a body and is skipped");
});

// ── REGRESSION ───────────────────────────────────────────────────────────────

test("27+28. immediate SMTP persistence + sent reconciliation are unaffected by the incremental rewrite", async () => {
  const rfc = "<CAF+regress@mail.gmail.com>";
  const smtpRow = { id: "smtp:CAF+regress@mail.gmail.com", org_id: ORG_A, thread_id: "smtp-thread:x", snippet: "Sent via SMTP", body_text: "Sent via SMTP", labels: ["SENT"], direction: "out", rfc_message_id: rfc };
  const db = makeDb([smtpRow]);
  const { api } = fakeGmail({
    historyPages: [{ messageIds: ["real-id"], historyId: "150" }],
    messages: { "real-id": detail("real-id", { labelIds: ["SENT"], payload: { mimeType: "text/plain", headers: [{ name: "Message-ID", value: rfc }], body: { data: b64u("Sent via SMTP, confirmed by Gmail") } } }) },
  });
  await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  const rows = messagesOf(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "real-id");
  assert.equal(rows[0].body_text, "Sent via SMTP, confirmed by Gmail", "Gmail's own body wins when it has content");
});

test("29. full Gmail MIME body extraction is unaffected — an HTML message is converted to readable text as before", async () => {
  const db = makeDb();
  const html = "<div>Hello <b>Aaron</b>,<br><br>See you Tuesday.</div>";
  const { api } = fakeGmail({ historyPages: [{ messageIds: ["h1"], historyId: "150" }], messages: { h1: detail("h1", { payload: { mimeType: "text/html", headers: [], body: { data: b64u(html) } } }) } });
  await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(messagesOf(db)[0].body_text, "Hello Aaron,\n\nSee you Tuesday.");
});

test("30. the sync result carries every field the frontend/auto-sync contract relies on", async () => {
  const db = makeDb();
  const { api } = fakeGmail({ historyPages: [{ messageIds: [], historyId: "150" }] });
  const r: any = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  for (const key of ["fetched", "inserted", "updated", "skipped", "unchanged", "changed", "mode", "recoveredFromInvalidCursor"]) {
    assert.ok(key in r, `missing ${key}`);
  }
  assert.equal(typeof r.changed, "number");
});

// ── MESSAGE-ID COLLISIONS (production incident, 2026-10-27) ─────────────────
//
// Two distinct Gmail messages can carry the same Message-ID header. Before the
// fix the batch upsert hit gmail_messages_org_rfc_message_id_uq, the cursor
// (correctly) stayed put, and every later sync re-fetched and failed on the
// same batch. These run against makeDb()'s production-equivalent constraints.

const RFC = "<shared-1@mailer.example.com>";
const DUP = "duplicate_rfc_message_id";
const withCursor = () => [{ id: INTEGRATION_A, org_id: ORG_A, gmail_history_id: "100", gmail_history_id_account_email: ACCOUNT }];
function runIncremental(db: any, ids: string[], messages: Record<string, any>) {
  const { api, calls } = fakeGmail({ historyPages: [{ messageIds: ids, historyId: "150" }], messages });
  return { calls, result: S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api) as Promise<any> };
}
const byId = (db: any) => Object.fromEntries(messagesOf(db).map((m) => [m.id, m]));
/** Wraps db so gmail_messages upserts go through `hook(payload, opts, realUpsert)` first. */
function interceptUpserts(db: any, hook: (payload: any[], opts: any, real: () => Promise<any>, call: number) => Promise<any>) {
  let call = 0;
  return {
    ...db,
    from(t: string) {
      const b = db.from(t);
      if (t === "gmail_messages") {
        const upsert = b.upsert.bind(b);
        b.upsert = (payload: any[], opts: any) => hook(payload, opts, () => upsert(payload, opts), ++call);
      }
      return b;
    },
  };
}

test("C1. reproduction: two Gmail messages in ONE batch with the same Message-ID are both saved and the cursor advances", async () => {
  const db = makeDb([], withCursor());
  const { result } = runIncremental(db, ["g-inbox", "g-spam"], {
    "g-inbox": detailWithRfc("g-inbox", RFC, { labelIds: ["INBOX"], internalDate: "2000" }),
    "g-spam": detailWithRfc("g-spam", RFC, { labelIds: ["SPAM"], internalDate: "1000" }),
  });
  const r = await result;
  assert.equal(r.changed, 2);
  assert.equal(r.rfcCollisions, 1);
  assert.equal(integrationsOf(db)[0].gmail_history_id, "150", "cursor advanced after the whole batch was saved");
  const rows = byId(db);
  assert.equal(Object.keys(rows).length, 2, "neither distinct Gmail message is dropped or merged");
  assert.equal(rows["g-spam"].rfc_message_id, RFC, "no SENT copy -> the earliest internal_date keeps the Message-ID");
  assert.equal(rows["g-inbox"].rfc_message_id, null);
  assert.equal(rows["g-inbox"][DUP], RFC, "the original header is preserved");
});

test("C2. owner preference within a batch: the SENT copy, then earliest internal_date, then smallest id", async () => {
  const db = makeDb([], withCursor());
  const { result } = runIncremental(db, ["b-in", "a-in", "z-sent"], {
    "b-in": detailWithRfc("b-in", RFC, { labelIds: ["INBOX"], internalDate: "1000" }),
    "a-in": detailWithRfc("a-in", RFC, { labelIds: ["INBOX"], internalDate: "1000" }),
    "z-sent": detailWithRfc("z-sent", RFC, { labelIds: ["SENT"], internalDate: "9000" }),
  });
  await result;
  const rows = byId(db);
  assert.equal(rows["z-sent"].rfc_message_id, RFC, "the SENT copy wins even though it is the latest");
  assert.equal(rows["a-in"].rfc_message_id, null);
  assert.equal(rows["b-in"].rfc_message_id, null);

  const db2 = makeDb([], withCursor());
  await runIncremental(db2, ["b-in", "a-in"], {
    "b-in": detailWithRfc("b-in", RFC, { labelIds: ["INBOX"], internalDate: "1000" }),
    "a-in": detailWithRfc("a-in", RFC, { labelIds: ["INBOX"], internalDate: "1000" }),
  }).result;
  assert.equal(byId(db2)["a-in"].rfc_message_id, RFC, "same time -> smallest id, deterministic");
});

test("C3. an incoming Message-ID already stored under a DIFFERENT Gmail id never overwrites that row", async () => {
  const stored = { id: "g-old", org_id: ORG_A, thread_id: "t-old", body_text: "original body", labels: ["INBOX"], direction: "in", rfc_message_id: RFC };
  const db = makeDb([stored], withCursor());
  const { result } = runIncremental(db, ["g-new"], { "g-new": detailWithRfc("g-new", RFC, { labelIds: ["INBOX"] }) });
  const r = await result;
  assert.equal(r.rfcCollisions, 1);
  const rows = byId(db);
  assert.deepEqual(rows["g-old"], stored, "the stored owner is untouched, even if the new copy would sort first");
  assert.equal(rows["g-new"].rfc_message_id, null);
  assert.equal(rows["g-new"][DUP], RFC);
  assert.equal(integrationsOf(db)[0].gmail_history_id, "150");
});

test("C4. the same Gmail id twice in one batch (overlapping bootstrap pages) is fetched and written once", async () => {
  const db = makeDb([], [{ id: INTEGRATION_A, org_id: ORG_A, gmail_history_id: null, gmail_history_id_account_email: null }]);
  const { api, calls } = fakeGmail({ listPages: [{ ids: ["m1", "m2"], nextPageToken: "p2" }, { ids: ["m2", "m3"] }], messages: { m1: detail("m1"), m2: detail("m2"), m3: detail("m3") } });
  const r: any = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: null, accountEmail: null }, ACCOUNT, api);
  assert.deepEqual([...calls.getMessage].sort(), ["m1", "m2", "m3"]);
  assert.equal(messagesOf(db).length, 3);
  assert.equal(r.cursorAdvanced, true, "no 'ON CONFLICT ... cannot affect row a second time' failure");
});

test("C5. a self-addressed Gmail API message (one Gmail id, SENT + INBOX) is one row and keeps its Message-ID", async () => {
  const db = makeDb([], withCursor());
  const r: any = await runIncremental(db, ["g-self"], { "g-self": detailWithRfc("g-self", RFC, { labelIds: ["SENT", "INBOX"] }) }).result;
  assert.equal(r.rfcCollisions, 0);
  const rows = messagesOf(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rfc_message_id, RFC);
  assert.equal(rows[0].direction, "out");
});

test("C6. a self-addressed SMTP send (temp smtp: row + separate SENT and INBOX copies) re-keys onto the SENT copy; the INBOX copy is kept separately", async () => {
  const smtpRow = { id: "smtp:shared-1@mailer.example.com", org_id: ORG_A, thread_id: "smtp-thread:x", snippet: "Note to self", body_text: "Note to self", labels: ["SENT"], direction: "out", rfc_message_id: RFC };
  const db = makeDb([smtpRow], withCursor());
  const r: any = await runIncremental(db, ["g-in", "g-sent"], {
    "g-in": detailWithRfc("g-in", RFC, { labelIds: ["INBOX"], internalDate: "1000" }),
    "g-sent": detailWithRfc("g-sent", RFC, { labelIds: ["SENT"], internalDate: "1000" }),
  }).result;
  const rows = byId(db);
  assert.deepEqual(Object.keys(rows).sort(), ["g-in", "g-sent"], "temp row re-keyed in place, nothing duplicated");
  assert.equal(rows["g-sent"].rfc_message_id, RFC, "the outbound copy keeps the Message-ID (inbox optimistic-send matching relies on it)");
  assert.equal(rows["g-in"].rfc_message_id, null);
  assert.equal(rows["g-in"][DUP], RFC);
  assert.equal(r.rfcCollisions, 1);
});

test("C7. concurrent writer: another sync stores the same Message-ID under a different id mid-flight -> re-resolved and retried, never overwritten", async () => {
  const base = makeDb([], withCursor());
  const competing = { id: "g-other", org_id: ORG_A, thread_id: "t", body_text: "theirs", labels: ["INBOX"], direction: "in", rfc_message_id: RFC };
  const db = interceptUpserts(base, async (_payload, _opts, real, call) => {
    if (call === 1) {
      const { error } = await base.from("gmail_messages").insert({ ...competing });
      assert.equal(error, null);
    }
    return real();
  });
  const r: any = await runIncremental(db, ["g-mine"], { "g-mine": detailWithRfc("g-mine", RFC, { labelIds: ["INBOX"] }) }).result;
  const rows = byId(base);
  assert.deepEqual(rows["g-other"], competing, "the concurrent writer's row is untouched");
  assert.equal(rows["g-mine"].rfc_message_id, null);
  assert.equal(rows["g-mine"][DUP], RFC);
  assert.equal(r.rfcCollisions, 1);
  assert.equal(integrationsOf(base)[0].gmail_history_id, "150");
});

test("C8. a conflict that keeps recurring is bounded: the sync fails, nothing is half-written and the cursor stays put", async () => {
  const base = makeDb([], withCursor());
  let calls = 0;
  const db = interceptUpserts(base, async () => {
    calls++;
    return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "gmail_messages_org_rfc_message_id_uq"' } };
  });
  await assert.rejects(runIncremental(db, ["m1"], { m1: detail("m1") }).result, /Failed to save fetched messages/);
  assert.equal(calls, S.RFC_RESOLVE_MAX_ATTEMPTS);
  assert.equal(messagesOf(base).length, 0);
  assert.equal(integrationsOf(base)[0].gmail_history_id, "100");
});

test("C9. any other write failure is not retried and never advances the cursor", async () => {
  const base = makeDb([], withCursor());
  let calls = 0;
  const db = interceptUpserts(base, async () => {
    calls++;
    return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "gmail_messages_pkey"' } };
  });
  await assert.rejects(runIncremental(db, ["m1"], { m1: detail("m1") }).result);
  assert.equal(calls, 1);
  assert.equal(integrationsOf(base)[0].gmail_history_id, "100");
});

test("C10. a batch that fails on one row writes none of them (atomic), so a retry starts clean", async () => {
  // Without the fix this exact batch is what blocked production; the fake's
  // strict upsert must reject it as a whole, like Postgres does.
  const db = makeDb([], withCursor());
  const { error } = await db.from("gmail_messages").upsert(
    [
      { id: "x1", org_id: ORG_A, thread_id: "t", rfc_message_id: RFC },
      { id: "x2", org_id: ORG_A, thread_id: "t", rfc_message_id: RFC },
    ],
    { onConflict: "id" },
  );
  assert.equal(error?.code, "23505");
  assert.equal(messagesOf(db).length, 0);
});

test("C11. repeated syncs are idempotent: same rows, same owner, no duplicates", async () => {
  const msgs = {
    "g-a": detailWithRfc("g-a", RFC, { labelIds: ["INBOX"], internalDate: "1000" }),
    "g-b": detailWithRfc("g-b", RFC, { labelIds: ["INBOX"], internalDate: "2000" }),
  };
  const db = makeDb([], withCursor());
  await runIncremental(db, ["g-a", "g-b"], msgs).result;
  const first = messagesOf(db);
  // A sync whose cursor write lost a race (or an invalid-cursor bootstrap)
  // sees the same ids again; a legacy no-body row forces a re-fetch too.
  await S.processCandidateMessages(db, ORG_A, fakeGmail({ messages: msgs }).api, ["g-a", "g-b"]);
  assert.deepEqual(messagesOf(db), first);

  const legacy = makeDb([
    { id: "g-a", org_id: ORG_A, thread_id: "t", body_text: "kept", labels: ["INBOX"], direction: "in", rfc_message_id: RFC },
    { id: "g-b", org_id: ORG_A, thread_id: "t", body_text: null, labels: ["INBOX"], direction: "in", rfc_message_id: null, [DUP]: RFC },
  ]);
  await S.processCandidateMessages(legacy, ORG_A, fakeGmail({ messages: msgs }).api, ["g-a", "g-b"]);
  const rows = byId(legacy);
  assert.equal(rows["g-a"].rfc_message_id, RFC, "ownership never flips on a re-fetch");
  assert.equal(rows["g-b"].rfc_message_id, null);
  assert.equal(rows["g-b"][DUP], RFC);
  assert.equal(rows["g-b"].body_text, "Body of g-b", "the re-fetch still backfilled the body");
});

test("C12. multi-org isolation: the same Message-ID in another org is neither an owner nor touched", async () => {
  const orgBRow = { id: "g-b-copy", org_id: ORG_B, thread_id: "t", body_text: "org B", labels: ["INBOX"], direction: "in", rfc_message_id: RFC };
  const db = makeDb([orgBRow], withCursor());
  const r: any = await runIncremental(db, ["g-a-copy"], { "g-a-copy": detailWithRfc("g-a-copy", RFC) }).result;
  assert.equal(r.rfcCollisions, 0);
  const rows = byId(db);
  assert.equal(rows["g-a-copy"].rfc_message_id, RFC, "unique per org, so org A keeps its own Message-ID");
  assert.deepEqual(rows["g-b-copy"], orgBRow);
});

// The same Gmail account connected to two orgs (production has this: one
// mailbox in three orgs). gmail_messages.id is the primary key on its own, so
// a plain upsert on "id" would MOVE org B's row into org A; skipping it would
// advance org A's cursor past mail it never stored. Both are wrong — the sync
// must fail explicitly and leave everything as it was.
const ORG_B_SECRET = "org B's private body";

test("C13. same mailbox in two orgs: a batch with another org's message fails closed — nothing written, cursor kept, org B untouched", async () => {
  const orgBRow = { id: "shared-id", org_id: ORG_B, thread_id: "t", body_text: ORG_B_SECRET, labels: ["INBOX"], direction: "in" };
  const db = makeDb([orgBRow], withCursor());
  const { calls, result } = runIncremental(db, ["m1", "shared-id"], { "shared-id": detail("shared-id"), m1: detail("m1") });
  await assert.rejects(result, (err: any) => {
    assert.ok(err instanceof S.GmailMessageOwnedByAnotherOrgError);
    assert.match(err.message, /another RenoMeta organization/);
    assert.ok(!err.message.includes(ORG_B) && !err.message.includes(ORG_B_SECRET) && !err.message.includes("shared-id"), "reveals nothing about the other org");
    return true;
  });
  assert.deepEqual(messagesOf(db), [orgBRow], "org B's row untouched and m1 NOT saved — the whole batch waits");
  assert.equal(integrationsOf(db)[0].gmail_history_id, "100", "cursor not advanced, so no message is skipped for good");
  assert.equal(calls.getMessage.length, 0);
});

test("C13b. same mailbox in two orgs, first sync (bootstrap) of the second org: fails closed and no cursor is established", async () => {
  const orgBRow = { id: "shared-id", org_id: ORG_B, thread_id: "t", body_text: ORG_B_SECRET, labels: ["INBOX"], direction: "in" };
  const db = makeDb([orgBRow], [{ id: INTEGRATION_A, org_id: ORG_A, gmail_history_id: null, gmail_history_id_account_email: null }]);
  const { api, calls } = fakeGmail({ listPages: [{ ids: ["shared-id", "m1"] }], messages: { "shared-id": detail("shared-id"), m1: detail("m1") } });
  await assert.rejects(S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: null, accountEmail: null }, ACCOUNT, api), S.GmailMessageOwnedByAnotherOrgError);
  assert.equal(calls.getProfile, 0);
  assert.equal(integrationsOf(db)[0].gmail_history_id, null);
  assert.deepEqual(messagesOf(db), [orgBRow]);
});

test("C13c. same mailbox in two orgs, race: org B stores the id after org A's check -> org B's row is not overwritten and org A fails closed", async () => {
  const base = makeDb([], withCursor());
  const orgBRow = { id: "race-id", org_id: ORG_B, thread_id: "t", body_text: ORG_B_SECRET, labels: ["INBOX"], direction: "in" };
  const db = interceptUpserts(base, async (_payload, _opts, real, call) => {
    if (call === 1) assert.equal((await base.from("gmail_messages").insert({ ...orgBRow })).error, null);
    return real();
  });
  await assert.rejects(runIncremental(db, ["race-id"], { "race-id": detail("race-id") }).result, S.GmailMessageOwnedByAnotherOrgError);
  assert.deepEqual(byId(base)["race-id"], orgBRow, "ON CONFLICT (id) DO NOTHING — never moved into org A");
  assert.equal(integrationsOf(base)[0].gmail_history_id, "100");
});

test("C13d. a message this org already holds is still updated in place (the DO NOTHING insert is only for new ids)", async () => {
  const legacy = { id: "mine", org_id: ORG_A, thread_id: "old-thread", body_text: null, labels: ["INBOX"], direction: "in" };
  const db = makeDb([legacy], withCursor());
  await runIncremental(db, ["mine"], { mine: detail("mine", { threadId: "new-thread" }) }).result;
  const row = byId(db)["mine"];
  assert.equal(row.thread_id, "new-thread");
  assert.equal(row.body_text, "Body of mine");
});

test("C14. before migration 20261031: a missing duplicate_rfc_message_id column still saves the batch (header just not preserved)", async () => {
  const base = makeDb([], withCursor());
  let calls = 0;
  const db = interceptUpserts(base, async (payload, _opts, real) => {
    calls++;
    if (payload.some((row) => DUP in row)) {
      return { data: null, error: { code: "PGRST204", message: `Could not find the '${DUP}' column of 'gmail_messages' in the schema cache` } };
    }
    return real();
  });
  await runIncremental(db, ["g-1", "g-2"], {
    "g-1": detailWithRfc("g-1", RFC, { internalDate: "1000" }),
    "g-2": detailWithRfc("g-2", RFC, { internalDate: "2000" }),
  }).result;
  assert.equal(calls, 2);
  const rows = byId(base);
  assert.equal(rows["g-1"].rfc_message_id, RFC);
  assert.equal(rows["g-2"].rfc_message_id, null);
  assert.ok(!(DUP in rows["g-2"]));
  assert.equal(integrationsOf(base)[0].gmail_history_id, "150");
});

test("C15. a batch with no collisions never sends the new column (works before and after the migration)", async () => {
  const base = makeDb([], withCursor());
  const db = interceptUpserts(base, async (payload, _opts, real) => {
    assert.ok(payload.every((row) => !(DUP in row)));
    return real();
  });
  await runIncremental(db, ["m1", "m2"], { m1: detail("m1"), m2: detail("m2") }).result;
  assert.equal(messagesOf(base).length, 2);
});

test("assignRfcOwnership: pure decision — stored owner first, rows without a Message-ID untouched", () => {
  const rows = [
    { id: "n1", labels: ["INBOX"], internal_date: null, rfc_message_id: null },
    { id: "k1", labels: ["INBOX"], internal_date: "2026-01-01T00:00:00.000Z", rfc_message_id: RFC },
  ];
  const original = new Map(rows.map((r) => [r.id, r.rfc_message_id]));
  const out = S.assignRfcOwnership(rows, original, new Map([[RFC, "stored-elsewhere"]]));
  assert.equal(out.rows[0].rfc_message_id, null);
  assert.ok(!(DUP in out.rows[0]));
  assert.equal(out.rows[1].rfc_message_id, null);
  assert.equal(out.rows[1][DUP], RFC);
  assert.deepEqual(out.demoted.map((d: any) => [d.id, d.ownerId, d.ownerStored]), [["k1", "stored-elsewhere", true]]);
});

// ── helper pure functions ───────────────────────────────────────────────────

test("parseHistoryResponse: dedupes within one page and ignores non-messageAdded records", () => {
  const page = S.parseHistoryResponse({
    historyId: "150",
    nextPageToken: "next",
    history: [
      { messagesAdded: [{ message: { id: "a" } }, { message: { id: "b" } }] },
      { messagesAdded: [{ message: { id: "a" } }] },
      { labelsAdded: [{ message: { id: "c" } }] }, // not messageAdded — ignored
      { messagesDeleted: [{ message: { id: "d" } }] }, // not messageAdded — ignored
    ],
  });
  assert.deepEqual([...page.messageIds].sort(), ["a", "b"]);
  assert.equal(page.nextPageToken, "next");
  assert.equal(page.historyId, "150");
});

test("cursorIsUsable: requires a non-null historyId AND a matching, non-null account email", () => {
  assert.equal(S.cursorIsUsable({ historyId: "1", accountEmail: ACCOUNT }, ACCOUNT), true);
  assert.equal(S.cursorIsUsable({ historyId: null, accountEmail: ACCOUNT }, ACCOUNT), false);
  assert.equal(S.cursorIsUsable({ historyId: "1", accountEmail: null }, ACCOUNT), false);
  assert.equal(S.cursorIsUsable({ historyId: "1", accountEmail: ACCOUNT }, null), false);
  assert.equal(S.cursorIsUsable({ historyId: "1", accountEmail: OTHER_ACCOUNT }, ACCOUNT), false);
});
