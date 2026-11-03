// src/lib/realtime-optional-subscription.test.ts
//
// Run:  node --test src/lib/realtime-optional-subscription.test.ts
//
// Production 2026-11-02: the shared `realtime-bridge-${orgId}` channel never
// subscribed. Its `deal_activities` INSERT binding was rejected ("Please check
// Realtime is enabled…" — the table is not in the supabase_realtime
// publication), and Realtime fails a whole channel when any one binding is
// rejected, so every CRM / organization / team binding on it was dead too.
//
// The fake client below models exactly that server rule. The behavioral tests
// drive the REAL subscribeOptionalTable(); the bridge tests feed the shared
// channel's REAL bindings (parsed from realtime-bridge.tsx — the repo has no
// component harness to mount RealtimeBridge) through the same fake.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const { subscribeOptionalTable, rejectedRealtimeTable } = await import("./realtime-optional-subscription.ts");

const ORG = "11111111-1111-4111-8111-111111111111";
const bridge = readFileSync(new URL("./realtime-bridge.tsx", import.meta.url), "utf8");

// Tables in the production supabase_realtime publication that the bridge uses
// (verified against the live endpoint); deal_activities is deliberately absent.
const PUBLISHED = new Set([
  "conversation_states", "contacts", "leads", "deals", "projects", "tasks", "appointments",
  "companies", "company_contacts", "company_notes", "company_activities", "project_files",
  "organizations", "org_memberships", "profiles", "invitations", "member_permissions",
  "sms_meta_messages", "agent_approval_requests",
]);

type Binding = { event: string; schema: string; table: string; filter?: string };

class FakeChannel {
  bindings: { filter: Binding; callback: (p: unknown) => void }[] = [];
  status: string | null = null;
  removed = false;
  private statusCallback?: (status: string, err?: Error) => void;
  readonly name: string;
  private readonly client: FakeClient;
  constructor(name: string, client: FakeClient) { this.name = name; this.client = client; }
  on(_type: string, filter: any, callback: (p: unknown) => void) {
    this.bindings.push({ filter, callback });
    return this;
  }
  subscribe(callback?: (status: string, err?: Error) => void) {
    this.statusCallback = callback;
    const rejected = this.bindings.find((b) => !this.client.published.has(b.filter.table));
    this.status = rejected ? "CHANNEL_ERROR" : "SUBSCRIBED";
    callback?.(this.status, rejected ? new Error("rejected") : undefined);
    return this;
  }
  emitStatus(status: string) { this.statusCallback?.(status); }
  deliver(table: string, event: string, payload: unknown) {
    if (this.removed || this.status !== "SUBSCRIBED") return 0;
    const hits = this.bindings.filter((b) => b.filter.table === table && (b.filter.event === event || b.filter.event === "*"));
    hits.forEach((b) => b.callback(payload));
    return hits.length;
  }
}

class FakeClient {
  channels: FakeChannel[] = [];
  removeCalls = 0;
  readonly published: Set<string>;
  constructor(published: Set<string>) { this.published = published; }
  channel(name: string) { const c = new FakeChannel(name, this); this.channels.push(c); return c; }
  removeChannel(c: FakeChannel) {
    this.removeCalls++;
    c.removed = true;
    c.emitStatus("CLOSED"); // realtime-js reports CLOSED to the subscribe callback on removal
  }
}

/** The shared channel's postgres_changes bindings, exactly as written in realtime-bridge.tsx. */
function sharedChannelBindings(): Binding[] {
  const start = bridge.indexOf(".channel(`realtime-bridge-${orgId}`)");
  assert.ok(start > 0, "shared realtime-bridge channel not found");
  const block = bridge.slice(start, bridge.indexOf(".subscribe(", start));
  const re = /\{ event: "([A-Z*]+)", schema: "(\w+)", table: "(\w+)"(?:, filter: `(\w+)=eq\.\$\{orgId\}`)? \}/g;
  return [...block.matchAll(re)].map(([, event, schema, table, col]) => ({
    event, schema, table, ...(col ? { filter: `${col}=eq.${ORG}` } : {}),
  }));
}

function subscribeShared(client: FakeClient, bindings: Binding[]) {
  const c = client.channel(`realtime-bridge-${ORG}`);
  for (const b of bindings) c.on("postgres_changes", b, () => {});
  return c.subscribe();
}

test("an unpublished optional table cannot disable the shared CRM channel", () => {
  const client = new FakeClient(PUBLISHED);
  const logs: Record<string, unknown>[] = [];
  const shared = subscribeShared(client, sharedChannelBindings());
  subscribeOptionalTable(client, {
    channelName: `realtime-deal-activities-${ORG}`, table: "deal_activities", event: "INSERT",
    filter: `org_id=eq.${ORG}`, onChange: () => {},
  }, (_m, d) => logs.push(d));

  assert.equal(shared.status, "SUBSCRIBED");
  assert.equal(shared.removed, false);
  for (const table of ["contacts", "leads", "deals", "projects", "tasks", "organizations", "org_memberships"]) {
    assert.ok(shared.deliver(table, "UPDATE", {}) + shared.deliver(table, "INSERT", {}) > 0, `${table} events must still arrive`);
  }
  const optional = client.channels.find((c) => c.name.startsWith("realtime-deal-activities-"))!;
  assert.equal(optional.removed, true, "a rejected optional channel removes itself instead of rejoining forever");
  assert.equal(logs.length, 1);
});

test("counterfactual: the same binding on the shared channel fails every CRM binding (the production bug)", () => {
  const client = new FakeClient(PUBLISHED);
  const withDealActivities = [...sharedChannelBindings(), { event: "INSERT", schema: "public", table: "deal_activities", filter: `org_id=eq.${ORG}` }];
  const shared = subscribeShared(client, withDealActivities);
  assert.equal(shared.status, "CHANNEL_ERROR");
  assert.equal(shared.deliver("contacts", "INSERT", {}), 0);
});

