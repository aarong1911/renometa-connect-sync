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

function makeDb(rows: any[] = [], integrationsRows: any[] = []) {
  return createFakeSupabaseClient(
    { gmail_messages: rows, integrations: integrationsRows },
    {},
    { uniqueConstraints: { gmail_messages: [["id"]] } },
  ) as any;
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
  // another org must still be fully fetched for THIS org rather than being
  // mistaken for "already synced" because a same-id row exists elsewhere.
  const db = makeDb([{ id: "shared-id", org_id: ORG_B, thread_id: "t", body_text: "org B's body", labels: [], direction: "in" }]);
  const { api, calls } = fakeGmail({ historyPages: [{ messageIds: ["shared-id"], historyId: "150" }], messages: { "shared-id": detail("shared-id") } });
  const r: any = await S.runGmailMessageSync(db, ORG_A, INTEGRATION_A, { historyId: "100", accountEmail: ACCOUNT }, ACCOUNT, api);
  assert.equal(calls.getMessage.length, 1, "org A has no row of its own yet, so it must still be fetched despite org B's row existing");
  assert.equal(r.unchanged, 0, "not counted as an org-A row that already had a body");
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
