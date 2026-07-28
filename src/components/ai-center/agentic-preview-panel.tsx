// src/components/ai-center/agentic-preview-panel.tsx
//
// Phase 9.6 — Priority 15's "smallest useful UI foundation," visually
// aligned with the rest of AI Center in the density/hierarchy pass. Still
// self-contained, not a redesign: a top safety-summary strip, a two-column
// Awaiting Approval / Prepare Follow-Up layout on wide screens (stacked on
// narrow ones), and a tinted result panel. Every mutation still goes
// through the same two Netlify functions, which re-validate everything
// server-side — nothing here executes action logic directly.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Loader2, ShieldCheck, Sparkles } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { getOrgId } from "@/lib/contacts-store";
import { useLeads } from "@/lib/leads-store";
import { AUTONOMY_LEVEL_LABELS } from "@/lib/agentic/types";
import { formatEstimatedCostUsd } from "@/lib/agentic/usage";

type ApprovalRow = {
  id: string;
  action_key: string;
  summary: string;
  risk_level: string;
  status: string;
  requested_at: string;
  expires_at: string | null;
  target_entity_type: string | null;
  target_entity_id: string | null;
};

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export function AgenticPreviewPanel() {
  const leads = useLeads();
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [loadingApprovals, setLoadingApprovals] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [pocResult, setPocResult] = useState<{ draft?: string; status?: string } | null>(null);

  async function loadApprovals() {
    setLoadingApprovals(true);
    const orgId = await getOrgId();
    if (!orgId) { setLoadingApprovals(false); return; }
    const { data } = await supabase
      .from("agent_approval_requests")
      .select("id, action_key, summary, risk_level, status, requested_at, expires_at, target_entity_type, target_entity_id")
      .eq("org_id", orgId)
      .eq("status", "pending")
      .order("requested_at", { ascending: false })
      .limit(20);
    setApprovals(data ?? []);
    setLoadingApprovals(false);
  }

  useEffect(() => { void loadApprovals(); }, []);

  async function handleDecision(id: string, decision: "approve" | "reject") {
    const approval = approvals.find((a) => a.id === id);
    setDecidingId(id);
    try {
      const res = await fetch("/.netlify/functions/agent-approve-action", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ approvalId: id, decision, rejectionReason: decision === "reject" ? "Rejected from AI Center." : undefined }),
      });
      const body = await res.json();
      if (!res.ok) { toast.error(body.error ?? "Could not process this approval."); return; }

      if (decision === "reject") {
        toast.success("Action rejected.");
      } else if (!body.success || !body.taskId) {
        // The Netlify function returns HTTP 200 even for a handler
        // failure so the UI can show a real error rather than a generic
        // network-failure message. A response is only ever treated as a
        // success here when the server proved a real task id — never
        // inferred from status text alone.
        toast.error(body.error ?? "Could not verify this action completed. Please try again.");
      } else if (approval?.action_key === "create_follow_up_task") {
        toast.success(body.status === "already_executed" ? "Task already created — no duplicate added" : "Follow-up task created");
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

  async function handleRunPoc() {
    if (!selectedLeadId) return;
    setRunning(true);
    setPocResult(null);
    try {
      const res = await fetch("/.netlify/functions/agent-execute", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ flow: "lead_follow_up_prep_poc", leadId: selectedLeadId }),
      });
      const body = await res.json();
      if (!res.ok) { toast.error(body.error ?? "Could not run the proof of concept."); return; }
      setPocResult({ draft: body.draft?.draft, status: body.status });
      toast.success(body.status === "awaiting_approval" ? "Prepared — follow-up task awaiting approval." : "Prepared.");
      await loadApprovals();
    } catch {
      toast.error("Network error — please try again.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* Top safety-summary strip (Part 13) */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-violet-200/70 bg-violet-50/70 px-3 py-2 dark:border-violet-900/40 dark:bg-violet-500/5">
        <ShieldCheck className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
        <span className="text-sm font-semibold text-foreground">Agentic Beta</span>
        <Badge variant="outline" className="h-5 rounded text-[10px]">Autonomy: {AUTONOMY_LEVEL_LABELS[2]}</Badge>
        <span className="text-xs text-muted-foreground">No messages are sent automatically.</span>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {/* Awaiting Approval */}
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <h3 className="text-sm font-semibold">Awaiting Approval</h3>
            <Badge variant="secondary" className="h-5 rounded px-1.5 text-[10px]">{approvals.length}</Badge>
          </div>
          {loadingApprovals ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : approvals.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No actions are currently awaiting approval.</p>
          ) : (
            <div className="space-y-2">
              {approvals.map((a) => {
                const targetLead = a.target_entity_type === "lead"
                  ? leads.find((l) => l.id === a.target_entity_id)
                  : undefined;
                return (
                  <div key={a.id} className="rounded-md border p-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        {targetLead && <div className="truncate text-sm font-semibold">{targetLead.name}</div>}
                        <div className="text-xs text-muted-foreground">{a.summary}</div>
                      </div>
                      <Badge variant={a.risk_level === "high" ? "destructive" : "outline"} className="h-5 shrink-0 rounded px-1.5 text-[10px] capitalize">{a.risk_level}</Badge>
                    </div>
                    <div className="mt-1.5 text-[11px] text-muted-foreground">
                      Requested {new Date(a.requested_at).toLocaleString()}
                      {a.expires_at && <> · Expires {new Date(a.expires_at).toLocaleString()}</>}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" disabled={decidingId === a.id} onClick={() => handleDecision(a.id, "approve")}>
                        {decidingId === a.id && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        Approve
                      </Button>
                      <Button size="sm" variant="outline" disabled={decidingId === a.id} onClick={() => handleDecision(a.id, "reject")}>
                        Reject
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Prepare Follow-Up proof of concept */}
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Prepare Follow-Up</h3>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            Architecture preview. This loads scoped lead data and prepares a deterministic draft — it does not call a real model yet. It never sends a message automatically. Approved follow-up actions create a real CRM task linked to the lead.
          </p>
          <div className="space-y-1.5">
            <Label className="text-xs">Lead</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={selectedLeadId} onValueChange={setSelectedLeadId}>
                <SelectTrigger className="h-8 w-64 text-xs"><SelectValue placeholder="Select a lead…" /></SelectTrigger>
                <SelectContent>
                  {leads.map((l) => <SelectItem key={l.id} value={l.id} className="text-xs">{l.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" disabled={!selectedLeadId || running} onClick={handleRunPoc}>
                {running && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Prepare follow-up
              </Button>
            </div>
          </div>
          {pocResult?.draft && (
            <div className="mt-3 rounded-md border border-sky-200/70 bg-sky-50/70 p-3 text-sm dark:border-sky-900/40 dark:bg-sky-500/5">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Deterministic draft — not sent, not real AI output</div>
              {pocResult.draft}
              <div className="mt-2 text-[11px] text-muted-foreground">
                Estimated cost: {formatEstimatedCostUsd(0)} (stub usage — no real model call was made)
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
