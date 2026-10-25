// netlify/functions/lib/price-book-service.ts
//
// Pricing Intelligence P4 — trusted, ORG-SCOPED Price Book CRUD. HTTP-free so it is unit-testable; netlify/functions/price-book.ts
// is a thin handler around it.
//
// TRUST BOUNDARY (see the secure-backend / server-authorization skills)
//   - `orgId` and `userId` are parameters supplied by the HANDLER after it authenticated the bearer token and resolved the org +
//     owner/admin authority server-side. Nothing in a request body can set org_id, reviewed_by, normalized_name, source, id on
//     create, or any timestamp: the body schemas are STRICT and those names are not in them.
//   - Every read AND write filters on org_id. An id from another organization is "not found", indistinguishable from a missing id.
//   - normalized_name / aliases / unit are computed HERE with the shared deterministic normalizer (never trusted from the browser).
//   - Reviewer identity: marking an entry reviewed stamps reviewed_by = the authenticated user and reviewed_at = now. A browser
//     cannot name a reviewer.
//   - Soft disable only: there is no delete. active=false entries are ignored by Pricing Intelligence.
//   - This is the ONE place staff-only fields (internal_unit_cost, default_markup_percent, notes) are read or written. They are
//     returned only to the authenticated owner/admin who manages the price book, never to a model, customer or public payload.

import {
  normalizePriceBookWrite, priceBookPatchSchema, priceBookWriteSchema,
  type NormalizedPriceBookColumns, type PriceBookPatchInput,
} from "../../../src/lib/pricing/price-book";

export type PriceBookDbClient = { from: (table: string) => any };

/** The full staff-facing row (owner/admin only). */
export type PriceBookRecord = {
  id: string;
  name: string;
  aliases: string[];
  projectTypes: string[];
  itemType: string | null;
  unit: string;
  sellUnitPrice: number;
  lowUnitPrice: number | null;
  highUnitPrice: number | null;
  internalUnitCost: number | null;
  defaultMarkupPercent: number | null;
  taxable: boolean;
  active: boolean;
  source: string;
  notes: string | null;
  reviewedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export const PRICE_BOOK_RECORD_COLUMNS =
  "id, name, aliases, project_types, item_type, unit, sell_unit_price, low_unit_price, high_unit_price, internal_unit_cost, default_markup_percent, taxable, active, source, notes, reviewed_at, created_at, updated_at";

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function toPriceBookRecord(r: any): PriceBookRecord {
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    aliases: Array.isArray(r.aliases) ? r.aliases.filter((a: unknown): a is string => typeof a === "string") : [],
    projectTypes: Array.isArray(r.project_types) ? r.project_types.filter((a: unknown): a is string => typeof a === "string") : [],
    itemType: typeof r.item_type === "string" ? r.item_type : null,
    unit: String(r.unit ?? ""),
    sellUnitPrice: num(r.sell_unit_price) ?? 0,
    lowUnitPrice: num(r.low_unit_price),
    highUnitPrice: num(r.high_unit_price),
    internalUnitCost: num(r.internal_unit_cost),
    defaultMarkupPercent: num(r.default_markup_percent),
    taxable: r.taxable !== false,
    active: r.active !== false,
    source: typeof r.source === "string" ? r.source : "manual",
    notes: typeof r.notes === "string" ? r.notes : null,
    reviewedAt: typeof r.reviewed_at === "string" ? r.reviewed_at : null,
    createdAt: typeof r.created_at === "string" ? r.created_at : null,
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
  };
}

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 500 | 501; error: string; details?: string[] };

const GENERIC_FAIL = "Could not save the price book entry.";
const NOT_FOUND = "Price book entry not found.";

function mapDbError(operation: string, error: unknown): ServiceResult<never> {
  const e = (error && typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  // Operation + Postgres code only — never a row, a price or a name.
  console.error("[price-book-service] db error", { operation, code: code || null });
  if (code === "42P01") return { ok: false, status: 501, error: "The Price Book has not been set up in this environment yet (pending migration 20261026_pricing_catalog_items.sql)." };
  if (code === "23514" || code === "23502" || code === "22P02" || code === "22003") return { ok: false, status: 400, error: "Those price book values were rejected. Check the prices, project types and required fields." };
  return { ok: false, status: 500, error: GENERIC_FAIL };
}

// ── list / search ────────────────────────────────────────────────────────

export type ListFilter = { q?: string; active?: "all" | "active" | "inactive" };

/** Lists this organization's entries (newest-updated first). Search is applied in code over name + aliases so it uses the same
 * normalization as matching. Bounded. */
export async function listPriceBook(db: PriceBookDbClient, orgId: string, filter: ListFilter = {}): Promise<ServiceResult<PriceBookRecord[]>> {
  const { data, error } = await db
    .from("pricing_catalog_items")
    .select(PRICE_BOOK_RECORD_COLUMNS)
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false })
    .limit(1000);
  if (error) return mapDbError("list", error);
  let items = ((data ?? []) as any[]).map(toPriceBookRecord);
  if (filter.active === "active") items = items.filter((i) => i.active);
  if (filter.active === "inactive") items = items.filter((i) => !i.active);
  const q = (filter.q ?? "").trim().toLowerCase();
  if (q) {
    items = items.filter((i) => [i.name, ...i.aliases, i.itemType ?? "", ...i.projectTypes].some((s) => s.toLowerCase().includes(q)));
  }
  return { ok: true, value: items };
}

