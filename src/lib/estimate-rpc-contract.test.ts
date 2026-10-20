// src/lib/estimate-rpc-contract.test.ts
//
// Run:  node --test src/lib/estimate-rpc-contract.test.ts
//
// STATIC SOURCE-CONTRACT TESTS for supabase/migrations/20261017_estimate_transactional_rpcs.sql and its callers.
//
//   *** NONE OF THESE EXECUTE PL/pgSQL. ***
//
// They read the migration's TEXT and the callers' source and assert the contract between them: whitelists, grants,
// security mode, the strict-attribution logic, the absence of fallbacks / dynamic SQL, and that what the browser
// editor really sends is accepted by the SQL whitelist. They catch drift between TypeScript and SQL (the class of bug
// where the editor sent `estimate_id` and the RPC rejected it) and accidental edits to the security-relevant lines.
//
// What they CANNOT prove: that the SQL behaves as written (atomicity, locking, RLS, trigger interaction). That needs
// real PL/pgSQL: the rollback-wrapped script supabase/verification/estimate_transactional_rpcs_verification.sql run on
// a NON-PRODUCTION database (and, outside the repo, the throwaway PGlite stand-in smoke).

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const outDir = mkdtempSync(path.join(tmpdir(), "estimate-rpc-contract-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: { contents: `export * from "./src/lib/estimate-item-rows";`, resolveDir: repoRoot, loader: "ts" },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error",
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const noisy = ["log", "warn", "error"] as const;
const saved = noisy.map((k) => (console as any)[k]);
noisy.forEach((k) => ((console as any)[k] = () => {}));
after(() => noisy.forEach((k, i) => ((console as any)[k] = saved[i])));

// ── source readers ──────────────────────────────────────────────────────

const MIGRATION = readFileSync(path.join(repoRoot, "supabase/migrations/20261017_estimate_transactional_rpcs.sql"), "utf8").replace(/\r\n/g, "\n");
const EDITOR = readFileSync(path.join(repoRoot, "src/routes/estimates.tsx"), "utf8").replace(/\r\n/g, "\n");
const HANDLERS = readFileSync(path.join(repoRoot, "src/lib/agentic/estimate-handlers.ts"), "utf8").replace(/\r\n/g, "\n");

const FN = {
  syncProjectTotal: "sync_project_estimate_total",
  normalize: "estimate_rpc_normalize_ai_items",
  create: "create_estimate_draft_transaction",
  add: "add_estimate_line_items_transaction",
  replace: "replace_estimate_items_transaction",
} as const;

/** The full text of one function (signature through its closing `$$;`). */
function fnText(name: string): string {
  const start = MIGRATION.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `function ${name} not found in migration`);
  const end = MIGRATION.indexOf("\n$$;", start);
  assert.ok(end > start, `function ${name} has no closing $$;`);
  return MIGRATION.slice(start, end + 4);
}
/** SQL with -- comments and 'string literals' removed, for structural assertions. */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");
}
/** The quoted members of `<name> constant text[] := array[ ... ];` inside the replace function. */
function sqlList(name: string): string[] {
  const m = fnText(FN.replace).match(new RegExp(`${name}\\s+constant text\\[\\] := array\\[([\\s\\S]*?)\\];`));
  assert.ok(m, `list ${name} not found`);
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
/** The grantee list of every `<verb> ... on function public.<name>(...) <from|to> a, b;` statement. */
function grantees(name: string, verb: "revoke" | "grant"): string[] {
  const re = new RegExp(`^${verb} [a-z ]+ on function public\\.${name}\\([^)]*\\) ${verb === "revoke" ? "from" : "to"} ([^;]+);`, "gm");
  return [...MIGRATION.matchAll(re)].flatMap((m) => m[1].split(",").map((s) => s.trim())).sort();
}
/** Keys of the object literal that follows `marker`, taken at the indentation of the first key. */
function objectKeys(source: string, marker: string, firstKey: string): string[] {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `marker not found: ${marker}`);
  const rest = source.slice(at);
  const first = rest.match(new RegExp(`^( +)${firstKey}:`, "m"));
  assert.ok(first, `first key ${firstKey} not found after ${marker}`);
  const indent = first![1];
  const from = rest.indexOf(first![0]);
  const closing = rest.slice(from).search(new RegExp(`^${indent.slice(2)}\\}`, "m"));
  const block = rest.slice(from, from + closing);
  return [...block.matchAll(new RegExp(`^${indent}(\\w+):`, "gm"))].map((m) => m[1]);
}

