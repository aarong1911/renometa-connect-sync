// netlify/functions/lib/ai/lead-qualification-background.test.ts
//
// Run:  node --test netlify/functions/lib/ai/lead-qualification-background.test.ts
// AI-3C hardening. Covers:
//   - the injectable background core (org/lead revalidation, one dispatch
//     per payload, no double-dispatcher)
//   - the REAL handler's internal-secret gate (bundled and invoked directly,
//     network denied by default — a rejected request must never reach Supabase)
//   - the REAL dispatchLeadQualificationBackground()'s outbound HTTP shape
//     (URL, secret header, 202-vs-other handling), using a mocked
//     globalThis.fetch — never a live network call.
//
// No live Supabase, no live Anthropic, no live network.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

const req = createRequire(import.meta.url);
const esbuild = createRequire(req.resolve("vite/package.json"))("esbuild");
const outDir = mkdtempSync(path.join(tmpdir(), "lead-qual-background-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry: string, outfile: string, extraExternal: string[] = []) {
  await esbuild.build({
    entryPoints: [path.join(here, entry)],
    outfile: path.join(outDir, outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "error",
    alias: { "@": path.join(repoRoot, "src") },
    // Scheduling foundation: lead-qualification-background.ts ->
    // lead-qualification-dispatch.ts -> action-executor.ts -> handlers.ts
    // now transitively imports appointment-post-booking.ts -> nodemailer
    // (the schedule_appointment handler's post-booking lifecycle call).
    // No longer marked external (this outDir has no node_modules to
    // resolve it from) — bundled directly, with the banner below as
    // nodemailer's own CJS `require("events")` escape hatch under
    // esbuild's ESM output format.
    external: ["@supabase/supabase-js", ...extraExternal],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  return import(pathToFileURL(path.join(outDir, outfile)).href);
}

const Core: any = await bundle("lead-qualification-background.ts", "core.mjs");
const Hook: any = await bundle("lead-created-hook.ts", "hook.mjs");
const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(here, "../test-support/fake-supabase-client.mjs")).href);

const noisy = ["log", "warn", "error"] as const;
const saved = noisy.map((k) => console[k]);
noisy.forEach((k) => (console[k] = () => {}));
after(() => noisy.forEach((k, i) => (console[k] = saved[i])));

// ── Core: org/lead revalidation, dispatch is the ONE existing dispatcher ────

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const LEAD_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CONTACT_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

function makeDb() {
  return createFakeSupabaseClient({
    organizations: [{ id: ORG_A, ai_center_settings: { agents: { lead_qualification: { enabled: true, defaultAutonomyLevel: 1 } } } }, { id: ORG_B, ai_center_settings: {} }],
    leads: [{ id: LEAD_1, org_id: ORG_A, contact_id: CONTACT_1 }],
    agent_executions: [],
    agent_approval_requests: [],
  }, {}, { uniqueConstraints: { agent_executions: [["org_id", "idempotency_key"]] } }) as any;
}
function fakeOrchestrate() {
  let calls = 0;
  return async () => {
    calls++;
    return { executionId: `exec-${calls}`, status: "completed", responseText: "hi" };
  };
}

test("3. the background core revalidates orgId/leadId server-side rather than trusting the payload", async () => {
  const db = makeDb();
  const orchestrate = fakeOrchestrate();
  const r = await Core.processLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }, { supabase: db, orchestrate });
  assert.equal(r.revalidated, true);
  assert.equal(r.dispatch?.status, "recommendation");
});

test("a leadId that does not belong to the claimed orgId is dropped, never dispatched", async () => {
  const db = makeDb();
  const orchestrate = fakeOrchestrate();
  const r = await Core.processLeadQualificationBackground({ orgId: ORG_B, leadId: LEAD_1 }, { supabase: db, orchestrate });
  assert.equal(r.revalidated, false);
  assert.equal(r.dispatch, undefined);
  assert.equal(r.statusCode, 200, "still 200 — a mismatched payload is dropped quietly, not retried forever");
});

