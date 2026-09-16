// src/components/ai-center/sms-compliance-settings.tsx
//
// AI-2C.1. Smallest appropriate settings UI for the deterministic SMS
// HELP reply (organizations.ai_center_settings.smsCompliance.helpReply).
// Placed inside the existing "Agentic (Beta)" tab (agentic-preview-
// panel.tsx) rather than a new top-level tab — that tab is already AI
// Center's catch-all for operational/compliance controls that don't fit
// Autonomous Agents/AI Tools/Voice/Approvals/Test Console.
//
// Reads/writes go through netlify/functions/ai-sms-compliance-settings.ts
// (owner/admin-gated server-side via resolveOrgAndAuthority()) — this
// component NEVER writes organizations.ai_center_settings directly, and
// never calls Twilio. It only edits configuration; the AI-2C.1 HELP
// sender (netlify/functions/lib/sms-compliance.ts) is what actually acts
// on it, entirely outside this component.
//
// AI-2C.1 completion pass: added the "Disable Reply" affordance — the
// endpoint's POST now accepts `{ helpReply: string | null }`, where
// `null` explicitly removes the configured reply rather than requiring an
// (invalid) empty-string save. `null` is used throughout this component
// as "no reply configured," distinct from `draft === null`, which means
// "no unsaved edit" (the textarea mirrors the saved value).

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageCircleQuestion } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useOrgId } from "@/lib/org-id";
import { useCurrentUserRole } from "@/lib/permissions";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
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

const HELP_REPLY_MAX_LENGTH = 1600;

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not authenticated.");
  return { Authorization: `Bearer ${token}` };
}

/** null = no HELP reply currently configured. */
async function fetchHelpReply(): Promise<string | null> {
  const headers = await authHeader();
  const res = await fetch("/.netlify/functions/ai-sms-compliance-settings", { method: "GET", headers });
  if (!res.ok) throw new Error(`Failed to load SMS compliance settings (${res.status}).`);
  const body = await res.json();
  return typeof body.helpReply === "string" ? body.helpReply : null;
}

/** Pass null to explicitly disable the HELP reply. */
async function saveHelpReply(helpReply: string | null): Promise<string | null> {
  const headers = await authHeader();
  const res = await fetch("/.netlify/functions/ai-sms-compliance-settings", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ helpReply }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Failed to save (${res.status}).`);
  return typeof body.helpReply === "string" ? body.helpReply : null;
}

export function SmsComplianceSettings() {
  const orgId = useOrgId();
  const role = useCurrentUserRole();
  const isOwnerOrAdmin = role === "owner" || role === "admin";
  const queryClient = useQueryClient();

  const queryKey = ["ai-sms-compliance-help-reply", orgId] as const;
  const { data: savedHelpReply, isLoading } = useQuery({
    queryKey,
    queryFn: fetchHelpReply,
    enabled: !!orgId && isOwnerOrAdmin,
  });

  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDisableOpen, setConfirmDisableOpen] = useState(false);

  // Defensive only — this component is embedded in a tab already reached
  // via AI Center's owner/admin route guard; the server endpoint
  // independently re-checks role regardless of what this renders.
  if (!isOwnerOrAdmin) return null;
  if (!orgId) return null;

  if (isLoading) {
    return <Skeleton className="h-32 w-full rounded-md" />;
  }

  const isConfigured = savedHelpReply !== null && savedHelpReply !== undefined;
  const value = draft ?? savedHelpReply ?? "";
  const isDirty = draft !== null && draft !== (savedHelpReply ?? "");

  async function handleSave() {
    if (draft === null || draft.trim().length === 0) return;
    setSaving(true);
    try {
      const confirmed = await saveHelpReply(draft);
      queryClient.setQueryData(queryKey, confirmed);
      setDraft(null);
      toast.success("SMS Help reply saved.");
    } catch (err) {
      console.error("[ai-center] SMS compliance settings save failed:", err);
      toast.error(err instanceof Error ? err.message : "Couldn't save the HELP reply. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmDisable() {
    setSaving(true);
    try {
      await saveHelpReply(null);
      queryClient.setQueryData(queryKey, null);
      setDraft(null);
      toast.success("SMS HELP reply disabled.");
    } catch (err) {
      console.error("[ai-center] SMS compliance settings disable failed:", err);
      toast.error(err instanceof Error ? err.message : "Couldn't disable the HELP reply. Please try again.");
    } finally {
      setSaving(false);
      setConfirmDisableOpen(false);
    }
  }

  return (
    <>
      <Card className="p-4">
        <div className="mb-2 flex items-center gap-2">
          <MessageCircleQuestion className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">SMS Help Reply</h3>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Sent automatically when a contact texts HELP or INFO. This response is deterministic and does not use AI.
        </p>

        {!isConfigured && (
          <div className="mb-2 rounded-md border border-dashed px-2.5 py-1.5 text-[11px] text-muted-foreground">
            No HELP reply is currently configured — contacts who text HELP or INFO will not receive an automatic response. Their messages are still excluded from AI.
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="sms-help-reply" className="text-xs">Reply text</Label>
          <Textarea
            id="sms-help-reply"
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            maxLength={HELP_REPLY_MAX_LENGTH}
            rows={3}
            placeholder="e.g. This number receives automated updates from Acme Renovations. Reply STOP to unsubscribe."
            className="text-sm"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {value.length}/{HELP_REPLY_MAX_LENGTH} · Plain text only
            </span>
            <div className="flex gap-2">
              {isConfigured && (
                <Button size="sm" variant="outline" disabled={saving} onClick={() => setConfirmDisableOpen(true)}>
                  Disable Reply
                </Button>
              )}
              <Button size="sm" disabled={!isDirty || saving || value.trim().length === 0} onClick={handleSave}>
                {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {isConfigured ? "Save Changes" : "Save Reply"}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <AlertDialog open={confirmDisableOpen} onOpenChange={(open) => !saving && setConfirmDisableOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable SMS HELP reply?</AlertDialogTitle>
            <AlertDialogDescription>
              Contacts who text HELP or INFO will no longer receive an automatic response. Their messages will still be treated as compliance commands and will not be sent to AI.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleConfirmDisable();
              }}
              disabled={saving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {saving ? "Disabling…" : "Disable Reply"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