const editorItemKeys = () => objectKeys(EDITOR, "function buildItemRows(", "estimate_id");
const editorHeaderKeys = () => objectKeys(EDITOR, "const header = {", "title");

// ── B1: editor payload vs SQL whitelist ──────────────────────────────────

test("[static] B1 — the editor's item row keys, minus estimate_id, are EXACTLY the SQL item whitelist (no drift in either direction)", () => {
  const editor = editorItemKeys();
  assert.ok(editor.includes("estimate_id") && editor.includes("metadata") && editor.length >= 12, `parsed editor keys look wrong: ${editor.join(",")}`);
  const sql = sqlList("v_item_allowed");
  assert.deepEqual([...sql].sort(), editor.filter((k) => k !== "estimate_id").sort(),
    "the editor sends a key SQL rejects, or SQL accepts a key the editor never sends — update both sides together");
});

test("[static] B1 — the SQL item whitelist does NOT accept estimate_id / id / selected_by_customer / any money-trust column the editor must not set", () => {
  const sql = sqlList("v_item_allowed");
  for (const forbidden of ["estimate_id", "id", "selected_by_customer", "discount_type", "discount_value", "created_at"]) {
    assert.ok(!sql.includes(forbidden), `${forbidden} must not be accepted`);
  }
});

test("[static] B1 — the editor's header keys (minus metadata and client_total, which are stripped before the RPC) are a subset of the SQL header whitelist", () => {
  const header = editorHeaderKeys();
  assert.ok(header.includes("title") && header.includes("metadata") && header.includes("client_total"), header.join(","));
  assert.match(EDITOR, /const \{ metadata: _metadataMerged, client_total: _clientTotal, \.\.\.updateHeader \} = header;/);
  const sent = header.filter((k) => k !== "metadata" && k !== "client_total");
  const sql = new Set(sqlList("v_header_allowed"));
  for (const k of sent) assert.ok(sql.has(k), `editor header key ${k} is not in the SQL whitelist`);
  assert.ok(!sql.has("client_total") && !sql.has("metadata"));
});

test("[static] B1 — the editor's metadata patch key (serviceAddress) is exactly the SQL metadata whitelist; provenance keys are not accepted", () => {
  assert.deepEqual(sqlList("v_meta_allowed"), ["serviceAddress"]);
  assert.match(EDITOR, /metadataPatch: \{ serviceAddress: address\.trim\(\) \|\| null \}/);
});

test("[static] B1 — SQL header whitelist can never touch identity / lifecycle / relationship / provenance columns", () => {
  const sql = sqlList("v_header_allowed");
  for (const forbidden of [
    "org_id", "created_by", "number", "status", "version_number", "public_token", "sent_at", "viewed_at", "first_viewed_at",
    "last_viewed_at", "approved_at", "rejected_at", "changes_requested_at", "expired_at", "converted_at", "cancelled_at",
    "lead_id", "project_id", "deal_id", "converted_deal_id", "converted_project_id", "client_total", "metadata", "ai_execution_id", "ai_generated",
  ]) assert.ok(!sql.includes(forbidden), `${forbidden} must not be in the header whitelist`);
});

test("[static] B1 — unknown keys FAIL CLOSED in SQL: the replace function raises invalid_*_field on any key outside each whitelist", () => {
  assert.match(fnText(FN.replace), /v_key <> all \(v_header_allowed\) then\s+raise exception 'estimate_rpc:invalid_header_field'/);
  assert.match(fnText(FN.replace), /v_key <> all \(v_meta_allowed\) then\s+raise exception 'estimate_rpc:invalid_metadata_field'/);
  assert.match(fnText(FN.replace), /v_key <> all \(v_item_allowed\) then\s+raise exception 'estimate_rpc:invalid_item_field'/);
  assert.match(fnText(FN.normalize), /v_key <> all \(array\['name', 'description', 'itemType'\]\) then\s+raise exception 'estimate_rpc:invalid_item_field'/);
});

