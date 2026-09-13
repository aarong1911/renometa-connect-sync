// src/components/ai-center/ai-test-console.tsx
//
// AI Center — Phase AI-1H. The first Test Console: sends a manual test
// message through the REAL AI Center runtime (POST /.netlify/functions/
// ai-orchestrate -> orchestrateAI() -> Context Builder -> Router ->
// Reception -> Anthropic) and renders the resulting AIRunResult.
//
// Deliberately minimal per AI-1H's scope:
//   - channel is fixed to "internal", eventType fixed to "manual_test" —
//     neither is user-selectable yet (shown as read-only labels, not a
//     disabled dropdown, so the UI doesn't imply a choice that isn't real).
//   - no contact/lead/project selector — the request's `context` is
//     omitted entirely, so every test run is guaranteed to carry no
//     customer-identifying data.
//   - no model/agent selector — routing is automatic; a manual_test event
//     with no lead context deterministically routes to Reception (see
//     lib/ai/router.ts), which is the point of this first test.
//   - no outbound communication happens from this console — it only
//     displays the model's response text; nothing is sent to a customer.
//
// TYPE-SHARING DECISION: this file does NOT import AIRunResult/AIAgentKey
// from netlify/functions/lib/ai/types.ts. A `import type` from that path
// would in fact be fully erased at build time (TypeScript elides
// type-only imports, so it could never add server code to the browser
// bundle) — but importing across the src/ -> netlify/functions/ boundary,
// even type-only, still couples this frontend file's compilation to the
// server's internal file layout, and invites a future edit here to
// casually add a REAL (value) import across that same path. The response
// shape this console actually needs is tiny and stable (five fields), so
// a small local mirror type is defined below instead — see
// AITestConsoleResult.
//
// AI-1J-B ADDENDUM: added a second, deliberately narrow "Lead
// Qualification" test mode alongside the original ("Reception") mode.
// Lead Qualification mode requires a manually-pasted Test Lead ID (no
// dropdown of production leads — see TestMode's own comment) and sends
// `eventType: "new_lead"` + `context: { leadId }`; Reception mode is
// byte-for-byte unchanged from AI-1H. Org ownership of the pasted lead id
// is verified entirely server-side (ai-orchestrate.ts's
// verifyEntityBelongsToOrg()) — this file never attempts that check
// itself. AITestConsoleResult also gained an optional `toolResults`
// field (name + outcome only, see its own comment) so a successful
// tool-enabled run can show which tool ran — no backend contract change
// was needed since AIRunResult already carries this.
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, Loader2, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { AIRunInspector } from "@/components/ai-center/ai-run-inspector";

// AI-1J-B: two deliberately narrow test modes. "Lead Qualification" is a
// TEST HARNESS for the tool-enabled flow added in AI-1J — not a general
// lead selector. There is no dropdown of production leads here on
// purpose: the tester must know and paste a specific, deliberately chosen
// test lead id, never casually pick a real customer from a list.
type TestMode = "reception" | "lead_qualification";

// Simple structural check only — the backend (ai-orchestrate.ts's Zod
// schema, then verifyEntityBelongsToOrg()) remains the sole source of
// truth for whether this id is well-formed AND actually belongs to the
// caller's org. This regex only prevents submitting something that isn't
// shaped like a UUID at all.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors the backend's content.text bound in netlify/functions/
// ai-orchestrate.ts's eventSchema — kept in sync manually; a mismatch
// here only means the character counter/maxLength stop the user one
// character earlier or later than the server would, never a security
// concern (the server re-validates regardless).
const MAX_MESSAGE_LENGTH = 4000;

type AITestConsoleRunStatus = "completed" | "awaiting_approval" | "handed_off" | "human_escalation" | "failed";
const KNOWN_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "awaiting_approval",
  "handed_off",
  "human_escalation",
  "failed",
]);

