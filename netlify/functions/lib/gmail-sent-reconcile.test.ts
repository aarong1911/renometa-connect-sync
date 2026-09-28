// netlify/functions/lib/gmail-sent-reconcile.test.ts
//
// Run:  node --test netlify/functions/lib/gmail-sent-reconcile.test.ts
// In-memory fake Supabase only (test-support/fake-supabase-client.mjs); no live
// Gmail/SMTP/Supabase. The sync step is simulated exactly as gmail-sync.ts does
// it: reconcileSmtpSentRows(rows) FIRST, then upsert(rows, { onConflict: "id" }).

import assert from "node:assert/strict";
import test from "node:test";
import { buildSmtpSentRow, persistSmtpSentEmail, reconcileSmtpSentRows, SMTP_SENT_ID_PREFIX } from "./gmail-sent-reconcile.ts";

// Untyped .mjs fake, loaded by URL (same approach as the other repo tests).
const { createFakeSupabaseClient }: any = await import(new URL("./test-support/fake-supabase-client.mjs", import.meta.url).href);

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const RFC = "<CAF+abc123@mail.gmail.com>";

const sent = (over: Record<string, unknown> = {}) => ({
  orgId: ORG,
  messageId: RFC,
  threadId: "thr-1",
  fromEmail: "RenoMeta <sales@renometa.com>",
  to: "lead@example.com",
  subject: "Re: Kitchen",
  body: "Hi Sam,\n\nThe estimate is attached.\n\nThanks,\nAaron",
  ...over,
});

function makeDb() {
  return createFakeSupabaseClient({ gmail_messages: [] }, {}, { uniqueConstraints: { gmail_messages: [["id"]] } }) as any;
}

/** What gmail-sync.ts does for one fetched message. */
async function syncOnce(db: any, fetched: Array<Record<string, unknown>>) {
  const rows = fetched.map((r) => ({ ...r }));
  const res = await reconcileSmtpSentRows(db, ORG, rows as any);
  const { error } = await db.from("gmail_messages").upsert(rows, { onConflict: "id" });
  assert.equal(error ?? null, null);
  return res;
}
const gmailOutRow = (over: Record<string, unknown> = {}) => ({
  id: "18c0ffee00000001",
  org_id: ORG,
  thread_id: "thr-1",
  internal_date: new Date().toISOString(),
  snippet: "Hi Sam, The estimate is attached.",
  body_text: "Hi Sam,\n\nThe estimate is attached.\n\nThanks,\nAaron",
  from_email: "RenoMeta <sales@renometa.com>",
  subject: "Re: Kitchen",
  labels: ["SENT"],
  direction: "out",
  rfc_message_id: RFC,
  ...over,
});
const all = (db: any) => db.__dumpTable("gmail_messages") as any[];

test("16. immediate SMTP persistence stores the full body (body_text) and the snippet", async () => {
  const db = makeDb();
  const row = buildSmtpSentRow(sent()) as any;
  assert.equal(row.body_text, sent().body);
  assert.equal(row.snippet, sent().body);
  assert.equal(row.direction, "out");
  assert.deepEqual(row.labels, ["SENT"]);
  assert.equal(row.id, `${SMTP_SENT_ID_PREFIX}CAF+abc123@mail.gmail.com`);

  const res = await persistSmtpSentEmail(db, sent());
  assert.equal(res.persisted, true);
  const stored = all(db);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].body_text, sent().body);
});

test("17. Gmail reconciliation re-keys the temporary row to the real id and keeps the full body", async () => {
  const db = makeDb();
  await persistSmtpSentEmail(db, sent());
  // Gmail returned the message but extraction yielded no text (e.g. odd MIME): the SMTP-time body must survive.
  const res = await syncOnce(db, [gmailOutRow({ body_text: "" })]);
  assert.deepEqual(res, { rekeyed: 1, failed: 0 });
  const rows = all(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "18c0ffee00000001");
  assert.equal(rows[0].body_text, sent().body, "body preserved through reconciliation");
  assert.equal(rows[0].rfc_message_id, RFC);
});

