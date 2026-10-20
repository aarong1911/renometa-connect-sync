// src/lib/agentic/estimate-handlers.ts
//
// Estimate Assistant Foundation. The ONLY trusted write/read seam AI Center
// has into `estimates` / `estimate_items`. Three action handlers, reached
// exclusively through action-executor.ts (executeStep / executeApprovedStep),
// which has already validated input against the Zod schemas below, enforced
// emergency pause, and — for the two write actions — gated on human approval.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
//
// Before this phase the ONLY estimate write path in the product was the
// browser editor (src/routes/estimates.tsx: browser-direct Supabase writes
// under RLS, totals computed in the browser). AI code must never write
// Supabase directly from model/orchestrator code, so this is the narrowest
// trusted server-side seam that reuses the SAME rules the editor applies:
//   - every AI line is a $0 pending placeholder, so no total is ever
//     model-computed (the RPCs write total and client_total together and
//     equal — the pre-existing trg_sync_total trigger copies client_total),
//   - estimate numbers are left to the set_estimate_number() trigger.
//
// ── NO INVENTED MONEY (structural, not just prompted) ───────────────────
//
// The write-action input schemas below contain NO price, quantity, tax,
// discount, deposit, or markup field. A model cannot supply one even if it
// tries (`.strict()` rejects unknown keys, and the executor validates before
// any handler runs). Draft line items are STRUCTURE ONLY: a name, an
// optional description, an optional item type. They are stored with the
// existing editor's own "unpriced draft" state (unit_price 0 — the editor
// saves a blank price as 0 too) PLUS an explicit `price_pending` marker in
// the row's metadata, and every read here reports such rows as
// `pricePending: true, unitPrice: null` — never "$0.00" — so no downstream
// prompt can mistake an unpriced placeholder for a real zero-dollar price.
//
// ── TENANT ISOLATION ────────────────────────────────────────────────────
//
// orgId comes only from ActionContext (server-resolved). Every estimate /
// lead / project / contact lookup filters on BOTH the id and ctx.orgId.
// estimate_items has no org_id column; an item is only ever reached through
// an estimate that was itself just verified to belong to ctx.orgId. Every
// "not found in this org" outcome returns the SAME generic message as "does
// not exist anywhere", so these handlers cannot be used to probe whether an
// id exists in another organization.
//
// ── INTERNAL-ONLY FIELDS ────────────────────────────────────────────────
//
// `estimates` carries cost_total / contingency / contractor_margin /
// client_total and a free-text internal `notes` field. They are never
// selected here (the column lists below are explicit — no `select("*")`), so
// they cannot reach a model prompt or a customer reply.
//
// ── ATOMICITY ───────────────────────────────────────────────────────────
//
// The two WRITE handlers below are thin callers of single-transaction database
// functions (supabase/migrations/20261017_estimate_transactional_rpcs.sql):
//   create_estimate_draft_transaction   header + items + created-activity
//                                       attribution, or nothing
//   add_estimate_line_items_transaction locks the estimate, requires draft
//                                       status in-transaction, appends lines
// Because the database makes each all-or-nothing, there is NO client-side
// compensation here (no "delete the header if the items fail", no separate
// attribution step). Authorization is enforced inside the functions too: they
// are EXECUTE-able by service_role only, re-verify the approving user's
// membership and every related entity's organization in SQL, and HARDCODE all
// money/quantity values, so nothing a caller (or model) sends can set a price.

import { z } from "zod";
import type { ActionHandler } from "./types";
import { isPricePendingItem } from "../estimate-pricing-gate";

// ── Shared constants ─────────────────────────────────────────────────────

/** Item types the assistant may label a structural line with. Subset of the
 * live `estimate_items_item_type_check` set — "discount" is excluded on
 * purpose (a discount is a price decision the assistant must never make). */
export const ESTIMATE_DRAFT_ITEM_TYPES = ["labor", "material", "service", "equipment", "allowance", "fee", "custom"] as const;
export type EstimateDraftItemType = (typeof ESTIMATE_DRAFT_ITEM_TYPES)[number];

/** The assistant may only mutate an estimate that is still a plain draft.
 * A "ready" estimate has been internally reviewed (editing it silently would
 * invalidate that review); sent/viewed/approved/etc. are customer-facing or
 * contractual. Those need a human in the editor (which versions properly). */
export const AI_EDITABLE_ESTIMATE_STATUSES: ReadonlySet<string> = new Set(["draft"]);

const INACTIVE_ESTIMATE_STATUSES: ReadonlySet<string> = new Set(["archived", "cancelled"]);

