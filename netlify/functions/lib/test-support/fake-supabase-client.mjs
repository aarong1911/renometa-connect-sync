// scripts/fake-supabase-client.mjs
//
// Test-safety incident follow-up (2026-09-17/18). A MINIMAL in-memory
// fake of the Supabase query-builder chains actually used by
// netlify/functions/lib/meta-whatsapp-selection-store.ts — NOT a general
// Supabase emulator. It exists so those three functions (and the pure
// decision/discovery functions alongside them) can be unit-tested without
// ever touching a real Supabase project — no real `organizations` row,
// no real `meta_connections` mutation, no FK constraints to satisfy.
//
// Deliberately does NOT enforce foreign keys, unique constraints, RLS, or
// any other real-Postgres behavior — those require a real (but isolated)
// Postgres instance to validate (local Supabase via `supabase start`, or
// a dedicated Supabase test project) and are explicitly OUT OF SCOPE for
// this fake. See scripts/TEST_SAFETY_RULES.md and this pass's own report
// for why that gap is a deliberate, reported limitation, not an oversight.
//
// Supports the chain shapes meta-whatsapp-selection-store.ts uses:
//   .from(table).insert(obj)                                   -> awaited directly, {error}
//   .from(table).select(cols).eq().eq().maybeSingle()           -> {data, error}
//   .from(table).update(obj).eq()*.is().gt().select(cols)       -> awaited directly, {data: rows[], error}
//   .from(table).upsert(obj, {onConflict}).                     -> awaited directly, {error}
//
// AI-2E extension (this pass): action-executor.ts's real chain shapes
// needed a few more primitives, added here in the same "fail loud on
// anything unhandled" spirit rather than a general-purpose emulator:
//   .insert(obj).select(cols).single()                          -> the newly inserted row
//   .select(cols).eq()*.order(col,{ascending}).limit(n).maybeSingle()
//   .upsert(obj, {onConflict, ignoreDuplicates}).select(cols)   -> [] on conflict when ignoreDuplicates
//   .update(obj).eq()*.is(col,null).select(cols)                -> only rows matched BEFORE the update
//   .delete().eq()*                                             -> awaited directly, {error}
//
// Any chain shape used elsewhere in the app that isn't listed above will
// throw "not implemented in fake-supabase-client" rather than silently
// doing the wrong thing — fail loud, not fail quiet.

import crypto from "node:crypto";

// Column reference: plain column, or a PostgREST jsonb text path such as
// "meta->>some_key" (returns the value as text, or null when absent).
function columnValue(row, col) {
  const idx = col.indexOf("->>");
  if (idx === -1) return row[col] === undefined ? null : row[col];
  const base = row[col.slice(0, idx)];
  const v = base && typeof base === "object" ? base[col.slice(idx + 3)] : undefined;
  return v === undefined || v === null ? null : String(v);
}

function evalCondition(row, f) {
  if (f.op === "not") return !evalCondition(row, f.inner);
  if (f.op === "or") return f.branches.some((br) => br.every((c) => evalCondition(row, c)));
  if (f.op === "and") return f.conds.every((c) => evalCondition(row, c));
  // A column absent from an inserted object (e.g. consumed_at never set
  // at insert time) behaves as SQL NULL, same as a real Postgres row.
  const val = columnValue(row, f.col);
  if (f.op === "eq") return val === f.val;
  if (f.op === "is") return val === (f.val === "null" ? null : f.val);
  // SQL comparison with NULL is never true.
  if (f.op === "gt") return val !== null && val > f.val;
  if (f.op === "lt") return val !== null && val < f.val;
  if (f.op === "gte") return val !== null && val >= f.val;
  if (f.op === "lte") return val !== null && val <= f.val;
  if (f.op === "in") return f.val.includes(val);
  throw new Error("not implemented in fake-supabase-client: filter op " + f.op);
}

function matchesFilters(row, filters) {
  return filters.every((f) => evalCondition(row, f));
}

