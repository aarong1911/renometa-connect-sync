// netlify/functions/lib/ai/prompting.ts
//
// AI Center — small, shared leaf module extracted during AI-1J so that
// both orchestrator.ts (Reception's plain-response prompt) and
// agents/lead-qualification.ts (the new structured-decision + final-
// response prompts) can build a consistent CRM-context summary and use
// the same temporary model defaults, without either file importing from
// the other (which would create a circular dependency, since orchestrator
// imports the lead-qualification flow to run it).
//
// Nothing here calls a model or touches Supabase — pure formatting and
// constants only.

import type { AIResolvedContext } from "./types";

/**
 * Temporary default model, unchanged since AI-1A/AI-1F — the exact alias
 * already smoke-tested against the real Anthropic API. Model choice
 * belongs to agent versioning/configuration once that exists; this is the
 * one place it's defined for every AI-1 prompt builder.
 */
export const AI_CENTER_DEFAULT_MODEL = "claude-haiku-4-5";

/** Bounded reply length for AI-1 conversational/decision calls — an AI-1
 * default, not an architectural constant. */
export const AI_CENTER_MAX_TOKENS = 400;

/**
 * Renders a compact, bounded, plain-text summary of resolved CRM context
 * for a model prompt. Never serializes raw event metadata or anything
 * context-builder.ts didn't already scope down to a small summary (see
 * that file's own scoping guarantees) — this only re-formats what it's
 * given.
 */
export function buildContextLines(context: AIResolvedContext): string[] {
  const contextLines: string[] = [];

  if (context.contact) {
    contextLines.push(`Contact: ${context.contact.name}${context.contact.phone ? ` (${context.contact.phone})` : ""}`);
  }
  if (context.lead) {
    // Lead name shown only when no separate contact record was resolved
    // (the common case — a lead-scoped run often has no contactId at
    // all) so the model still has a trusted name to personalize with
    // without a second, possibly-duplicate "Contact:" line.
    if (context.lead.name && !context.contact) {
      contextLines.push(`Lead name: ${context.lead.name}`);
    }
    contextLines.push(
      `Lead status: ${context.lead.status}${context.lead.source ? `, source: ${context.lead.source}` : ""}`,
    );
    if (context.lead.projectType) {
      contextLines.push(`Project type: ${context.lead.projectType}`);
    }
    if (typeof context.lead.estimatedBudget === "number") {
      contextLines.push(`Estimated budget: $${context.lead.estimatedBudget.toLocaleString("en-US")}`);
    }
  }
  if (context.project) {
    contextLines.push(`Project: ${context.project.name} (${context.project.status})`);
  }
  if (context.conversation?.recentMessages?.length) {
    // Already bounded by context-builder.ts's RECENT_MESSAGE_LIMIT (10) —
    // formatted compactly as plain text lines, not a JSON dump.
    const formatted = context.conversation.recentMessages
      .map((m) => `${m.direction === "in" ? "Customer" : "Us"}: ${m.text}`)
      .join("\n");
    contextLines.push(`Recent conversation:\n${formatted}`);
  }

  return contextLines;
}
