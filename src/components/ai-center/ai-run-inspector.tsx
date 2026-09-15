// src/components/ai-center/ai-run-inspector.tsx
//
// AI Center — Phase AI-1I-B. The first read-only AI Run Inspector: lists
// recent new-architecture agent_executions rows for the current org and
// shows a compact detail view for whichever one is selected. Purely a
// reader — no insert/update/delete anywhere in this file, no tool
// execution, no handoffs, no routing/prompt/model changes.
//
// Data sources (both already RLS-scoped to "org members read own org",
// the same policy shape agentic-preview-panel.tsx already reads
// agent_approval_requests through — no new access pattern introduced):
//   - agent_executions: agent_key, status, timestamps, tokens, cost,
//     input_summary/output_summary (populated by AI-1I-A's orchestrator
//     changes).
//   - agent_usage_events: provider/model, joined by execution_id (these
//     columns don't exist on agent_executions itself — see AI-1I-A's
//     report on why they weren't duplicated there).
//
// TYPE-SHARING: input_summary/output_summary are read here via small
// LOCAL mirror types (RunInputSummary/RunOutputSummary etc.), not by
// importing orchestrator.ts's internal (unexported) types — same
// boundary decision as ai-test-console.tsx's AITestConsoleResult in
// AI-1H, for the same reason (this frontend file should not depend on a
// server file's internal shape or layout). Both jsonb columns are
// treated as untrusted-shape-but-trusted-content: they're written only
// by our own orchestrator, never by a customer or a model directly, but
// older rows (from before AI-1I-A) may have `{}` in either column, so
// every field is read optionally and rendered with a safe fallback.

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CheckCircle2, Circle, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { getOrgId } from "@/lib/contacts-store";
import { formatEstimatedCostUsd } from "@/lib/agentic/usage";

// ── Local mirror types for the jsonb columns (see file header) ─────────

type RunRouteSummary = {
  agentKey?: string;
  source?: string;
  reason?: string;
  confidence?: number;
};

type RunContextPresence = {
  organization?: boolean;
  contact?: boolean;
  lead?: boolean;
  project?: boolean;
  recentMessageCount?: number;
};

/** AI-1K addition — the backend persists only this compact audit record
 * (fromAgent/toAgent/reason), never knownFacts/openQuestions/raw model
 * output (see orchestrator.ts's AIHandoffSummary). Kept optional and
 * validated field-by-field below rather than cast, since this is still
 * jsonb read back from the database, not a value this file produced. */
type RunHandoffSummary = {
  fromAgent: string;
  toAgent: string;
  reason: string;
};

type RunInputSummary = {
  channel?: string;
  route?: RunRouteSummary;
  context?: RunContextPresence;
  handoff?: unknown;
};

type RunOutputSummary = {
  responseText?: string;
};

function asRunInputSummary(value: unknown): RunInputSummary {
  return value && typeof value === "object" ? (value as RunInputSummary) : {};
}

/** Validates that `handoff` is genuinely `{fromAgent, toAgent, reason}`
 * with all three as non-empty strings — never a blind cast. Any other
 * shape (missing field, wrong type, or not an object at all) is treated
 * as "no handoff to show," never a crash. */
function getValidHandoff(value: unknown): RunHandoffSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.fromAgent !== "string" || !v.fromAgent) return undefined;
  if (typeof v.toAgent !== "string" || !v.toAgent) return undefined;
  if (typeof v.reason !== "string" || !v.reason) return undefined;
  return { fromAgent: v.fromAgent, toAgent: v.toAgent, reason: v.reason };
}

function asRunOutputSummary(value: unknown): RunOutputSummary {
  return value && typeof value === "object" ? (value as RunOutputSummary) : {};
}

// ── Row shapes ────────────────────────────────────────────────────────

type ExecutionRow = {
  id: string;
  agent_key: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd_estimated: number | null;
  input_summary: unknown;
  output_summary: unknown;
  error: string | null;
  /** Selected only so the query above is self-documenting about what it
   * filtered on — not displayed (every row here is already known to be
   * "ai_orchestrate_http" by construction of the query itself). */
  source: string | null;
};

/** An execution can have more than one agent_usage_events row (e.g. a
 * future multi-call execution). This collects the distinct provider/model
 * values seen across all of an execution's usage rows — never a single
 * "last row wins" pick. Display-only: token/cost totals remain
 * authoritative on agent_executions itself (input_tokens/output_tokens/
 * cost_usd_estimated), never recomputed from these rows. */
