// src/lib/gmail-conversations.test.ts
//
// Run:  node --test src/lib/gmail-conversations.test.ts
// Bundles the REAL fetchGmailConversations (src/lib/gmail-conversations.ts) with
// esbuild and runs it against the in-memory fake Supabase (no live Supabase).
// Covers how Conversations builds email messages: subject is its own field,
// legacy snippet-only rows fall back safely, the list query never pulls full
// bodies, and the newest rows are the ones fetched.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const outDir = mkdtempSync(path.join(tmpdir(), "gmail-conversations-"));
after(() => {
  delete (globalThis as any).__testSupabase;
  rmSync(outDir, { recursive: true, force: true });
});

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "test-support/email-entry.ts")],
  outfile: path.join(outDir, "entry.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  alias: { "@/lib/supabase": path.join(here, "test-support/supabase-stub.ts"), "@": path.join(repoRoot, "src") },
  define: { "import.meta.env.DEV": "false", "import.meta.env.VITE_SUPABASE_URL": '"https://fake.supabase.co"', "import.meta.env.VITE_SUPABASE_ANON_KEY": '"fake"' },
});
const { fetchGmailConversations }: any = await import(pathToFileURL(path.join(outDir, "entry.mjs")).href);
const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href);

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTACT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

function install(rows: any[]) {
  const selects: Array<{ table: string; cols: string }> = [];
  const inner = createFakeSupabaseClient({
    gmail_messages: rows,
    contacts: [{ id: CONTACT, org_id: ORG, full_name: "Sam Lead", email: "sam@example.com" }],
    conversation_states: [],
  });
  (globalThis as any).__testSupabase = {
    from(table: string) {
      const b = inner.from(table);
      const select = b.select.bind(b);
      b.select = (cols: string, opts?: unknown) => {
        selects.push({ table, cols });
        return select(cols, opts);
      };
      return b;
    },
  };
  return selects;
}

const row = (id: string, minutes: number, over: Record<string, unknown> = {}) => ({
  id,
  org_id: ORG,
  thread_id: "thr-1",
  internal_date: new Date(Date.UTC(2026, 8, 20, 12, minutes)).toISOString(),
  created_at: new Date(Date.UTC(2026, 8, 20, 12, minutes)).toISOString(),
  snippet: "Can you start Monday?",
  from_email: "Sam Lead <sam@example.com>",
  to_emails: ["sales@renometa.com"],
  subject: "Kitchen remodel",
  labels: ["INBOX"],
  rfc_message_id: `<${id}@example.com>`,
  // A body column exists on the row, but the LIST query must not select it.
  body_text: "FULL BODY that must not be shipped with the list",
  ...over,
});

test("10. the subject is its own field and is never concatenated into the body (legacy snippet-only row)", async () => {
  install([row("m1", 0)]);
  const { messages } = await fetchGmailConversations(ORG);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].subject, "Kitchen remodel");
  assert.equal(messages[0].body, "Can you start Monday?", "legacy fallback body is the snippet only");
  assert.ok(!messages[0].body.includes("Kitchen remodel"));
  assert.equal(messages[0].emailRowId, "m1");
  assert.equal(messages[0].direction, "in");
});

test("9. legacy row with no snippet: empty body, subject still separate; HTML-entity subject decoded", async () => {
  install([row("m1", 0, { snippet: null, subject: "Q&amp;A: deck" })]);
  const { messages } = await fetchGmailConversations(ORG);
  assert.equal(messages[0].body, "");
  assert.equal(messages[0].subject, "Q&A: deck");
});

test("the list query does not select body_text (full bodies load only for the open thread)", async () => {
  const selects = install([row("m1", 0), row("m2", 5, { labels: ["SENT"], from_email: "sales@renometa.com", to_emails: ["sam@example.com"] })]);
  await fetchGmailConversations(ORG);
  const gm = selects.filter((s) => s.table === "gmail_messages");
  assert.equal(gm.length, 1);
  assert.ok(!gm[0].cols.includes("body_text"));
  assert.ok(gm[0].cols.includes("snippet"));
});

test("thread order follows the message timestamps (oldest to newest) and direction comes from the SENT label", async () => {
  install([row("m2", 5, { labels: ["SENT"], from_email: "sales@renometa.com", to_emails: ["sam@example.com"], snippet: "Yes" }), row("m1", 0), row("m3", 10, { snippet: "Great" })]);
  const { conversations, messages } = await fetchGmailConversations(ORG);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].id, `gm-contact-${CONTACT}`);
  const ordered = messages.filter((m: any) => m.conversationId === conversations[0].id).sort((a: any, b: any) => +new Date(a.at) - +new Date(b.at));
  assert.deepEqual(ordered.map((m: any) => m.emailRowId), ["m1", "m2", "m3"]);
  assert.deepEqual(ordered.map((m: any) => m.direction), ["in", "out", "in"]);
});

test("the newest rows are fetched: with more than 2000 rows the latest reply is still present", async () => {
  const many = Array.from({ length: 2100 }, (_, i) => row(`old${i}`, 0, { thread_id: `t${i}`, internal_date: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
  many.push(row("brand-new-reply", 30, { thread_id: "t-new", internal_date: new Date(Date.UTC(2026, 8, 25)).toISOString() }));
  install(many);
  const { messages } = await fetchGmailConversations(ORG);
  assert.equal(messages.length, 2000);
  assert.ok(messages.some((m: any) => m.emailRowId === "brand-new-reply"), "newest message is not cut off");
  assert.ok(!messages.some((m: any) => m.emailRowId === "old0"), "the oldest rows are what falls off");
});
