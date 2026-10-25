// src/lib/pricing/price-book-reader.ts
//
// Pricing Intelligence P4 — the TRUSTED, ORG-SCOPED, READ-ONLY Price Book reader used by the suggestion pipeline.
//
// TRUST BOUNDARY
//   - `orgId` comes from trusted server code (ActionContext.orgId); every query filters on it. Inactive entries are filtered in
//     the query (active = true) AND re-checked in code (the active flag is part of the select list for that reason).
//   - The SELECT LIST IS EXPLICIT and deliberately omits id, internal_unit_cost, default_markup_percent, notes, reviewed_by,
//     source and the timestamps. This function therefore cannot return staff-only cost data, a database id, or a reviewer id —
//     the entries it produces (PriceBookItem) have no field for them. A static test pins the select list.
//   - READ ONLY.
//
// RESILIENCE: if the price book cannot be read (for example the table does not exist yet because the migration has not been
// applied, or a transient error), the suggestion pipeline continues with organization history only. That is reported as
// `available: false`; it is never a hard failure.

import type { PriceBookItem } from "./price-book";
import { MAX_PRICE_BOOK_ITEMS_READ } from "./price-book";

export type PriceBookClient = { from: (table: string) => any };

/** The ONLY columns the suggestion pipeline reads from public.pricing_catalog_items. */
export const PRICE_BOOK_READ_COLUMNS = "name, aliases, project_types, item_type, unit, sell_unit_price, low_unit_price, high_unit_price, reviewed_at, active";

export type PriceBookReadResult = { available: true; items: PriceBookItem[] } | { available: false; items: [] };

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function readPriceBook(client: PriceBookClient, orgId: string): Promise<PriceBookReadResult> {
  if (!orgId) return { available: false, items: [] };
  try {
    const { data, error } = await client
      .from("pricing_catalog_items")
      .select(PRICE_BOOK_READ_COLUMNS)
      .eq("org_id", orgId)
      .eq("active", true)
      .order("normalized_name", { ascending: true })
      .limit(MAX_PRICE_BOOK_ITEMS_READ);
    if (error) {
      const e = error as { code?: unknown; message?: unknown };
      console.error("[price-book-reader] read error", { code: typeof e.code === "string" ? e.code : null, message: typeof e.message === "string" ? e.message : "" });
      return { available: false, items: [] };
    }
    const items: PriceBookItem[] = [];
    for (const r of (data ?? []) as any[]) {
      const sell = num(r.sell_unit_price);
      if (r.active === false) continue; // defense in depth: inactive entries are never matched
      if (sell === null || sell < 0 || typeof r.name !== "string" || typeof r.unit !== "string") continue;
      items.push({
        name: r.name,
        aliases: Array.isArray(r.aliases) ? r.aliases.filter((a: unknown): a is string => typeof a === "string") : [],
        projectTypes: Array.isArray(r.project_types) ? r.project_types.filter((a: unknown): a is string => typeof a === "string") : [],
        itemType: typeof r.item_type === "string" ? r.item_type : null,
        unit: r.unit,
        sellUnitPrice: sell,
        lowUnitPrice: num(r.low_unit_price),
        highUnitPrice: num(r.high_unit_price),
        reviewed: !!r.reviewed_at,
      });
    }
    return { available: true, items };
  } catch (err) {
    console.error("[price-book-reader] unexpected error", { message: err instanceof Error ? err.message : "unknown" });
    return { available: false, items: [] };
  }
}
