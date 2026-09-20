// netlify/functions/lib/ai/tools/registry.ts
//
// AI Center — Phase AI-1B. The AI Tool Registry: a thin, AI-facing adapter
// over the existing Gen-2 Agentic Foundation. This module does NOT
// implement a competing action system — it exposes a narrow, provider-
// neutral surface (discover tools, execute one) that always routes through
// the real pipeline:
//
//   AI orchestrator (future)
//         -> this file (AI Tool Registry)
//         -> src/lib/agentic/action-registry.ts (getActionDefinition)
//         -> src/lib/agentic/action-executor.ts (executeStep) which itself
//            owns: Zod validation, org isolation (via ActionContext),
//            actor/risk/autonomy checks, approval gating, idempotency,
//            handler invocation, and audit/usage recording.
//
// This file never calls a handler directly, never touches Supabase, and
// never constructs an ActionContext itself — executeStep() does all of
// that. See the ai-center skill's "Tool Registry" and "Tool Execution
// Security" sections for the architecture this implements.
//
// MODEL SAFETY: executeAITool()'s two parameters are intentionally
// separate types. `request` (AIToolExecutionRequest) is the ONLY thing a
// model may ever influence — a tool name plus its own arguments.
// `trustedContext` (AIToolTrustedContext) carries every trust-sensitive
// value (orgId, actor, autonomy level, execution id, idempotency key) and
// must be resolved by trusted server code before this function is called.
// There is no code path in this file that reads orgId/actor/autonomy from
// `request.input` — model-supplied JSON is only ever handed to the
// underlying action's Zod schema as opaque argument data.

import { getActionDefinition } from "../../../../../src/lib/agentic/action-registry";
import { executeStep, type ExecuteStepResult } from "../../../../../src/lib/agentic/action-executor";
import type { ActionDefinition } from "../../../../../src/lib/agentic/types";
import type {
  AIToolArgumentDescriptor,
  AIToolDefinition,
  AIToolExecutionRequest,
  AIToolExecutionResult,
  AIToolTrustedContext,
} from "./types";

export type {
  AIToolArgumentDescriptor,
  AIToolDefinition,
  AIToolExecutionRequest,
  AIToolExecutionResult,
  AIToolExecutionStatus,
  AIToolTrustedContext,
} from "./types";

// ── AI-exposed allowlist ────────────────────────────────────────────────
//
// Explicit allowlist, not "everything isExecutable in action-registry.ts".
// Per the AI-1B scope: no financial actions, no communication/send actions
// (draft_customer_reply is excluded here even though it never sends
// anything itself, because its category is "communication" — kept out
// until a deliberate later decision reviews it specifically), and no
// actions that aren't already real/executable this phase.
//
// Covers one read action, one no-approval low-risk write, and one
// approval-required low-risk write, so the three outcome branches
// (completed / approval_required / failed) are all reachable through a
// real allowlisted tool rather than only in theory.
const AI_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "get_lead_context",
  "add_internal_note",
  "create_follow_up_task",
]);

// ── Manual argument descriptors ─────────────────────────────────────────
//
// Hand-written, NOT generated from the Zod schemas in action-registry.ts
// (no zod-to-json-schema dependency was added — see AI-1B task notes).
// These exist purely to give a future model tool-definition something to
// show; they are not validated against and must be kept in sync by hand
// when the corresponding Zod schema changes. A mismatch here degrades
// model UX only — executeAITool() always re-validates via the real schema.
const ARGUMENT_DESCRIPTORS: Record<string, AIToolArgumentDescriptor[]> = {
  get_lead_context: [
    { name: "leadId", type: "string", required: true, description: "UUID of the lead to load." },
  ],
  add_internal_note: [
    {
      name: "targetEntityType", type: "enum", required: true,
      description: "Kind of record the note attaches to.",
      enumValues: ["lead", "contact", "deal", "company"],
    },
    { name: "targetEntityId", type: "string", required: true, description: "UUID of the target record." },
    { name: "content", type: "string", required: true, description: "Note text, staff-only, never customer-facing (max 4000 chars)." },
  ],
  create_follow_up_task: [
    { name: "leadId", type: "string", required: true, description: "UUID of the lead this task follows up on." },
    { name: "title", type: "string", required: true, description: "Task title (max 200 chars)." },
    { name: "dueDate", type: "string", required: false, description: "Due date, YYYY-MM-DD." },
    {
      name: "priority", type: "enum", required: false, description: "Task priority.",
      enumValues: ["low", "medium", "high", "urgent"],
    },
    { name: "assignedTo", type: "string", required: false, description: "UUID of the team member to assign, or omit to leave unassigned." },
  ],
};

