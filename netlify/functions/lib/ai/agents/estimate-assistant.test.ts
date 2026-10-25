// netlify/functions/lib/ai/agents/estimate-assistant.test.ts
//
// Run:  node --test netlify/functions/lib/ai/agents/estimate-assistant.test.ts
//
// Estimate Assistant Foundation — the agent CONTRACT: strict decision schema,
// trusted-input binding, prompt grounding (no invented price / Business
// Knowledge / permit-handling-vs-permit-fees), deterministic readiness
// (known vs missing), and the deterministic customer-reply money guard.
// Pure functions only: no model, no Supabase, no network.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("real network access is forbidden in this test file"); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(tmpdir(), "estimate-assistant-agent-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "estimate-assistant.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const AGENT_INSTRUCTIONS = "You are the Estimate Assistant.";
const EST_ID = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";

const noEstimate = { found: false, pricing: { trustedCatalogAvailable: false, note: "The assistant never sets or infers a price itself: prices are entered or approved by the business owner. Staff-only price suggestions drawn from this organization's own past estimates and change orders may be attached to a run separately (Pricing Intelligence); they are advisory, never final, and never quoted to a customer." } };

function estimateWith(items: any[], overrides: Record<string, unknown> = {}) {
  return {
    found: true, matchedBy: "lead", pricing: noEstimate.pricing,
    estimate: {
      id: EST_ID, number: "EST-000007", title: "Kitchen remodel", status: "draft", clientId: null, leadId: null, projectId: null,
      scope: "Replace cabinets and countertops.", exclusions: null, assumptions: null, validUntil: null,
      taxRate: 0, discountType: null, discountValue: 0, depositType: null, depositValue: 0,
      subtotal: 0, discountTotal: 0, taxTotal: 0, total: 0, depositAmount: 0, balanceDue: 0,
      createdAt: null, updatedAt: null, editableByAssistant: true, ...overrides,
    },
    items,
  };
}
const pending = (name: string) => ({ id: `i-${name}`, name, description: null, itemType: "material", quantity: 1, unit: "each", unitPrice: null, lineTotal: null, optional: false, taxable: true, isHeading: false, pricePending: true });
const priced = (name: string, unitPrice: number, quantity = 1) => ({ id: `i-${name}`, name, description: null, itemType: "material", quantity, unit: "each", unitPrice, lineTotal: unitPrice * quantity, optional: false, taxable: true, isHeading: false, pricePending: false });

const baseContext = (extra: Record<string, unknown> = {}) => ({
  organization: { id: "org-1", name: "Acme Remodeling" },
  channel: "sms" as const,
  lead: { id: "lead-1", status: "qualified", name: "Jane", projectType: "Kitchen remodel — cabinets, countertops, sink" },
  businessKnowledge: { status: "ok", entries: [] },
  ...extra,
});
const evt = (text: string, channel: any = "sms") => ({ eventId: "e1", channel, eventType: "message_received", content: { type: "text" as const, text } });

const decisionText = (ctx: any, event: any, handoff?: any) => {
  const req = S.buildEstimateAssistantDecisionRequest(AGENT_INSTRUCTIONS, ctx, event, handoff);
  return `${req.system}\n\n${req.messages[0].content}`;
};

// ── Decision contract ────────────────────────────────────────────────────

test("tool allowlist is exactly the three estimate actions plus the read-only pricing suggestions tool", () => {
  assert.deepEqual([...S.ESTIMATE_ASSISTANT_TOOL_ALLOWLIST].sort(), ["add_estimate_line_items", "create_estimate_draft", "get_estimate_context", "get_pricing_suggestions"]);
});

test("valid respond / propose / clarify decisions parse", () => {
  const cases = [
    { type: "respond", response: "Happy to help." },
    { type: "propose_estimate_draft", title: "Kitchen remodel", scope: "New cabinets.", items: [{ name: "Cabinet replacement", itemType: "material" }] },
    { type: "propose_add_line_items", items: [{ name: "Tile backsplash" }] },
    { type: "clarify", category: "permit_handling", question: "Do you handle permits?" },
  ];
  for (const c of cases) assert.equal(S.parseEstimateAssistantDecision(JSON.stringify(c)).kind, "decision", c.type);
});