test("B1 — saveEstimateWithItems sends the REAL editor row shape to the RPC with estimate_id stripped (payload keys are a subset of the SQL whitelist)", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = { rpc: async (_fn: string, args: Record<string, unknown>) => { calls.push(args); return { data: { item_count: 1 }, error: null }; } };
  // A row with exactly the keys buildItemRows() emits, DERIVED from the editor source (not retyped here).
  const row: Record<string, unknown> = Object.fromEntries(editorItemKeys().map((k) => [k, k === "metadata" ? {} : k === "estimate_id" ? "est-1" : "x"]));
  assert.ok("estimate_id" in row);
  const res = await S.saveEstimateWithItems(client, { estimateId: "est-1", header: {}, metadataPatch: {}, rows: [row] });
  assert.equal(res.ok, true);
  const sent = (calls[0].p_items as Array<Record<string, unknown>>)[0];
  assert.ok(!("estimate_id" in sent), "estimate_id must not reach the RPC");
  const sql = new Set(sqlList("v_item_allowed"));
  for (const k of Object.keys(sent)) assert.ok(sql.has(k), `sent key ${k} is not accepted by the SQL whitelist`);
  assert.equal(calls[0].p_estimate_id, "est-1", "the estimate is bound ONLY by p_estimate_id");
  assert.equal((row as any).estimate_id, "est-1", "the caller's row object is not mutated");
});

// ── B2: strict created-activity attribution ──────────────────────────────

test("[static] B2 — create: the attribution UPDATE targets only the trigger's system row (org, estimate, 'created', system, NULL actor)", () => {
  const body = fnText(FN.create);
  const update = body.slice(body.indexOf("update public.estimate_activities a"), body.indexOf("get diagnostics v_updated = row_count;"));
  assert.ok(update.length > 50);
  for (const needle of [
    "a.org_id = p_org_id", "a.estimate_id = v_id", "a.activity_type = 'created'", "a.actor_type = 'system'", "a.actor_id is null",
    "actor_id = p_created_by", "actor_type = 'user'",
    "description = 'Drafted by the Estimate Assistant and approved by a team member.'",
  ]) assert.ok(update.includes(needle), `attribution update is missing: ${needle}`);
});

test("[static] B2 — create: exactly ONE row required; zero OR many raises attribution_failed (whole transaction rolls back)", () => {
  const body = code(fnText(FN.create));
  assert.match(body, /get diagnostics v_updated = row_count;\s+if v_updated <> 1 then\s+raise exception ''/);
  assert.match(fnText(FN.create), /if v_updated <> 1 then\s+raise exception 'estimate_rpc:attribution_failed' using errcode = 'P0001';/);
});

test("[static] B2 — create: NO fallback insert into estimate_activities remains; an activity is never fabricated", () => {
  assert.doesNotMatch(code(fnText(FN.create)), /insert\s+into\s+public\.estimate_activities/i);
  assert.doesNotMatch(code(fnText(FN.add)), /estimate_activities/i);
  assert.doesNotMatch(code(fnText(FN.replace)), /estimate_activities/i);
});

