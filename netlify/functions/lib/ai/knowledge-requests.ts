// netlify/functions/lib/ai/knowledge-requests.ts
//
// Request-body parsing + dispatch for the two Business Knowledge HTTP
// endpoints (business-knowledge.ts, ai-clarification-resolve.ts), split out
// so the part that DECIDES things (which actions exist, which fields are
// accepted, status-code mapping) is unit-testable without a Netlify event
// or a real bearer token. The thin handlers do authentication and
// owner/admin authorization (resolveOrgAndAuthority) and pass in an
// ALREADY-VERIFIED orgId/userId — nothing here ever reads an org id from
// `body`. Unknown body fields are ignored, never forwarded.

import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteCustomKnowledgeEntry, setKnowledgeStatus, upsertKnowledgeEntry } from "./business-knowledge-store";
import { dismissClarification, resolveClarification } from "./knowledge-clarification";

export type HandlerResponse = { statusCode: number; body: Record<string, unknown> };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export async function processBusinessKnowledgeRequest(
  supabase: SupabaseClient,
  actor: { orgId: string; userId: string },
  body: unknown,
): Promise<HandlerResponse> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const action = str(b.action);

  if (action === "upsert") {
    const result = await upsertKnowledgeEntry(supabase, {
      orgId: actor.orgId,
      userId: actor.userId,
      key: str(b.key),
      question: str(b.question),
      answer: str(b.answer) ?? "",
      // Source is NEVER taken from the body: an owner editing in Settings is `owner_configured`.
      source: "owner_configured",
      optionId: str(b.optionId),
    });
    if (!result.ok) return { statusCode: result.code === "db_error" ? 500 : 400, body: { error: result.message } };
    return { statusCode: 200, body: { entry: result.entry } };
  }

  if (action === "set_status") {
    const key = str(b.key);
    if (!key || (b.status !== "active" && b.status !== "inactive")) {
      return { statusCode: 400, body: { error: "key and status ('active'|'inactive') are required." } };
    }
    const result = await setKnowledgeStatus(supabase, { orgId: actor.orgId, key, status: b.status });
    if (!result.ok) return { statusCode: result.code === "not_found" ? 404 : 500, body: { error: result.message } };
    return { statusCode: 200, body: { entry: result.entry } };
  }

  if (action === "delete") {
    const key = str(b.key);
    if (!key) return { statusCode: 400, body: { error: "key is required." } };
    const result = await deleteCustomKnowledgeEntry(supabase, { orgId: actor.orgId, key });
    if (!result.ok) {
      return { statusCode: result.code === "invalid" ? 400 : result.code === "not_found" ? 404 : 500, body: { error: result.message } };
    }
    return { statusCode: 200, body: { deleted: true } };
  }

  return { statusCode: 400, body: { error: "action must be 'upsert', 'set_status' or 'delete'." } };
}

export async function processClarificationRequest(
  supabase: SupabaseClient,
  actor: { orgId: string; userId: string },
  body: unknown,
): Promise<HandlerResponse> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const clarificationId = str(b.clarificationId);
  if (!clarificationId) return { statusCode: 400, body: { error: "clarificationId is required." } };

  if (b.action === "dismiss") {
    const result = await dismissClarification({ supabase, orgId: actor.orgId, userId: actor.userId, clarificationId });
    if (result.status === "not_found") return { statusCode: 404, body: { error: "Request not found." } };
    if (result.status === "already_resolved") return { statusCode: 409, body: { error: "This question was already answered." } };
    if (result.status === "in_progress") return { statusCode: 409, body: { error: "This answer is being sent right now." } };
    return { statusCode: 200, body: { status: "dismissed" } };
  }

  if (b.action !== "answer") return { statusCode: 400, body: { error: "action must be 'answer' or 'dismiss'." } };

  const result = await resolveClarification({
    supabase,
    orgId: actor.orgId,
    userId: actor.userId,
    clarificationId,
    answer: str(b.answer) ?? "",
    optionId: str(b.optionId),
    saveToKnowledge: b.saveToKnowledge === true,
  });

  switch (result.status) {
    case "not_found": return { statusCode: 404, body: { error: "Request not found." } };
    case "invalid": return { statusCode: 400, body: { error: result.message } };
    case "dismissed": return { statusCode: 409, body: { error: "This question was dismissed." } };
    case "in_progress": return { statusCode: 409, body: { status: "in_progress", error: "This answer is already being sent." } };
    case "send_failed":
      // 200 with success:false — mirrors agent-approve-action.ts: the HTTP call worked, the action did not.
      return { statusCode: 200, body: { success: false, status: "send_failed", error: result.error, knowledge: result.knowledge } };
    case "resolved":
      return { statusCode: 200, body: { success: true, status: result.alreadyResolved ? "already_resolved" : "resolved", knowledge: result.knowledge } };
  }
}