function toAIToolDefinition(action: ActionDefinition<unknown, unknown>): AIToolDefinition {
  return {
    name: action.key,
    displayName: action.displayName,
    description: action.description,
    category: action.category,
    riskLevel: action.riskLevel,
    requiresApproval: action.requiresApproval,
    arguments: ARGUMENT_DESCRIPTORS[action.key] ?? [],
  };
}

// ── Discovery ─────────────────────────────────────────────────────────────

/** Lists metadata for every AI-exposed tool. Safe to show to a model or an
 * orchestrator's tool-selection step — contains no execution internals. */
export function listAITools(): AIToolDefinition[] {
  const tools: AIToolDefinition[] = [];
  for (const key of AI_TOOL_ALLOWLIST) {
    const action = getActionDefinition(key);
    // Defensive only: every allowlisted key above is a real, executable
    // action-registry entry as of this writing. If the underlying
    // registry ever drops a key still listed here, skip it rather than
    // surface a broken tool definition.
    if (!action || !action.isExecutable) continue;
    tools.push(toAIToolDefinition(action));
  }
  return tools;
}

/** Metadata for one AI-exposed tool, or undefined if the name isn't
 * allowlisted (whether or not it exists in the underlying registry). */
export function getAITool(toolName: string): AIToolDefinition | undefined {
  if (!AI_TOOL_ALLOWLIST.has(toolName)) return undefined;
  const action = getActionDefinition(toolName);
  if (!action || !action.isExecutable) return undefined;
  return toAIToolDefinition(action);
}

// ── Execution ─────────────────────────────────────────────────────────────

function normalizeExecuteStepResult(toolName: string, result: ExecuteStepResult): AIToolExecutionResult {
  switch (result.status) {
    case "succeeded":
    case "skipped":
      return { status: "completed", toolName, output: result.output };
    case "awaiting_approval":
      return { status: "approval_required", toolName, approvalRequestId: result.approvalRequestId };
    case "failed":
      return { status: "failed", toolName, error: sanitizeError(result.error) };
    // action-executor.ts's executeStep() only ever returns one of the four
    // statuses above (see its docstring: "never throws for an expected
    // business-rule outcome"). This default exists only so an
    // unanticipated future status can't silently masquerade as success.
    default:
      return { status: "failed", toolName, error: "Tool returned an unrecognized status." };
  }
}

/** Caps length and guards against an empty/undefined message. The
 * underlying handlers/executor already write human-safe error strings
 * (never raw Postgres errors or stack traces — see handlers.ts's own
 * conventions), so this is a defensive backstop, not the primary
 * sanitization step. */
function sanitizeError(message: string | undefined): string {
  const fallback = "Tool execution failed.";
  if (!message) return fallback;
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/**
 * Executes exactly one AI-exposed tool through the real action-executor
 * pipeline. Returns a normalized, provider-neutral result — never throws
 * for an expected outcome, and never lets an unexpected exception (e.g. a
 * database error creating the execution step row) escape with its raw
 * message or stack trace.
 *
 * `request.input` is the ONLY model-controlled value this function reads.
 * Every other field it acts on comes from `trustedContext`, which the
 * caller (the future orchestrator) must populate from server-resolved
 * state — never from model output. See this file's header.
 */
export async function executeAITool(
  request: AIToolExecutionRequest,
  trustedContext: AIToolTrustedContext,
): Promise<AIToolExecutionResult> {
  const { toolName, input } = request;

  if (!AI_TOOL_ALLOWLIST.has(toolName)) {
    return { status: "denied", toolName, error: "This tool is not available to AI Center." };
  }

  const action = getActionDefinition(toolName);
  if (!action || !action.isExecutable) {
    return { status: "denied", toolName, error: "This tool is not available to AI Center." };
  }

  try {
    const result = await executeStep({
      supabase: trustedContext.supabase,
      orgId: trustedContext.orgId,
      actor: trustedContext.actor,
      executionId: trustedContext.executionId,
      agentInstanceId: trustedContext.agentInstanceId,
      sequence: trustedContext.sequence,
      actionKey: toolName,
      rawInput: input,
      autonomyLevel: trustedContext.autonomyLevel,
      idempotencyKey: trustedContext.idempotencyKey,
      targetEntityType: trustedContext.targetEntityType,
      targetEntityId: trustedContext.targetEntityId,
      approvalSummary: trustedContext.approvalSummary,
    });

    return normalizeExecuteStepResult(toolName, result);
  } catch (err) {
    // executeStep() documents that it does not throw for expected
    // business-rule outcomes — reaching here means something unexpected
    // happened (e.g. the execution-step insert itself failed). Log the
    // real error server-side; never forward it to the model/caller.
    console.error(`[ai/tools/registry] executeAITool(\"${toolName}\") threw unexpectedly:`, err);
    return { status: "failed", toolName, error: "Tool execution failed unexpectedly." };
  }
}
