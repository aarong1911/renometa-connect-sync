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

// ── Atomic editor save (one database transaction) ─────────────────────────

/** Minimal slice of the Supabase client this helper needs (structural, so it is unit-testable with a fake). */
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

export type SaveEstimateResult =
  | { ok: true; itemCount: number }
  | { ok: false; error: unknown };

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
 * Saves the editor's header fields AND replaces the estimate's line items in ONE database transaction
 * (public.replace_estimate_items_transaction, SECURITY INVOKER — the caller's existing RLS is the boundary).
 * If any part fails, the header and the old items are exactly as they were: there is no partial header
 * update, no delete-then-failed-insert, and no client-side compensation to fail in turn.
 *
 *  - header:        only editor-owned columns (the RPC whitelists and REJECTS anything else — never org_id,
 *                   status, number, created_by, lifecycle timestamps or relationship ids). Do not send
 *                   client_total: the database writes it equal to total.
 *  - metadataPatch: only editor-owned metadata keys (serviceAddress). Merged server-side, so AI provenance
 *                   (ai_generated / ai_execution_id) is never replaced.
 *  - rows:          the complete replacement item set; every row carries a metadata OBJECT (see buildItemMetadata).
 *                   Rows may still be built with an `estimate_id` (the direct-insert create/duplicate paths need it);
 *                   it is STRIPPED here because the RPC takes the estimate from p_estimate_id and its item whitelist
 *                   deliberately rejects `estimate_id` (a row must never be able to name a different estimate).
 */
/** Removes the only editor-row key the RPC does not accept: `estimate_id` (the RPC binds items to p_estimate_id). */
function toRpcItemRow(row: Record<string, unknown>): Record<string, unknown> {
  const { estimate_id: _estimateId, ...rest } = row;
  return rest;
}

export async function saveEstimateWithItems(
  client: RpcClient,
  args: {
    estimateId: string;
    header: Record<string, unknown>;
    metadataPatch: Record<string, unknown>;
    rows: ReadonlyArray<Record<string, unknown>>;
  },
): Promise<SaveEstimateResult> {
  const { data, error } = await client.rpc("replace_estimate_items_transaction", {
    p_estimate_id: args.estimateId,
    p_header: args.header,
    p_metadata_patch: args.metadataPatch,
    p_items: args.rows.map(toRpcItemRow),
  });
  if (error) {
    logDbError("save_estimate.replace_items_transaction", error);
    return { ok: false, error };
  }
  const itemCount = data && typeof data === "object" && typeof (data as { item_count?: unknown }).item_count === "number"
    ? (data as { item_count: number }).item_count
    : args.rows.length;
  return { ok: true, itemCount };
}

/** A user-safe message for a deliberate RPC failure ('estimate_rpc:<code>'), or null for anything else
 * (callers then fall back to their existing error handling). Nothing was changed in any of these cases. */
export function friendlyEstimateSaveError(error: unknown): string | null {
  const message = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  if (typeof message !== "string") return null;
  const i = message.indexOf("estimate_rpc:");
  if (i < 0) return null;
  const code = message.slice(i + "estimate_rpc:".length).split(/[^a-z_]/)[0];
  switch (code) {
    case "not_found": return "This estimate could not be found, or you don't have access to it. Nothing was changed.";
    case "delete_blocked": return "The estimate's line items could not be replaced. Nothing was changed.";
    default: return "The estimate could not be saved. Nothing was changed.";
  }
}