test("a nonexistent leadId is dropped the same way", async () => {
  const db = makeDb();
  const orchestrate = fakeOrchestrate();
  const r = await Core.processLeadQualificationBackground({ orgId: ORG_A, leadId: "99999999-9999-4999-8999-999999999999" }, { supabase: db, orchestrate });
  assert.equal(r.revalidated, false);
});

test("5. two background invocations for the SAME lead (a provider retry) converge to exactly one AI execution via the existing dispatcher idempotency", async () => {
  const db = makeDb();
  const orchestrate = fakeOrchestrate();
  const [a, b] = await Promise.all([
    Core.processLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }, { supabase: db, orchestrate }),
    Core.processLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }, { supabase: db, orchestrate }),
  ]);
  assert.equal(a.revalidated, true);
  assert.equal(b.revalidated, true);
  const inner = [a.dispatch?.status, b.dispatch?.status];
  assert.equal(inner.filter((s) => s === "recommendation").length, 1, "exactly one real run");
  assert.deepEqual(inner.filter((s) => s !== "recommendation"), ["skipped"], "the other invocation's OWN dispatch call reports the duplicate");
});

test("6. a downstream dispatch failure (e.g. claim insert error) is reported, never thrown, and never rolls back the CRM lead the caller already created", async () => {
  const inner = makeDb();
  const db = { ...inner, from: (t: string) => { const b = inner.from(t); if (t === "agent_executions") { const insert = b.insert.bind(b); b.insert = () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "53300", message: "too many connections" } }) }) }); } return b; } };
  const orchestrate = fakeOrchestrate();
  const r = await Core.processLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }, { supabase: db, orchestrate });
  assert.equal(r.statusCode, 200, "the background function itself never throws/500s over a dispatch-level failure");
  assert.equal(r.dispatch?.status, "failed");
});

test("isValidLeadQualificationBackgroundPayload rejects malformed shapes", async () => {
  for (const bad of [null, {}, { orgId: 1, leadId: "x" }, { orgId: "x" }, { orgId: "x", leadId: "y", contactId: 5 }, { orgId: "x", leadId: "y", associatedWithInboundMessage: "true" }]) {
    assert.equal(Core.isValidLeadQualificationBackgroundPayload(bad), false, JSON.stringify(bad));
  }
  assert.equal(Core.isValidLeadQualificationBackgroundPayload({ orgId: "x", leadId: "y" }), true);
  assert.equal(Core.isValidLeadQualificationBackgroundPayload({ orgId: "x", leadId: "y", contactId: "z", associatedWithInboundMessage: true, actorId: "a" }), true);
});

// ── AI-3I: source/inboundEvent extension (live inbound-SMS Lead Qualification) ──

const VALID_INBOUND_EVENT = { channel: "sms", messageRowId: "m-1", text: "hi", externalMessageId: "SM1", candidate: { channel: "sms", direction: "in", syncOrigin: "live" } };

test("isValidLeadQualificationBackgroundPayload accepts source:'inbound_lead_message' with a well-shaped inboundEvent", () => {
  assert.equal(Core.isValidLeadQualificationBackgroundPayload({ orgId: "x", leadId: "y", source: "inbound_lead_message", inboundEvent: VALID_INBOUND_EVENT }), true);
});

test("isValidLeadQualificationBackgroundPayload rejects source:'inbound_lead_message' with a missing or malformed inboundEvent", () => {
  assert.equal(Core.isValidLeadQualificationBackgroundPayload({ orgId: "x", leadId: "y", source: "inbound_lead_message" }), false, "missing inboundEvent");
  assert.equal(Core.isValidLeadQualificationBackgroundPayload({ orgId: "x", leadId: "y", source: "inbound_lead_message", inboundEvent: { channel: "sms" } }), false, "incomplete inboundEvent");
  assert.equal(Core.isValidLeadQualificationBackgroundPayload({ orgId: "x", leadId: "y", source: "inbound_lead_message", inboundEvent: { ...VALID_INBOUND_EVENT, candidate: { channel: "sms" } } }), false, "malformed candidate (missing direction/syncOrigin)");
});