export const MAX_DRAFT_ITEMS = 25;
const CONTEXT_MAX_ITEMS = 40;
const CONTEXT_MAX_TEXT = 1500;
const CONTEXT_MAX_ITEM_TEXT = 300;

/** Stated to the model verbatim whenever pricing is discussed. Today no price
 * book / catalog / labor-rate / estimate-template-with-prices source exists
 * for AI to read (audited: estimate_items are the only priced rows, and they
 * are per-estimate, not a reusable catalog). When one is added, this is the
 * single place to flip — see the phase report's "trusted pricing" section. */
export const ESTIMATE_PRICING_AVAILABILITY = {
  trustedCatalogAvailable: false as const,
  note: "No trusted price book, catalog, or labor-rate source is configured for this business. Every unit price and quantity must be entered by the business owner — never estimated or inferred.",
};

const GENERIC_NOT_FOUND = "The requested record was not found in this organization.";

// ── Zod input schemas (used by action-registry.ts AND agent parsing) ────

export const estimateDraftItemSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(1000).optional(),
    itemType: z.enum(ESTIMATE_DRAFT_ITEM_TYPES).optional(),
  })
  .strict();
export type EstimateDraftItemInput = z.infer<typeof estimateDraftItemSchema>;

export const getEstimateContextInput = z
  .object({
    estimateId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
  })
  .strict();
export type GetEstimateContextInput = z.infer<typeof getEstimateContextInput>;

export const createEstimateDraftInput = z
  .object({
    // Optional: resolved server-side from the lead's own contact_id when the
    // trusted run has a lead but no separate contact id.
    contactId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(200),
    scope: z.string().trim().min(1).max(4000).optional(),
    items: z.array(estimateDraftItemSchema).max(MAX_DRAFT_ITEMS).optional(),
  })
  .strict();
export type CreateEstimateDraftInput = z.infer<typeof createEstimateDraftInput>;

export const addEstimateLineItemsInput = z
  .object({
    estimateId: z.string().uuid(),
    items: z.array(estimateDraftItemSchema).min(1).max(MAX_DRAFT_ITEMS),
  })
  .strict();
export type AddEstimateLineItemsInput = z.infer<typeof addEstimateLineItemsInput>;

// ── Output shapes ────────────────────────────────────────────────────────

export type EstimateContextItem = {
  id: string;
  name: string;
  description: string | null;
  itemType: string | null;
  quantity: number | null;
  unit: string | null;
  /** null when the row is unpriced (unit_price <= 0) — never reported as 0. */
  unitPrice: number | null;
  lineTotal: number | null;
  optional: boolean;
  taxable: boolean;
  isHeading: boolean;
  pricePending: boolean;
};

export type EstimateContextEstimate = {
  id: string;
  number: string | null;
  title: string;
  status: string;
  clientId: string | null;
  leadId: string | null;
  projectId: string | null;
  scope: string | null;
  exclusions: string | null;
  assumptions: string | null;
  validUntil: string | null;
  taxRate: number;
  discountType: string | null;
  discountValue: number;
  depositType: string | null;
  depositValue: number;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  depositAmount: number;
  balanceDue: number;
  createdAt: string | null;
  updatedAt: string | null;
  /** Whether the assistant is allowed to propose edits to this estimate. */
  editableByAssistant: boolean;
};

export type EstimateContextOutput = {
  found: boolean;
  /** More than one active estimate matched at the same lookup scope — the
   * assistant must not guess which one a customer means, and the
   * orchestrator will not bind an add-items proposal to any of them. */
  ambiguous?: boolean;
  matchedBy?: "estimate_id" | "project" | "lead" | "contact";
  estimate?: EstimateContextEstimate;
  items?: EstimateContextItem[];
  itemsTruncated?: boolean;
  pricing: typeof ESTIMATE_PRICING_AVAILABILITY;
};

export type CreateEstimateDraftOutput = {
  estimateId: string;
  number: string | null;
  status: "draft";
  itemCount: number;
  pricePendingItemCount: number;
  total: number;
  alreadyCreated: boolean;
};

export type AddEstimateLineItemsOutput = {
  estimateId: string;
  addedItemIds: string[];
  skippedDuplicateNames: string[];
  itemCount: number;
  totalsUpdated: boolean;
  total: number;
  alreadyApplied: boolean;
};

// ── Helpers ──────────────────────────────────────────────────────────────

