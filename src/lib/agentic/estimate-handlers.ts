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
//   - totals come from src/lib/estimate-calculations.ts (the one shared
//     calculation engine — never reimplemented here, never model-computed),
//   - `total` and `client_total` are written together and equal (the
//     pre-existing trg_sync_total trigger would otherwise zero `total`),
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
// ── ATOMICITY NOTE ──────────────────────────────────────────────────────
//
// PostgREST has no multi-statement transaction, and this phase deliberately
// creates no migration/RPC. Each write handler therefore orders its steps so
// a failure leaves nothing half-done: create inserts the header then the
// items and DELETES the header if the items fail; add inserts the items then
// updates the totals and DELETES the just-inserted items if the totals
// update fails. A transactional RPC would be the stronger fix and is listed
// as a follow-up in the phase report.

import { z } from "zod";
import type { ActionHandler } from "./types";
import { calculateEstimate, round2, type CalcLineItem } from "../estimate-calculations";
import { isPricePendingItem } from "../estimate-pricing-gate";

// ── Shared constants ─────────────────────────────────────────────────────

/** Item types the assistant may label a structural line with. Subset of the
 * live `estimate_items_item_type_check` set — "discount" is excluded on
 * purpose (a discount is a price decision the assistant must never make). */
export const ESTIMATE_DRAFT_ITEM_TYPES = ["labor", "material", "service", "equipment", "allowance", "fee", "custom"] as const;
export type EstimateDraftItemType = (typeof ESTIMATE_DRAFT_ITEM_TYPES)[number];

/** Same labels as src/lib/estimate-status.ts's ESTIMATE_ITEM_TYPE_LABELS —
 * duplicated here only because that module imports lucide-react, which this
 * tree must not pull into a Netlify bundle. `category` is free text, so a
 * drift here is cosmetic, never a constraint violation. */
const ITEM_TYPE_CATEGORY_LABELS: Record<EstimateDraftItemType, string> = {
  labor: "Labor", material: "Material", service: "Service", equipment: "Equipment",
  allowance: "Allowance", fee: "Fee", custom: "Custom",
};

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

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
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

function toCalcItem(row: any): CalcLineItem {
  return {
    quantity: num(row.quantity),
    unitPrice: num(row.unit_price),
    taxable: row.taxable !== false,
    optional: !!row.optional,
    selectedByCustomer: row.selected_by_customer !== false,
    isHeading: !!row.is_heading,
    discountType: row.discount_type ?? null,
    discountValue: row.discount_value == null ? null : num(row.discount_value),
  };
}

/** The editor's own header-totals payload shape (estimates.tsx save()): note
 * `total` and `client_total` are always written together and equal. */
function totalsPatch(calc: ReturnType<typeof calculateEstimate>) {
  return {
    subtotal: calc.subtotal,
    discount_total: calc.discountTotal,
    tax_total: calc.taxTotal,
    total: calc.total,
    client_total: calc.total,
    deposit_amount: calc.depositAmount,
    balance_due: Math.max(0, calc.balanceDue),
  };
}