// Minimal PostgREST or=(...) parser: comma-separated items, each either
// col.op.value or and(item,item,...). Nested parentheses supported; values
// must not contain commas/parentheses (true for the ISO timestamps used).
function splitTopLevel(str) {
  const out = []; let depth = 0; let cur = "";
  for (const ch of str) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function parseCondition(item) {
  if (item.startsWith("and(") && item.endsWith(")")) {
    return { op: "and", conds: splitTopLevel(item.slice(4, -1)).map(parseCondition) };
  }
  const m = item.match(/^(.+?)\.(eq|is|lt|gt)\.(.*)$/);
  if (!m) throw new Error("not implemented in fake-supabase-client: or() item " + item);
  return { col: m[1], op: m[2], val: m[3] };
}

class FakeQueryBuilder {
  constructor(table, store, uniqueConstraints) {
    this.table = table;
    this.store = store;
    // AI-2E extension: an array of column-name arrays, e.g.
    // [["org_id", "provider_message_id"]] — see createFakeSupabaseClient's
    // own doc comment. Empty/undefined means "no declared constraint,"
    // matching this fake's original no-constraints-enforced behavior.
    this.uniqueConstraints = uniqueConstraints ?? [];
    this.filters = [];
    this.op = null; // "insert" | "update" | "upsert" | "select" | "delete"
    this.payload = null;
    this.selectCols = null;
    this.selectOpts = null;
    this.upsertOpts = null;
    this.orderSpec = null;
    this.limitN = null;
  }

  eq(col, val) { this.filters.push({ col, op: "eq", val }); return this; }
  is(col, val) { this.filters.push({ col, op: "is", val }); return this; }
  gt(col, val) { this.filters.push({ col, op: "gt", val }); return this; }
  lt(col, val) { this.filters.push({ col, op: "lt", val }); return this; }
  not(col, op, val) { this.filters.push({ op: "not", inner: { col, op, val } }); return this; }
  gte(col, val) { this.filters.push({ col, op: "gte", val }); return this; }
  lte(col, val) { this.filters.push({ col, op: "lte", val }); return this; }
  filter(col, op, val) { this.filters.push({ col, op, val }); return this; }
  or(expr) { this.filters.push({ op: "or", branches: splitTopLevel(expr).map((i) => [parseCondition(i)]) }); return this; }
  in(col, vals) { this.filters.push({ col, op: "in", val: vals }); return this; }

  order(col, opts) {
    this.orderSpec = { col, ascending: opts?.ascending !== false };
    return this;
  }

  limit(n) {
    this.limitN = n;
    return this;
  }

  select(cols, opts) {
    this.selectCols = cols;
    this.selectOpts = opts ?? null;
    if (!this.op) this.op = "select";
    return this;
  }

  insert(obj) {
    this.op = "insert";
    this.payload = obj;
    return this;
  }

  update(obj) {
    this.op = "update";
    this.payload = obj;
    return this;
  }

  upsert(obj, opts) {
    this.op = "upsert";
    this.payload = obj;
    this.upsertOpts = opts;
    return this;
  }

  delete() {
    this.op = "delete";
    return this;
  }

  // .single()/.maybeSingle() following a mutating op (insert/update/upsert)
  // must resolve the MUTATION's own result rows, not re-run an unrelated
  // filtered read against the whole table (that was a real bug here: an
  // insert().select("id").single() chain with no .eq() filters would
  // otherwise silently return every pre-existing row in the table instead
  // of the row just inserted). A read-only select() chain still filters
  // the live store as before.
  async _rowsForTerminal() {
    if (this.op === "insert" || this.op === "update" || this.op === "upsert" || this.op === "delete") {
      const { data, error } = await this._execute();
      if (error) return { rows: null, error };
      return { rows: data ?? [], error: null };
    }
    return { rows: this._runSelectLike(), error: null };
  }

  async maybeSingle() {
    const { rows, error } = await this._rowsForTerminal();
    if (error) return { data: null, error };
    if (rows.length > 1) return { data: null, error: { message: "multiple rows returned for maybeSingle()" } };
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    const { rows, error } = await this._rowsForTerminal();
    if (error) return { data: null, error };
    if (rows.length !== 1) return { data: null, error: { message: "expected exactly one row for single()" } };
    return { data: rows[0], error: null };
  }

  _runSelectLike() {
    const rows = this.store.get(this.table) ?? [];
    let matched = rows.filter((r) => matchesFilters(r, this.filters));
    if (this.orderSpec) {
      const { col, ascending } = this.orderSpec;
      matched = [...matched].sort((a, b) => {
        const av = a[col], bv = b[col];
        if (av === bv) return 0;
        const cmp = av > bv ? 1 : -1;
        return ascending ? cmp : -cmp;
      });
    }
    if (this.limitN != null) matched = matched.slice(0, this.limitN);
    return matched;
  }

  // Makes the builder itself awaitable (matches supabase-js's own
  // thenable query builder) for the "await chain with no .single()/
  // .maybeSingle()" shapes used by insert()/update()/upsert().
  then(resolve, reject) {
    this._execute().then(resolve, reject);
  }

  async _execute() {
    const rows = this.store.get(this.table) ?? [];

    if (this.op === "insert") {
      // AI-2E extension: a declared unique constraint (see
      // createFakeSupabaseClient's doc comment) now genuinely rejects a
      // conflicting insert with the same {code, message} shape a real
      // Postgres unique-index violation returns — needed to honestly test
      // code that branches on `error.code === "23505"` (e.g.
      // meta-whatsapp-inbound.ts's dedupe-on-provider_message_id), rather
      // than a fake that silently allows an unbounded number of
      // "duplicate" rows a real DB would have rejected.
      for (const cols of this.uniqueConstraints) {
        const conflict = rows.find((r) => cols.every((c) => (this.payload[c] === undefined ? null : this.payload[c]) === (r[c] === undefined ? null : r[c])));
        if (conflict) {
          return {
            data: null,
            error: { code: "23505", message: `duplicate key value violates unique constraint on (${cols.join(", ")})` },
          };
        }
      }
      // Real Postgres tables in this schema default `id` to
      // gen_random_uuid() — callers like action-executor.ts's insertStep()
      // rely on getting a real generated id back via
      // .insert(...).select("id").single() without ever supplying one
      // themselves. Match that here so a fake-backed test exercises the
      // same "id assigned by the row's own insert" shape as production.
      const newRow = { ...this.payload };
      if (newRow.id === undefined) newRow.id = crypto.randomUUID();
      rows.push(newRow);
      this.store.set(this.table, rows);
      return { data: [newRow], error: null };
    }

    if (this.op === "update") {
      // Snapshot rows matching BEFORE mutation — matches real Postgres
      // `UPDATE ... RETURNING`, which returns the rows the WHERE clause
      // matched at update time (a subtlety this fake had already handled
      // by luck, since Object.assign mutates in place; kept explicit now
      // that .single()/.maybeSingle() also call this path).
      const matched = rows.filter((r) => matchesFilters(r, this.filters));
      for (const row of matched) Object.assign(row, this.payload);
      return { data: matched, error: null };
    }

    if (this.op === "upsert" && Array.isArray(this.payload)) {
      // Bulk upsert (gmail-sync.ts upserts an array): apply row by row.
      const out = [];
      for (const p of this.payload) {
        const one = new FakeQueryBuilder(this.table, this.store, this.uniqueConstraints);
        one.op = "upsert";
        one.payload = p;
        one.upsertOpts = this.upsertOpts;
        const r = await one._execute();
        if (r.error) return r;
        out.push(...(r.data ?? []));
      }
      return { data: out, error: null };
    }

    if (this.op === "upsert") {
      const conflictCols = (this.upsertOpts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      let existing = null;
      if (conflictCols.length > 0) {
        existing = rows.find((r) => conflictCols.every((c) => r[c] === this.payload[c]));
      }
      if (existing) {
        // Real Postgres `ON CONFLICT ... DO NOTHING` (ignoreDuplicates:
        // true) returns zero rows for the conflicting insert attempt —
        // the caller must distinguish "I won the claim" (rows returned)
        // from "someone already holds it" (empty array), exactly like
        // action-executor.ts's claimIdempotencySlot() does.
        if (this.upsertOpts?.ignoreDuplicates) {
          return { data: [], error: null };
        }
        Object.assign(existing, this.payload);
        return { data: [existing], error: null };
      }
      // Same gen_random_uuid()-default reasoning as the plain insert
      // branch above — a fresh upsert row with no existing conflict is a
      // real INSERT under the hood, so it gets a real generated id too.
      const newRow = { ...this.payload };
      if (newRow.id === undefined) newRow.id = crypto.randomUUID();
      rows.push(newRow);
      this.store.set(this.table, rows);
      return { data: [newRow], error: null };
    }

    if (this.op === "delete") {
      const remaining = [];
      const deleted = [];
      for (const r of rows) {
        if (matchesFilters(r, this.filters)) deleted.push(r);
        else remaining.push(r);
      }
      this.store.set(this.table, remaining);
      return { data: deleted, error: null };
    }

    if (this.op === "select") {
      const matched = this._runSelectLike();
      // `.select(cols, { count: "exact", head: true })` — a count-only
      // query (e.g. ai-approvals-count.ts's pending-badge count): real
      // PostgREST returns `data: null` and the match count separately when
      // `head: true`, never the actual rows. Matches that shape rather
      // than returning the same `{data: rows}` a normal select would.
      if (this.selectOpts?.head) {
        return { data: null, count: matched.length, error: null };
      }
      // Bare .select() awaited without .single()/.maybeSingle().
      return { data: matched, error: null };
    }

    throw new Error(`[fake-supabase-client] unsupported operation on table "${this.table}"`);
  }
}

/**
 * Creates a fresh in-memory fake Supabase client. `seedTables` optionally
 * pre-populates tables, e.g. { meta_connections: [{ org_id: "...", ... }] }.
 * `rpcHandlers` optionally maps an RPC function name to
 * `(args) => { data, error }` — used to unit-test TS wrapper code that
 * calls `.rpc(...)` (e.g. finalizeMetaWhatsAppSelectionAtomic) WITHOUT a
 * real Postgres function to call. This does NOT simulate the RPC's own
 * SQL logic/atomicity — that is validated separately against real local
 * Postgres (see scripts/TEST_SAFETY_RULES.md's "two distinct layers"
 * rule). It only lets a test supply a canned response and assert the TS
 * wrapper maps it to the right shape/HTTP status.
 */
export function createFakeSupabaseClient(seedTables = {}, rpcHandlers = {}, options = {}) {
  const store = new Map();
  for (const [table, rows] of Object.entries(seedTables)) {
    store.set(table, rows.map((r) => ({ ...r })));
  }
  // `options.uniqueConstraints`: { tableName: [["col1","col2"], ...] } —
  // see the insert-op comment above for why this exists (AI-2E). Omitted
  // entirely by default, matching every pre-existing caller of this fake.
  const uniqueConstraints = options.uniqueConstraints ?? {};

  return {
    from(table) {
      return new FakeQueryBuilder(table, store, uniqueConstraints[table]);
    },
    async rpc(fnName, args) {
      const handler = rpcHandlers[fnName];
      if (!handler) {
        throw new Error(`[fake-supabase-client] no rpc handler registered for "${fnName}"`);
      }
      return handler(args);
    },
    // Debug/assertion helper for tests — not part of the real
    // SupabaseClient surface, only used test-side.
    __dumpTable(table) {
      return (store.get(table) ?? []).map((r) => ({ ...r }));
    },
  };
}