const ESTIMATE_CONTEXT_COLUMNS =
  "id, number, title, status, client_id, lead_id, project_id, scope, exclusions, assumptions, valid_until, tax_rate, discount_type, discount_value, deposit_type, deposit_value, subtotal, discount_total, tax_total, total, deposit_amount, balance_due, created_at, updated_at";

// `metadata` is selected ONLY so pending-ness is decided by the shared gate (estimate-pricing-gate.ts); it is
// never copied into the output. (Items carry no internal cost/margin fields — those live on `estimates`.)
const ESTIMATE_ITEM_CONTEXT_COLUMNS =
  "id, name, description, item_type, quantity, unit, unit_price, total, position, taxable, optional, is_heading, metadata";

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function mapEstimateRow(row: any): EstimateContextEstimate {
  return {
    id: row.id,
    number: typeof row.number === "string" ? row.number : null,
    title: clip(row.title, 200) ?? "Untitled",
    status: typeof row.status === "string" ? row.status : "draft",
    clientId: row.client_id ?? null,
    leadId: row.lead_id ?? null,
    projectId: row.project_id ?? null,
    scope: clip(row.scope, CONTEXT_MAX_TEXT),
    exclusions: clip(row.exclusions, CONTEXT_MAX_TEXT),
    assumptions: clip(row.assumptions, CONTEXT_MAX_TEXT),
    validUntil: row.valid_until ?? null,
    taxRate: num(row.tax_rate),
    discountType: row.discount_type ?? null,
    discountValue: num(row.discount_value),
    depositType: row.deposit_type ?? null,
    depositValue: num(row.deposit_value),
    subtotal: num(row.subtotal),
    discountTotal: num(row.discount_total),
    taxTotal: num(row.tax_total),
    total: num(row.total),
    depositAmount: num(row.deposit_amount),
    balanceDue: num(row.balance_due),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    editableByAssistant: AI_EDITABLE_ESTIMATE_STATUSES.has(row.status),
  };
}

function mapItemRow(row: any): EstimateContextItem {
  const isHeading = !!row.is_heading;
  const unitPrice = num(row.unit_price);
  // SAME rule as the send gate and the editor (estimate-pricing-gate.ts): a line is an unpriced PLACEHOLDER only
  // when it carries metadata.price_pending === true AND has no positive price; headings are never pending. So a
  // reviewed $0 (marker removed) is a real zero price, and a stale marker on a positive price is simply priced.
  const pricePending = isPricePendingItem(row);
  return {
    id: row.id,
    name: clip(row.name, CONTEXT_MAX_ITEM_TEXT) ?? "Untitled item",
    description: clip(row.description, CONTEXT_MAX_ITEM_TEXT),
    itemType: typeof row.item_type === "string" ? row.item_type : null,
    quantity: isHeading ? null : num(row.quantity, 0),
    unit: typeof row.unit === "string" ? row.unit : null,
    unitPrice: pricePending || isHeading ? null : unitPrice,
    lineTotal: pricePending || isHeading ? null : num(row.total),
    optional: !!row.optional,
    taxable: row.taxable !== false,
    isHeading,
    pricePending,
  };
}

type EstimateLookup = { kind: "error" } | { kind: "none" } | { kind: "found"; row: any; matchedBy: NonNullable<EstimateContextOutput["matchedBy"]>; ambiguous: boolean };

/** Resolves WHICH estimate this run is about, strictly org-scoped. An
 * explicit trusted estimateId wins; otherwise the most specific trusted
 * entity (project, then lead, then contact) is used. Archived/cancelled
 * estimates are never "the current estimate". */
async function resolveEstimateRow(
  ctx: Parameters<ActionHandler>[0],
  input: GetEstimateContextInput,
): Promise<EstimateLookup> {
  if (input.estimateId) {
    const { data, error } = await ctx.supabase
      .from("estimates")
      .select(ESTIMATE_CONTEXT_COLUMNS)
      .eq("id", input.estimateId)
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (error) return { kind: "error" };
    if (!data) return { kind: "none" };
    return { kind: "found", row: data, matchedBy: "estimate_id", ambiguous: false };
  }

  const scopes: Array<{ column: string; id: string | undefined; matchedBy: "project" | "lead" | "contact" }> = [
    { column: "project_id", id: input.projectId, matchedBy: "project" },
    { column: "lead_id", id: input.leadId, matchedBy: "lead" },
    { column: "client_id", id: input.contactId, matchedBy: "contact" },
  ];
  for (const scope of scopes) {
    if (!scope.id) continue;
    const { data, error } = await ctx.supabase
      .from("estimates")
      .select(ESTIMATE_CONTEXT_COLUMNS)
      .eq(scope.column, scope.id)
      .eq("org_id", ctx.orgId)
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) return { kind: "error" };
    const active = (data ?? []).filter((r: any) => !INACTIVE_ESTIMATE_STATUSES.has(r.status));
    if (active.length > 0) {
      return { kind: "found", row: active[0], matchedBy: scope.matchedBy, ambiguous: active.length > 1 };
    }
  }
  return { kind: "none" };
}

