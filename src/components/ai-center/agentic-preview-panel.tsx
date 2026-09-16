// src/components/ai-center/agentic-preview-panel.tsx
//
// Phase 9.6 — Priority 15's "smallest useful UI foundation," visually
// aligned with the rest of AI Center in the density/hierarchy pass.
//
// AI-2B: the "Awaiting Approval" list that used to live here (a direct
// read of agent_approval_requests + approve/reject via
// agent-approve-action.ts) has been REMOVED from this panel and replaced
// by the new first-class "Approvals" tab (src/components/ai-center/
// ai-approvals-tab.tsx) — same data source, same canonical endpoint, but
// with send_sms-specific contextual display, a pending-count badge,
// status filters, and an execution-detail drawer. Keeping both would mean
// two competing approval UIs on the same page, which this task's own
// architecture explicitly rules out ("do not create a second approval
// system"). This panel now only holds the deterministic "Prepare
// Follow-Up" proof of concept, which is unrelated to approvals display.

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Loader2, ShieldCheck, Sparkles } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useLeads } from "@/lib/leads-store";
import { AUTONOMY_LEVEL_LABELS } from "@/lib/agentic/types";
import { formatEstimatedCostUsd } from "@/lib/agentic/usage";

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export function AgenticPreviewPanel() {
  const leads = useLeads();
  const [selectedLeadId, setSelectedLeadId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [pocResult, setPocResult] = useState<{ draft?: string; status?: string } | null>(null);

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
      toast.success(body.status === "awaiting_approval" ? "Prepared — follow-up task awaiting approval in the Approvals tab." : "Prepared.");
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

      {/* Prepare Follow-Up proof of concept */}
      <Card className="p-4">
        <div className="mb-2 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Prepare Follow-Up</h3>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Architecture preview. This loads scoped lead data and prepares a deterministic draft — it does not call a real model yet. It never sends a message automatically. Approved follow-up actions create a real CRM task linked to the lead — review them in AI Center's Approvals tab.
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
  );
}
