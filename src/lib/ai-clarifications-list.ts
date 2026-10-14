// src/lib/ai-clarifications-list.ts
//
// AI Center "Knowledge Clarification" list query — the read side of the
// Owner Clarification workflow, rendered inside the existing Approvals tab
// (ai-approvals-tab.tsx) but deliberately a SEPARATE query/type from
// ai-approvals-list.ts: a clarification is not an action approval (see
// 20261013_business_knowledge_and_clarifications.sql's header), so it has
// its own row type, status vocabulary, and filter mapping.
//
// READ ONLY, RLS-scoped (the table's only policy is tenant-scoped SELECT);
// every write goes through netlify/functions/ai-clarification-resolve.ts.
// Plain, DOM/React-free, injectable-client function so it is unit-testable
// against the fake Supabase client — same shape as fetchAiApprovalsList().

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { KnowledgeOption } from "@/lib/agentic/business-knowledge-catalog";
import type { FilterValue, ContactSummary, InboundMessage } from "@/lib/ai-approvals-list";

export type ClarificationStatus = "pending" | "sending" | "send_failed" | "resolved" | "dismissed";

/** Statuses where the owner still has something to do (or something is in flight). */
export const OPEN_CLARIFICATION_STATUSES: readonly ClarificationStatus[] = ["pending", "sending", "send_failed"];

export type ClarificationRow = {
  id: string;
  execution_id: string;
  contact_id: string;
  channel: string;
  question: string;
  knowledge_key: string;
  category: string;
  suggested_options: KnowledgeOption[];
  status: ClarificationStatus;
  answer: string | null;
  save_to_knowledge: boolean;
  knowledge_saved_at: string | null;
  knowledge_save_error: string | null;
  send_error: string | null;
  inbound_message_id: string | null;
  created_at: string;
  resolved_at: string | null;
};

export type ClarificationListResult = {
  clarifications: ClarificationRow[];
  contactById: Map<string, ContactSummary>;
  inboundById: Map<string, InboundMessage>;
  /** Open (actionable/in-flight) count for the parent badge, regardless of the active filter. */
  openCount: number;
};

const COLUMNS =
  "id, execution_id, contact_id, channel, question, knowledge_key, category, suggested_options, status, answer, save_to_knowledge, knowledge_saved_at, knowledge_save_error, send_error, inbound_message_id, created_at, resolved_at";

const LIST_LIMIT = 50;

export async function fetchOpenClarificationCount(orgId: string, client: SupabaseClient = supabase): Promise<number> {
  const { count, error } = await client
    .from("ai_clarification_requests")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .in("status", [...OPEN_CLARIFICATION_STATUSES]);
  // A failed count must never break the page — the badge simply hides.
  if (error) return 0;
  return count ?? 0;
}

export async function fetchAiClarificationsList(
  orgId: string,
  filter: FilterValue,
  client: SupabaseClient = supabase,
): Promise<ClarificationListResult> {
  let query = client
    .from("ai_clarification_requests")
    .select(COLUMNS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);

  // Filter vocabulary is shared with the approvals tabs: "Completed" =
  // delivered answers, "Rejected" = dismissed, "Pending" = anything the
  // owner still needs to act on (including a failed send awaiting retry).
  if (filter === "pending") query = query.in("status", [...OPEN_CLARIFICATION_STATUSES]);
  else if (filter === "completed") query = query.eq("status", "resolved");
  else if (filter === "rejected") query = query.eq("status", "dismissed");

  const { data, error } = await query;
  if (error) {
    console.error("[ai-clarifications-list] load failed:", error);
    return { clarifications: [], contactById: new Map(), inboundById: new Map(), openCount: 0 };
  }
  const clarifications = (data ?? []) as ClarificationRow[];

  const contactIds = Array.from(new Set(clarifications.map((c) => c.contact_id)));
  const contactById = new Map<string, ContactSummary>();
  if (contactIds.length > 0) {
    const { data: contacts } = await client.from("contacts").select("id, full_name, phone").eq("org_id", orgId).in("id", contactIds);
    for (const c of contacts ?? []) contactById.set(c.id, { id: c.id, name: c.full_name ?? "Unknown", phone: c.phone ?? null });
  }

  const messageIds = Array.from(new Set(clarifications.map((c) => c.inbound_message_id).filter((x): x is string => !!x)));
  const inboundById = new Map<string, InboundMessage>();
  if (messageIds.length > 0) {
    const { data: rows } = await client.from("sms_meta_messages").select("id, body, from_address, created_at").eq("org_id", orgId).in("id", messageIds);
    for (const r of rows ?? []) inboundById.set((r as any).id, { body: r.body, from_address: r.from_address, created_at: r.created_at });
  }

  const openCount =
    filter === "pending" ? clarifications.length : await fetchOpenClarificationCount(orgId, client);

  return { clarifications, contactById, inboundById, openCount };
}