// ── get_estimate_context (read-only) ─────────────────────────────────────

export const getEstimateContext: ActionHandler<GetEstimateContextInput, EstimateContextOutput> = async (ctx, input) => {
  try {
    const lookup = await resolveEstimateRow(ctx, input);
    if (lookup.kind === "error") return { ok: false, error: "Could not load estimate context." };
    if (lookup.kind === "none") return { ok: true, output: { found: false, pricing: ESTIMATE_PRICING_AVAILABILITY } };

    const { data: itemRows, error: itemsError } = await ctx.supabase
      .from("estimate_items")
      .select(ESTIMATE_ITEM_CONTEXT_COLUMNS)
      .eq("estimate_id", lookup.row.id)
      .order("position", { ascending: true })
      .limit(CONTEXT_MAX_ITEMS + 1);
    if (itemsError) return { ok: false, error: "Could not load estimate context." };

    const rows = itemRows ?? [];
    const truncated = rows.length > CONTEXT_MAX_ITEMS;
    return {
      ok: true,
      output: {
        found: true,
        ambiguous: lookup.ambiguous,
        matchedBy: lookup.matchedBy,
        estimate: mapEstimateRow(lookup.row),
        items: rows.slice(0, CONTEXT_MAX_ITEMS).map(mapItemRow),
        itemsTruncated: truncated,
        pricing: ESTIMATE_PRICING_AVAILABILITY,
      },
    };
  } catch {
    return { ok: false, error: "Could not load estimate context." };
  }
};

// ── RPC plumbing (shared by the two approval-gated writes) ───────────────

const CREATE_DRAFT_FAILED = "Could not create the estimate draft.";
const ADD_ITEMS_FAILED = "Could not add the line items.";
const NEEDS_TEAM_MEMBER = "An estimate must be attributed to a team member.";
const NEEDS_CONTACT = "An estimate needs a linked customer contact, and none is on file yet.";
const NOT_A_DRAFT = "This estimate is no longer a draft, so the assistant cannot change it. A team member can edit it directly.";

/** Server-side diagnostics for a database failure: the operation name and the
 * Postgres/PostgREST error code + message ONLY. Never the row payload, ids from
 * the request, customer content, tokens or secrets. The caller still returns
 * the same user-safe outward message. */
function logDbError(operation: string, error: unknown): void {
  const e = (error && typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown };
  console.error("[estimate-handlers] db error", {
    operation,
    code: typeof e.code === "string" ? e.code : null,
    message: typeof e.message === "string" ? e.message : String(error ?? ""),
  });
}

/** The RPCs raise deliberate failures as 'estimate_rpc:<code>' (see the migration's ERROR CONTRACT). */
const RPC_ERROR_PREFIX = "estimate_rpc:";
function rpcErrorCode(error: unknown): string | null {
  const message = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  if (typeof message !== "string") return null;
  const i = message.indexOf(RPC_ERROR_PREFIX);
  return i < 0 ? null : message.slice(i + RPC_ERROR_PREFIX.length).split(/[^a-z_]/)[0] || null;
}

/** AI items cross the RPC boundary as { name, description?, itemType? } and NOTHING else — the SQL validator
 * rejects any other key, and the SQL hardcodes every quantity and price. */
function toRpcItems(items: ReadonlyArray<EstimateDraftItemInput> | undefined): Array<Record<string, string>> {
  return (items ?? []).map((it) => ({
    name: it.name,
    ...(it.description ? { description: it.description } : {}),
    ...(it.itemType ? { itemType: it.itemType } : {}),
  }));
}

// ── create_estimate_draft (approval-gated write) ─────────────────────────

