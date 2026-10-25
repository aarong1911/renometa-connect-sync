// src/lib/pricing/pricing-evidence-reader.ts
//
// Pricing Intelligence v1 (P2) — the TRUSTED, ORG-SCOPED, READ-ONLY historical evidence reader.
//
// It loads the organization's own past pricing and hands it, already filtered and normalized, to the pure engine
// (pricing-engine.ts). It performs SELECTs only. It is the ONLY place that touches the database for pricing.
//
// TRUST BOUNDARY
//   - `orgId` is a parameter supplied by trusted server code (ActionContext.orgId). Every query below filters on it:
//     estimates (org_id), projects (org_id), leads (org_id), project_change_orders (org_id), project_change_order_items
//     (org_id). estimate_items has no org_id column, so its rows are only ever reached through estimate ids that this
//     function itself read under the org filter — never through ids supplied by a caller or a model.
//   - Nothing here accepts a model value. Callers pass only the org id and a clock.
//   - The returned HistoricalLine objects carry NO database ids, NO customer / contact / project names, NO notes, NO
//     internal cost or vendor data and NO free text beyond the line item's own name/unit (needed to match, and never
//     echoed back to staff or customers — the engine's output contains aggregates only).
//
// EVIDENCE (a line must satisfy ALL; everything else is never fetched or is dropped here):
//   estimates:      status IN (approved, converted, sent, viewed); NOT draft/ready/rejected/expired/cancelled/archived
//   estimate lines: unit_price > 0, not heading, not optional, not discount, not price_pending, not ai_proposed
//   change orders:  status = approved only; items with unit_price > 0
//   date:           within 36 months and not in the future (see documentDate priority below)
//
// DOCUMENT DATE (deterministic priority, normalized into HistoricalLine.documentDate):
//   estimates:      approved_at -> converted_at -> sent_at -> created_at
//   change orders:  approved_at -> created_at
//
// QUERY STRATEGY (bounded, safe to scale)
//   1. estimates: org + status filter, a date SUPERSET filter (any of the date fields inside the window), newest first,
//      capped at MAX_ESTIMATES. The exact window is then applied in code from the chosen documentDate.
//   2. estimate_items: only for those estimate ids, in chunks, with server-side filters (unit_price > 0, not heading, not
//      optional) and PAGED reads (the API caps one response at ~1000 rows), capped at MAX_LINES overall.
//   3. projects / leads: one chunked lookup each, only for the ids on the estimates just read, to classify project type.
//   4. change orders: the same shape (org + status = approved, window, cap), then their items.
//   `truncated` is reported when a cap is hit; capped data is the NEWEST data, so a cap only ever drops the oldest evidence.

import { classifyProjectTypeFromText, normalizeProjectType } from "./project-type";
import { EVIDENCE_WINDOW_MONTHS, evaluateEligibility, type HistoricalLine } from "./pricing-engine";

export type EvidenceClient = { from: (table: string) => any };

export const EVIDENCE_ESTIMATE_STATUSES = ["approved", "converted", "sent", "viewed"] as const;
export const MAX_EVIDENCE_ESTIMATES = 1000;
export const MAX_EVIDENCE_CHANGE_ORDERS = 500;
export const MAX_EVIDENCE_LINES = 5000;
const ID_CHUNK = 50;
const PAGE_SIZE = 1000;

export type EvidenceDiagnostics = {
  estimatesScanned: number;
  estimateLinesScanned: number;
  estimateLinesEligible: number;
  changeOrdersScanned: number;
  changeOrderItemsScanned: number;
  changeOrderItemsEligible: number;
  /** false when the change-order source could not be read (estimate evidence is still returned). */
  changeOrderEvidenceAvailable: boolean;
  /** true when a row cap was reached (only the oldest evidence is dropped). */
  truncated: boolean;
};

export type EvidenceReadResult =
  | { ok: true; evidence: HistoricalLine[]; diagnostics: EvidenceDiagnostics }
  | { ok: false; error: string };

const READ_FAILED = "Could not load pricing history.";

