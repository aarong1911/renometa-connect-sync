// src/lib/command-center-deal-activity.test.ts
//
// Run:  node --test src/lib/command-center-deal-activity.test.ts
//
// Command Center Recent Activity → deal events. Production returned
// HTTP 400 / 42703 "column deals_1.name does not exist" because the embed
// asked for deals.name; the real column is deals.title (confirmed against
// the live PostgREST schema, and by deals-store.ts / contact-activity.ts /
// the lead-conversion RPC, which all read or write deals.title).
//
// Drives the REAL query builder against a recording fake client and parses
// the actual select expression — not a source-string grep.

import assert from "node:assert/strict";
import test from "node:test";

const M = await import("./command-center-deal-activity.ts");

const ORG = "11111111-1111-4111-8111-111111111111";

// Columns confirmed to exist (live PostgREST probe + repo evidence).
const REAL_COLUMNS: Record<string, Set<string>> = {
  deal_activities: new Set(["id", "activity_type", "title", "description", "occurred_at", "org_id", "deal_id"]),
  deals: new Set(["id", "title", "contact_id", "org_id", "value", "status"]),
  contacts: new Set(["id", "full_name", "avatar_url", "avatar_key"]),
};

type Field = { alias: string | null; column: string } | { embed: string; hint: string | null; fields: Field[] };

/** Minimal PostgREST select parser: `a, alias:col, rel!hint(…)`. */
function parseSelect(src: string): Field[] {
  let i = 0;
  function list(): Field[] {
    const out: Field[] = [];
    while (i < src.length) {
      while (src[i] === " " || src[i] === ",") i++;
      if (src[i] === ")" || i >= src.length) break;
      let token = "";
      while (i < src.length && !",()".includes(src[i])) token += src[i++];
      token = token.trim();
      if (src[i] === "(") {
        i++;
        const [embed, hint = null] = token.split("!");
        out.push({ embed, hint, fields: list() });
        i++; // ")"
      } else {
        const [a, b] = token.split(":");
        out.push(b === undefined ? { alias: null, column: a } : { alias: a, column: b });
      }
    }
    return out;
  }
  return list();
}

function assertColumnsExist(table: string, fields: Field[]) {
  for (const f of fields) {
    if ("embed" in f) assertColumnsExist(f.embed, f.fields);
    else assert.ok(REAL_COLUMNS[table].has(f.column), `${table}.${f.column} does not exist`);
  }
}

function recordingClient(result: { data?: unknown; error?: unknown; throws?: Error } = {}) {
  const calls: [string, ...unknown[]][] = [];
  const builder: any = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) {
    builder[method] = (...args: unknown[]) => { calls.push([method, ...args]); return builder; };
  }
  builder.then = (resolve: any, reject: any) =>
    result.throws ? Promise.reject(result.throws).then(resolve, reject)
      : Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve, reject);
  const client: any = { from: (table: string) => { calls.push(["from", table]); return builder; } };
  return { client, calls };
}

function row(id: string, type: string, deals: any, at = "2026-10-20T10:00:00Z") {
  return { id, activity_type: type, title: null, description: null, occurred_at: at, deals };
}
const contact = { id: "c1", full_name: "Jane Homeowner", avatar_url: "https://x/a.png", avatar_key: "k1" };

test("query: selects only existing columns — deals.title aliased to name, never deals.name", () => {
  const { client, calls } = recordingClient();
  M.queryRecentDealActivity(client, ORG);
  const select = calls.find((c) => c[0] === "select")![1] as string;
  const fields = parseSelect(select);
  assertColumnsExist("deal_activities", fields);

  const deals = fields.find((f) => "embed" in f && f.embed === "deals") as Extract<Field, { embed: string }>;
  assert.equal(deals.hint, "deal_id");
  const nameField = deals.fields.find((f) => !("embed" in f) && (f.alias ?? f.column) === "name") as any;
  assert.deepEqual(nameField, { alias: "name", column: "title" });
  assert.ok(!deals.fields.some((f) => !("embed" in f) && f.column === "name"), "deals.name must never be requested");

  const contacts = deals.fields.find((f) => "embed" in f && f.embed === "contacts") as Extract<Field, { embed: string }>;
  assert.equal(contacts.hint, "contact_id");
  assert.deepEqual(contacts.fields.map((f: any) => f.column), ["id", "full_name", "avatar_url", "avatar_key"]);
});