export const createEstimateDraft: ActionHandler<CreateEstimateDraftInput, CreateEstimateDraftOutput> = async (ctx, input) => {
  try {
    // The draft is attributed to the verified approving USER. Fail closed before any database call when there
    // is none; the RPC re-verifies this user belongs to ctx.orgId (never trusted from context alone).
    const createdBy = ctx.actor.actorType === "user" && typeof ctx.actor.actorId === "string" ? ctx.actor.actorId.trim() : "";
    if (!createdBy) return { ok: false, error: NEEDS_TEAM_MEMBER };

    const { data, error } = await ctx.supabase.rpc("create_estimate_draft_transaction", {
      p_org_id: ctx.orgId,
      p_created_by: createdBy,
      p_client_id: input.contactId ?? null,
      p_lead_id: input.leadId ?? null,
      p_project_id: input.projectId ?? null,
      p_title: input.title,
      p_scope: input.scope ?? null,
      p_items: toRpcItems(input.items),
      p_execution_id: ctx.executionId ?? null,
    });

    if (error) {
      switch (rpcErrorCode(error)) {
        case "attribution_required": return { ok: false, error: NEEDS_TEAM_MEMBER };
        case "attribution_failed":
          // The database rolled the whole create back (the created-activity row could not be attributed
          // unambiguously). Nothing exists; log the code only and return the generic safe message.
          logDbError("create_estimate_draft.rpc", error);
          return { ok: false, error: CREATE_DRAFT_FAILED };
        case "not_found": return { ok: false, error: GENERIC_NOT_FOUND };
        case "contact_required": return { ok: false, error: NEEDS_CONTACT };
        default:
          logDbError("create_estimate_draft.rpc", error);
          return { ok: false, error: CREATE_DRAFT_FAILED };
      }
    }

    const out = (data ?? {}) as { estimate_id?: unknown; number?: unknown; status?: unknown; item_count?: unknown; already_created?: unknown };
    if (typeof out.estimate_id !== "string" || !out.estimate_id) {
      logDbError("create_estimate_draft.rpc", { message: "rpc returned no estimate id" });
      return { ok: false, error: CREATE_DRAFT_FAILED };
    }
    const itemCount = typeof out.item_count === "number" ? out.item_count : (input.items ?? []).length;
    return {
      ok: true,
      output: {
        estimateId: out.estimate_id,
        number: typeof out.number === "string" ? out.number : null,
        status: "draft",
        itemCount,
        pricePendingItemCount: itemCount,
        total: 0,
        alreadyCreated: out.already_created === true,
      },
    };
  } catch (err) {
    logDbError("create_estimate_draft.unexpected", err);
    return { ok: false, error: CREATE_DRAFT_FAILED };
  }
};

// ── add_estimate_line_items (approval-gated write) ───────────────────────

export const addEstimateLineItems: ActionHandler<AddEstimateLineItemsInput, AddEstimateLineItemsOutput> = async (ctx, input) => {
  try {
    const { data, error } = await ctx.supabase.rpc("add_estimate_line_items_transaction", {
      p_org_id: ctx.orgId,
      p_estimate_id: input.estimateId,
      p_items: toRpcItems(input.items),
      p_execution_id: ctx.executionId ?? null,
    });

    if (error) {
      switch (rpcErrorCode(error)) {
        case "not_found": return { ok: false, error: GENERIC_NOT_FOUND };
        case "not_draft": return { ok: false, error: NOT_A_DRAFT };
        default:
          logDbError("add_estimate_line_items.rpc", error);
          return { ok: false, error: ADD_ITEMS_FAILED };
      }
    }

    const out = (data ?? {}) as {
      estimate_id?: unknown; added_item_ids?: unknown; skipped_duplicate_names?: unknown;
      item_count?: unknown; total?: unknown; already_applied?: unknown;
    };
    if (typeof out.estimate_id !== "string" || !Array.isArray(out.added_item_ids)) {
      logDbError("add_estimate_line_items.rpc", { message: "rpc returned an unexpected shape" });
      return { ok: false, error: ADD_ITEMS_FAILED };
    }
    return {
      ok: true,
      output: {
        estimateId: out.estimate_id,
        addedItemIds: out.added_item_ids.filter((x): x is string => typeof x === "string"),
        skippedDuplicateNames: Array.isArray(out.skipped_duplicate_names) ? out.skipped_duplicate_names.filter((x): x is string => typeof x === "string") : [],
        itemCount: typeof out.item_count === "number" ? out.item_count : 0,
        // Totals are never touched: every added line is a $0 pending placeholder, which cannot change any total.
        totalsUpdated: false,
        total: Number.isFinite(Number(out.total)) ? Number(out.total) : 0,
        alreadyApplied: out.already_applied === true,
      },
    };
  } catch (err) {
    logDbError("add_estimate_line_items.unexpected", err);
    return { ok: false, error: ADD_ITEMS_FAILED };
  }
};