test("the shared channel keeps every published CRM, organization, team and Conversations binding", () => {
  const bindings = sharedChannelBindings();
  assert.equal(bindings.length, 45);
  assert.deepEqual(
    [...new Set(bindings.map((b) => b.table))].sort(),
    ["appointments", "companies", "company_activities", "company_contacts", "company_notes", "contacts",
      "conversation_states", "deals", "invitations", "leads", "member_permissions", "org_memberships",
      "organizations", "profiles", "project_files", "projects", "tasks"],
  );
  for (const b of bindings) assert.ok(PUBLISHED.has(b.table), `${b.table} on the shared channel must be published`);
  assert.ok(!bindings.some((b) => b.table === "deal_activities"), "deal_activities must never return to the shared channel");
});

test("deal_activities is subscribed only through the isolated optional helper, and cleaned up", () => {
  assert.equal((bridge.match(/table: "deal_activities"/g) ?? []).length, 1);
  assert.match(bridge, /subscribeOptionalTable\(supabase, \{\s*channelName: `realtime-deal-activities-\$\{orgId\}`,\s*table: "deal_activities",\s*event: "INSERT",\s*filter: `org_id=eq\.\$\{orgId\}`,\s*onChange: \(\) => invalidatePipelinePulse\(\),/);
  assert.match(bridge, /return \(\) => \{[^}]*dealActivitiesCleanup\(\);/);
});

test("every bridge channel logs which table Realtime rejected", () => {
  for (const name of ["realtime-bridge", "realtime-sms", "realtime-ai-approvals"]) {
    assert.match(bridge, new RegExp(`\\.channel\\(\`${name}-\\$\\{orgId\\}\`\\)\\s*\\.on\\("system", \\{\\}, logRejectedBinding\\("${name}"\\)\\)`));
  }
});

test("optional subscription delivers events while subscribed, with the filter it was given", () => {
  const client = new FakeClient(new Set([...PUBLISHED, "deal_activities"]));
  let calls = 0;
  subscribeOptionalTable(client, {
    channelName: "opt", table: "deal_activities", event: "INSERT", filter: `org_id=eq.${ORG}`, onChange: () => calls++,
  }, () => assert.fail("must not log when subscribed"));
  const c = client.channels[0];
  assert.deepEqual(c.bindings[0].filter, { event: "INSERT", schema: "public", table: "deal_activities", filter: `org_id=eq.${ORG}` });
  assert.equal(c.deliver("deal_activities", "INSERT", { new: {} }), 1);
  assert.equal(calls, 1);
  assert.equal(c.removed, false);
});

test("TIMED_OUT keeps the optional channel (realtime-js rejoins); only CHANNEL_ERROR removes it", () => {
  const client = new FakeClient(new Set([...PUBLISHED, "deal_activities"]));
  const logs: unknown[] = [];
  subscribeOptionalTable(client, { channelName: "opt", table: "deal_activities", event: "INSERT", onChange: () => {} }, (_m, d) => logs.push(d));
  const c = client.channels[0];
  c.emitStatus("TIMED_OUT");
  assert.equal(c.removed, false);
  assert.equal(logs.length, 0);
  c.emitStatus("CHANNEL_ERROR");
  assert.equal(c.removed, true);
  assert.equal(logs.length, 1);
});

test("cleanup is idempotent and the CLOSED after removal is not reported as a failure", () => {
  const client = new FakeClient(PUBLISHED);
  const logs: unknown[] = [];
  const cleanup = subscribeOptionalTable(client, { channelName: "opt", table: "deal_activities", event: "INSERT", onChange: () => {} }, (_m, d) => logs.push(d));
  assert.equal(client.removeCalls, 1); // removed itself after the rejection
  cleanup();
  cleanup();
  assert.equal(client.removeCalls, 1);
  assert.equal(logs.length, 1);

  const healthy = new FakeClient(new Set([...PUBLISHED, "deal_activities"]));
  const stop = subscribeOptionalTable(healthy, { channelName: "opt", table: "deal_activities", event: "INSERT", onChange: () => {} }, () => assert.fail("unmount must not log"));
  stop();
  stop();
  assert.equal(healthy.removeCalls, 1);
});

test("failure log names the table but carries no filter values, payloads or tokens", () => {
  const client = new FakeClient(PUBLISHED);
  let message = "";
  let details: Record<string, unknown> = {};
  subscribeOptionalTable(client, {
    channelName: "realtime-deal-activities-x", table: "deal_activities", event: "INSERT", filter: `org_id=eq.${ORG}`, onChange: () => {},
  }, (m, d) => { message = m; details = d; });
  assert.deepEqual(Object.keys(details).sort(), ["channel", "event", "status", "table"]);
  assert.equal(details.table, "deal_activities");
  assert.doesNotMatch(message + JSON.stringify(details), new RegExp(ORG));
  assert.doesNotMatch(message + JSON.stringify(details), /eyJ|access_token|apikey/i);
});

test("rejectedRealtimeTable extracts only the table from the real server message", () => {
  // Verbatim shape of the production rejection (2026-11-02), org id replaced.
  const real = `Unable to subscribe to changes with given parameters. Please check Realtime is enabled for the given connect parameters: [event: INSERT, schema: public, table: deal_activities, filters: [{"org_id", "eq", "${ORG}", false}], select: nil]`;
  assert.equal(rejectedRealtimeTable(real), "deal_activities");
  assert.equal(rejectedRealtimeTable("something else"), null);
  assert.equal(rejectedRealtimeTable(undefined), null);
  assert.equal(rejectedRealtimeTable({ table: "x" }), null);
});