test("TEST 2 / 5 — NO price can be smuggled through ANY decision shape: price/quantity/tax/discount/deposit/id fields all fail strict validation", () => {
  const smuggled = ["unitPrice", "price", "quantity", "total", "taxRate", "discountValue", "depositValue", "markup", "estimateId", "orgId", "contactId", "leadId", "projectId", "status"];
  for (const key of smuggled) {
    for (const shape of [
      { type: "propose_estimate_draft", title: "T", [key]: 1 },
      { type: "propose_estimate_draft", title: "T", items: [{ name: "Cabinets", [key]: 1 }] },
      { type: "propose_add_line_items", items: [{ name: "Backsplash", [key]: 1 }] },
      { type: "propose_add_line_items", items: [{ name: "Backsplash" }], [key]: "x" },
      { type: "respond", response: "hi", [key]: 1 },
    ]) {
      assert.equal(S.parseEstimateAssistantDecision(JSON.stringify(shape)).kind, "fallback", `${key} in ${JSON.stringify(shape)}`);
    }
  }
});

test("there is NO handoff variant — the Estimate Assistant cannot hand off anywhere (structural loop prevention)", () => {
  for (const toAgent of ["scheduling", "lead_qualification", "reception", "estimate_assistant"]) {
    const parsed = S.parseEstimateAssistantDecision(JSON.stringify({ type: "handoff", toAgent, reason: "x", summary: "y" }));
    assert.equal(parsed.kind, "fallback", toAgent);
  }
});

test("unparseable / schema-invalid output NEVER becomes customer text: always the fixed generic reply with value-free issue metadata; fenced valid JSON is still just JSON", () => {
  assert.deepEqual(S.parseEstimateAssistantDecision("Sure — happy to help with that."), {
    kind: "fallback", responseText: S.GENERIC_FALLBACK_RESPONSE, issues: [{ path: "(root)", code: "not_json" }], normalized: false,
  });
  const bad = S.parseEstimateAssistantDecision(JSON.stringify({ type: "propose_add_line_items", items: [] }));
  assert.equal(bad.kind, "fallback");
  assert.equal(bad.responseText, S.GENERIC_FALLBACK_RESPONSE);
  assert.equal(S.parseEstimateAssistantDecision('```json\n{"type":"respond","response":"ok"}\n```').kind, "decision");
});

test("trusted input binding: ids come ONLY from the trusted context, never the decision; add binds the server-resolved estimate id", () => {
  const draft = S.parseEstimateAssistantDecision(JSON.stringify({ type: "propose_estimate_draft", title: "Kitchen", scope: "s", items: [{ name: "Cabinets" }] })).decision;
  const input = S.buildTrustedCreateDraftInput(draft, { contactId: "c-1", leadId: "l-1", projectId: undefined });
  assert.deepEqual(input, { contactId: "c-1", leadId: "l-1", title: "Kitchen", scope: "s", items: [{ name: "Cabinets" }] });
  assert.ok(!("projectId" in input));

  const add = S.parseEstimateAssistantDecision(JSON.stringify({ type: "propose_add_line_items", items: [{ name: "Backsplash" }] })).decision;
  assert.deepEqual(S.buildTrustedAddItemsInput(add, EST_ID), { estimateId: EST_ID, items: [{ name: "Backsplash" }] });
});

// ── Readiness: known vs missing, computed by code ────────────────────────

test("TEST 2 — kitchen scope, NO trusted pricing: prompt tells the model pricing is unavailable and lists what is missing; the prompt itself contains no dollar figure", () => {
  const ctx = baseContext({ estimate: noEstimate });
  const text = decisionText(ctx, evt("Can you prepare an estimate?"));
  assert.match(text, /The assistant never sets or infers a price itself/);
  assert.match(text, /Staff-only price suggestions drawn from this organization/);
  assert.doesNotMatch(text.replace(/NEVER say or imply that[^.]*./g, ""), /no price book|every unit price must come from the business owner/i, "the unsupported price-book conclusion is gone (only the PROHIBITION of it remains)");
  assert.match(text, /Existing estimate: none found/);
  assert.match(text, /No estimate exists yet for this customer\/project/);
  assert.match(text, /Confirmed unit prices — set or approved by the business owner/);
  assert.match(text, /Measurements \/ quantities/);
  assert.match(text, /Project type \/ scope mentioned by the customer: Kitchen remodel/);
  assert.ok(!/\$\d/.test(text), "no dollar figure may appear anywhere in this prompt");
});