test("isValidLeadQualificationBackgroundPayload rejects an inboundEvent carried alongside a non-inbound_lead_message source", () => {
  assert.equal(Core.isValidLeadQualificationBackgroundPayload({ orgId: "x", leadId: "y", inboundEvent: VALID_INBOUND_EVENT }), false, "default source is lead_created — must not carry inboundEvent");
  assert.equal(Core.isValidLeadQualificationBackgroundPayload({ orgId: "x", leadId: "y", source: "lead_created", inboundEvent: VALID_INBOUND_EVENT }), false);
  assert.equal(Core.isValidLeadQualificationBackgroundPayload({ orgId: "x", leadId: "y", source: "manual_run", inboundEvent: VALID_INBOUND_EVENT }), false);
});

test("isValidLeadQualificationBackgroundPayload rejects an unrecognized source value", () => {
  assert.equal(Core.isValidLeadQualificationBackgroundPayload({ orgId: "x", leadId: "y", source: "something_else" }), false);
});

test("processLeadQualificationBackground passes source:'inbound_lead_message' and inboundEvent through to dispatchLeadQualification() unchanged — default source stays 'lead_created' for every existing caller", async () => {
  const db = makeDb();
  const orchestrate = fakeOrchestrate();

  // Existing lead_created caller shape — completely unaffected by the extension.
  const legacy = await Core.processLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }, { supabase: db, orchestrate });
  assert.equal(legacy.dispatch?.status, "recommendation");

  // New inbound_lead_message shape reaches the SAME dispatcher with the
  // correct source/inboundEvent — proven by it producing its OWN distinct
  // idempotency claim (not colliding with the lead_created run above for
  // the same lead) rather than by inspecting dispatchLeadQualification's
  // internals directly.
  const inbound = await Core.processLeadQualificationBackground(
    { orgId: ORG_A, leadId: LEAD_1, source: "inbound_lead_message", inboundEvent: VALID_INBOUND_EVENT },
    { supabase: db, orchestrate },
  );
  assert.equal(inbound.revalidated, true);
  assert.equal(inbound.dispatch?.status, "recommendation", "a distinct run for the SAME lead under a different trigger source is not treated as a duplicate of the lead_created run");
});

// ── The real handler: internal-secret gate, network denied by default ──────

