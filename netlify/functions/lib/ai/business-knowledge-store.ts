// netlify/functions/lib/ai/business-knowledge-store.ts
//
// Business Knowledge — the ONLY write path to business_knowledge_entries.
// Injectable (takes a service-role SupabaseClient) and free of HTTP/Netlify
// concerns so it is directly unit-testable against the fake Supabase client;
// the thin Netlify handlers (business-knowledge.ts, ai-clarification-
// resolve.ts) do authentication + owner/admin authorization and call in
// here with an ALREADY-RESOLVED orgId/userId.
//
// TRUST: callers pass `orgId`/`userId` from server-side resolution
// (resolve-org.ts). Nothing here reads an org id from a request body or a
// model, and every query is scoped by `org_id`. A model can never reach
// this module: it is not importable from any agent, tool, or the
// orchestrator's decision schemas — only from the two HTTP handlers and
// from knowledge-clarification.ts's owner-resolution path (a human action).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CUSTOM_CATEGORY,
  CUSTOM_KEY_PREFIX,
  MAX_ANSWER_LENGTH,
  MAX_QUESTION_LENGTH,
  customKeyForQuestion,
  getCatalogCategory,
} from "../../../../src/lib/agentic/business-knowledge-catalog";

export type KnowledgeSource = "owner_configured" | "owner_clarification" | "system_seeded";

export type KnowledgeEntryRow = {
  id: string;
  org_id: string;
  key: string;
  category: string;
  question: string;
  answer: string;
  source: KnowledgeSource;
  status: "active" | "inactive";
  metadata: Record<string, unknown>;
  created_by: string | null;
  updated_by: string | null;
  created_at?: string;
  updated_at: string;
};

export type KnowledgeWriteResult =
  | { ok: true; entry: KnowledgeEntryRow }
  | { ok: false; code: "invalid" | "not_found" | "db_error"; message: string };

const ENTRY_COLUMNS = "id, org_id, key, category, question, answer, source, status, metadata, created_by, updated_by, created_at, updated_at";

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type UpsertKnowledgeParams = {
  orgId: string;
  /** The human who authored this answer (from the verified bearer token). */
  userId: string;
  /** Catalog key, or a `custom_*` key. Omit for a NEW custom entry (derived from `question`). */
  key?: string;
  question?: string;
  answer: string;
  source: KnowledgeSource;
  optionId?: string;
};

/**
 * Deterministic upsert on (org_id, key). A catalog key always takes its
 * canonical category/question from the catalog (never from the caller), so
 * "permit_handling" can never be saved under a drifting question text. A
 * custom entry requires a real question. Re-saving an existing key
 * overwrites its answer and re-activates it — "save this answer" by the
 * owner is an explicit statement that this is the current truth.
 */
