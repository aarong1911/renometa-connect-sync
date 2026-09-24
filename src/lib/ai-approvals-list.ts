// src/lib/ai-approvals-list.ts
//
// AI Center Approvals — the approval LIST query (Pending/Completed/
// Rejected/All tabs), split out of ai-approvals-tab.tsx (Platform State
// Sync S6.2, 2026-09) for the same reason ai-approvals-count.ts's
// fetchAiApprovalPendingCount was split out earlier: a plain, DOM/React-
// free async function is directly unit-testable against a fake Supabase
// client, without pulling in the whole component tree (Button/Card/Sheet/
// Tabs and their own dependencies) just to test a data fetch.
//
// This is the SAME read this file's UI has always performed — nothing new
// was invented here, only "where the result goes" changed (returned from
// a plain function, then cached via TanStack Query, instead of setState'd
// directly inside a bespoke loadApprovals() loader). See ai-approvals-
// tab.tsx's own header for the read/write trust-model comment this list
// still honors (never writes agent_approval_requests directly, never
// calls a provider API — only reads and displays).

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled" | "executed" | "failed";

export type ApprovalRow = {
  id: string;
  execution_id: string;
  action_key: string;
  target_entity_type: string | null;
  target_entity_id: string | null;
  proposed_input: unknown;
  summary: string;
  risk_level: string;
  status: ApprovalStatus;
  requested_at: string;
  reviewed_at: string | null;
  expires_at: string | null;
  rejection_reason: string | null;
};

export type ContactSummary = { id: string; name: string; phone: string | null };
export type InboundMessage = { body: string; from_address: string | null; created_at: string };

export type FilterValue = "pending" | "completed" | "rejected" | "all";

export const RECENT_LIMIT = 50;

