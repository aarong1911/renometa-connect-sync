// src/components/ai-center/ai-emergency-pause-control.tsx
//
// AI-1M (+ security completion pass). A UI-only control for
// organizations.ai_center_settings.emergencyPaused — the same jsonb key
// src/lib/agentic/policy-resolver.ts's resolveExecutionPolicy() reads to
// centrally gate mutating/outbound AI-executed actions. This component
// implements NO enforcement itself: it only reads/writes the flag.
// Enforcement remains solely in action-executor.ts/policy-resolver.ts.
//
// SECURITY: reads and writes go through netlify/functions/ai-emergency-
// pause.ts, NOT a direct browser `.update("organizations")`. Live RLS on
// `organizations` could not be inspected from this environment (no
// DATABASE_URL/psql, pg_policies isn't PostgREST-exposed), so there was no
// way to prove UPDATE is already owner/admin-restricted at the database
// layer. Rather than trust the frontend's owner/admin hiding (below) as
// the only gate on an org-wide AI kill switch, authorization is enforced
// server-side in that endpoint via resolveOrgAndAuthority() — a normal
// member calling it directly gets 403 regardless of what this component
// renders.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useOrgId } from "@/lib/org-id";
import { useCurrentUserRole } from "@/lib/permissions";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not authenticated.");
  return { Authorization: `Bearer ${token}` };
}

async function fetchEmergencyPaused(): Promise<boolean> {
  const headers = await authHeader();
  const res = await fetch("/.netlify/functions/ai-emergency-pause", { method: "GET", headers });
  if (!res.ok) throw new Error(`Failed to load Emergency Pause state (${res.status}).`);
  const body = await res.json();
  return body.emergencyPaused === true;
}

async function writeEmergencyPaused(nextValue: boolean): Promise<boolean> {
  const headers = await authHeader();
  const res = await fetch("/.netlify/functions/ai-emergency-pause", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ emergencyPaused: nextValue }),
  });
  if (!res.ok) throw new Error(`Failed to update Emergency Pause (${res.status}).`);
  const body = await res.json();
  return body.emergencyPaused === true;
}

export function AIEmergencyPauseControl() {
  const orgId = useOrgId();
  const role = useCurrentUserRole();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const isOwnerOrAdmin = role === "owner" || role === "admin";
  const queryKey = ["ai-center-emergency-pause", orgId] as const;
  const { data: paused, isLoading } = useQuery({
    queryKey,
    queryFn: fetchEmergencyPaused,
    enabled: !!orgId && isOwnerOrAdmin,
  });

  // Visible only to owner/admin — matches AI Center's existing route-level
  // access control (RoleGuard in __root.tsx). This is a UI convenience;
  // the server endpoint independently re-checks role and is the real gate
  // (see this file's header) — a normal member cannot bypass it by
  // calling the endpoint directly.
  if (!isOwnerOrAdmin) return null;
  if (!orgId) return null;

  const isPaused = paused === true;

  async function handleConfirm() {
    const nextValue = !isPaused;
    setSaving(true);
    try {
      const confirmedValue = await writeEmergencyPaused(nextValue);
      queryClient.setQueryData(queryKey, confirmedValue);
      toast.success(confirmedValue ? "AI actions paused." : "AI actions resumed.");
    } catch (err) {
      console.error("[ai-center] emergency pause update failed:", err);
      toast.error("Couldn't update Emergency Pause. Please try again.");
      // No optimistic update was made, so there's nothing to roll back —
      // the switch already reflects the last confirmed server state.
    } finally {
      setSaving(false);
      setConfirmOpen(false);
    }
  }

  if (isLoading) {
    return <Skeleton className="h-7 w-40 rounded-full" />;
  }

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={saving}
          className={
            isPaused
              ? "inline-flex h-7 items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-60"
              : "inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-60"
          }
        >
          {isPaused ? <AlertTriangle className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
          {isPaused ? "AI Actions Paused" : "Emergency Pause: OFF"}
          <Switch checked={isPaused} disabled={saving} className="ml-1 scale-75" />
        </button>
        <span className="max-w-[220px] text-right text-[10px] leading-snug text-muted-foreground">
          Emergency Pause blocks AI mutations and outbound actions. Read-only context and conversational responses remain available.
        </span>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !saving && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isPaused ? "Resume AI actions?" : "Pause all AI actions?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isPaused
                ? "AI Center mutations and future outbound actions will be allowed again according to normal permissions, approvals, and opt-out rules."
                : "AI Center will continue to read context and respond conversationally, but mutating actions and outbound actions will be blocked until the pause is turned off."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleConfirm();
              }}
              disabled={saving}
              className={isPaused ? "" : "bg-destructive text-destructive-foreground hover:bg-destructive/90"}
            >
              {saving ? "Saving…" : isPaused ? "Resume AI Actions" : "Pause AI Actions"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