/** AI-1J-B: minimal, display-only mirror of one AIToolExecutionResult —
 * name and outcome only. Deliberately excludes `output`/`error`/
 * `approvalRequestId` from the real backend type: never surface raw
 * arguments, note content, internal handler output, or any id beyond the
 * execution id already shown elsewhere. */
type AITestConsoleToolResult = {
  toolName: string;
  status: string;
};

/** Minimal local mirror of AIRunResult — only the fields this console
 * actually renders. See this file's header for why it isn't imported
 * from the server contract directly. `toolResults` added in AI-1J-B, same
 * narrow-mirror approach as every other field here — no backend contract
 * change was needed since AIRunResult already carries this. */
type AITestConsoleResult = {
  executionId: string;
  status: AITestConsoleRunStatus;
  agentKey: string;
  responseText?: string;
  error?: string;
  toolResults?: AITestConsoleToolResult[];
};

function isAITestConsoleResult(value: unknown): value is AITestConsoleResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.executionId === "string" &&
    typeof v.status === "string" &&
    KNOWN_RUN_STATUSES.has(v.status) &&
    typeof v.agentKey === "string"
  );
}

/** Picks only `toolName`/`status` off whatever the response's `toolResults`
 * array actually contains — never trusts or forwards any other field
 * (see AITestConsoleToolResult's own comment on what's deliberately
 * excluded). Returns undefined rather than an empty array when there's
 * nothing safe/present to show. */
function extractSafeToolResults(value: unknown): AITestConsoleToolResult[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>).toolResults;
  if (!Array.isArray(raw)) return undefined;

  const results: AITestConsoleToolResult[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const toolName = (item as Record<string, unknown>).toolName;
      const status = (item as Record<string, unknown>).status;
      if (typeof toolName === "string" && typeof status === "string") {
        results.push({ toolName, status });
      }
    }
  }
  return results.length > 0 ? results : undefined;
}

const TOOL_RESULT_STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  approval_required: "Awaiting approval",
  denied: "Denied",
  failed: "Failed",
};