function buildItemRows(
  estimateId: string,
  items: EstimateDraftItemInput[],
  startPosition: number,
  executionId: string | undefined,
) {
  return items.map((it, idx) => {
    const itemType: EstimateDraftItemType = it.itemType ?? "custom";
    return {
      estimate_id: estimateId,
      category: ITEM_TYPE_CATEGORY_LABELS[itemType],
      item_type: itemType,
      name: it.name,
      description: it.description ?? null,
      // Placeholders, NOT facts: the editor treats a blank quantity as 1 and
      // a blank price as 0. `price_pending` / `quantity_pending` make the
      // placeholder explicit so nothing (including this file's own readers)
      // ever reports it as a real price or measurement.
      quantity: 1,
      unit: "each",
      unit_price: 0,
      total: 0,
      position: startPosition + idx,
      taxable: true,
      optional: false,
      is_heading: false,
      metadata: {
        ai_proposed: true,
        price_pending: true,
        quantity_pending: true,
        ...(executionId ? { ai_execution_id: executionId } : {}),
      },
    };
  });
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

// ── create_estimate_draft (approval-gated write) ─────────────────────────

const CREATE_DRAFT_FAILED = "Could not create the estimate draft.";
const NEEDS_TEAM_MEMBER = "An estimate must be attributed to a team member.";

/** Server-side diagnostics for a database failure: the operation name and the
 * Postgres/PostgREST error code + message ONLY. Never the row payload, ids from
 * the request, customer content, tokens or secrets. The caller still returns
 * the same user-safe outward message as before. */
function logDbError(operation: string, error: unknown): void {
  const e = (error && typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown };
  console.error("[estimate-handlers] db error", {
    operation,
    code: typeof e.code === "string" ? e.code : null,
    message: typeof e.message === "string" ? e.message : String(error ?? ""),
  });
}

/**
 * `estimates.created_by` is NOT NULL (default auth.uid(), FK profiles.id). The
 * browser editor satisfies it because it writes as the logged-in user; this
 * handler writes with the service-role client, where auth.uid() is NULL, so the
 * attribution must be supplied explicitly — and it must be a REAL team member of
 * THIS org, never a guessed owner/admin/system identity and never an unverified
 * id taken from context.
 *
 * Membership follows the repo's canonical precedence (resolve-org.ts):
 * profiles.organization_id first, then org_memberships. Returns the verified
 * user id, or null when the actor is absent, not a user, or not in this org
 * (callers fail closed BEFORE any write). A lookup error also yields null.
 */
async function resolveAttributableUserId(ctx: Parameters<ActionHandler>[0]): Promise<string | null> {
  if (ctx.actor.actorType !== "user") return null;
  const userId = typeof ctx.actor.actorId === "string" ? ctx.actor.actorId.trim() : "";
  if (!userId) return null;

  const { data: profile, error: profileError } = await ctx.supabase
    .from("profiles")
    .select("id")
    .eq("id", userId)
    .eq("organization_id", ctx.orgId)
    .maybeSingle();
  if (profileError) { logDbError("estimate_actor.profile_lookup", profileError); return null; }
  if (profile) return userId;

  const { data: membership, error: membershipError } = await ctx.supabase
    .from("org_memberships")
    .select("member_id")
    .eq("member_id", userId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (membershipError) { logDbError("estimate_actor.membership_lookup", membershipError); return null; }
  return membership ? userId : null;
}

/**
 * "Estimate created" attribution. log_estimate_activity() (AFTER INSERT trigger)
 * records the created event using auth.uid(), which is NULL for this service-role
 * write, so it writes actor_type = 'system', actor_id = NULL — misleading, because
 * a real team member approved the AI action. The trigger cannot be told otherwise
 * without a migration, so the handler corrects THAT ONE row after a successful
 * create:
 *   - only the unattributed trigger row is touched (activity_type 'created',
 *     actor_type 'system', actor_id NULL, this org, this estimate) — a row that
 *     already names a user is never overwritten;
 *   - it is an UPDATE of the existing row, never an extra INSERT, so there is
 *     never a duplicate "Estimate created";
 *   - the actor is the SAME verified same-org user stamped into estimates.created_by
 *     (nothing is fabricated), and the row records that it was originally written as
 *     'system' and corrected via the approval flow;
 *   - best effort: a failure is logged (operation + code + message only) and never
 *     fails or rolls back the create. If no unattributed row exists (e.g. the trigger
 *     is absent) nothing is invented.
 * Ordinary user-created estimates never pass through here and keep the trigger's
 * auth.uid() attribution; automation with no verified user is refused earlier.
 */
async function attributeCreatedActivity(
  ctx: Parameters<ActionHandler>[0],
  estimateId: string,
  userId: string,
  executionId: string | undefined,
): Promise<void> {
  try {
    const { data, error } = await ctx.supabase
      .from("estimate_activities")
      .update({
        actor_id: userId,
        actor_type: "user",
        description: "Drafted by the Estimate Assistant and approved by a team member.",
        metadata: {
          attributed_via: "estimate_assistant_approval",
          originally_recorded_as: "system",
          ...(executionId ? { ai_execution_id: executionId } : {}),
        },
      })
      .eq("org_id", ctx.orgId)
      .eq("estimate_id", estimateId)
      .eq("activity_type", "created")
      .eq("actor_type", "system")
      .is("actor_id", null)
      .select("id");
    if (error) { logDbError("create_estimate_draft.attribute_created_activity", error); return; }
    if ((data ?? []).length === 0) {
      logDbError("create_estimate_draft.attribute_created_activity", { message: "no unattributed 'created' activity row found; nothing changed" });
    }
  } catch (err) {
    logDbError("create_estimate_draft.attribute_created_activity", err);
  }
}

export const createEstimateDraft: ActionHandler<CreateEstimateDraftInput, CreateEstimateDraftOutput> = async (ctx, input) => {
  try {
    const executionId = ctx.executionId;

    // Fail closed BEFORE reading or writing anything else: the draft needs a
    // verified same-org team member to attribute it to (see above).
    const createdBy = await resolveAttributableUserId(ctx);
    if (!createdBy) return { ok: false, error: NEEDS_TEAM_MEMBER };

    // Belt-and-suspenders idempotency on top of agent_action_idempotency: one
    // execution proposes at most one draft, so an estimate already stamped
    // with this execution id IS this action's prior success.
    if (executionId) {
      const { data: prior, error: priorError } = await ctx.supabase
        .from("estimates")
        .select("id, number, status")
        .eq("org_id", ctx.orgId)
        .eq("metadata->>ai_execution_id", executionId)
        .maybeSingle();
      if (priorError) { logDbError("create_estimate_draft.prior_lookup", priorError); return { ok: false, error: CREATE_DRAFT_FAILED }; }
      if (prior) {
        const { data: priorItems } = await ctx.supabase.from("estimate_items").select("id").eq("estimate_id", prior.id);
        return {
          ok: true,
          output: {
            estimateId: prior.id,
            number: prior.number ?? null,
            status: "draft",
            itemCount: (priorItems ?? []).length,
            pricePendingItemCount: (priorItems ?? []).length,
            total: 0,
            alreadyCreated: true,
          },
        };
      }
    }

    // Every referenced entity must belong to THIS org. One generic message
    // for every miss (no cross-tenant probing).
    let leadContactId: string | null = null;
    if (input.leadId) {
      const { data: lead, error } = await ctx.supabase
        .from("leads")
        .select("id, contact_id")
        .eq("id", input.leadId)
        .eq("org_id", ctx.orgId)
        .maybeSingle();
      if (error) { logDbError("create_estimate_draft.lead_lookup", error); return { ok: false, error: CREATE_DRAFT_FAILED }; }
      if (!lead) return { ok: false, error: GENERIC_NOT_FOUND };
      leadContactId = lead.contact_id ?? null;
    }
    if (input.projectId) {
      const { data: project, error } = await ctx.supabase
        .from("projects")
        .select("id")
        .eq("id", input.projectId)
        .eq("org_id", ctx.orgId)
        .maybeSingle();
      if (error) { logDbError("create_estimate_draft.project_lookup", error); return { ok: false, error: CREATE_DRAFT_FAILED }; }
      if (!project) return { ok: false, error: GENERIC_NOT_FOUND };
    }

    const clientId = input.contactId ?? leadContactId;
    if (!clientId) return { ok: false, error: "An estimate needs a linked customer contact, and none is on file yet." };
    const { data: contact, error: contactError } = await ctx.supabase
      .from("contacts")
      .select("id")
      .eq("id", clientId)
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (contactError) { logDbError("create_estimate_draft.contact_lookup", contactError); return { ok: false, error: CREATE_DRAFT_FAILED }; }
    if (!contact) return { ok: false, error: GENERIC_NOT_FOUND };

    const items = input.items ?? [];
    // Authoritative totals from the shared engine over the rows about to be
    // written (all unpriced → zeros, but derived, never hardcoded).
    const itemRowsPreview = buildItemRows("preview", items, 0, executionId);
    const calc = calculateEstimate({ items: itemRowsPreview.map(toCalcItem) });

    const { data: header, error: headerError } = await ctx.supabase
      .from("estimates")
      .insert({
        org_id: ctx.orgId,
        // NOT NULL; auth.uid() is NULL for the service-role client, so it is
        // supplied explicitly (verified same-org team member — see above).
        created_by: createdBy,
        status: "draft",
        client_id: clientId,
        lead_id: input.leadId ?? null,
        project_id: input.projectId ?? null,
        title: input.title,
        scope: input.scope ?? null,
        tax_rate: 0,
        discount_type: null,
        discount_value: 0,
        deposit_type: null,
        deposit_value: 0,
        ...totalsPatch(calc),
        metadata: {
          ai_generated: true,
          ai_source: "estimate_assistant",
          ...(executionId ? { ai_execution_id: executionId } : {}),
        },
      })
      .select("id, number")
      .single();
    if (headerError || !header) {
      logDbError("create_estimate_draft.insert_estimate", headerError ?? { message: "insert returned no row" });
      return { ok: false, error: CREATE_DRAFT_FAILED };
    }

    if (items.length > 0) {
      const { error: itemsError } = await ctx.supabase
        .from("estimate_items")
        .insert(buildItemRows(header.id, items, 0, executionId));
      if (itemsError) {
        logDbError("create_estimate_draft.insert_items", itemsError);
        // Compensate: never leave a header the owner didn't approve in a
        // half-built state.
        const { error: cleanupError } = await ctx.supabase.from("estimates").delete().eq("id", header.id).eq("org_id", ctx.orgId);
        if (cleanupError) logDbError("create_estimate_draft.compensating_delete", cleanupError);
        return { ok: false, error: CREATE_DRAFT_FAILED };
      }
    }

    // Only after the estimate AND its items are safely in place (a rolled-back create
    // deletes the header, which cascades its activity rows away).
    await attributeCreatedActivity(ctx, header.id, createdBy, executionId);

    return {
      ok: true,
      output: {
        estimateId: header.id,
        number: header.number ?? null,
        status: "draft",
        itemCount: items.length,
        pricePendingItemCount: items.length,
        total: calc.total,
        alreadyCreated: false,
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
    const executionId = ctx.executionId;

    const { data: estimate, error: estimateError } = await ctx.supabase
      .from("estimates")
      .select("id, status, total, tax_rate, discount_type, discount_value, deposit_type, deposit_value")
      .eq("id", input.estimateId)
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (estimateError) return { ok: false, error: "Could not add the line items." };
    if (!estimate) return { ok: false, error: GENERIC_NOT_FOUND };
    if (!AI_EDITABLE_ESTIMATE_STATUSES.has(estimate.status)) {
      return { ok: false, error: "This estimate is no longer a draft, so the assistant cannot change it. A team member can edit it directly." };
    }

    const { data: existingRows, error: existingError } = await ctx.supabase
      .from("estimate_items")
      .select("id, name, position, quantity, unit_price, taxable, optional, selected_by_customer, is_heading, discount_type, discount_value, metadata")
      .eq("estimate_id", estimate.id);
    if (existingError) return { ok: false, error: "Could not add the line items." };
    const existing = existingRows ?? [];

    // Idempotent replay: this execution already inserted its items.
    if (executionId) {
      const prior = existing.filter((r: any) => r.metadata?.ai_execution_id === executionId);
      if (prior.length > 0) {
        return {
          ok: true,
          output: {
            estimateId: estimate.id,
            addedItemIds: prior.map((r: any) => r.id),
            skippedDuplicateNames: [],
            itemCount: existing.length,
            totalsUpdated: false,
            total: num(estimate.total),
            alreadyApplied: true,
          },
        };
      }
    }

    // Skip anything already on the estimate (or repeated within this batch).
    const seen = new Set(existing.filter((r: any) => !r.is_heading).map((r: any) => normalizeName(String(r.name ?? ""))));
    const toAdd: EstimateDraftItemInput[] = [];
    const skipped: string[] = [];
    for (const it of input.items) {
      const key = normalizeName(it.name);
      if (seen.has(key)) { skipped.push(it.name); continue; }
      seen.add(key);
      toAdd.push(it);
    }

    if (toAdd.length === 0) {
      return {
        ok: true,
        output: {
          estimateId: estimate.id,
          addedItemIds: [],
          skippedDuplicateNames: skipped,
          itemCount: existing.length,
          totalsUpdated: false,
          total: num(estimate.total),
          alreadyApplied: false,
        },
      };
    }

    const startPosition = existing.reduce((max: number, r: any) => Math.max(max, num(r.position, -1)), -1) + 1;
    const rows = buildItemRows(estimate.id, toAdd, startPosition, executionId);
    const { data: inserted, error: insertError } = await ctx.supabase
      .from("estimate_items")
      .insert(rows)
      .select("id");
    if (insertError || !inserted) return { ok: false, error: "Could not add the line items." };
    const insertedIds = (inserted as Array<{ id: string }>).map((r) => r.id);

    // Totals: recomputed by the shared engine over ALL items (never by the
    // model). Guard: a legacy "quick estimate" (stored total, zero item rows)
    // keeps its stored total — see src/lib/estimate-totals.ts — so adding the
    // first placeholder rows can never silently zero a real stored figure.
    const keepStoredTotals = existing.length === 0 && num(estimate.total) > 0;
    let totalsUpdated = false;
    let total = num(estimate.total);
    if (!keepStoredTotals) {
      const calc = calculateEstimate({
        items: [...existing, ...rows].map(toCalcItem),
        discountType: estimate.discount_type ?? null,
        discountValue: estimate.discount_value == null ? null : num(estimate.discount_value),
        taxRate: num(estimate.tax_rate),
        depositType: estimate.deposit_type ?? null,
        depositValue: estimate.deposit_value == null ? null : num(estimate.deposit_value),
      });
      const { error: updateError } = await ctx.supabase
        .from("estimates")
        .update({ ...totalsPatch(calc), updated_at: new Date().toISOString() })
        .eq("id", estimate.id)
        .eq("org_id", ctx.orgId);
      if (updateError) {
        await ctx.supabase.from("estimate_items").delete().in("id", insertedIds);
        return { ok: false, error: "Could not add the line items." };
      }
      totalsUpdated = true;
      total = calc.total;
    }

    return {
      ok: true,
      output: {
        estimateId: estimate.id,
        addedItemIds: insertedIds,
        skippedDuplicateNames: skipped,
        itemCount: existing.length + insertedIds.length,
        totalsUpdated,
        total: round2(total),
        alreadyApplied: false,
      },
    };
  } catch {
    return { ok: false, error: "Could not add the line items." };
  }
};