// ── create ───────────────────────────────────────────────────────────────

export async function createPriceBookItem(
  db: PriceBookDbClient,
  ctx: { orgId: string; userId: string },
  input: unknown,
  now: () => Date = () => new Date(),
): Promise<ServiceResult<PriceBookRecord>> {
  // `reviewed` is a request flag, not a column; everything else is validated + normalized by the shared module.
  const parsed = priceBookWriteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, error: "Invalid price book entry.", details: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`) };
  const normalized = normalizePriceBookWrite(parsed.data);
  if (!normalized.ok) return { ok: false, status: 400, error: "Invalid price book entry.", details: normalized.errors };

  const row = {
    org_id: ctx.orgId, // from the authenticated session, never from the body
    ...normalized.columns,
    source: "manual",
    ...(parsed.data.reviewed ? { reviewed_at: now().toISOString(), reviewed_by: ctx.userId } : {}),
  };
  const { data, error } = await db.from("pricing_catalog_items").insert(row).select(PRICE_BOOK_RECORD_COLUMNS).single();
  if (error || !data) return mapDbError("create", error);
  return { ok: true, value: toPriceBookRecord(data) };
}

// ── update / activate / deactivate ───────────────────────────────────────

/** Fields whose change invalidates a prior review (the reviewed state vouches for THIS content). */
const REVIEW_INVALIDATING: Array<keyof NormalizedPriceBookColumns> = [
  "name", "aliases", "project_types", "item_type", "unit", "sell_unit_price", "low_unit_price", "high_unit_price",
];

function columnsToWriteInput(c: NormalizedPriceBookColumns): Record<string, unknown> {
  return {
    name: c.name, aliases: c.aliases, projectTypes: c.project_types, itemType: c.item_type, unit: c.unit, sellUnitPrice: c.sell_unit_price,
    lowUnitPrice: c.low_unit_price, highUnitPrice: c.high_unit_price, internalUnitCost: c.internal_unit_cost, defaultMarkupPercent: c.default_markup_percent,
    taxable: c.taxable, active: c.active, notes: c.notes,
  };
}

export async function updatePriceBookItem(
  db: PriceBookDbClient,
  ctx: { orgId: string; userId: string },
  id: string,
  patchInput: unknown,
  now: () => Date = () => new Date(),
): Promise<ServiceResult<PriceBookRecord>> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, status: 404, error: NOT_FOUND };
  const parsedPatch = priceBookPatchSchema.safeParse(patchInput);
  if (!parsedPatch.success) return { ok: false, status: 400, error: "Invalid price book update.", details: parsedPatch.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`) };
  const patch: PriceBookPatchInput = parsedPatch.data;

  // Org-scoped load: a foreign / missing id is simply "not found".
  const { data: existingRow, error: loadError } = await db.from("pricing_catalog_items").select(PRICE_BOOK_RECORD_COLUMNS).eq("id", id).eq("org_id", ctx.orgId).maybeSingle();
  if (loadError) return mapDbError("load", loadError);
  if (!existingRow) return { ok: false, status: 404, error: NOT_FOUND };
  const existing = toPriceBookRecord(existingRow);

  // Merge the patch over the existing entry, then validate + normalize the MERGED whole (so cross-field rules such as
  // low <= sell <= high hold for the final state, not just the changed fields).
  const existingAsColumns = normalizePriceBookWrite({
    name: existing.name, aliases: existing.aliases, projectTypes: existing.projectTypes, itemType: existing.itemType, unit: existing.unit,
    sellUnitPrice: existing.sellUnitPrice, lowUnitPrice: existing.lowUnitPrice, highUnitPrice: existing.highUnitPrice,
    internalUnitCost: existing.internalUnitCost, defaultMarkupPercent: existing.defaultMarkupPercent, taxable: existing.taxable, active: existing.active, notes: existing.notes,
  });
  const base = existingAsColumns.ok ? columnsToWriteInput(existingAsColumns.columns) : {};
  const { reviewed, ...patchFields } = patch;
  const merged = normalizePriceBookWrite({ ...base, ...patchFields });
  if (!merged.ok) return { ok: false, status: 400, error: "Invalid price book update.", details: merged.errors };

  let reviewFields: Record<string, unknown> = {};
  if (reviewed === true) reviewFields = { reviewed_at: now().toISOString(), reviewed_by: ctx.userId };
  else if (reviewed === false) reviewFields = { reviewed_at: null, reviewed_by: null };
  else if (existing.reviewedAt && existingAsColumns.ok) {
    const changed = REVIEW_INVALIDATING.some((k) => JSON.stringify(merged.columns[k]) !== JSON.stringify(existingAsColumns.columns[k]));
    if (changed) reviewFields = { reviewed_at: null, reviewed_by: null };
  }

  const { data, error } = await db
    .from("pricing_catalog_items")
    .update({ ...merged.columns, ...reviewFields })
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .select(PRICE_BOOK_RECORD_COLUMNS)
    .maybeSingle();
  if (error) return mapDbError("update", error);
  if (!data) return { ok: false, status: 404, error: NOT_FOUND };
  return { ok: true, value: toPriceBookRecord(data) };
}

/** Soft enable / disable (an inactive entry is ignored by Pricing Intelligence). */
export function setPriceBookItemActive(db: PriceBookDbClient, ctx: { orgId: string; userId: string }, id: string, active: boolean) {
  return updatePriceBookItem(db, ctx, id, { active });
}
