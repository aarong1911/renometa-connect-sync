// src/components/ai-center/ai-approvals-tab.tsx
//
// AI-2B — AI Center Approvals UI.
//
// Consolidates the ONLY prior approval UI in this codebase
// (agentic-preview-panel.tsx's "Awaiting Approval" card, which read
// agent_approval_requests directly and posted to agent-approve-action.ts)
// into one first-class, dedicated Approvals tab — that panel's approval
// section is removed in this same pass so there are never two competing
// approval UIs on the same page. Reuses the EXACT same data source and
// the EXACT same canonical write path:
//
//   read:  agent_approval_requests (direct Supabase read, RLS-scoped —
//          the "org members read own org approval requests" policy
//          already permits this; no new endpoint needed)
//   write: POST netlify/functions/agent-approve-action.ts (unmodified —
//          owner/admin-gated server-side via resolveOrgAndAuthority(),
//          approval hash re-validation, emergency-pause/opt-out rechecks,
//          idempotency, real handler execution)
//
// This file NEVER writes agent_approval_requests directly, NEVER calls
// Twilio, and NEVER duplicates action-executor.ts's safety checks
// client-side — it only displays what already happened/will happen
// server-side and forwards the operator's decision to the one endpoint
// authorized to act on it.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, MessageSquareText, RefreshCw, ShieldAlert, User } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useOrgId } from "@/lib/org-id";
import { useCurrentUserRole } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import {
  fetchAiApprovalsList,
  channelForActionKey,
  readSmsBody,
  type ApprovalStatus,
  type ApprovalRow,
  type ContactSummary,
  type InboundMessage,
  type FilterValue,
} from "@/lib/ai-approvals-list";

type ExecutionRow = {
  id: string;
  agent_key: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd_estimated: number | null;
  error: string | null;
};

type ExecutionStepRow = {
  id: string;
  status: string;
  input_snapshot: unknown;
  output_snapshot: unknown;
  error: string | null;
};

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

/** Masks a stored phone number to only its last 4 digits — "•••-•••-8466". Never
 * used for anything but display; the real value is only ever read server-side. */
function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "—";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "•••-•••-••••";
  return `•••-•••-${digits.slice(-4)}`;
}

function statusBadgeVariant(status: ApprovalStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "pending") return "outline";
  if (status === "executed") return "default";
  if (status === "rejected" || status === "failed") return "destructive";
  return "secondary";
}

function statusLabel(status: ApprovalStatus): string {
  switch (status) {
    case "pending": return "Pending";
    case "executed": return "Completed";
    case "rejected": return "Rejected";
    case "failed": return "Failed";
    case "expired": return "Expired";
    case "cancelled": return "Cancelled";
    case "approved": return "Approved";
    default: return status;
  }
}