// ── pure helpers ─────────────────────────────────────────────────────────

function validDate(v: unknown): Date | null {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** First valid timestamp in priority order, as an ISO string; null when none. */
export function pickDocumentDate(row: Record<string, unknown>, priority: readonly string[]): string | null {
  for (const key of priority) {
    const d = validDate(row[key]);
    if (d) return d.toISOString();
  }
  return null;
}
export const ESTIMATE_DATE_PRIORITY = ["approved_at", "converted_at", "sent_at", "created_at"] as const;
export const CHANGE_ORDER_DATE_PRIORITY = ["approved_at", "created_at"] as const;

export function windowStart(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - EVIDENCE_WINDOW_MONTHS);
  return d;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function logReadError(operation: string, error: unknown): void {
  const e = (error && typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown };
  // Operation + Postgres code/message only — never a row, id or customer content.
  console.error("[pricing-evidence-reader] read error", {
    operation,
    code: typeof e.code === "string" ? e.code : null,
    message: typeof e.message === "string" ? e.message : String(error ?? ""),
  });
}

/** Reads ALL pages of a query built by `build(from, to)`; stops at `cap` rows. */
async function readPaged(build: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: unknown }>, cap: number): Promise<{ rows: any[]; error: unknown; truncated: boolean }> {
  const rows: any[] = [];
  for (let from = 0; rows.length < cap; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) return { rows, error, truncated: false };
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { rows: rows.slice(0, cap), error: null, truncated: false };
  }
  return { rows: rows.slice(0, cap), error: null, truncated: true };
}

// ── project type resolution (trusted relationships only) ─────────────────

/** Project types for the given project ids, org-scoped. Unknown / foreign ids simply have no entry. */
export async function loadProjectTypes(client: EvidenceClient, orgId: string, projectIds: readonly string[]): Promise<{ ok: true; types: Map<string, string | null> } | { ok: false }> {
  const types = new Map<string, string | null>();
  for (const ids of chunk([...new Set(projectIds)], ID_CHUNK)) {
    const { data, error } = await client.from("projects").select("id, project_type").eq("org_id", orgId).in("id", ids);
    if (error) { logReadError("pricing_evidence.projects", error); return { ok: false }; }
    for (const r of data ?? []) types.set(r.id, normalizeProjectType(r.project_type));
  }
  return { ok: true, types };
}

/** FALLBACK classification: leads.custom_fields.service free text mapped onto a canonical key. Org-scoped. Never a project link. */
export async function loadLeadServiceTypes(client: EvidenceClient, orgId: string, leadIds: readonly string[]): Promise<{ ok: true; types: Map<string, string | null> } | { ok: false }> {
  const types = new Map<string, string | null>();
  for (const ids of chunk([...new Set(leadIds)], ID_CHUNK)) {
    const { data, error } = await client.from("leads").select("id, custom_fields").eq("org_id", orgId).in("id", ids);
    if (error) { logReadError("pricing_evidence.leads", error); return { ok: false }; }
    for (const r of data ?? []) {
      const cf = r.custom_fields && typeof r.custom_fields === "object" ? (r.custom_fields as Record<string, unknown>) : {};
      types.set(r.id, classifyProjectTypeFromText(cf.service)); // only `service` is ever read
    }
  }
  return { ok: true, types };
}

// ── the reader ───────────────────────────────────────────────────────────