test("17b. when Gmail does return a body it is authoritative (what was actually delivered)", async () => {
  const db = makeDb();
  await persistSmtpSentEmail(db, sent());
  await syncOnce(db, [gmailOutRow({ body_text: "Hi Sam,\n\nThe estimate is attached.\n\nThanks,\nAaron\n\nSent from RenoMeta" })]);
  assert.equal(all(db).length, 1);
  assert.match(all(db)[0].body_text, /Sent from RenoMeta$/);
});

test("18. no duplicate after reconciliation: repeated syncs and repeated persistence keep exactly one row per Message-ID", async () => {
  const db = makeDb();
  await persistSmtpSentEmail(db, sent());
  const again = await persistSmtpSentEmail(db, sent()); // same Message-ID: 23505 -> still 'persisted'
  assert.equal(again.persisted, true);
  assert.equal(all(db).length, 1);

  await syncOnce(db, [gmailOutRow()]);
  await syncOnce(db, [gmailOutRow()]);
  await syncOnce(db, [gmailOutRow()]);
  const rows = all(db);
  assert.equal(rows.length, 1);
  assert.equal(rows.filter((r) => r.rfc_message_id === RFC).length, 1, "RFC Message-ID stays unique");
  assert.ok(!rows.some((r) => String(r.id).startsWith(SMTP_SENT_ID_PREFIX)), "no temporary row left behind");
});

test("18b. Message-ID matching is normalised (with/without angle brackets) and org-isolated", async () => {
  const db = makeDb();
  await persistSmtpSentEmail(db, sent({ messageId: "CAF+abc123@mail.gmail.com" })); // bare id
  // a different org's Gmail sync with the same Message-ID must not touch this org's row
  await reconcileSmtpSentRows(db, OTHER_ORG, [{ id: "zzz", rfc_message_id: RFC, direction: "out", body_text: "" }]);
  assert.equal(all(db)[0].id, `${SMTP_SENT_ID_PREFIX}CAF+abc123@mail.gmail.com`);
  const res = await syncOnce(db, [gmailOutRow()]);
  assert.equal(res.rekeyed, 1);
  assert.equal(all(db).length, 1);
});

test("inbound rows and unrelated messages are never re-keyed or altered", async () => {
  const db = makeDb();
  await persistSmtpSentEmail(db, sent());
  const inbound = gmailOutRow({ id: "18c0ffee00000002", direction: "in", labels: ["INBOX"], rfc_message_id: "<reply-1@example.com>", body_text: "Thanks!" });
  const res = await syncOnce(db, [inbound]);
  assert.deepEqual(res, { rekeyed: 0, failed: 0 });
  assert.equal(all(db).length, 2);
  assert.equal(all(db).find((r) => r.id === "18c0ffee00000002").body_text, "Thanks!");
  assert.ok(all(db).some((r) => r.id.startsWith(SMTP_SENT_ID_PREFIX)));
});

test("persistence still succeeds if the body_text migration has not been applied yet (send is never lost)", async () => {
  const inner = makeDb();
  const db = {
    ...inner,
    from(table: string) {
      const b = inner.from(table);
      const insert = b.insert.bind(b);
      b.insert = (row: any) =>
        "body_text" in row
          ? Promise.resolve({ data: null, error: { code: "42703", message: 'column "body_text" of relation "gmail_messages" does not exist' } })
          : insert(row);
      return b;
    },
  } as any;
  const res = await persistSmtpSentEmail(db, sent());
  assert.equal(res.persisted, true);
  const rows = inner.__dumpTable("gmail_messages");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].snippet, sent().body, "the text is still stored (snippet) for the fallback display");
  assert.ok(!("body_text" in rows[0]));
});
