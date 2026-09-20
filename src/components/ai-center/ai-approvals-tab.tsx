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

import { useCallback, useEffect, useState } from "react";
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

type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled" | "executed" | "failed";

type ApprovalRow = {
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

type ContactSummary = { id: string; name: string; phone: string | null };
type InboundMessage = { body: string; from_address: string | null; created_at: string };

type FilterValue = "pending" | "completed" | "rejected" | "all";

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

const RECENT_LIMIT = 50;

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

function readContactId(proposedInput: unknown): string | undefined {
  if (proposedInput && typeof proposedInput === "object") {
    const v = (proposedInput as Record<string, unknown>).contactId;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

function readSmsBody(proposedInput: unknown): string | undefined {
  if (proposedInput && typeof proposedInput === "object") {
    const v = (proposedInput as Record<string, unknown>).body;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
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

/** AI-2E: the two action keys that render the shared "message reply"
 * contact/inbound/proposed-reply layout below — generalized from AI-2B's
 * original send_sms-only `isSms` gate so send_whatsapp renders with full
 * context instead of falling back to the generic `a.summary` line. Maps
 * an action key to the `sms_meta_messages.channel` value used to look up
 * its inbound linkage. */
function channelForActionKey(actionKey: string): "sms" | "whatsapp" | undefined {
  if (actionKey === "send_sms") return "sms";
  if (actionKey === "send_whatsapp") return "whatsapp";
  return undefined;
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

  const [filter, setFilter] = useState<FilterValue>("pending");
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  // Per-approval resolved display context — contact name/phone, inbound
  // message text — keyed by approval id. Populated after the approval
  // list itself loads (needs contactId/executionId from each row first).
  const [contactByApproval, setContactByApproval] = useState<Map<string, ContactSummary>>(new Map());
  const [inboundByApproval, setInboundByApproval] = useState<Map<string, InboundMessage | null>>(new Map());

  const [detailApproval, setDetailApproval] = useState<ApprovalRow | null>(null);
  const [detailExecution, setDetailExecution] = useState<ExecutionRow | null>(null);
  const [detailStep, setDetailStep] = useState<ExecutionStepRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadApprovals = useCallback(async () => {
    if (!orgId) { setApprovals([]); setLoading(false); return; }
    setLoading(true);
    try {
      let query = supabase
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
      if (error) { console.error("[ai-approvals-tab] load failed:", error); setApprovals([]); return; }
      setApprovals((data ?? []) as ApprovalRow[]);

      // send_sms/send_whatsapp contextual resolution — org-scoped,
      // trusted-id-bound. AI-2E widened this from send_sms-only to both
      // message-reply actions (see channelForActionKey()) — the lookup
      // logic itself is channel-agnostic (contactId, execution_id).
      const smsRows = (data ?? []).filter((a: any) => channelForActionKey(a.action_key) !== undefined);
      const contactIds = Array.from(new Set(smsRows.map((a: any) => readContactId(a.proposed_input)).filter((x: unknown): x is string => !!x)));
      const nextContacts = new Map<string, ContactSummary>();
      if (contactIds.length > 0) {
        const { data: contacts } = await supabase
          .from("contacts")
          .select("id, full_name, phone")
          .eq("org_id", orgId)
          .in("id", contactIds);
        for (const c of contacts ?? []) {
          nextContacts.set(c.id, { id: c.id, name: c.full_name ?? "Unknown", phone: c.phone ?? null });
        }
      }
      setContactByApproval((prev) => {
        const merged = new Map(prev);
        for (const a of smsRows as any[]) {
          const cid = readContactId(a.proposed_input);
          if (cid && nextContacts.has(cid)) merged.set(a.id, nextContacts.get(cid)!);
        }
        return merged;
      });

      // Inbound-message linkage — see ai-twilio-sms-orchestrate-
      // background.ts's AI-2B addition: sms_meta_messages.meta->>
      // 'execution_id' is an exact match to the approval's own
      // execution_id, never a heuristic (timestamp/text) match.
      const executionIds = new Set(smsRows.map((a: any) => a.execution_id as string));
      const nextInbound = new Map<string, InboundMessage | null>();
      if (executionIds.size > 0) {
        // Filtered in-memory by meta->>execution_id rather than a
        // PostgREST jsonb-arrow `.in()` filter (uncertain cross-version
        // support) — bounded to this org's recent inbound SMS, which is
        // small at this stage of the product. Exact match only, never a
        // timestamp/text heuristic (see this file's header).
        const { data: inboundRows } = await supabase
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
        for (const a of smsRows as any[]) {
          nextInbound.set(a.id, byExecutionId.get(a.execution_id) ?? null);
        }
      }
      setInboundByApproval((prev) => {
        const merged = new Map(prev);
        for (const [k, v] of nextInbound) merged.set(k, v);
        return merged;
      });

      if (onPendingCountChange) {
        if (filter === "pending") {
          onPendingCountChange((data ?? []).length);
        } else {
          const { count } = await supabase
            .from("agent_approval_requests")
            .select("id", { count: "exact", head: true })
            .eq("org_id", orgId)
            .eq("status", "pending");
          onPendingCountChange(count ?? 0);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [orgId, filter, onPendingCountChange]);

  useEffect(() => { void loadApprovals(); }, [loadApprovals]);

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

      await loadApprovals();
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
        <Button size="sm" variant="outline" className="h-9 text-xs" onClick={() => void loadApprovals()} disabled={loading}>
          {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
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