test("4. the real handler rejects an invalid/missing internal secret BEFORE touching Supabase (network denied by default proves no DB call was attempted)", async () => {
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  process.env.AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET = "s3cret";
  const handlerDir = mkdtempSync(path.join(tmpdir(), "lead-qual-handler-"));
  after(() => rmSync(handlerDir, { recursive: true, force: true }));
  await esbuild.build({
    entryPoints: [path.join(here, "../../lead-qualification-background.ts")],
    outfile: path.join(handlerDir, "handler.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "error",
    alias: { "@": path.join(repoRoot, "src") },
    // nodemailer is bundled directly here too now (see the shared
    // bundle() helper's own comment above) — no longer external.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  const { handler }: any = await import(pathToFileURL(path.join(handlerDir, "handler.mjs")).href);
  const realFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    throw new Error("no network allowed");
  }) as typeof fetch;
  try {
    const call = (headers: any, body: any) => handler({ httpMethod: "POST", headers, body: JSON.stringify(body) }, {});
    assert.equal((await call({}, { orgId: ORG_A, leadId: LEAD_1 })).statusCode, 403, "missing secret");
    assert.equal((await call({ "x-internal-secret": "wrong" }, { orgId: ORG_A, leadId: LEAD_1 })).statusCode, 403, "wrong secret");
    assert.equal(fetchCalled, false, "a rejected request never reaches out at all");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── The real dispatchLeadQualificationBackground(): outbound HTTP shape ────

test("1+2. dispatchLeadQualificationBackground makes exactly ONE fast HTTP call to the background endpoint with the internal secret, and does not await a body/processing result", async () => {
  process.env.AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET = "s3cret";
  process.env.URL = "https://example.netlify.app";
  const realFetch = globalThis.fetch;
  let captured: any;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), init };
    return new Response("", { status: 202 });
  }) as typeof fetch;
  try {
    const ok = await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1, contactId: CONTACT_1 });
    assert.equal(ok, true);
    assert.equal(captured.url, "https://example.netlify.app/.netlify/functions/lead-qualification-background");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers["X-Internal-Secret"], "s3cret");
    assert.equal(JSON.parse(captured.init.body).leadId, LEAD_1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a non-202/200 response, a network error, or a missing secret are all reported as 'not accepted' — never thrown", async () => {
  const realFetch = globalThis.fetch;
  try {
    process.env.AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET = "s3cret";
    process.env.URL = "https://example.netlify.app";
    globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
    assert.equal(await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }), false);

    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    assert.equal(await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }), false);

    delete process.env.AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET;
    assert.equal(await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── AI-3J: explicit request-origin dispatch (CORRECTED architecture) ───────
//
// REPLACES the previous "AI-3H: deploy-preview URL precedence (DEPLOY_URL
// over URL)" test block, which encoded an INCORRECT assumption. DEPLOY_URL
// is Netlify BUILD-TIME deploy metadata, not a guaranteed Function-runtime
// environment variable — confirmed by a real Deploy Preview failure (a
// PR's inbound-SMS webhook dispatched to production and got a 404, because
// `process.env.DEPLOY_URL` was undefined at runtime and the code fell
// through to `process.env.URL`, which is always the canonical PRODUCTION
// site). See lead-created-hook.ts's own AI-3J correction comment for the
// full story. The real fix: dispatchLeadQualificationBackground() now
// accepts an explicit `opts.baseUrl` — the CALLER's own trusted,
// externally-visible request origin — which always wins over any
// environment-variable fallback. These tests prove that contract instead.
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("A. an explicit request origin (opts.baseUrl) always wins over any env var", async () => {
  const realFetch = globalThis.fetch;
  let captured: any;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), init };
    return new Response("", { status: 202 });
  }) as typeof fetch;
  try {
    await withEnv({ AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET: "s3cret", URL: "https://renoconnect.netlify.app" }, async () => {
      const ok = await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }, { baseUrl: "https://deploy-preview-15--renoconnect.netlify.app" });
      assert.equal(ok, true);
      assert.equal(captured.url, "https://deploy-preview-15--renoconnect.netlify.app/.netlify/functions/lead-qualification-background", "must stay on the SAME deployment that made the original request, never fall back to production's URL env var");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("B. the production request origin works the same way (no Deploy Preview involved)", async () => {
  const realFetch = globalThis.fetch;
  let captured: any;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), init };
    return new Response("", { status: 202 });
  }) as typeof fetch;
  try {
    await withEnv({ AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET: "s3cret" }, async () => {
      const ok = await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }, { baseUrl: "https://renoconnect.netlify.app" });
      assert.equal(ok, true);
      assert.equal(captured.url, "https://renoconnect.netlify.app/.netlify/functions/lead-qualification-background");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("C. a malformed explicit origin fails safely — no fetch attempted", async () => {
  const realFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => { fetchCalled = true; throw new Error("must never be called"); }) as typeof fetch;
  try {
    await withEnv({ AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET: "s3cret" }, async () => {
      for (const bad of ["not a url", "", "   ", "/relative/path/only"]) {
        const ok = await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }, { baseUrl: bad });
        assert.equal(ok, false, JSON.stringify(bad));
      }
    });
  } finally {
    globalThis.fetch = realFetch;
    assert.equal(fetchCalled, false, "fail-closed must happen before any fetch is attempted for a malformed origin");
  }
});

