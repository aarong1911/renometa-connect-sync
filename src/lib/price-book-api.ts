// src/lib/price-book-api.ts
//
// Client wrappers for the trusted Price Book + Suggest Pricing Netlify functions. Nothing here sends an org id, a reviewer id, a
// normalized name or a timestamp: the server resolves the organization and user from the bearer token and computes the rest.
// Types are imported from the SHARED pricing modules so the browser and the server validate against the same contract.

import { supabase } from "@/lib/supabase";
import type { PriceBookPatchInput, PriceBookWriteInput } from "@/lib/pricing/price-book";
import { readStaffPricingIntelligence, type StaffPricingIntelligence } from "@/lib/pricing/staff-pricing";

export type { PriceBookPatchInput, PriceBookWriteInput };

/** The full staff-facing row (owner/admin only; includes internal cost / markup / notes). */
export type PriceBookRow = {
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

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

async function call<T>(url: string, init: RequestInit, fallbackError: string): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(await authHeaders()) } });
  let data: any = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const details = Array.isArray(data?.details) && data.details.length ? ` (${data.details.join("; ")})` : "";
    throw new Error(`${data?.error || fallbackError}${details}`);
  }
  return data as T;
}

const PRICE_BOOK_URL = "/.netlify/functions/price-book";

export async function listPriceBookItems(filter: { q?: string; active?: "all" | "active" | "inactive" } = {}): Promise<PriceBookRow[]> {
  const params = new URLSearchParams();
  if (filter.q?.trim()) params.set("q", filter.q.trim());
  if (filter.active && filter.active !== "all") params.set("active", filter.active);
  const qs = params.toString();
  const data = await call<{ items: PriceBookRow[] }>(`${PRICE_BOOK_URL}${qs ? `?${qs}` : ""}`, { method: "GET" }, "Could not load the Price Book.");
  return data.items ?? [];
}

export async function createPriceBookItem(input: PriceBookWriteInput): Promise<PriceBookRow> {
  const data = await call<{ item: PriceBookRow }>(PRICE_BOOK_URL, { method: "POST", body: JSON.stringify(input) }, "Could not save the price book entry.");
  return data.item;
}

export async function updatePriceBookItem(id: string, patch: PriceBookPatchInput): Promise<PriceBookRow> {
  const data = await call<{ item: PriceBookRow }>(PRICE_BOOK_URL, { method: "PATCH", body: JSON.stringify({ id, patch }) }, "Could not save the price book entry.");
  return data.item;
}

export type SuggestPricingResponse =
  | { kind: "all_priced"; message: string }
  | { kind: "suggestions"; pricing: StaffPricingIntelligence; requestedItems: number; capped: boolean };

/** Staff "Suggest Pricing" for the open estimate. Read only: nothing is applied. */
export async function suggestEstimatePricing(estimateId: string): Promise<SuggestPricingResponse> {
  const data = await call<any>("/.netlify/functions/estimate-suggest-pricing", { method: "POST", body: JSON.stringify({ estimateId }) }, "Could not calculate pricing suggestions.");
  if (data?.kind === "all_priced") return { kind: "all_priced", message: String(data.message ?? "") };
  const pricing = readStaffPricingIntelligence(data?.pricing);
  if (!pricing) throw new Error("Could not calculate pricing suggestions.");
  return { kind: "suggestions", pricing, requestedItems: Number(data.requestedItems) || 0, capped: data.capped === true };
}