export async function upsertKnowledgeEntry(supabase: SupabaseClient, params: UpsertKnowledgeParams): Promise<KnowledgeWriteResult> {
  const answer = cleanText(params.answer);
  if (!answer) return { ok: false, code: "invalid", message: "An answer is required." };
  if (answer.length > MAX_ANSWER_LENGTH) return { ok: false, code: "invalid", message: `Answers are limited to ${MAX_ANSWER_LENGTH} characters.` };

  let key: string;
  let category: string;
  let question: string;

  const catalogEntry = params.key ? getCatalogCategory(params.key) : undefined;
  if (catalogEntry) {
    key = catalogEntry.key;
    category = catalogEntry.key;
    question = catalogEntry.question;
  } else {
    question = cleanText(params.question);
    if (question.length < 8) return { ok: false, code: "invalid", message: "A custom entry needs a question of at least 8 characters." };
    if (question.length > MAX_QUESTION_LENGTH) return { ok: false, code: "invalid", message: `Questions are limited to ${MAX_QUESTION_LENGTH} characters.` };
    if (params.key !== undefined && !params.key.startsWith(CUSTOM_KEY_PREFIX)) {
      return { ok: false, code: "invalid", message: "Unknown knowledge key." };
    }
    key = params.key ?? customKeyForQuestion(question);
    category = CUSTOM_CATEGORY;
  }

  // created_by / updated_by semantics: created_by is the ORIGINAL author and
  // is never sent on the update path (so it can never be overwritten, even
  // before the DB trigger backstop — 20261013 migration — is considered);
  // updated_by is always the human making THIS write. Read-then-write rather
  // than a blind upsert for exactly that reason; a concurrent first-insert
  // race (23505) simply retries as an update.
  const fields = {
    category,
    question,
    answer,
    source: params.source,
    status: "active",
    metadata: params.optionId ? { optionId: params.optionId } : {},
    updated_by: params.userId,
    updated_at: new Date().toISOString(),
  };

  const update = async () =>
    supabase
      .from("business_knowledge_entries")
      .update(fields)
      .eq("org_id", params.orgId)
      .eq("key", key)
      .select(ENTRY_COLUMNS)
      .maybeSingle();

  const { data: existing, error: lookupError } = await supabase
    .from("business_knowledge_entries")
    .select("id")
    .eq("org_id", params.orgId)
    .eq("key", key)
    .maybeSingle();
  if (lookupError) {
    console.error("[business-knowledge-store] lookup failed:", lookupError.message);
    return { ok: false, code: "db_error", message: "Could not save this Business Knowledge entry." };
  }

  let result = existing
    ? await update()
    : await supabase
        .from("business_knowledge_entries")
        .insert({ org_id: params.orgId, key, ...fields, created_by: params.userId })
        .select(ENTRY_COLUMNS)
        .maybeSingle();
  if (!existing && (result.error as { code?: string } | null)?.code === "23505") result = await update();

  if (result.error || !result.data) {
    console.error("[business-knowledge-store] save failed:", result.error?.message);
    return { ok: false, code: "db_error", message: "Could not save this Business Knowledge entry." };
  }
  return { ok: true, entry: result.data as KnowledgeEntryRow };
}

/** Enable/disable an existing entry. Org-scoped; an unknown key is `not_found`, never a cross-org write. */
export async function setKnowledgeStatus(
  supabase: SupabaseClient,
  params: { orgId: string; key: string; status: "active" | "inactive" },
): Promise<KnowledgeWriteResult> {
  const { data, error } = await supabase
    .from("business_knowledge_entries")
    .update({ status: params.status, updated_at: new Date().toISOString() })
    .eq("org_id", params.orgId)
    .eq("key", params.key)
    .select(ENTRY_COLUMNS)
    .maybeSingle();
  if (error) {
    console.error("[business-knowledge-store] set status failed:", error.message);
    return { ok: false, code: "db_error", message: "Could not update this entry." };
  }
  if (!data) return { ok: false, code: "not_found", message: "Entry not found." };
  return { ok: true, entry: data as KnowledgeEntryRow };
}

/**
 * Hard-deletes a CUSTOM entry only. Catalog entries are never deleted (they
 * are the owner's configured answer for a fixed question — to stop the AI
 * using one, disable it instead).
 */
export async function deleteCustomKnowledgeEntry(
  supabase: SupabaseClient,
  params: { orgId: string; key: string },
): Promise<{ ok: true } | { ok: false; code: "invalid" | "not_found" | "db_error"; message: string }> {
  if (!params.key.startsWith(CUSTOM_KEY_PREFIX)) {
    return { ok: false, code: "invalid", message: "Only custom entries can be deleted. Disable a built-in entry instead." };
  }
  const { data, error } = await supabase
    .from("business_knowledge_entries")
    .delete()
    .eq("org_id", params.orgId)
    .eq("key", params.key)
    .select("id");
  if (error) {
    console.error("[business-knowledge-store] delete failed:", error.message);
    return { ok: false, code: "db_error", message: "Could not delete this entry." };
  }
  if (!data || data.length === 0) return { ok: false, code: "not_found", message: "Entry not found." };
  return { ok: true };
}