test("TEST 3 — a known $25,000 budget is shown as a customer TARGET only, never as a price/total", () => {
  const ctx = baseContext({ estimate: noEstimate, lead: { id: "lead-1", status: "qualified", estimatedBudget: 25000, projectType: "Kitchen remodel" } });
  const text = decisionText(ctx, evt("Can you prepare an estimate?"));
  assert.match(text, /Customer's stated target budget: \$25,000 — a customer target only, NOT a quote, price, line-item price, or estimate total/);
  assert.match(text, /The customer's stated budget is a TARGET/);
  assert.match(text, /never agree to, accept, or commit to a price the customer proposes/);
  // The only dollar figures in the whole prompt are the budget itself.
  const amounts = S.extractMoneyAmounts(text);
  assert.ok(amounts.length > 0 && amounts.every((n: number) => n === 25000), JSON.stringify(amounts));
});

test("TEST 4 — an existing priced estimate is described exactly: items, prices, stored totals; unpriced rows are 'NOT set yet (not $0)'", () => {
  const ctx = baseContext({
    estimate: estimateWith([priced("Base cabinets", 100, 2), pending("Backsplash")], { subtotal: 200, taxTotal: 20, total: 220 }),
  });
  const text = decisionText(ctx, evt("What's in my estimate?"));
  assert.match(text, /Existing estimate: "Kitchen remodel" \(EST-000007\), status: draft\. It is still a draft\./);
  assert.match(text, /Base cabinets \[material\] — 2 each @ \$100 = \$200/);
  assert.match(text, /Backsplash \[material\] — price and quantity NOT set yet \(unpriced placeholder, not \$0\)/);
  assert.match(text, /Stored totals \(calculated by the system — never recalculate or alter\): subtotal \$200, tax \$20, total \$220/);
  assert.match(text, /Unit price and quantity for: Backsplash/);
});

test("a reviewed $0 line (not pending) is described as a real $0 — never as 'price NOT set yet'; a true placeholder still is", () => {
  const ctx = baseContext({ estimate: estimateWith([priced("Site visit (included)", 0), pending("Backsplash")], { total: 0 }) });
  const block = S.buildEstimateContextBlock(ctx);
  assert.match(block, /Site visit \(included\) \[material\] — 1 each @ \$0 = \$0/);
  assert.doesNotMatch(block, /Site visit \(included\)[^\n]*NOT set yet/);
  assert.match(block, /Backsplash \[material\] — price and quantity NOT set yet/);
  const readiness = S.computeEstimateReadiness(ctx);
  assert.ok(readiness.missing.some((m: string) => /Unit price and quantity for: Backsplash$/.test(m)), "only the true placeholder is listed as missing");
});

test("a non-draft estimate is flagged as not editable; several matches are flagged ambiguous; missing context is stated honestly", () => {
  const sent = decisionText(baseContext({ estimate: estimateWith([priced("Cabinets", 100)], { status: "sent", editableByAssistant: false, total: 100 }) }), evt("hi"));
  assert.match(sent, /It is no longer a draft — you cannot propose changes to it\./);
  const amb = decisionText(baseContext({ estimate: { ...estimateWith([]), ambiguous: true } }), evt("hi"));
  assert.match(amb, /more than one active estimate matches/);
  const unloaded = decisionText(baseContext({ estimate: undefined }), evt("hi"));
  assert.match(unloaded, /Estimate data could not be loaded\. Do not describe, assume, or promise anything about an existing estimate\./);
});

test("computeEstimateReadiness: known vs missing is deterministic (no estimate → missing scope/pricing/measurements; priced items → no 'unit price' gap)", () => {
  const none = S.computeEstimateReadiness(baseContext({ estimate: noEstimate, lead: { id: "l", status: "new" } }));
  assert.ok(none.missing.some((m: string) => /Project scope/.test(m)));
  assert.ok(none.missing.some((m: string) => /Property address/.test(m)));
  assert.ok(none.missing.some((m: string) => /Confirmed unit prices/.test(m)));
  assert.ok(none.missing.some((m: string) => /Measurements/.test(m)));
  const full = S.computeEstimateReadiness(baseContext({ estimate: estimateWith([priced("Cabinets", 100)], { total: 100 }), lead: { id: "l", status: "new", projectType: "Kitchen", location: "Austin" } }));
  assert.ok(!full.missing.some((m: string) => /Unit price and quantity/.test(m)));
  assert.ok(!full.missing.some((m: string) => /Measurements/.test(m)));
});

// ── Business Knowledge + the permit nuance ──────────────────────────────

test("TEST 7 / 19 — saved Business Knowledge (permit_handling) enters the Estimate Assistant prompt as an authoritative fact", () => {
  const ctx = baseContext({
    estimate: noEstimate,
    businessKnowledge: { status: "ok", entries: [{ key: "permit_handling", category: "permit_handling", question: "Do you handle permits?", answer: "We handle permits and inspections." }] },
  });
  const text = decisionText(ctx, evt("Do you handle permits?"));
  assert.match(text, /Permit handling: We handle permits and inspections\./);
  assert.match(text, /Trusted Business Knowledge below is AUTHORITATIVE/);
});

test("TEST 8 — the prompt separates 'we handle permits' from 'permit fees are included in this estimate' (the second needs estimate-specific data)", () => {
  const ctx = baseContext({
    estimate: estimateWith([pending("Cabinets")]),
    businessKnowledge: { status: "ok", entries: [{ key: "permit_handling", category: "permit_handling", question: "q", answer: "We handle permits and inspections." }] },
  });
  const text = decisionText(ctx, evt("Are permit fees included in this estimate?"));
  assert.match(text, /"We handle permits and inspections" \(Business Knowledge\) is NOT the same as "permit fees are included in this estimate"/);
  assert.match(text, /Say permit fees are included ONLY if a listed line item, scope, assumption, or exclusion explicitly says so/);
  // No line item in context mentions permit fees:
  assert.ok(!/permit fee/i.test(S.buildEstimateContextBlock(ctx)));
});

test("TEST 9 / 20 — the Owner Clarification path is offered with the catalog keys, with the rule that estimate-specific facts are NOT clarified", () => {
  const text = decisionText(baseContext({ estimate: noEstimate }), evt("Do you offer a 10 year warranty?"));
  assert.match(text, /"type":"clarify","category"/);
  assert.match(text, /warranty/);
  assert.match(text, /Do NOT use clarify for facts about this specific estimate/);
});

test("with no Business Knowledge configured the prompt says so explicitly (silence is never treated as permission)", () => {
  const text = decisionText(baseContext({ estimate: noEstimate, businessKnowledge: { status: "ok", entries: [] } }), evt("hi"));
  assert.match(text, /Trusted Business Knowledge: none has been configured yet\. Do not assert any company-specific policy or capability\./);
});

// ── Customer vs internal context ─────────────────────────────────────────

test("customer channels get customer guidance (no internals); the internal channel may be explicit — and BOTH forbid ungrounded prices and internal fields", () => {
  const sms = decisionText(baseContext({ estimate: noEstimate }), evt("hi", "sms"));
  assert.match(sms, /You are replying directly to a customer/);
  const internal = decisionText(baseContext({ estimate: noEstimate, channel: "internal" }), evt("hi", "internal"));
  assert.match(internal, /internal test\/owner context/);
  for (const t of [sms, internal]) {
    assert.match(t, /Never mention internal cost, margin, markup, contingency, internal notes, record ids, tool names, or approval mechanics/);
    assert.match(t, /Never state or imply a price, total, range, ballpark/);
  }
});

test("the decision prompt documents the three proposals with NO price/quantity fields and says proposals change nothing", () => {
  const text = decisionText(baseContext({ estimate: noEstimate }), evt("hi"));
  assert.match(text, /there is no price, quantity, tax, discount, or id field/);
  assert.match(text, /a proposal does not change anything; a team member must approve it first/);
  assert.match(text, /"type":"propose_estimate_draft"/);
  assert.match(text, /"type":"propose_add_line_items"/);
});

test("handoff continuity: the handed-off prompt carries the summary/known facts/open questions and says not to announce a transfer", () => {
  const handoff = { fromAgent: "lead_qualification", toAgent: "estimate_assistant", reason: "asked for estimate", summary: "Kitchen remodel, wants an estimate.", knownFacts: { project: "kitchen remodel" }, openQuestions: ["countertop material?"] };
  const text = decisionText(baseContext({ estimate: noEstimate }), evt("Can you prepare an estimate?"), handoff);
  assert.match(text, /Kitchen remodel, wants an estimate\./);
  assert.match(text, /project: kitchen remodel/);
  assert.match(text, /Still open: countertop material\?/);
  assert.match(text, /do not tell the customer they were transferred/);
});

// ── Money guard ──────────────────────────────────────────────────────────

test("extractMoneyAmounts understands $ forms, k suffix, decimals and 'N dollars'", () => {
  assert.deepEqual(S.extractMoneyAmounts("$25,000 and $25k and $1,250.50 and 500 dollars"), [25000, 25000, 1250.5, 500]);
  assert.deepEqual(S.extractMoneyAmounts("no money here, just 3 cabinets"), []);
});

test("TEST 2/3 — guard: an invented estimate total is REPLACED; the customer's own budget may be acknowledged; replies without money pass through untouched", () => {
  const ctx = baseContext({ estimate: noEstimate, lead: { id: "l", status: "new", estimatedBudget: 25000 } });
  const ev = evt("My budget is $25,000. Can you prepare an estimate?");
  const invented = S.guardEstimateReply("Your estimate is $24,800.", ctx, ev);
  assert.equal(invented.replaced, true);
  assert.equal(invented.text, S.PRICE_SAFE_RESPONSE);
  assert.ok(!/\$/.test(invented.text));

  const ack = S.guardEstimateReply("Your target budget is $25,000 — I still need cabinet selection, countertop material, measurements, and pricing.", ctx, ev);
  assert.equal(ack.replaced, false);
  assert.equal(S.guardEstimateReply("I need measurements and pricing before I can prepare it.", ctx, ev).replaced, false);
});

test("guard: a 'ballpark' from generic industry knowledge is blocked, in every notation", () => {
  const ctx = baseContext({ estimate: noEstimate });
  const ev = evt("Roughly what would a kitchen cost?");
  for (const reply of ["Kitchens like this typically run $30k–$50k.", "Usually around 40000 dollars.", "That's about $120 per square foot."]) {
    assert.equal(S.guardEstimateReply(reply, ctx, ev).replaced, true, reply);
  }
});

test("TEST 4 — guard: figures that are really on the estimate (item prices, stored totals) and in Business Knowledge may be stated", () => {
  const ctx = baseContext({
    estimate: estimateWith([priced("Base cabinets", 100, 2)], { subtotal: 200, taxTotal: 20, total: 220 }),
    businessKnowledge: { status: "ok", entries: [{ key: "project_minimums", category: "project_minimums", question: "q", answer: "Our minimum project size is $5,000." }] },
  });
  const ev = evt("what's in it?");
  assert.equal(S.guardEstimateReply("Base cabinets are $100 each, two of them, for $200; the total is $220.", ctx, ev).replaced, false);
  assert.equal(S.guardEstimateReply("Our minimum project size is $5,000.", ctx, ev).replaced, false);
  assert.equal(S.guardEstimateReply("The total is $230.", ctx, ev).replaced, true, "a figure that is NOT stored is blocked");
});

test("guard — unsupported money request: 'Can you do the whole project for $18,000?' may be acknowledged but never ACCEPTED", () => {
  const ctx = baseContext({ estimate: noEstimate });
  const ev = evt("Can you do the whole project for $18,000?");
  assert.equal(S.guardEstimateReply("I see your target is $18,000 — our team will need to review the project before we can confirm anything.", ctx, ev).replaced, false);
  for (const accept of ["Yes, we can do it for $18,000!", "Deal — $18,000 it is.", "$18,000 works for us, consider it agreed.", "We'll do that for $18,000, locked in."]) {
    assert.equal(S.guardEstimateReply(accept, ctx, ev).replaced, true, accept);
  }
});

test("summarizeProposalSubmitted always says NOTHING was created/changed and never carries a price", () => {
  const draft = S.summarizeProposalSubmitted("draft", ["Cabinets", "Countertops"]);
  const add = S.summarizeProposalSubmitted("add_items", ["Backsplash"]);
  for (const t of [draft, add]) {
    assert.match(t, /NOTHING has been (created|changed)/);
    assert.ok(!/\$/.test(t));
  }
});

// ── Structured-decision robustness (normalization, strict boundary, never-raw-text, repair prompt) ──

const proposal = (over: Record<string, unknown> = {}) => ({
  type: "propose_estimate_draft", title: "Kitchen Remodel", scope: "New cabinets and countertops.",
  items: [{ name: "Kitchen cabinets", description: "New cabinetry", itemType: "material" }, { name: "Countertops", itemType: "material" }],
  ...over,
});
const parse = (v: unknown) => S.parseEstimateAssistantDecision(typeof v === "string" ? v : JSON.stringify(v));
const assertGenericFallback = (p: any, label: string) => {
  assert.equal(p.kind, "fallback", label);
  assert.equal(p.responseText, S.GENERIC_FALLBACK_RESPONSE, `${label}: only the fixed generic text may ever be returned`);
};

test("A — a valid proposal parses unchanged: normalized=false, nothing rewritten", () => {
  const p = parse(proposal());
  assert.equal(p.kind, "decision");
  assert.equal(p.normalized, false);
  assert.deepEqual(p.decision, proposal());
});

test("B — known optional field null (scope/reason) is OMITTED, then validates (normalized=true)", () => {
  const p = parse(proposal({ scope: null, reason: null }));
  assert.equal(p.kind, "decision");
  assert.equal(p.normalized, true);
  assert.ok(!("scope" in p.decision) && !("reason" in p.decision));
  assert.equal(parse({ type: "propose_add_line_items", items: [{ name: "Backsplash" }], reason: "" }).kind, "decision");
});

test("C — known optional text blank ('' / whitespace) is OMITTED: item description, scope, reason", () => {
  const p = parse(proposal({ scope: "   ", items: [{ name: "Cabinets", description: "" }, { name: "Sink", description: "  \n " }] }));
  assert.equal(p.kind, "decision");
  assert.equal(p.normalized, true);
  assert.ok(!("scope" in p.decision));
  for (const item of p.decision.items) assert.ok(!("description" in item));
});

test("D — an unknown itemType becomes 'custom' ONLY when the item has no extra keys; blank itemType is omitted", () => {
  const ok = parse(proposal({ items: [{ name: "Permits", itemType: "permit" }, { name: "Demo", itemType: "Material" }, { name: "Misc", itemType: null }] }));
  assert.equal(ok.kind, "decision");
  assert.equal(ok.normalized, true);
  assert.deepEqual(ok.decision.items.map((i: any) => i.itemType), ["custom", "custom", undefined]);
  // Same unknown itemType but the item carries an extra key -> NOT rewritten, strict schema rejects the item.
  const bad = parse(proposal({ items: [{ name: "Permits", itemType: "permit", notes: "x" }] }));
  assertGenericFallback(bad, "unknown itemType + extra key");
  assert.ok(bad.issues.some((i: any) => i.path === "items[].itemType" && i.code === "invalid_enum_value"), "the unknown itemType was NOT rewritten");
  assert.ok(bad.issues.some((i: any) => i.path === "items[]" && i.code === "unrecognized_keys"));
});

test("E — an unknown/extra key (e.g. location) still fails the strict schema — never silently stripped", () => {
  for (const shape of [proposal({ location: "Miami, FL" }), proposal({ items: [{ name: "Cabinets", location: "Miami" }] }), { type: "respond", response: "hi", location: "x" }]) {
    const p = parse(shape);
    assertGenericFallback(p, JSON.stringify(shape).slice(0, 60));
    assert.ok(p.issues.some((i: any) => i.code === "unrecognized_keys"));
  }
});

const MONEY_KEYS = ["unitPrice", "unit_price", "price", "quantity", "qty", "budget", "tax", "taxRate", "discount", "discountValue", "deposit", "depositValue", "markup", "margin", "cost", "total", "subtotal"];
test("F — money-like keys fail strict validation at root AND item level — even when null / blank / zero (normalization never touches them)", () => {
  for (const key of MONEY_KEYS) {
    for (const value of [1, 0, null, "", "12.50"]) {
      assertGenericFallback(parse(proposal({ [key]: value })), `root ${key}=${JSON.stringify(value)}`);
      assertGenericFallback(parse(proposal({ items: [{ name: "Cabinets", [key]: value }] })), `item ${key}=${JSON.stringify(value)}`);
      assertGenericFallback(parse({ type: "propose_add_line_items", items: [{ name: "Backsplash", [key]: value }] }), `add item ${key}=${JSON.stringify(value)}`);
    }
  }
});

test("G — id-like keys fail strict validation (model can never supply or override trusted ids)", () => {
  for (const key of ["estimateId", "leadId", "contactId", "projectId", "orgId", "organizationId", "clientId", "approvalId"]) {
    assertGenericFallback(parse(proposal({ [key]: "11111111-1111-4111-8111-111111111111" })), `root ${key}`);
    assertGenericFallback(parse(proposal({ items: [{ name: "Cabinets", [key]: "x" }] })), `item ${key}`);
    assertGenericFallback(parse({ type: "propose_add_line_items", estimateId: "11111111-1111-4111-8111-111111111111", items: [{ name: "Backsplash" }] }), "add estimateId");
  }
});

test("a null/blank value on a key that is NOT a known optional field is never 'fixed' (e.g. title, name, scope on an add decision)", () => {
  assertGenericFallback(parse(proposal({ title: null })), "title null");
  assertGenericFallback(parse(proposal({ title: "" })), "title blank");
  assertGenericFallback(parse(proposal({ items: [{ name: "" }] })), "name blank");
  assertGenericFallback(parse({ type: "propose_add_line_items", scope: null, items: [{ name: "Backsplash" }] }), "scope is not a field of add_line_items");
});

test("normalizeDecisionCandidate is pure: the input object is never mutated", () => {
  const input = proposal({ scope: null, items: [{ name: "A", description: "", itemType: "permit" }] });
  const snapshot = JSON.stringify(input);
  const out = S.normalizeDecisionCandidate(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(out.changed, true);
  assert.notEqual(out.value, input);
});

test("H/I/J/K — non-JSON prose, truncated JSON, and prose around JSON NEVER become customer-facing text; markdown fences never leak either", () => {
  const good = JSON.stringify(proposal());
  const secret = "SECRET-CUSTOMER-TEXT";
  const cases: Record<string, string> = {
    "H prose": `Sure! I'd be happy to help with your kitchen, ${secret}.`,
    "H prose with dollar figure": "These usually cost around $40,000.",
    "I fenced prose": "```\nSure, here you go " + secret + "\n```",
    "I fenced invalid JSON": "```json\n" + JSON.stringify(proposal({ location: secret })) + "\n```",
    "J truncated": good.slice(0, 90),
    "J truncated respond": '{"type":"respond","response":"Your kitchen ' + secret,
    "K prose before": "Here is my decision:\n" + good,
    "K prose after": good + "\nLet me know if that helps. " + secret,
    "K prose both sides": "Decision: " + good + " — " + secret,
    "empty": "   ",
    "json array": "[1,2,3]",
    "json string": '"hello ' + secret + '"',
    "json null": "null",
  };
  for (const [label, raw] of Object.entries(cases)) {
    const p = parse(raw);
    assertGenericFallback(p, label);
    assert.ok(!p.responseText.includes(secret), label);
    assert.ok(Array.isArray(p.issues) && p.issues.length > 0, `${label}: carries safe issue metadata`);
    assert.ok(!JSON.stringify(p.issues).includes(secret), `${label}: issue metadata is value-free`);
  }
  // Fenced VALID json is just JSON: it still has to pass the strict schema, and only its validated content is used.
  assert.equal(parse("```json\n" + good + "\n```").kind, "decision");
});

test("safe issue metadata: only { path, code }; array indexes collapse to []; no values; deduped; non-object/unknown type are described value-free", () => {
  const p = parse(proposal({ title: 5, items: [{ name: 7 }, { name: 8 }] }));
  assertGenericFallback(p, "types");
  for (const issue of p.issues) assert.deepEqual(Object.keys(issue).sort(), ["code", "path"]);
  assert.ok(p.issues.some((i: any) => i.path === "title" && i.code === "invalid_type"));
  assert.equal(p.issues.filter((i: any) => i.path === "items[].name").length, 1, "indexes collapse and duplicates are removed");
  assert.deepEqual(parse({ type: "something_else" }).issues, [{ path: "type", code: "unknown_decision_type" }]);
  assert.deepEqual(parse("not json").issues, [{ path: "(root)", code: "not_json" }]);
});

test("the decision prompt carries the hardened output contract and stays free of dollar figures", () => {
  const text = decisionText(baseContext({ estimate: noEstimate }), evt("Can you prepare an estimate?"));
  assert.match(text, /Return JSON only — no markdown fences and no text before or after the object/);
  assert.match(text, /omit it entirely when unknown, and never output null or an empty string for it/);
  assert.match(text, /Do not add any field that is not shown in the shapes above/);
  assert.match(text, /itemType must be exactly one of labor\|material\|service\|equipment\|allowance\|fee\|custom — if unsure, use "custom"/);
  assert.match(text, /The customer's budget is context only: it is not a line-item price and must never be copied into a proposal field/);
  assert.match(text, /there is no price, quantity, tax, discount, or id field/);
  assert.ok(!/\$\d/.test(text));
});

test("repair request: same trusted context + original intent + allowed shapes, a VALUE-FREE issue list, and no raw invalid output", () => {
  const ctx = baseContext({ estimate: noEstimate });
  const issues = [{ path: "items[].itemType", code: "invalid_enum_value" }, { path: "(root)", code: "unrecognized_keys" }];
  const normal = S.buildEstimateAssistantDecisionRequest(AGENT_INSTRUCTIONS, ctx, evt("Can you prepare an estimate for the kitchen?"));
  const repair = S.buildEstimateAssistantDecisionRequest(AGENT_INSTRUCTIONS, ctx, evt("Can you prepare an estimate for the kitchen?"), undefined, issues);
  assert.equal(repair.system, normal.system, "identical contract and trusted context");
  const user = repair.messages[0].content;
  assert.match(user, /Can you prepare an estimate for the kitchen\?/);
  assert.match(user, /Your previous structured decision did not match the required schema/);
  assert.match(user, /- items\[\]\.itemType: invalid_enum_value/);
  assert.match(user, /- \(root\): unrecognized_keys/);
  assert.match(user, /corrected JSON only/);
  assert.match(user, /Pricing, quantity, tax, discount, deposit, markup, margin, budget and identifier fields are forbidden/);
  assert.ok(!normal.messages[0].content.includes("did not match the required schema"));
});

test("P — token caps: the decision AND repair requests use the Estimate Assistant cap (900); the shared 400 default is unchanged for the response-only final call", () => {
  assert.equal(S.ESTIMATE_ASSISTANT_DECISION_MAX_TOKENS, 900);
  const ctx = baseContext({ estimate: noEstimate });
  assert.equal(S.buildEstimateAssistantDecisionRequest(AGENT_INSTRUCTIONS, ctx, evt("hi")).maxTokens, 900);
  assert.equal(S.buildEstimateAssistantDecisionRequest(AGENT_INSTRUCTIONS, ctx, evt("hi"), undefined, [{ path: "(root)", code: "not_json" }]).maxTokens, 900);
  assert.equal(S.buildEstimateAssistantFinalRequest(AGENT_INSTRUCTIONS, ctx, evt("hi"), "outcome").maxTokens, 400);
});

test("P — a long proposal (8 line items, scope, reason) parses successfully and its JSON is far larger than the old 400-token ceiling would allow", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ name: `Line item number ${i + 1} for the kitchen remodel project`, description: `Detailed description of work item ${i + 1}: supply and install per the stated scope of work, including cleanup.`, itemType: i % 2 ? "labor" : "material" }));
  const long = proposal({ scope: "Full kitchen remodel scope drawn only from stated facts: ".padEnd(600, "x"), items, reason: "Customer explicitly requested an estimate and provided enough scope to name the main line items." });
  const raw = JSON.stringify(long);
  const p = parse(raw);
  assert.equal(p.kind, "decision");
  assert.equal(p.decision.items.length, 8);
  assert.ok(raw.length / 4 > 400 * 0.9, `~${Math.round(raw.length / 4)} tokens: would not have fit the old cap`);
  assert.ok(raw.length / 3 < 900, "fits comfortably under the new cap");
});