test("[static] B2 — create: existing activity metadata is MERGED (coalesce(a.metadata) || …), not overwritten; execution id is carried", () => {
  const body = fnText(FN.create);
  assert.match(body, /metadata = coalesce\(a\.metadata, '\{\}'::jsonb\)\s+\|\| jsonb_build_object\('attributed_via', 'estimate_assistant_approval', 'originally_recorded_as', 'system'\)\s+\|\| v_exec_meta/);
  assert.doesNotMatch(body, /metadata = jsonb_build_object\(/, "a plain overwrite of activity metadata must not come back");
});

test("[static] B2 — the migration documents attribution_failed and the TypeScript caller maps it to the generic safe failure (no raw SQL)", () => {
  assert.match(MIGRATION, /attribution_failed/);
  assert.match(HANDLERS, /case "attribution_failed":[\s\S]{0,420}return \{ ok: false, error: CREATE_DRAFT_FAILED \};/);
});

// ── create / add: tenant, approver and hardcoded-money contract ──────────

test("[static] create — approver must belong to p_org_id via profiles OR org_memberships, checked BEFORE the advisory lock and any write", () => {
  const body = fnText(FN.create);
  const actor = body.indexOf("pr.organization_id = p_org_id");
  assert.ok(actor > 0 && body.includes("m.org_id = p_org_id"), "both membership sources must be checked against p_org_id");
  assert.match(body.slice(actor, actor + 600), /estimate_rpc:attribution_required/);
  assert.ok(actor < body.indexOf("pg_advisory_xact_lock"), "actor check precedes the lock");
  assert.ok(actor < body.indexOf("insert into public.estimates"), "actor check precedes the first write");
});

test("[static] create — lead / project / contact are each filtered by org_id = p_org_id and fail as not_found", () => {
  const body = fnText(FN.create);
  assert.match(body, /from public\.leads l where l\.id = p_lead_id and l\.org_id = p_org_id/);
  assert.match(body, /from public\.projects p where p\.id = p_project_id and p\.org_id = p_org_id/);
  assert.match(body, /from public\.contacts c where c\.id = v_client and c\.org_id = p_org_id/);
  assert.ok((body.match(/estimate_rpc:not_found/g) ?? []).length >= 3);
  assert.match(body, /estimate_rpc:contact_required/);
});

test("[static] create — replay lookup happens AFTER taking the advisory lock, scoped to the org, keyed on (org, execution id)", () => {
  const body = fnText(FN.create);
  const lock = body.indexOf("pg_advisory_xact_lock(hashtextextended('estimate_rpc:create:' || p_org_id::text || ':' || v_exec, 0))");
  assert.ok(lock > 0);
  const lookup = body.indexOf("e.org_id = p_org_id and e.metadata ->> 'ai_execution_id' = v_exec");
  assert.ok(lookup > lock, "lookup must come after the lock");
});

test("[static] create + add — money / quantity / flags are HARDCODED in SQL; item JSON contributes only name, description, item type", () => {
  for (const name of [FN.create, FN.add]) {
    const body = fnText(name);
    assert.match(body, /1, 'each', 0, 0,/, `${name}: quantity/unit/unit_price/total must be literals`);
    assert.match(body, /true, false, true, false,/, `${name}: taxable/optional/selected_by_customer/is_heading must be literals`);
    assert.match(body, /jsonb_build_object\('ai_proposed', true, 'price_pending', true, 'quantity_pending', true\) \|\| v_exec_meta/);
    assert.doesNotMatch(body, /elem ->> '(quantity|unit_price|total|price|unit|taxable|optional)'/, `${name}: no money/flag may be read from item JSON`);
  }
  const norm = fnText(FN.normalize);
  assert.match(norm, /array\['name', 'description', 'itemType'\]/);
  assert.match(norm, /array\['labor', 'material', 'service', 'equipment', 'allowance', 'fee', 'custom'\]/);
  assert.doesNotMatch(norm.match(/array\['labor'[^\]]*\]/)![0], /discount/);
});

test("[static] create — header money is all zero literals and total/client_total are written together", () => {
  const body = fnText(FN.create);
  assert.match(body, /0, null, 0, null, 0,\s+0, 0, 0, 0, 0, 0, 0,/);
  assert.match(body, /subtotal, discount_total, tax_total, total, client_total, deposit_amount, balance_due/);
});

test("[static] add — locks the estimate FOR UPDATE (org-scoped), THEN checks draft, THEN computes the append position; never touches totals", () => {
  const body = fnText(FN.add);
  const lock = body.indexOf("for update;");
  const draft = body.indexOf("if v_status <> 'draft'");
  const replay = body.indexOf("into v_replay");
  const pos = body.indexOf("coalesce(max(i.position), -1)");
  assert.ok(lock > 0 && lock < draft && draft < pos, "order must be lock -> draft check -> position");
  assert.ok(replay > lock, "replay lookup also runs under the lock");
  assert.match(body, /e\.id = p_estimate_id and e\.org_id = p_org_id\s+for update/);
  const c = code(body);
  assert.doesNotMatch(c, /\b(subtotal|tax_total|discount_total|client_total|balance_due|deposit_amount)\b/, "add must not write any total");
  assert.match(c, /update public\.estimates set updated_at = now\(\) where id = p_estimate_id/);
});

test("[static] replace — locks the estimate FOR UPDATE before the header update, then deletes/inserts items under the same lock; row counts are verified", () => {
  const body = fnText(FN.replace);
  const lock = body.indexOf("for update;");
  const upd = body.indexOf("update public.estimates e set");
  const del = body.indexOf("delete from public.estimate_items");
  const ins = body.indexOf("insert into public.estimate_items");
  assert.ok(lock > 0 && lock < upd && upd < del && del < ins, "order must be lock -> header -> delete -> insert");
  assert.match(body, /if v_updated <> 1 then/);
  assert.match(body, /if v_deleted <> v_before then/);
  assert.match(body, /client_total\s+= case when 'total'\s+= any \(v_hk\) then \(p_header ->> 'total'\)::numeric/, "client_total mirrors total (trg_sync_total contract)");
  assert.match(body, /metadata\s+= e\.metadata \|\| v_patch/, "metadata is merged against the locked row");
});