type UsageInfo = { providers: Set<string>; models: Set<string> };

/** "Anthropic" for a single known provider, "Multiple" if more than one
 * distinct value was seen, "—" if none. */
function summarizeUsageValues(values: Set<string> | undefined, formatSingle: (value: string) => string): string {
  if (!values || values.size === 0) return "—";
  if (values.size > 1) return "Multiple";
  return formatSingle([...values][0]);
}

function formatProviderName(provider: string): string {
  return provider.length > 0 ? provider[0].toUpperCase() + provider.slice(1) : provider;
}

const RECENT_EXECUTIONS_LIMIT = 20;

const STATUS_LABEL: Record<string, string> = {
  succeeded: "Completed",
  failed: "Failed",
  running: "Running",
  queued: "Queued",
  awaiting_approval: "Awaiting approval",
  partially_succeeded: "Partially succeeded",
  cancelled: "Cancelled",
  paused: "Paused",
  expired: "Expired",
};

function StatusBadge({ status }: { status: string }) {
  const isSuccess = status === "succeeded";
  const isFailed = status === "failed";
  return (
    <Badge
      variant="secondary"
      className={cn(
        "h-5 shrink-0 rounded px-1.5 text-[10px]",
        isSuccess && "border border-success/30 bg-success/15 text-success",
        isFailed && "border border-destructive/30 bg-destructive/15 text-destructive",
        !isSuccess && !isFailed && "border border-warning/30 bg-warning/15 text-warning",
      )}
    >
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

function formatAgentKey(key: string): string {
  return key.replace(/_/g, " ");
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return "—";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function PresenceRow({ label, present }: { label: string; present: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {present ? (
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
      ) : (
        <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className={present ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xs">{value}</div>
    </div>
  );
}

export function AIRunInspector({ refreshSignal }: { refreshSignal?: number }) {
  const [loading, setLoading] = useState(true);
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
  const [usageByExecution, setUsageByExecution] = useState<Map<string, UsageInfo>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const orgId = await getOrgId();
      if (!orgId) {
        setExecutions([]);
        setUsageByExecution(new Map());
        return;
      }

      const { data: executionRows } = await supabase
        .from("agent_executions")
        .select("id, agent_key, status, started_at, completed_at, input_tokens, output_tokens, cost_usd_estimated, input_summary, output_summary, error, source")
        // Scopes to the new AI Center orchestrator runtime only (every
        // trusted caller of orchestrateAI() sets a real actor.source — see
        // orchestrator.ts's createExecutionRow()). Without this, legacy/POC
        // Gen-2 executions (e.g. agent-execute.ts's
        // "contacts_or_leads_manual_run") would mix into this view.
        // Historical rows from this same runtime still show even when
        // input_summary is `{}` (predating AI-1I-A) — this filters by
        // source, not by whether input_summary is populated.
        //
        // AI-2A addition: "twilio_inbound_sms" is the real Twilio SMS
        // channel adapter (ai-twilio-sms-orchestrate-background.ts) —
        // added alongside the Test Console's "ai_orchestrate_http" rather
        // than replacing it, so both real and test-console runs remain
        // visible here.
        .in("source", ["ai_orchestrate_http", "twilio_inbound_sms"])
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(RECENT_EXECUTIONS_LIMIT);

      const rows = (executionRows ?? []) as ExecutionRow[];
      setExecutions(rows);

      const ids = rows.map((r) => r.id);
      const nextUsage = new Map<string, UsageInfo>();
      if (ids.length > 0) {
        const { data: usageRows } = await supabase
          .from("agent_usage_events")
          .select("execution_id, provider, model")
          .eq("org_id", orgId)
          .in("execution_id", ids);
        // Collect ALL distinct provider/model values per execution — not
        // last-row-wins — so an execution with more than one usage row
        // (not possible yet, but the reducer should already be correct
        // when it is) is displayed as "Multiple" rather than silently
        // showing only its last row's values. Token/cost totals are never
        // derived here — see UsageInfo's comment.
        for (const row of usageRows ?? []) {
          if (!row.execution_id) continue;
          const existing = nextUsage.get(row.execution_id) ?? { providers: new Set<string>(), models: new Set<string>() };
          if (row.provider) existing.providers.add(row.provider);
          if (row.model) existing.models.add(row.model);
          nextUsage.set(row.execution_id, existing);
        }
      }
      setUsageByExecution(nextUsage);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshSignal]);

  const selected = executions.find((e) => e.id === selectedId) ?? null;

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Recent Executions</h3>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <span className="ml-1">Refresh</span>
          </Button>
        </div>

        {loading && executions.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : executions.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No AI Center executions yet.</p>
        ) : (
          <div className="space-y-1.5">
            {executions.map((row) => {
              const input = asRunInputSummary(row.input_summary);
              return (
                <button
                  type="button"
                  key={row.id}
                  onClick={() => setSelectedId(row.id === selectedId ? null : row.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md border border-border p-2.5 text-left transition-colors hover:bg-secondary/40",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    row.id === selectedId && "border-primary/40 bg-primary-soft",
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={row.status} />
                      <span className="truncate text-xs font-medium capitalize">{formatAgentKey(row.agent_key)}</span>
                    </div>
                    <div className="mt-1 text-[10.5px] text-muted-foreground">
                      {formatDateTime(row.started_at)}
                      {input.channel && <> · {input.channel}</>}
                    </div>
                  </div>
                  <div className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                    {formatEstimatedCostUsd(row.cost_usd_estimated ?? 0)}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {selected && <ExecutionDetail row={selected} usage={usageByExecution.get(selected.id)} />}
    </div>
  );
}

function ExecutionDetail({ row, usage }: { row: ExecutionRow; usage?: UsageInfo }) {
  const input = asRunInputSummary(row.input_summary);
  const output = asRunOutputSummary(row.output_summary);
  const route = input.route;
  const context = input.context;
  const handoff = getValidHandoff(input.handoff);

  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Execution Details</h3>
        <StatusBadge status={row.status} />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Field label="Execution ID" value={<span className="font-mono text-[11px]" title={row.id}>{row.id}</span>} />
        <Field label="Status" value={STATUS_LABEL[row.status] ?? row.status} />
        <Field label="Agent" value={<span className="capitalize">{formatAgentKey(row.agent_key)}</span>} />
      </div>

      {context && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Context</div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <PresenceRow label="Organization" present={!!context.organization} />
            <PresenceRow label="Contact" present={!!context.contact} />
            <PresenceRow label="Lead" present={!!context.lead} />
            <PresenceRow label="Project" present={!!context.project} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Recent messages: {context.recentMessageCount ?? 0}
          </p>
        </div>
      )}

      {route && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Routing</div>
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <Field label="Agent" value={<span className="capitalize">{route.agentKey ? formatAgentKey(route.agentKey) : "—"}</span>} />
            <Field label="Source" value={route.source ?? "—"} />
            <Field label="Confidence" value={typeof route.confidence === "number" ? route.confidence.toFixed(2) : "—"} />
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">{route.reason ?? "—"}</p>
        </div>
      )}

      {handoff && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Handoff</div>
          <p className="text-xs font-medium capitalize">
            {formatAgentKey(handoff.fromAgent)} <span className="text-muted-foreground">→</span> {formatAgentKey(handoff.toAgent)}
          </p>
          <p className="text-[11px] leading-snug text-muted-foreground">{handoff.reason}</p>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Model</div>
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <Field label="Provider" value={summarizeUsageValues(usage?.providers, formatProviderName)} />
          <Field label="Model" value={<span className="font-mono text-[11px]">{summarizeUsageValues(usage?.models, (m) => m)}</span>} />
          <Field label="Input tokens" value={row.input_tokens ?? "—"} />
          <Field label="Output tokens" value={row.output_tokens ?? "—"} />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Estimated cost: {formatEstimatedCostUsd(row.cost_usd_estimated ?? 0)}
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Timing</div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <Field label="Started" value={formatDateTime(row.started_at)} />
          <Field label="Completed" value={formatDateTime(row.completed_at)} />
          <Field label="Duration" value={formatDuration(row.started_at, row.completed_at)} />
        </div>
      </div>

      {output.responseText && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Response</div>
          <p className="whitespace-pre-wrap rounded-md border border-border bg-secondary/30 p-2.5 text-sm leading-relaxed">
            {output.responseText}
          </p>
        </div>
      )}

      {row.error && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Error</div>
          <p className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
            {row.error}
          </p>
        </div>
      )}
    </Card>
  );
}
