// src/lib/agentic/estimate-lookup.ts
//
// The ONE definition of "which estimate is current for this customer/lead/project", shared by
//   - estimate-handlers.ts's get_estimate_context action (the Estimate Assistant's audited read), and
//   - netlify/functions/lib/ai/context-builder.ts (so Lead Qualification can SEE an existing estimate before it
//     decides whether to hand off).
// Keeping a single implementation guarantees the two can never disagree about priority or about what counts as a
// current estimate.
//
// RULES (unchanged from the original get_estimate_context behavior):
//   - Strictly org-scoped: every query filters on the trusted org id AND the entity id.
//   - An explicit TRUSTED estimateId wins. It is only ever supplied by trusted server code, never by a model.
//   - Otherwise the most specific trusted entity wins: project, then lead, then contact.
//   - Within a scope, archived and cancelled estimates are never "the current estimate". Several remaining active
//     estimates at the SAME scope are reported as ambiguous (callers must not guess which one is meant).
//   - Read-only: SELECTs only.

/** Minimal slice of the Supabase client this module needs (structural, so it works with the real client and with test fakes). */
export type EstimateLookupClient = { from: (table: string) => any };

/** The assistant may only mutate an estimate that is still a plain draft. A "ready" estimate has been internally reviewed
 * (editing it silently would invalidate that review); sent/viewed/approved/etc. are customer-facing or contractual. Those
 * need a human in the editor (which versions properly). */
export const AI_EDITABLE_ESTIMATE_STATUSES: ReadonlySet<string> = new Set(["draft"]);

/** Estimates in these statuses are never "the current estimate". */
export const INACTIVE_ESTIMATE_STATUSES: ReadonlySet<string> = new Set(["archived", "cancelled"]);

/** How many recent estimates per scope are examined (matches the original handler). */
export const ESTIMATE_LOOKUP_SCOPE_LIMIT = 5;

export type EstimateLookupScope = {
  estimateId?: string;
  projectId?: string;
  leadId?: string;
  contactId?: string;
};

export type EstimateMatchedBy = "estimate_id" | "project" | "lead" | "contact";

export type EstimateLookup =
  | { kind: "error" }
  | { kind: "none" }
  | {
      kind: "found";
      /** The newest active estimate at the winning scope. */
      row: any;
      matchedBy: EstimateMatchedBy;
      /** More than one active estimate matched at the winning scope. */
      ambiguous: boolean;
      /** Every active estimate at the winning scope (newest first, at most ESTIMATE_LOOKUP_SCOPE_LIMIT). */
      candidates: any[];
    };

/** Resolves WHICH estimate a run is about. `columns` is the select list (callers choose how much of the row they need;
 * it must include `status` and `created_at`). */
export async function lookupCurrentEstimate(
  supabase: EstimateLookupClient,
  orgId: string,
  scope: EstimateLookupScope,
  columns: string,
): Promise<EstimateLookup> {
  if (scope.estimateId) {
    const { data, error } = await supabase
      .from("estimates")
      .select(columns)
      .eq("id", scope.estimateId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) return { kind: "error" };
    if (!data) return { kind: "none" };
    return { kind: "found", row: data, matchedBy: "estimate_id", ambiguous: false, candidates: [data] };
  }

  const scopes: Array<{ column: string; id: string | undefined; matchedBy: "project" | "lead" | "contact" }> = [
    { column: "project_id", id: scope.projectId, matchedBy: "project" },
    { column: "lead_id", id: scope.leadId, matchedBy: "lead" },
    { column: "client_id", id: scope.contactId, matchedBy: "contact" },
  ];
  for (const s of scopes) {
    if (!s.id) continue;
    const { data, error } = await supabase
      .from("estimates")
      .select(columns)
      .eq(s.column, s.id)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(ESTIMATE_LOOKUP_SCOPE_LIMIT);
    if (error) return { kind: "error" };
    const active = ((data ?? []) as any[]).filter((r) => !INACTIVE_ESTIMATE_STATUSES.has(r.status));
    if (active.length > 0) {
      return { kind: "found", row: active[0], matchedBy: s.matchedBy, ambiguous: active.length > 1, candidates: active };
    }
  }
  return { kind: "none" };
}