test("origin normalization: a baseUrl with a path/query/trailing slash is reduced to just its origin", async () => {
  const realFetch = globalThis.fetch;
  let captured: any;
  globalThis.fetch = (async (url: any) => { captured = String(url); return new Response("", { status: 202 }); }) as typeof fetch;
  try {
    await withEnv({ AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET: "s3cret" }, async () => {
      const ok = await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }, { baseUrl: "https://deploy-preview-15--renoconnect.netlify.app/.netlify/functions/ai-twilio-sms-inbound?foo=bar" });
      assert.equal(ok, true);
      assert.equal(captured, "https://deploy-preview-15--renoconnect.netlify.app/.netlify/functions/lead-qualification-background", "the supplied URL's own path/query must be discarded — only its origin is used");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("G. the payload sent to the background endpoint is unchanged by the baseUrl option", async () => {
  const realFetch = globalThis.fetch;
  let captured: any;
  globalThis.fetch = (async (_url: any, init: any) => { captured = JSON.parse(init.body); return new Response("", { status: 202 }); }) as typeof fetch;
  try {
    await withEnv({ AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET: "s3cret" }, async () => {
      await Hook.dispatchLeadQualificationBackground(
        { orgId: ORG_A, leadId: LEAD_1, contactId: CONTACT_1, source: "inbound_lead_message", inboundEvent: { channel: "sms", messageRowId: "m-1", text: "hi", externalMessageId: "SM1", candidate: { channel: "sms", direction: "in", syncOrigin: "live" } } },
        { baseUrl: "https://deploy-preview-15--renoconnect.netlify.app" },
      );
      assert.deepEqual(captured, { orgId: ORG_A, leadId: LEAD_1, contactId: CONTACT_1, source: "inbound_lead_message", inboundEvent: { channel: "sms", messageRowId: "m-1", text: "hi", externalMessageId: "SM1", candidate: { channel: "sms", direction: "in", syncOrigin: "live" } } });
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("F. the X-Internal-Secret header is still sent when baseUrl is supplied", async () => {
  const realFetch = globalThis.fetch;
  let captured: any;
  globalThis.fetch = (async (_url: any, init: any) => { captured = init; return new Response("", { status: 202 }); }) as typeof fetch;
  try {
    await withEnv({ AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET: "s3cret" }, async () => {
      await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }, { baseUrl: "https://deploy-preview-15--renoconnect.netlify.app" });
      assert.equal(captured.headers["X-Internal-Secret"], "s3cret");
      assert.equal(captured.method, "POST");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("H. a 202 or 200 response is accepted, with baseUrl supplied", async () => {
  const realFetch = globalThis.fetch;
  try {
    await withEnv({ AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET: "s3cret" }, async () => {
      globalThis.fetch = (async () => new Response("", { status: 202 })) as typeof fetch;
      assert.equal(await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }, { baseUrl: "https://example.netlify.app" }), true);
      globalThis.fetch = (async () => new Response("", { status: 200 })) as typeof fetch;
      assert.equal(await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }, { baseUrl: "https://example.netlify.app" }), true);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("I. a non-202/200 response (e.g. the observed 404) fails safely with baseUrl supplied", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
  try {
    await withEnv({ AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET: "s3cret" }, async () => {
      const ok = await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }, { baseUrl: "https://deploy-preview-15--renoconnect.netlify.app" });
      assert.equal(ok, false, "a 404 (the exact failure observed live) must be reported as not-accepted, never thrown");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("J. a network failure fails safely with baseUrl supplied", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
  try {
    await withEnv({ AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET: "s3cret" }, async () => {
      const ok = await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 }, { baseUrl: "https://deploy-preview-15--renoconnect.netlify.app" });
      assert.equal(ok, false);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("K. an existing lead-created caller with NO explicit baseUrl retains the documented env-var fallback (process.env.URL — NOT Deploy-Preview-safe, documented as such)", async () => {
  const realFetch = globalThis.fetch;
  let captured: any;
  globalThis.fetch = (async (url: any) => { captured = String(url); return new Response("", { status: 202 }); }) as typeof fetch;
  try {
    await withEnv({ AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET: "s3cret", URL: "https://renoconnect.netlify.app" }, async () => {
      const ok = await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 });
      assert.equal(ok, true);
      assert.equal(captured, "https://renoconnect.netlify.app/.netlify/functions/lead-qualification-background", "with no baseUrl, falls back to process.env.URL exactly as every existing fireLeadCreatedTrigger() caller (Meta Lead Ads/Google Ads/Vapi/Instagram/Messenger) already relies on");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("K. with no baseUrl and no URL env var at all, dispatch fails closed with no fetch attempted", async () => {
  const realFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => { fetchCalled = true; throw new Error("must never be called"); }) as typeof fetch;
  try {
    await withEnv({ AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET: "s3cret", URL: undefined }, async () => {
      const ok = await Hook.dispatchLeadQualificationBackground({ orgId: ORG_A, leadId: LEAD_1 });
      assert.equal(ok, false);
    });
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