function ToolResultBadge({ status }: { status: string }) {
  const isSuccess = status === "completed";
  const isFailed = status === "failed" || status === "denied";
  return (
    <Badge
      variant="secondary"
      className={cn(
        "h-5 rounded px-1.5 text-[10px]",
        isSuccess && "border border-success/30 bg-success/15 text-success",
        isFailed && "border border-destructive/30 bg-destructive/15 text-destructive",
        !isSuccess && !isFailed && "border border-warning/30 bg-warning/15 text-warning",
      )}
    >
      {TOOL_RESULT_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

/** Reads a safe, caller-facing `.error` string off an error response body,
 * if present — never renders the raw body otherwise (it may not even be
 * JSON on an unexpected failure). */
function extractSafeErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string") {
    return (body as Record<string, unknown>).error as string;
  }
  return undefined;
}

const STATUS_LABEL: Record<AITestConsoleRunStatus, string> = {
  completed: "Completed",
  awaiting_approval: "Awaiting approval",
  handed_off: "Handed off",
  human_escalation: "Needs human",
  failed: "Failed",
};

function StatusBadge({ status }: { status: AITestConsoleRunStatus }) {
  const isSuccess = status === "completed";
  const isFailed = status === "failed";
  return (
    <Badge
      variant="secondary"
      className={cn(
        "h-5 rounded px-1.5 text-[10px]",
        isSuccess && "border border-success/30 bg-success/15 text-success",
        isFailed && "border border-destructive/30 bg-destructive/15 text-destructive",
        !isSuccess && !isFailed && "border border-warning/30 bg-warning/15 text-warning",
      )}
    >
      {STATUS_LABEL[status]}
    </Badge>
  );
}

function formatAgentKey(key: string): string {
  return key.replace(/_/g, " ");
}

export function AITestConsole() {
  const [testMode, setTestMode] = useState<TestMode>("reception");
  const [testLeadId, setTestLeadId] = useState("");
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AITestConsoleResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  // Bumped only when a real AIRunResult comes back (a new agent_executions
  // row genuinely exists then) — never on a 400/401/network failure, where
  // no row was created and refreshing the inspector would be pointless.
  const [inspectorRefreshSignal, setInspectorRefreshSignal] = useState(0);

  const trimmedLength = message.trim().length;
  const trimmedLeadId = testLeadId.trim();
  const isLeadQualificationMode = testMode === "lead_qualification";
  const isLeadIdShapeValid = UUID_SHAPE.test(trimmedLeadId);
  const canRun =
    !running &&
    trimmedLength > 0 &&
    message.length <= MAX_MESSAGE_LENGTH &&
    (!isLeadQualificationMode || isLeadIdShapeValid);

  async function handleRun() {
    const text = message.trim();
    if (!text) return;

    setRunning(true);
    setResult(null);
    setErrorMessage(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) {
        setErrorMessage("Your session is no longer valid. Please sign in again.");
        return;
      }

      // Reception keeps AI-1H's exact shape — no `context` field, so a
      // Reception Test run is guaranteed to carry no customer-identifying
      // data. Lead Qualification Test adds ONLY `context.leadId`; the
      // endpoint (not this file) independently re-verifies that id
      // belongs to the caller's org before it's ever used — see
      // ai-orchestrate.ts's verifyEntityBelongsToOrg(). Neither branch
      // ever sends orgId/organizationId/userId/actor/autonomyLevel/
      // executionId/targetEntityId/targetEntityType — the endpoint owns
      // all of that.
      const requestBody = isLeadQualificationMode
        ? {
            event: {
              channel: "internal",
              eventType: "new_lead",
              content: { type: "text", text },
            },
            context: { leadId: trimmedLeadId },
          }
        : {
            event: {
              channel: "internal",
              eventType: "manual_test",
              content: { type: "text", text },
            },
          };

      const res = await fetch("/.netlify/functions/ai-orchestrate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(requestBody),
      });

      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // Non-JSON body (shouldn't happen from this endpoint) — handled
        // below by the generic fallback message.
      }

      // A response can be a real AIRunResult even on a non-2xx status —
      // ai-orchestrate.ts returns HTTP 500 with the full result body when
      // orchestrateAI() itself completes but reports status: "failed".
      // Render that in the result panel (it's a real, informative
      // outcome), not as an opaque top-level error banner.
      if (isAITestConsoleResult(body)) {
        setResult({ ...body, toolResults: extractSafeToolResults(body) });
        setInspectorRefreshSignal((n) => n + 1);
        if (body.status === "failed") {
          toast.error("The AI test run failed.");
        } else {
          toast.success("AI test completed.");
        }
        return;
      }

      if (res.status === 401) {
        setErrorMessage("Your session is no longer valid. Please sign in again.");
        return;
      }
      if (res.status === 400) {
        setErrorMessage(extractSafeErrorMessage(body) ?? "Invalid test request.");
        return;
      }
      setErrorMessage("AI test failed. Please try again.");
    } catch {
      setErrorMessage("AI test failed. Please try again.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-violet-200/70 bg-violet-50/70 px-3 py-2 dark:border-violet-900/40 dark:bg-violet-500/5">
        <Send className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
        <span className="text-sm font-semibold text-foreground">AI Test Console</span>
        <span className="text-xs text-muted-foreground">
          Send a test message through the real AI Center runtime — {isLeadQualificationMode ? "Lead Qualification" : "Reception"} responds automatically.
        </span>
      </div>

      <Card className="space-y-3 p-4">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Test Mode</Label>
          <Tabs
            value={testMode}
            onValueChange={(v) => {
              setTestMode(v as TestMode);
              setResult(null);
              setErrorMessage(null);
            }}
          >
            <TabsList className="h-9">
              <TabsTrigger value="reception" className="h-7 px-3 text-xs">Reception</TabsTrigger>
              <TabsTrigger value="lead_qualification" className="h-7 px-3 text-xs">Lead Qualification</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="flex flex-wrap gap-5">
          <div>
            <Label className="text-xs text-muted-foreground">Channel</Label>
            <div className="mt-1">
              <Badge variant="outline" className="h-6 rounded px-2 text-xs">Internal (Test Console)</Badge>
            </div>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Event type</Label>
            <div className="mt-1">
              <Badge variant="outline" className="h-6 rounded px-2 text-xs">
                {isLeadQualificationMode ? "New lead" : "Manual test"}
              </Badge>
            </div>
          </div>
        </div>

        {isLeadQualificationMode && (
          <div className="space-y-1.5">
            <Label htmlFor="ai-test-console-lead-id" className="text-xs">Test Lead ID</Label>
            <Input
              id="ai-test-console-lead-id"
              value={testLeadId}
              onChange={(e) => setTestLeadId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className={cn("h-9 font-mono text-xs", trimmedLeadId.length > 0 && !isLeadIdShapeValid && "border-destructive")}
            />
            {trimmedLeadId.length > 0 && !isLeadIdShapeValid && (
              <p className="text-[11px] text-destructive">This doesn't look like a valid UUID.</p>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Use only a designated test lead. This mode can read the lead and may add an internal CRM note.
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="ai-test-console-message" className="text-xs">Message</Label>
          <Textarea
            id="ai-test-console-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder={
              isLeadQualificationMode
                ? "Example: I'm interested in remodeling my kitchen and replacing the cabinets and countertops."
                : "Example: I need help remodeling my kitchen."
            }
            className="min-h-28 text-sm"
          />
          <div className="flex justify-end text-[10.5px] text-muted-foreground">
            {message.length} / {MAX_MESSAGE_LENGTH}
          </div>
        </div>

        <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {isLeadQualificationMode
            ? "This uses the live AI runtime. The agent may read this lead and may add one internal note. No customer message will be sent."
            : "Test runs use the live AI runtime and are recorded in AI Center activity. No customer message will be sent."}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" className="h-9" disabled={!canRun} onClick={handleRun}>
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            <span className="text-sm">{running ? "Running…" : "Run AI"}</span>
          </Button>
        </div>

        {errorMessage && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <p className="text-[11px] leading-snug text-destructive">{errorMessage}</p>
          </div>
        )}
      </Card>

      {result && (
        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Result</h3>
            <StatusBadge status={result.status} />
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Agent</div>
              <div className="mt-0.5 font-medium capitalize">{formatAgentKey(result.agentKey)}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Execution</div>
              <div className="mt-0.5 truncate font-mono text-[11px]" title={result.executionId}>{result.executionId}</div>
            </div>
          </div>

          {result.toolResults && result.toolResults.length > 0 && (
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Tool Activity</div>
              <div className="mt-1 space-y-1">
                {result.toolResults.map((tool, i) => (
                  <div
                    key={`${tool.toolName}-${i}`}
                    className="flex items-center justify-between rounded-md border border-border bg-secondary/30 px-2.5 py-1.5 text-xs"
                  >
                    <span className="font-medium capitalize">{tool.toolName.replace(/_/g, " ")}</span>
                    <ToolResultBadge status={tool.status} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.responseText && (
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Response</div>
              <p className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-secondary/30 p-2.5 text-sm leading-relaxed">
                {result.responseText}
              </p>
            </div>
          )}

          {result.error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
              <p className="text-[11px] leading-snug text-destructive">{result.error}</p>
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:underline"
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>
          {showDetails && (
            <div className="space-y-1 rounded-md border border-border bg-secondary/30 p-2.5 text-[11px] text-muted-foreground">
              <div>Execution ID: <span className="font-mono">{result.executionId}</span></div>
              <div>Status: {result.status}</div>
              <div>Agent key: {result.agentKey}</div>
            </div>
          )}
        </Card>
      )}

      <AIRunInspector refreshSignal={inspectorRefreshSignal} />
    </div>
  );
}
