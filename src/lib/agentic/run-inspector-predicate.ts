// src/lib/agentic/run-inspector-predicate.ts
//
// AI-3D (Run Inspector observability fix). Pure, dependency-free predicate
// used by ai-run-inspector.tsx to decide which agent_executions rows are
// real orchestrator runtime executions vs. internal claim/idempotency rows.
//
// BACKGROUND: dispatchLeadQualification() (lead-qualification-dispatch.ts)
// inserts a CLAIM row via claimTrigger() to reserve an idempotency_key,
// then calls orchestrateAI() (orchestrator.ts), which inserts its OWN,
// SEPARATE runtime row via createExecutionRow(). Both rows can share the
// same `source` value (source is copied straight from the claim's
// trustedContext.actor.source into the runtime row) and, once the runtime
// row finishes routing, can even share the same `agent_key` — so neither
// field alone safely distinguishes them. Naively adding "manual_run" /
// "lead_created" / "inbound_lead_message" to the Inspector's old source
// allowlist would have shown BOTH rows per real run, as duplicates.
//
// DISTINGUISHING SIGNAL: started_at. orchestrator.ts's createExecutionRow()
// unconditionally sets `started_at: new Date().toISOString()` at insert
// time, for every source this predicate allows — confirmed by reading every
// current writer of agent_executions for those sources:
//   - ai_orchestrate_http:        orchestrator.ts createExecutionRow()
//   - twilio_inbound_sms:         orchestrator.ts createExecutionRow()
//   - whatsapp_inbound:           orchestrator.ts createExecutionRow()
//     (meta-whatsapp-background.ts's own two agent_executions calls are a
//     SELECT and an UPDATE keyed off the orchestrator's own executionId —
//     neither is a second insert path)
//   - manual_run / lead_created / inbound_lead_message:
//     orchestrator.ts createExecutionRow() (dispatchLeadQualification()
//     always routes through the same orchestrateAI() call)
// claimTrigger()'s own insert (lead-qualification-dispatch.ts) NEVER sets
// started_at, and agent_executions.started_at is a nullable column with no
// DB-level default — so started_at IS NOT NULL is a real, persisted,
// deterministic marker of a runtime row, not a guess or a display-text
// heuristic. (agent-execute.ts, a separate legacy/POC path with its own
// unrelated source value "contacts_or_leads_manual_run", also always sets
// started_at on its insert — it isn't in this allowlist at all, but this
// confirms no known writer in the codebase ever omits started_at except
// the claim row this predicate is built to exclude.)

/** Every `agent_executions.source` value the AI Run Inspector shows.
 * Adding a new live channel here without also confirming its runtime row
 * always sets `started_at` reintroduces the exact silent-omission failure
 * mode this predicate was built to close — see the file header. */
export const RUN_INSPECTOR_SOURCES = [
  "ai_orchestrate_http",
  "twilio_inbound_sms",
  "whatsapp_inbound",
  "manual_run",
  "lead_created",
  "inbound_lead_message",
] as const;

export type RunInspectorSource = (typeof RUN_INSPECTOR_SOURCES)[number];

export interface RunInspectorCandidateRow {
  source: string | null | undefined;
  started_at: string | null | undefined;
}

const ALLOWED_SOURCES: ReadonlySet<string> = new Set(RUN_INSPECTOR_SOURCES);

/**
 * True when `row` is a real orchestrator runtime execution that belongs in
 * the AI Run Inspector's "Recent Executions" list. False for anything else,
 * including:
 *   - a source not in RUN_INSPECTOR_SOURCES (legacy/POC/unrelated rows)
 *   - a claim/idempotency row for one of those sources (started_at is null)
 */
export function isRunInspectorRuntimeRow(row: RunInspectorCandidateRow): boolean {
  if (!row.source || !ALLOWED_SOURCES.has(row.source)) return false;
  return row.started_at !== null && row.started_at !== undefined && row.started_at !== "";
}