export async function readPricingEvidence(client: EvidenceClient, orgId: string, now: Date): Promise<EvidenceReadResult> {
  if (!orgId) return { ok: false, error: READ_FAILED };
  const start = windowStart(now);
  const startDay = isoDay(start);
  const diagnostics: EvidenceDiagnostics = {
    estimatesScanned: 0, estimateLinesScanned: 0, estimateLinesEligible: 0, changeOrdersScanned: 0, changeOrderItemsScanned: 0,
    changeOrderItemsEligible: 0, changeOrderEvidenceAvailable: true, truncated: false,
  };
  const evidence: HistoricalLine[] = [];

  // ── A. estimates ──
  const { data: estimateRows, error: estimateError } = await client
    .from("estimates")
    .select("id, status, project_id, lead_id, approved_at, converted_at, sent_at, created_at")
    .eq("org_id", orgId)
    .in("status", [...EVIDENCE_ESTIMATE_STATUSES])
    .or(`approved_at.gte.${startDay},converted_at.gte.${startDay},sent_at.gte.${startDay},created_at.gte.${startDay}`)
    .order("created_at", { ascending: false })
    .limit(MAX_EVIDENCE_ESTIMATES);
  if (estimateError) { logReadError("pricing_evidence.estimates", estimateError); return { ok: false, error: READ_FAILED }; }
  if ((estimateRows ?? []).length >= MAX_EVIDENCE_ESTIMATES) diagnostics.truncated = true;

  type EstimateMeta = { status: string; documentDate: string; projectId: string | null; leadId: string | null };
  const estimates = new Map<string, EstimateMeta>();
  for (const r of estimateRows ?? []) {
    // Defense in depth: the query already filtered, but the status allowlist is re-checked in code.
    if (!(EVIDENCE_ESTIMATE_STATUSES as readonly string[]).includes(r.status)) continue;
    const documentDate = pickDocumentDate(r, ESTIMATE_DATE_PRIORITY);
    const d = documentDate ? new Date(documentDate) : null;
    if (!documentDate || !d || d.getTime() < start.getTime() || d.getTime() > now.getTime()) continue;
    estimates.set(r.id, { status: r.status, documentDate, projectId: r.project_id ?? null, leadId: r.lead_id ?? null });
  }
  diagnostics.estimatesScanned = estimates.size;

  // project type: project relationship first, lead service as the fallback classification signal
  const projectTypes = await loadProjectTypes(client, orgId, [...estimates.values()].map((e) => e.projectId).filter((x): x is string => !!x));
  if (!projectTypes.ok) return { ok: false, error: READ_FAILED };
  const needLead = [...estimates.values()].filter((e) => !(e.projectId && projectTypes.types.get(e.projectId))).map((e) => e.leadId).filter((x): x is string => !!x);
  const leadTypes = await loadLeadServiceTypes(client, orgId, needLead);
  if (!leadTypes.ok) return { ok: false, error: READ_FAILED };
  const estimateProjectType = (e: EstimateMeta): string | null =>
    (e.projectId ? projectTypes.types.get(e.projectId) ?? null : null) ?? (e.leadId ? leadTypes.types.get(e.leadId) ?? null : null);

  // ── B. estimate lines (only for the estimate ids read above, under the org filter) ──
  let linesRead = 0;
  for (const ids of chunk([...estimates.keys()], ID_CHUNK)) {
    if (linesRead >= MAX_EVIDENCE_LINES) { diagnostics.truncated = true; break; }
    const paged = await readPaged(
      (from, to) =>
        client
          .from("estimate_items")
          .select("id, estimate_id, name, item_type, unit, quantity, unit_price, is_heading, optional, metadata")
          .in("estimate_id", ids)
          .gt("unit_price", 0)
          .eq("is_heading", false)
          .eq("optional", false)
          .order("id", { ascending: true })
          .range(from, to),
      MAX_EVIDENCE_LINES - linesRead,
    );
    if (paged.error) { logReadError("pricing_evidence.estimate_items", paged.error); return { ok: false, error: READ_FAILED }; }
    if (paged.truncated) diagnostics.truncated = true;
    linesRead += paged.rows.length;
    for (const r of paged.rows) {
      diagnostics.estimateLinesScanned += 1;
      const meta = estimates.get(r.estimate_id);
      if (!meta) continue;
      const meta2 = r.metadata && typeof r.metadata === "object" ? (r.metadata as Record<string, unknown>) : {};
      const line: HistoricalLine = {
        source: "estimate_line",
        name: String(r.name ?? ""),
        itemType: typeof r.item_type === "string" ? r.item_type : null,
        unit: typeof r.unit === "string" ? r.unit : null,
        quantity: r.quantity === null || r.quantity === undefined ? null : Number(r.quantity),
        unitPrice: Number(r.unit_price),
        isHeading: !!r.is_heading,
        optional: !!r.optional,
        // Only the two flags the engine reads are carried; the rest of the metadata object is dropped.
        metadata: { price_pending: meta2.price_pending === true, ai_proposed: meta2.ai_proposed === true },
        estimateStatus: meta.status,
        documentDate: meta.documentDate,
        projectType: estimateProjectType(meta),
      };
      if (evaluateEligibility(line, now).eligible) { evidence.push(line); diagnostics.estimateLinesEligible += 1; }
    }
  }

  // ── C. approved change orders ──
  const co = await client
    .from("project_change_orders")
    .select("id, project_id, approved_at, created_at")
    .eq("org_id", orgId)
    .eq("status", "approved")
    .or(`approved_at.gte.${startDay},created_at.gte.${startDay}`)
    .order("created_at", { ascending: false })
    .limit(MAX_EVIDENCE_CHANGE_ORDERS);
  if (co.error) {
    logReadError("pricing_evidence.change_orders", co.error);
    diagnostics.changeOrderEvidenceAvailable = false;
  } else {
    if ((co.data ?? []).length >= MAX_EVIDENCE_CHANGE_ORDERS) diagnostics.truncated = true;
    type CoMeta = { documentDate: string; projectId: string | null };
    const orders = new Map<string, CoMeta>();
    for (const r of co.data ?? []) {
      const documentDate = pickDocumentDate(r, CHANGE_ORDER_DATE_PRIORITY);
      const d = documentDate ? new Date(documentDate) : null;
      if (!documentDate || !d || d.getTime() < start.getTime() || d.getTime() > now.getTime()) continue;
      orders.set(r.id, { documentDate, projectId: r.project_id ?? null });
    }
    diagnostics.changeOrdersScanned = orders.size;
    const coProjectTypes = await loadProjectTypes(client, orgId, [...orders.values()].map((o) => o.projectId).filter((x): x is string => !!x));
    if (!coProjectTypes.ok) {
      diagnostics.changeOrderEvidenceAvailable = false;
    } else {
      let coRead = 0;
      for (const ids of chunk([...orders.keys()], ID_CHUNK)) {
        if (coRead >= MAX_EVIDENCE_LINES) { diagnostics.truncated = true; break; }
        const paged = await readPaged(
          (from, to) =>
            client
              .from("project_change_order_items")
              .select("id, change_order_id, name, item_type, unit, quantity, unit_price")
              .eq("org_id", orgId)
              .in("change_order_id", ids)
              .gt("unit_price", 0)
              .order("id", { ascending: true })
              .range(from, to),
          MAX_EVIDENCE_LINES - coRead,
        );
        if (paged.error) { logReadError("pricing_evidence.change_order_items", paged.error); diagnostics.changeOrderEvidenceAvailable = false; break; }
        if (paged.truncated) diagnostics.truncated = true;
        coRead += paged.rows.length;
        for (const r of paged.rows) {
          diagnostics.changeOrderItemsScanned += 1;
          const meta = orders.get(r.change_order_id);
          if (!meta) continue;
          const line: HistoricalLine = {
            source: "change_order_item",
            name: String(r.name ?? ""),
            itemType: typeof r.item_type === "string" ? r.item_type : null,
            unit: typeof r.unit === "string" ? r.unit : null,
            quantity: r.quantity === null || r.quantity === undefined ? null : Number(r.quantity),
            unitPrice: Number(r.unit_price),
            changeOrderStatus: "approved",
            documentDate: meta.documentDate,
            projectType: meta.projectId ? coProjectTypes.types.get(meta.projectId) ?? null : null,
          };
          if (evaluateEligibility(line, now).eligible) { evidence.push(line); diagnostics.changeOrderItemsEligible += 1; }
        }
      }
    }
  }

  return { ok: true, evidence, diagnostics };
}
