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

import type { AIChannel, AIResolvedContext } from "./types";
import { getCatalogCategory } from "../../../../src/lib/agentic/business-knowledge-catalog";

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
  // An estimate that ALREADY exists for this customer. Deliberately carries no dollar figure: agents other than
  // the Estimate Assistant must never quote money, and the Estimate Assistant reads the full estimate itself.
  const existing = context.existingEstimate;
  if (existing?.state === "found") {
    const lines = typeof existing.itemCount === "number" ? `, ${existing.itemCount} line item${existing.itemCount === 1 ? "" : "s"}` : "";
    const pricing = existing.pricePending ? `, pricing still pending on ${existing.pricePendingItemCount ?? "some"} line${existing.pricePendingItemCount === 1 ? "" : "s"}` : "";
    contextLines.push(
      `Existing estimate on file: ${existing.number ?? "(unnumbered)"} "${existing.title ?? "Untitled estimate"}", status ${existing.status ?? "unknown"}${lines}${pricing}. The Estimate Assistant owns any question about it or change to it.`,
    );
  } else if (existing?.state === "ambiguous") {
    const list = (existing.candidates ?? []).map((c) => `${c.number ?? "(unnumbered)"} "${c.title}" (${c.status})`).join("; ");
    contextLines.push(`Several active estimates are on file for this customer: ${list}. It is not known which one the customer means — never guess.`);
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

/**
 * Shared answer-priority rule, appended (via buildBusinessKnowledgeSection)
 * to every agent's system prompt — one definition, so Reception, Lead
 * Qualification, Scheduling and every future agent follow the identical
 * rule instead of each carrying its own paraphrase.
 */
export const BUSINESS_KNOWLEDGE_RULES = [
  "Answer priority: (1) Trusted Business Knowledge below is AUTHORITATIVE for facts about THIS business (its policies, capabilities, services, pricing rules, service area, warranties, financing, permits, and so on). (2) The CRM context is AUTHORITATIVE for facts about THIS customer, lead, or project. You may combine the two naturally.",
  "State a company-specific fact ONLY if it is written in Trusted Business Knowledge — and state it as written, without embellishing or extending it. Never present generic industry knowledge, or what a typical contractor does, as this business's own policy or capability. If a company-specific fact is not in Trusted Business Knowledge, you do not know it.",
].join(" ");

/**
 * Renders the Trusted Business Knowledge block plus the shared answer-
 * priority rule, for appending to an agent's SYSTEM prompt. Pure formatting
 * of what context-builder.ts already resolved (org-scoped, active-only,
 * bounded) — never fetches anything. Always returns a non-empty string:
 * "none configured" and "unavailable" are both stated explicitly so the
 * model never infers facts from silence.
 */
export function buildBusinessKnowledgeSection(context: AIResolvedContext): string {
  const knowledge = context.businessKnowledge;
  let body: string;
  if (!knowledge || knowledge.status === "unavailable") {
    body = "Trusted Business Knowledge: currently unavailable. Do not assert any company-specific policy or capability.";
  } else if (knowledge.entries.length === 0) {
    body = "Trusted Business Knowledge: none has been configured yet. Do not assert any company-specific policy or capability.";
  } else {
    body = [
      "Trusted Business Knowledge (facts the business owner has configured about THIS business):",
      ...knowledge.entries.map((e) => {
        const label = getCatalogCategory(e.key)?.label;
        return label ? `- ${label}: ${e.answer}` : `- ${e.question || "Other"} — ${e.answer}`;
      }),
    ].join("\n");
  }
  return ["", BUSINESS_KNOWLEDGE_RULES, body].join("\n");
}

/**
 * AI-2A. One short, optional line of channel-aware guidance — not a
 * per-channel agent, not a hardcoded character limit (none exists in this
 * product's behavior today; see this task's own instruction not to invent
 * one). Empty string for every channel but sms, so every existing caller
 * (voice/web_chat/manual_test/etc.) is byte-for-byte unaffected.
 */
export function channelGuidance(channel: AIChannel): string {
  if (channel === "sms") {
    return "This conversation is happening over SMS text message — keep your reply short, natural, and easy to read as a text (a sentence or two), not an email or a list.";
  }
  return "";
}
