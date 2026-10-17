// src/lib/estimate-item-rows.ts
//
// Pure helpers for how the estimate editor persists `metadata` on estimate_items
// (and estimates). No Supabase, no React, no imports — usable in the browser
// editor and in tests.
//
// WHY THIS EXISTS (live bug, EST-000006): `estimate_items.metadata` is NOT NULL.
// The editor used to send a `metadata` key on SOME rows only (the unpriced ones).
// supabase-js/PostgREST bulk inserts take the UNION of keys and fill the rest with
// NULL, so any save that mixed unpriced and priced lines failed with 23502 — after
// the old rows had already been deleted. The fix is a uniform row shape: EVERY row
// carries a `metadata` object, and the object the line was loaded with is preserved.
//
// price_pending semantics (see estimate-pricing-gate.ts): an AI-created placeholder
// line stays pending until the owner explicitly touches its price. The editor tracks
// that as the line's `pricePending` flag (cleared on any price edit, including an
// explicit 0). This module turns the flag into the stored metadata WITHOUT touching
// any other key.

export type JsonObject = Record<string, unknown>;

/** A real metadata object, or `{}`. Arrays, null, primitives -> `{}`; never throws. */
export function asMetadataObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

/**
 * The metadata to persist for one editor line. Starts from a COPY of the line's
 * existing metadata and manages exactly one key:
 *   - `price_pending: true` iff the line is still an untouched pending placeholder
 *     (`pricePending` flag still set, not a heading, and no positive price);
 *   - otherwise `price_pending` is removed (price edited, explicit 0, heading, stale marker).
 * Every other key (ai_proposed, quantity_pending, ai_execution_id, anything else)
 * is preserved. Always returns an object — never null/undefined.
 */
export function buildItemMetadata(
  existing: unknown,
  opts: { pricePending?: boolean; isHeading?: boolean; price: number },
): JsonObject {
  const meta = asMetadataObject(existing);
  delete meta.price_pending;
  const stillPending = !!opts.pricePending && !opts.isHeading && !(opts.price > 0);
  if (stillPending) meta.price_pending = true;
  return meta;
}

/** Item metadata for a DUPLICATED estimate: everything is kept (price_pending stays,
 * so an unpriced AI estimate remains blocked from Send) EXCEPT `ai_execution_id`,
 * so a copy can never look like an idempotent replay of the original AI run. */
export function duplicateItemMetadata(existing: unknown): JsonObject {
  const meta = asMetadataObject(existing);
  delete meta.ai_execution_id;
  return meta;
}

/** Header metadata for a DUPLICATED estimate (provenance such as ai_generated is
 * kept; ai_execution_id is dropped for the same reason as above). */
export function duplicateEstimateMetadata(existing: unknown): JsonObject {
  return duplicateItemMetadata(existing);
}

/** Merge editor-owned header fields into the estimate's existing metadata instead of
 * replacing it (so ai_generated / ai_execution_id / unrelated keys survive a save).
 * Pure: neither argument is mutated. */
export function mergeEstimateMetadata(existing: unknown, patch: JsonObject): JsonObject {
  return { ...asMetadataObject(existing), ...patch };
}

// ── Safer replacement of an estimate's line items ─────────────────────────

/** Minimal slice of the Supabase client this helper needs (kept structural so it can
 * be unit-tested with the in-memory fake). */
type ItemsClient = { from: (table: string) => any };

export type ReplaceItemsResult =
  | { ok: true; insertedIds: string[]; removedCount: number }
  | { ok: false; phase: "load_existing" | "insert_new" | "delete_old"; error: unknown };

function logDbError(operation: string, error: unknown): void {
  const e = (error && typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown };
  // Operation + Postgres code/message only — never row payloads or customer content.
  console.error("[estimate-item-rows] db error", {
    operation,
    code: typeof e.code === "string" ? e.code : null,
    message: typeof e.message === "string" ? e.message : String(error ?? ""),
  });
}

/**
 * Replace all line items of an estimate WITHOUT the delete-first data-loss window.
 *   1. read the ids of the CURRENT items;
 *   2. insert the replacement rows (database-generated ids — the rows carry no id,
 *      so nothing can collide with the old rows' primary keys);
 *   3. only after that succeeds, delete the OLD ids.
 * If the insert fails the old items are untouched. If deleting the old items fails,
 * the newly inserted rows (and ONLY those) are removed as a best-effort compensation,
 * so the estimate is left exactly as it was. Not a transaction (no RPC/migration) —
 * the worst residual case is a failed compensation leaving duplicates, never loss.
 */
export async function replaceEstimateItems(
  client: ItemsClient,
  estimateId: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<ReplaceItemsResult> {
  const { data: existing, error: loadError } = await client.from("estimate_items").select("id").eq("estimate_id", estimateId);
  if (loadError) { logDbError("replace_items.load_existing", loadError); return { ok: false, phase: "load_existing", error: loadError }; }
  const oldIds: string[] = ((existing ?? []) as Array<{ id: string }>).map((r) => r.id);

  let insertedIds: string[] = [];
  if (rows.length > 0) {
    const { data: inserted, error: insertError } = await client.from("estimate_items").insert(rows).select("id");
    if (insertError) { logDbError("replace_items.insert_new", insertError); return { ok: false, phase: "insert_new", error: insertError }; }
    insertedIds = ((inserted ?? []) as Array<{ id: string }>).map((r) => r.id);
  }

  if (oldIds.length > 0) {
    const { error: deleteError } = await client.from("estimate_items").delete().in("id", oldIds);
    if (deleteError) {
      logDbError("replace_items.delete_old", deleteError);
      if (insertedIds.length > 0) {
        // Compensate: remove ONLY the rows we just inserted; never touch the old rows.
        const { error: cleanupError } = await client.from("estimate_items").delete().in("id", insertedIds);
        if (cleanupError) logDbError("replace_items.compensating_delete", cleanupError);
      }
      return { ok: false, phase: "delete_old", error: deleteError };
    }
  }
  return { ok: true, insertedIds, removedCount: oldIds.length };
}
