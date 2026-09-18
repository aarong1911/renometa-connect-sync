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
// Supports exactly the chain shapes meta-whatsapp-selection-store.ts
// uses:
//   .from(table).insert(obj)                                   -> awaited directly, {error}
//   .from(table).select(cols).eq().eq().maybeSingle()           -> {data, error}
//   .from(table).update(obj).eq()*.is().gt().select(cols)       -> awaited directly, {data: rows[], error}
//   .from(table).upsert(obj, {onConflict}).                     -> awaited directly, {error}
//
// Any chain shape used elsewhere in the app that isn't listed above will
// throw "not implemented in fake-supabase-client" rather than silently
// doing the wrong thing — fail loud, not fail quiet.

function matchesFilters(row, filters) {
  for (const f of filters) {
    // A column absent from an inserted object (e.g. consumed_at never set
    // at insert time) behaves as SQL NULL, same as a real Postgres row —
    // normalize `undefined` to `null` before comparing, otherwise .is(col,
    // null) would wrongly reject a row that never had the column set.
    const val = row[f.col] === undefined ? null : row[f.col];
    if (f.op === "eq" && val !== f.val) return false;
    if (f.op === "is" && val !== f.val) return false; // f.val is null for .is(col, null)
    if (f.op === "gt" && !(val > f.val)) return false;
  }
  return true;
}

class FakeQueryBuilder {
  constructor(table, store) {
    this.table = table;
    this.store = store;
    this.filters = [];
    this.op = null; // "insert" | "update" | "select" | "upsert"
    this.payload = null;
    this.selectCols = null;
    this.upsertOpts = null;
  }

  eq(col, val) { this.filters.push({ col, op: "eq", val }); return this; }
  is(col, val) { this.filters.push({ col, op: "is", val }); return this; }
  gt(col, val) { this.filters.push({ col, op: "gt", val }); return this; }

  select(cols) {
    this.selectCols = cols;
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

  async maybeSingle() {
    const rows = this._runSelectLike();
    if (rows.length > 1) return { data: null, error: { message: "multiple rows returned for maybeSingle()" } };
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    const rows = this._runSelectLike();
    if (rows.length !== 1) return { data: null, error: { message: "expected exactly one row for single()" } };
    return { data: rows[0], error: null };
  }

  _runSelectLike() {
    const rows = this.store.get(this.table) ?? [];
    return rows.filter((r) => matchesFilters(r, this.filters));
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
      const newRow = { ...this.payload };
      rows.push(newRow);
      this.store.set(this.table, rows);
      return { data: [newRow], error: null };
    }

    if (this.op === "update") {
      const matched = rows.filter((r) => matchesFilters(r, this.filters));
      for (const row of matched) Object.assign(row, this.payload);
      return { data: matched, error: null };
    }

    if (this.op === "upsert") {
      const conflictCols = (this.upsertOpts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      let existing = null;
      if (conflictCols.length > 0) {
        existing = rows.find((r) => conflictCols.every((c) => r[c] === this.payload[c]));
      }
      if (existing) {
        Object.assign(existing, this.payload);
      } else {
        rows.push({ ...this.payload });
        this.store.set(this.table, rows);
      }
      return { data: null, error: null };
    }

    if (this.op === "select") {
      // Bare .select() awaited without .single()/.maybeSingle() — not used
      // by the store functions today, but supported for completeness.
      return { data: this._runSelectLike(), error: null };
    }

    throw new Error(`[fake-supabase-client] unsupported operation on table "${this.table}"`);
  }
}

/**
 * Creates a fresh in-memory fake Supabase client. `seedTables` optionally
 * pre-populates tables, e.g. { meta_connections: [{ org_id: "...", ... }] }.
 */
export function createFakeSupabaseClient(seedTables = {}) {
  const store = new Map();
  for (const [table, rows] of Object.entries(seedTables)) {
    store.set(table, rows.map((r) => ({ ...r })));
  }

  return {
    from(table) {
      return new FakeQueryBuilder(table, store);
    },
    // Debug/assertion helper for tests — not part of the real
    // SupabaseClient surface, only used test-side.
    __dumpTable(table) {
      return (store.get(table) ?? []).map((r) => ({ ...r }));
    },
  };
}