// ── security mode, search_path, grants, no dynamic SQL ───────────────────

test("[static] security mode: create/add are SECURITY DEFINER; replace is SECURITY INVOKER; every function pins search_path = pg_catalog, pg_temp", () => {
  assert.match(fnText(FN.create), /\nsecurity definer\nset search_path = pg_catalog, pg_temp\n/);
  assert.match(fnText(FN.add), /\nsecurity definer\nset search_path = pg_catalog, pg_temp\n/);
  assert.match(fnText(FN.replace), /\nsecurity invoker\nset search_path = pg_catalog, pg_temp\n/);
  assert.doesNotMatch(fnText(FN.normalize), /security definer/);
  assert.match(fnText(FN.normalize), /set search_path = pg_catalog, pg_temp/);
});

test("[static] every application table is schema-qualified (public.) and there is NO dynamic SQL in any function", () => {
  for (const name of Object.values(FN)) {
    const c = code(fnText(name));
    assert.doesNotMatch(c, /(?<!public\.)\b(estimates|estimate_items|estimate_activities|org_memberships|profiles|contacts|leads|projects)\b/, `${name}: unqualified table reference`);
    assert.doesNotMatch(c, /\bexecute\b|\bformat\s*\(/i, `${name}: dynamic SQL is not allowed`);
  }
});

test("[static] grants — create/add: revoked from public, anon, authenticated; granted ONLY to service_role", () => {
  for (const name of [FN.create, FN.add]) {
    assert.deepEqual(grantees(name, "revoke"), ["anon", "authenticated", "public"], `${name} revoke`);
    assert.deepEqual(grantees(name, "grant"), ["service_role"], `${name} grant`);
  }
});

test("[static] grants — replace: revoked from public, anon, service_role; granted ONLY to authenticated", () => {
  assert.deepEqual(grantees(FN.replace, "revoke"), ["anon", "public", "service_role"]);
  assert.deepEqual(grantees(FN.replace, "grant"), ["authenticated"]);
});

test("[static] grants — normalize helper: revoked from public, anon, authenticated, service_role and NEVER granted to any role", () => {
  assert.deepEqual(grantees(FN.normalize, "revoke"), ["anon", "authenticated", "public", "service_role"]);
  assert.deepEqual(grantees(FN.normalize, "grant"), []);
});

test("[static] pre-0 — the migration hardens on_estimate_update's function: public.projects qualified, own search_path = pg_catalog, pg_temp, still SECURITY INVOKER, and it is replaced BEFORE the RPCs exist", () => {
  const body = fnText(FN.syncProjectTotal);
  assert.match(body, /\nreturns trigger\nlanguage plpgsql\nset search_path = pg_catalog, pg_temp\nas \$\$/);
  assert.doesNotMatch(body, /security definer/i, "behavior-preserving: it must stay SECURITY INVOKER (runs under the caller's RLS as before)");
  assert.match(code(body), /update public\.projects\s+set original_estimate_total = new\.total\s+where estimate_id = new\.id;/);
  assert.doesNotMatch(code(body), /update\s+projects/i);
  assert.ok(MIGRATION.indexOf("create or replace function public.sync_project_estimate_total()") < MIGRATION.indexOf("create or replace function public.estimate_rpc_normalize_ai_items"), "must precede the RPC definitions");
});

test("[static] pre-0 — the RPC search_path is NOT broadened, and the trigger function replacement carries no grants/revokes or trigger DDL", () => {
  for (const name of [FN.create, FN.add, FN.replace]) assert.match(fnText(name), /set search_path = pg_catalog, pg_temp\n/);
  for (const name of [FN.create, FN.add, FN.replace, FN.normalize]) assert.doesNotMatch(fnText(name), /search_path[^\n]*public/);
  assert.doesNotMatch(MIGRATION, /(create|drop|alter)\s+(or replace\s+)?trigger/i, "the migration must not create, drop or alter any trigger");
  assert.doesNotMatch(MIGRATION, /(grant|revoke)[^;]*sync_project_estimate_total/i);
});

test("[static] the model-facing TypeScript path cannot pick the org: handlers pass ctx.orgId and never read it from input", () => {
  assert.match(HANDLERS, /p_org_id: ctx\.orgId,/);
  assert.doesNotMatch(HANDLERS, /p_org_id: input\./);
  assert.doesNotMatch(HANDLERS, /p_created_by: input\./);
});