export function readContactId(proposedInput: unknown): string | undefined {
  if (proposedInput && typeof proposedInput === "object") {
    const v = (proposedInput as Record<string, unknown>).contactId;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

export function readSmsBody(proposedInput: unknown): string | undefined {
  if (proposedInput && typeof proposedInput === "object") {
    const v = (proposedInput as Record<string, unknown>).body;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

/** AI-2E: the two action keys that render the shared "message reply"
 * contact/inbound/proposed-reply layout — generalized from AI-2B's
 * original send_sms-only `isSms` gate so send_whatsapp renders with full
 * context instead of falling back to the generic `a.summary` line. Maps
 * an action key to the `sms_meta_messages.channel` value used to look up
 * its inbound linkage. */
export function channelForActionKey(actionKey: string): "sms" | "whatsapp" | undefined {
  if (actionKey === "send_sms") return "sms";
  if (actionKey === "send_whatsapp") return "whatsapp";
  return undefined;
}

export type ApprovalListResult = {
  approvals: ApprovalRow[];
  contactByApproval: Map<string, ContactSummary>;
  inboundByApproval: Map<string, InboundMessage | null>;
  /** Same two-branch count this file always computed (exact row length for
   * the "pending" filter itself; a separate exact count query otherwise)
   * — carried in the query result so the parent-badge callback
   * (onPendingCountChange) doesn't need its own second fetch. */
  pendingCount: number;
};

/**
 * Platform State Sync migration (S6.2, 2026-09) — the exact read logic
 * loadApprovals() always ran, now a standalone queryFn instead of a
 * useState-driven loader, so the AI Center Approvals list can be
 * TanStack Query-backed (queryKeys.aiApprovals.list(orgId, filter)) and
 * the central realtime bridge has something to invalidate for the LIST,
 * not just the sidebar's pendingCount. Every filter/sort/limit/enrichment
 * step below is byte-for-byte the same query this file already ran.
 * Takes an injectable client (defaulting to the real shared singleton)
 * for the same unit-testability reason as ai-approvals-count.ts's
 * fetchAiApprovalPendingCount.
 */
export async function fetchAiApprovalsList(
  orgId: string,
  filter: FilterValue,
  client: SupabaseClient = supabase,
): Promise<ApprovalListResult> {
  let query = client
    .from("agent_approval_requests")
    .select("id, execution_id, action_key, target_entity_type, target_entity_id, proposed_input, summary, risk_level, status, requested_at, reviewed_at, expires_at, rejection_reason")
    .eq("org_id", orgId)
    .order("requested_at", { ascending: false })
    .limit(RECENT_LIMIT);

  if (filter === "pending") query = query.eq("status", "pending");
  else if (filter === "completed") query = query.eq("status", "executed");
  else if (filter === "rejected") query = query.eq("status", "rejected");
  // "all": no status filter — every real DB status value renders with
  // its own real label (statusLabel()); nothing invented.

  const { data, error } = await query;
  if (error) {
    console.error("[ai-approvals-list] load failed:", error);
    return { approvals: [], contactByApproval: new Map(), inboundByApproval: new Map(), pendingCount: 0 };
  }
  const approvals = (data ?? []) as ApprovalRow[];

  // send_sms/send_whatsapp contextual resolution — org-scoped,
  // trusted-id-bound. AI-2E widened this from send_sms-only to both
  // message-reply actions (see channelForActionKey()) — the lookup
  // logic itself is channel-agnostic (contactId, execution_id).
  const smsRows = approvals.filter((a) => channelForActionKey(a.action_key) !== undefined);
  const contactIds = Array.from(new Set(smsRows.map((a) => readContactId(a.proposed_input)).filter((x): x is string => !!x)));
  const contactByApproval = new Map<string, ContactSummary>();
  if (contactIds.length > 0) {
    const { data: contacts } = await client
      .from("contacts")
      .select("id, full_name, phone")
      .eq("org_id", orgId)
      .in("id", contactIds);
    const nextContacts = new Map<string, ContactSummary>();
    for (const c of contacts ?? []) {
      nextContacts.set(c.id, { id: c.id, name: c.full_name ?? "Unknown", phone: c.phone ?? null });
    }
    for (const a of smsRows) {
      const cid = readContactId(a.proposed_input);
      if (cid && nextContacts.has(cid)) contactByApproval.set(a.id, nextContacts.get(cid)!);
    }
  }

  // Inbound-message linkage — see ai-twilio-sms-orchestrate-
  // background.ts's AI-2B addition: sms_meta_messages.meta->>
  // 'execution_id' is an exact match to the approval's own
  // execution_id, never a heuristic (timestamp/text) match.
  const executionIds = new Set(smsRows.map((a) => a.execution_id));
  const inboundByApproval = new Map<string, InboundMessage | null>();
  if (executionIds.size > 0) {
    // Filtered in-memory by meta->>execution_id rather than a
    // PostgREST jsonb-arrow `.in()` filter (uncertain cross-version
    // support) — bounded to this org's recent inbound SMS, which is
    // small at this stage of the product. Exact match only, never a
    // timestamp/text heuristic.
    const { data: inboundRows } = await client
      .from("sms_meta_messages")
      .select("body, from_address, created_at, meta")
      .eq("org_id", orgId)
      .eq("direction", "in")
      .in("channel", ["sms", "whatsapp"])
      .order("created_at", { ascending: false })
      .limit(200);
    const byExecutionId = new Map<string, InboundMessage>();
    for (const row of inboundRows ?? []) {
      const execId = (row as any).meta?.execution_id as string | undefined;
      if (execId && executionIds.has(execId) && !byExecutionId.has(execId)) {
        byExecutionId.set(execId, { body: row.body, from_address: row.from_address, created_at: row.created_at });
      }
    }
    for (const a of smsRows) {
      inboundByApproval.set(a.id, byExecutionId.get(a.execution_id) ?? null);
    }
  }

  const pendingCount = filter === "pending"
    ? approvals.length
    : await (async () => {
        const { count } = await client
          .from("agent_approval_requests")
          .select("id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .eq("status", "pending");
        return count ?? 0;
      })();

  return { approvals, contactByApproval, inboundByApproval, pendingCount };
}
