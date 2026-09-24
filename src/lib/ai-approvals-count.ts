// src/lib/ai-approvals-count.ts
//
// Sidebar "AI Center" pending-approval count badge. Mirrors the existing
// Inbox-unread pattern's architecture (sms-meta-conversations.ts /
// realtime-bridge.tsx): a thin useQuery wrapper reading ONE shared cache
// key (queryKeys.aiApprovals.pendingCount(orgId)) that the central
// realtime bridge invalidates on agent_approval_requests changes — no
// second, independent notification system, no per-component subscription.
//
// Deliberately separate from the AI Center route's own local
// pendingApprovalCount state (src/routes/ai-center.tsx) and from
// ai-approvals-tab.tsx's onPendingCountChange callback — both of those are
// pre-existing, local-only counts scoped to the Approvals tab trigger
// while that page is open, untouched by this change (task requirement:
// "the existing Approvals tab can keep its own badge"). This hook is for
// the sidebar, which needs a live count even when AI Center isn't the
// active route at all.
//
// Status vocabulary (supabase/migrations/20260731_agentic_foundation.sql's
// CHECK constraint): 'pending' | 'approved' | 'rejected' | 'expired' |
// 'cancelled' | 'executed' | 'failed'. Only 'pending' is a genuinely
// actionable, awaiting-a-human-decision approval — every other status is a
// terminal/decided state and must never inflate this count. This exact
// filter (.eq("status", "pending")) is the same one already used by
// ai-approvals-tab.tsx's own pending-count query and ai-center.tsx's
// Approvals-tab-trigger badge — not invented for this task.

import type { SupabaseClient } from "@supabase/supabase-js";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useOrgId } from "@/lib/org-id";
import { queryKeys } from "@/lib/query-keys";

const BADGE_CAP = 99;

/**
 * Formats a raw count for display in a small nav badge: null (render
 * nothing) for zero, the exact number for 1-99, "99+" above that. Pure and
 * exported specifically so the cap/hide behavior is unit-testable without
 * mounting the sidebar — same "smallest necessary extraction for
 * testability" precedent as this codebase's other pure-logic pulls
 * (isTrustedMetaOrigin, verifyActionSuccess, etc.).
 */
export function formatBadgeCount(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count > BADGE_CAP) return `${BADGE_CAP}+`;
  return String(Math.trunc(count));
}

/** Accessible label for the badge — "1 pending AI approval" / "N pending AI approvals". */
export function pendingApprovalAriaLabel(count: number): string {
  return `${count} pending AI approval${count === 1 ? "" : "s"}`;
}

/**
 * Count-only query (`{ count: "exact", head: true }` — never fetches full
 * approval rows just to display a number) for this org's currently pending
 * AI approval requests. Fails quietly: a query error resolves to a count
 * of 0 (badge hidden) rather than throwing — a transient failure to load
 * this notification count must never break sidebar rendering. Takes the
 * Supabase client as a parameter (defaulting to the app's real shared
 * singleton, so no call site needs to pass one explicitly) specifically so
 * it's directly unit-testable against a fake Supabase client — same
 * "smallest necessary extraction for testability" precedent as this
 * codebase's other pulled-out pure/near-pure functions.
 */
export async function fetchAiApprovalPendingCount(
  orgId: string,
  client: SupabaseClient = supabase,
): Promise<number> {
  const { count, error } = await client
    .from("agent_approval_requests")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("status", "pending");
  if (error) {
    console.error("[ai-approvals-count] fetch failed:", error.message);
    return 0;
  }
  return count ?? 0;
}

/**
 * Live pending-approval count for the current org. Realtime freshness
 * comes from the central bridge (realtime-bridge.tsx) invalidating this
 * same query key on agent_approval_requests INSERT/UPDATE/DELETE — this
 * hook itself only fetches, exactly like every other Platform-State-Sync
 * Query hook in this app.
 */
export function useAiApprovalPendingCount(): number {
  const orgId = useOrgId();
  const query = useQuery({
    queryKey: orgId ? queryKeys.aiApprovals.pendingCount(orgId) : ["aiApprovals", "pending"],
    queryFn: () => fetchAiApprovalPendingCount(orgId as string),
    enabled: !!orgId,
    staleTime: 15_000,
  });
  return query.data ?? 0;
}