test("query: org filter, created/won/lost only, newest first, limit 4", () => {
  const { client, calls } = recordingClient();
  M.queryRecentDealActivity(client, ORG);
  assert.deepEqual(calls.filter((c) => c[0] !== "select"), [
    ["from", "deal_activities"],
    ["eq", "org_id", ORG],
    ["in", "activity_type", ["created", "won", "lost"]],
    ["order", "occurred_at", { ascending: false }],
    ["limit", 4],
  ]);
});

test("items: contact name leads, deal title is the subtitle, avatar from the contact", () => {
  const items = M.toDealActivityFeedItems([
    row("a1", "won", { name: "Kitchen remodel", contact_id: "c1", contacts: contact }),
    row("a2", "lost", { name: "Deck", contact_id: "c1", contacts: contact }),
    row("a3", "created", { name: "Bath", contact_id: "c1", contacts: contact }),
  ]);
  assert.deepEqual(items[0], {
    id: "da1", who: "Jane Homeowner", t: "Deal won", s: "Kitchen remodel", when: "", at: "2026-10-20T10:00:00Z",
    kind: "deal", contactId: "c1", avatarUrl: "https://x/a.png", avatarKey: "k1",
  });
  assert.deepEqual(items.map((i) => i.t), ["Deal won", "Deal lost", "Deal created"]);
});

test("items: deal without a contact falls back to the deal title and the entity icon", () => {
  const [item] = M.toDealActivityFeedItems([row("a1", "created", { name: "Roof", contact_id: null, contacts: null })]);
  assert.equal(item.who, "Roof");
  assert.equal(item.s, "");
  assert.equal(item.contactId, undefined);
  assert.equal(item.avatarUrl, null);
});

test("items: missing/deleted deal or array-shaped embeds never crash", () => {
  const items = M.toDealActivityFeedItems([
    row("a1", "won", null),
    row("a2", "created", { name: null, contact_id: null, contacts: null }),
    row("a3", "lost", [{ name: "Siding", contact_id: "c1", contacts: [contact] }]),
  ]);
  assert.equal(items[0].who, "Deal");
  assert.equal(items[1].who, "Deal");
  assert.equal(items[2].who, "Jane Homeowner");
  assert.equal(items[2].s, "Siding");
});

test("load: empty results give an empty feed", async () => {
  assert.deepEqual(await M.loadRecentDealActivityItems(recordingClient({ data: [] }).client, ORG), []);
  assert.deepEqual(await M.loadRecentDealActivityItems(recordingClient({ data: null }).client, ORG), []);
  assert.deepEqual(M.toDealActivityFeedItems(undefined), []);
});

test("load: a Supabase error or thrown error returns [] with a warning instead of breaking the page", async () => {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const apiError = { code: "42703", message: "column deals_1.name does not exist" };
    assert.deepEqual(await M.loadRecentDealActivityItems(recordingClient({ error: apiError }).client, ORG), []);
    assert.deepEqual(await M.loadRecentDealActivityItems(recordingClient({ throws: new Error("network down") }).client, ORG), []);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 2);
  assert.deepEqual(warnings[0][1], { code: "42703", message: "column deals_1.name does not exist" });
});

test("load: success maps rows through the real query", async () => {
  const { client, calls } = recordingClient({ data: [row("a1", "won", { name: "Kitchen", contact_id: "c1", contacts: contact })] });
  const items = await M.loadRecentDealActivityItems(client, ORG);
  assert.equal(items.length, 1);
  assert.equal(items[0].s, "Kitchen");
  assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "org_id" && c[2] === ORG));
});