function actionDisplayName(actionKey: string): string {
  if (actionKey === "send_sms") return "SMS Reply";
  if (actionKey === "send_whatsapp") return "WhatsApp Reply";
  if (actionKey === "send_email") return "Email Reply";
  if (actionKey === "create_follow_up_task") return "Follow-Up Task";
  return actionKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function AIApprovalsTab({
  onPendingCountChange,
}: {
  /** Reports the current PENDING count up to the parent so the top-level
   * "Approvals" tab trigger can show a live badge — see ai-center.tsx. */
  onPendingCountChange?: (count: number) => void;
}) {
  const orgId = useOrgId();
  const role = useCurrentUserRole();
  const isOwnerOrAdmin = role === "owner" || role === "admin";
  // Sidebar "AI Center" pending-approval badge (ai-approvals-count.ts) is a
  // SEPARATE TanStack Query cache/key from this component's own approvals
  // LIST cache (queryKeys.aiApprovals.list) — approving/rejecting here
  // mutates the database but does nothing to the OTHER cache on its own.
  // The central realtime bridge (realtime-bridge.tsx) invalidates both via
  // the shared aiApprovals.all(orgId) prefix, but that's cross-tab/
  // server-change coverage, not a substitute for immediate same-tab
  // consistency: invalidate both directly right after a decision succeeds,
  // exactly like every other mutation-success handler in this app already
  // does for its own domain's query key(s).
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<FilterValue>("pending");
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const [detailApproval, setDetailApproval] = useState<ApprovalRow | null>(null);
  const [detailExecution, setDetailExecution] = useState<ExecutionRow | null>(null);
  const [detailStep, setDetailStep] = useState<ExecutionStepRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Platform State Sync (S6.2) — the approval list itself, per (org,
  // filter). Replaces the previous useState(approvals)/useState(loading)/
  // loadApprovals() trio: those had no query key the central realtime
  // bridge could invalidate, so a webhook-created approval updated the
  // sidebar's separate pendingCount query live but left THIS list stale
  // until a manual Refresh. See fetchAiApprovalsList() above and
  // query-keys.ts's aiApprovals.list().
  const approvalsQuery = useQuery({
    queryKey: orgId ? queryKeys.aiApprovals.list(orgId, filter) : ["aiApprovals", "list", filter],
    queryFn: () => fetchAiApprovalsList(orgId as string, filter),
    enabled: !!orgId,
    staleTime: 15_000,
  });
  const approvals = approvalsQuery.data?.approvals ?? [];
  const contactByApproval = approvalsQuery.data?.contactByApproval ?? new Map<string, ContactSummary>();
  const inboundByApproval = approvalsQuery.data?.inboundByApproval ?? new Map<string, InboundMessage | null>();
  // isPending (no data yet at all) drives the full-panel spinner-instead-
  // of-content branch below — NOT isFetching, so a realtime-triggered
  // background refetch (new approval arriving while this tab is open)
  // updates the list in place instead of blanking it out first. This is
  // the one intentional, strictly-better deviation from the old
  // "setLoading(true) on every single load" behavior — every other Query-
  // backed list in this app (conversations, leads, deals, …) already
  // behaves this way; it isn't a visual redesign, same cards/empty state.
  const loading = !orgId || approvalsQuery.isPending;

  // Reports the current PENDING count up to the parent (ai-center.tsx's
  // own Approvals-tab-trigger badge) — same value, same two-branch
  // computation as before (see fetchAiApprovalsList's pendingCount), now
  // sourced from this query's result instead of a duplicate inline fetch.
  useEffect(() => {
    if (onPendingCountChange && approvalsQuery.data) {
      onPendingCountChange(approvalsQuery.data.pendingCount);
    }
  }, [approvalsQuery.data, onPendingCountChange]);

  async function handleDecision(approval: ApprovalRow, decision: "approve" | "reject") {
    setDecidingId(approval.id);
    try {
      const res = await fetch("/.netlify/functions/agent-approve-action", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({
          approvalId: approval.id,
          decision,
          rejectionReason: decision === "reject" ? "Rejected from AI Center Approvals." : undefined,
        }),
      });
      const body = await res.json();

      if (!res.ok) {
        // 401/403/etc — the server remains authoritative regardless of
        // what the frontend showed; never assume success.
        toast.error(body.error ?? "Could not process this approval.");
        return;
      }

      if (decision === "reject") {
        toast.success("Action rejected. No message was sent.");
      } else if (!body.success) {
        // Server returned 200 but the underlying execution failed (e.g.
        // emergency pause engaged or consent changed since the request
        // was created — action-executor.ts rechecks both fresh at
        // execution time). Never expose private consent/policy internals
        // — action-executor.ts's own error strings are already safe/
        // generic (see checkOutboundConsent's SAFE_BLOCKED_REASON), but
        // this is a second layer of genericization in case that ever
        // changes.
        toast.error(
          /pause|consent|eligib|policy/i.test(body.error ?? "")
            ? "Action could not be completed because current safety or communication policy no longer allows it."
            : (body.error ?? "Action could not be completed."),
        );
      } else if (approval.action_key === "send_sms") {
        toast.success(body.status === "already_executed" ? "Already sent — no duplicate message." : "SMS approved and sent.");
      } else if (approval.action_key === "create_follow_up_task") {
        toast.success(body.status === "already_executed" ? "Task already created — no duplicate added." : "Follow-up task created.");
      } else {
        toast.success(body.status === "already_executed" ? "Already executed — no duplicate action taken." : "Action approved and executed.");
      }

      // Immediate same-tab consistency for BOTH the sidebar badge and this
      // list — see the comment on `queryClient` above. Always a full
      // invalidate/refetch from the database, never a manual decrement/
      // splice (a decision here could be a no-op re-execution of an
      // already-decided approval — see body.status === "already_executed"
      // above — so a fixed -1 or a spliced-out row could easily be wrong;
      // only the database's actual current state is trusted). One prefix
      // invalidation covers pendingCount AND every cached list filter
      // (Pending/Completed/Rejected/All) — the currently-active filter
      // refetches immediately, so a rejected/approved row disappears from
      // Pending right away, and the other tabs pick up the change next
      // time they're viewed.
      if (orgId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.aiApprovals.all(orgId) });
      }
    } catch {
      toast.error("Network error — please try again.");
    } finally {
      setDecidingId(null);
    }
  }

  async function openDetail(approval: ApprovalRow) {
    setDetailApproval(approval);
    setDetailExecution(null);
    setDetailStep(null);
    setDetailLoading(true);
    try {
      if (!orgId) return;
      const [{ data: execution }, { data: step }] = await Promise.all([
        supabase
          .from("agent_executions")
          .select("id, agent_key, status, started_at, completed_at, input_tokens, output_tokens, cost_usd_estimated, error")
          .eq("id", approval.execution_id)
          .eq("org_id", orgId)
          .maybeSingle(),
        supabase
          .from("agent_execution_steps")
          .select("id, status, input_snapshot, output_snapshot, error")
          .eq("execution_id", approval.execution_id)
          .eq("org_id", orgId)
          .eq("action_key", approval.action_key)
          .order("sequence", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      setDetailExecution((execution as ExecutionRow) ?? null);
      setDetailStep((step as ExecutionStepRow) ?? null);
    } finally {
      setDetailLoading(false);
    }
  }

  if (!isOwnerOrAdmin) {
    // Defensive only — AI Center's own route guard (ROLE_ALLOWED_ROUTES)
    // already restricts /ai-center to owner/admin, so this should be
    // unreachable in practice. The real authority boundary is server-side
    // (agent-approve-action.ts's resolveOrgAndAuthority()) regardless of
    // what this check does.
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        <ShieldAlert className="mx-auto mb-2 h-5 w-5" />
        Only an organization owner or admin may view AI action approvals.
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as FilterValue)}>
          <TabsList className="h-9">
            {FILTERS.map((f) => (
              <TabsTrigger key={f.value} value={f.value} className="h-7 px-2.5 text-xs">{f.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Button size="sm" variant="outline" className="h-9 text-xs" onClick={() => void approvalsQuery.refetch()} disabled={approvalsQuery.isFetching}>
          {approvalsQuery.isFetching ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : approvals.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {filter === "pending" ? "No actions are currently awaiting approval." : "No approvals match this filter."}
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {approvals.map((a) => {
            const replyChannel = channelForActionKey(a.action_key);
            const isSms = replyChannel !== undefined;
            const contact = contactByApproval.get(a.id);
            const inbound = inboundByApproval.get(a.id);
            const proposedBody = isSms ? readSmsBody(a.proposed_input) : undefined;
            const isPending = a.status === "pending";
            const isDeciding = decidingId === a.id;

            return (
              <Card key={a.id} className="p-4">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {isSms && <MessageSquareText className="h-4 w-4 shrink-0 text-primary" />}
                    <h3 className="text-sm font-semibold">{actionDisplayName(a.action_key)} Approval</h3>
                  </div>
                  <Badge variant={statusBadgeVariant(a.status)} className="h-5 shrink-0 rounded px-1.5 text-[10px]">
                    {statusLabel(a.status)}
                  </Badge>
                </div>

                {isSms ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <User className="h-3 w-3" />
                      <span className="font-medium text-foreground">{contact?.name ?? "Unknown contact"}</span>
                      <span>·</span>
                      <span>{maskPhone(contact?.phone)}</span>
                    </div>

                    {inbound ? (
                      <div className="rounded-md border bg-secondary/40 p-2 text-xs">
                        <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Incoming</div>
                        "{inbound.body}"
                      </div>
                    ) : (
                      <div className="rounded-md border border-dashed p-2 text-[11px] text-muted-foreground">
                        Original inbound message unavailable for this request (predates message-linkage tracking).
                      </div>
                    )}

                    {proposedBody && (
                      <div className="rounded-md border border-violet-200/70 bg-violet-50/70 p-2 text-xs dark:border-violet-900/40 dark:bg-violet-500/5">
                        <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">AI proposed reply</div>
                        "{proposedBody}"
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">{a.summary}</div>
                )}

                <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>
                    Requested {new Date(a.requested_at).toLocaleString()}
                    {a.expires_at && isPending && <> · Expires {new Date(a.expires_at).toLocaleString()}</>}
                  </span>
                  <button className="underline underline-offset-2 hover:text-foreground" onClick={() => void openDetail(a)}>
                    View Execution
                  </button>
                </div>

                {a.status === "rejected" && a.rejection_reason && (
                  <div className="mt-1.5 text-[11px] text-muted-foreground">Reason: {a.rejection_reason}</div>
                )}

                {isPending && (
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" disabled={isDeciding} onClick={() => void handleDecision(a, "approve")}>
                      {isDeciding && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                      {isSms ? "Approve & Send" : "Approve"}
                    </Button>
                    <Button size="sm" variant="outline" disabled={isDeciding} onClick={() => void handleDecision(a, "reject")}>
                      Reject
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Sheet open={!!detailApproval} onOpenChange={(open) => !open && setDetailApproval(null)}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Execution Details</SheetTitle>
            <SheetDescription>
              {detailApproval ? actionDisplayName(detailApproval.action_key) : ""}
            </SheetDescription>
          </SheetHeader>
          {detailLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : detailExecution ? (
            <div className="mt-4 space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-muted-foreground">Agent:</span> <span className="capitalize">{detailExecution.agent_key.replace(/_/g, " ")}</span></div>
                <div><span className="text-muted-foreground">Status:</span> {detailExecution.status}</div>
                <div><span className="text-muted-foreground">Started:</span> {new Date(detailExecution.started_at).toLocaleString()}</div>
                <div><span className="text-muted-foreground">Completed:</span> {detailExecution.completed_at ? new Date(detailExecution.completed_at).toLocaleString() : "—"}</div>
                <div><span className="text-muted-foreground">Tokens:</span> {(detailExecution.input_tokens ?? 0) + (detailExecution.output_tokens ?? 0)}</div>
                <div><span className="text-muted-foreground">Est. cost:</span> ${(detailExecution.cost_usd_estimated ?? 0).toFixed(4)}</div>
              </div>
              {detailExecution.error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{detailExecution.error}</div>
              )}
              {detailStep && (
                <div className="space-y-1.5">
                  <div className="text-xs font-medium">This action's step</div>
                  <div className="rounded-md border bg-secondary/40 p-2 text-[11px]">
                    <div className="text-muted-foreground">Status: {detailStep.status}</div>
                    {detailStep.error && <div className="mt-1 text-destructive">{detailStep.error}</div>}
                  </div>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                Full run history (routing, handoffs, tool activity) is available in the Test Console's Run Inspector for the same execution id: <span className="font-mono">{detailExecution.id}</span>
              </p>
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">Execution details unavailable.</p>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
