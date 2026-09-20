// src/components/ai-center/sms-reply-mode-settings.tsx
//
// AI-2D — Simple AI SMS Reply Mode. The entire user-facing setting: two
// options, one confirmation dialog for the riskier direction. Deliberately
// does NOT expose autonomy levels, trustedProposal, policy-engine
// terminology, idempotency, execution sources, confidence thresholds,
// per-agent toggles, or proactive-messaging controls — see this pass's
// own report for why (organization operators choose "may AI reply
// automatically to someone who just texted us," nothing more; the
// backend's own narrow enforcement — action-executor.ts's
// `autoApprovedSmsReply`, hardcoded to only ever affect `send_sms` replies
// from the verified reactive inbound-SMS path — is not this component's
// concern).
//
// Placed in the existing "Agentic (Beta)" tab alongside Emergency Pause's
// sibling settings cards (SMS Help Reply, etc.) — same reasoning as
// sms-compliance-settings.tsx: this tab is AI Center's existing catch-all
// for operational controls that don't fit any of the other tabs.
//
// Reads/writes go through netlify/functions/ai-sms-reply-mode-settings.ts
// (owner/admin-gated via resolveOrgAndAuthority()) — this component never
// writes ai_center_settings directly and never calls Twilio.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useOrgId } from "@/lib/org-id";
import { useCurrentUserRole } from "@/lib/permissions";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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

type SmsReplyMode = "review" | "automatic";

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not authenticated.");
  return { Authorization: `Bearer ${token}` };
}

async function fetchMode(): Promise<SmsReplyMode> {
  const headers = await authHeader();
  const res = await fetch("/.netlify/functions/ai-sms-reply-mode-settings", { method: "GET", headers });
  if (!res.ok) throw new Error(`Failed to load AI SMS reply mode (${res.status}).`);
  const body = await res.json();
  return body.mode === "automatic" ? "automatic" : "review";
}

async function saveMode(mode: SmsReplyMode): Promise<SmsReplyMode> {
  const headers = await authHeader();
  const res = await fetch("/.netlify/functions/ai-sms-reply-mode-settings", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Failed to save (${res.status}).`);
  return body.mode === "automatic" ? "automatic" : "review";
}

export function SmsReplyModeSettings() {
  const orgId = useOrgId();
  const role = useCurrentUserRole();
  const isOwnerOrAdmin = role === "owner" || role === "admin";
  const queryClient = useQueryClient();

  const queryKey = ["ai-sms-reply-mode", orgId] as const;
  const { data: savedMode, isLoading } = useQuery({
    queryKey,
    queryFn: fetchMode,
    enabled: !!orgId && isOwnerOrAdmin,
  });

  const [saving, setSaving] = useState(false);
  const [confirmAutomaticOpen, setConfirmAutomaticOpen] = useState(false);

  // Defensive only — this component is embedded in a tab already reached
  // via AI Center's owner/admin route guard; the server endpoint
  // independently re-checks role regardless of what this renders.
  if (!isOwnerOrAdmin) return null;
  if (!orgId) return null;

  if (isLoading) {
    return <Skeleton className="h-28 w-full rounded-md" />;
  }

  const mode: SmsReplyMode = savedMode ?? "review";

  async function applyMode(next: SmsReplyMode) {
    setSaving(true);
    try {
      const confirmed = await saveMode(next);
      queryClient.setQueryData(queryKey, confirmed);
      toast.success(confirmed === "automatic" ? "AI SMS replies will now send automatically." : "AI SMS replies now require review before sending.");
    } catch (err) {
      console.error("[ai-center] AI SMS reply mode save failed:", err);
      toast.error(err instanceof Error ? err.message : "Couldn't update AI SMS reply mode. Please try again.");
    } finally {
      setSaving(false);
      setConfirmAutomaticOpen(false);
    }
  }

  function handleRadioChange(next: string) {
    if (next === mode || saving) return;
    if (next === "automatic") {
      // Switching TO automatic is the riskier direction — confirm first.
      setConfirmAutomaticOpen(true);
      return;
    }
    // Switching back to review is immediate and easy, per this task's
    // explicit instruction — no confirmation.
    void applyMode("review");
  }

  return (
    <>
      <Card className="p-4">
        <h3 className="mb-1 text-sm font-semibold">AI SMS Replies</h3>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Controls how AI-generated replies to inbound text conversations are sent.
        </p>

        <RadioGroup value={mode} onValueChange={handleRadioChange} className="gap-3">
          <label
            htmlFor="sms-reply-mode-review"
            className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-3 ${mode === "review" ? "border-primary/40 bg-primary-soft" : "border-border"} ${saving ? "cursor-not-allowed opacity-60" : ""}`}
          >
            <RadioGroupItem id="sms-reply-mode-review" value="review" disabled={saving} className="mt-0.5" />
            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <UserCheck className="h-3.5 w-3.5" />
                Review before sending
              </div>
              <p className="text-xs text-muted-foreground">AI drafts replies, but you approve them before they are sent.</p>
            </div>
          </label>

          <label
            htmlFor="sms-reply-mode-automatic"
            className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-3 ${mode === "automatic" ? "border-primary/40 bg-primary-soft" : "border-border"} ${saving ? "cursor-not-allowed opacity-60" : ""}`}
          >
            <RadioGroupItem id="sms-reply-mode-automatic" value="automatic" disabled={saving} className="mt-0.5" />
            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Bot className="h-3.5 w-3.5" />
                Send automatically
              </div>
              <p className="text-xs text-muted-foreground">AI replies automatically to inbound SMS conversations when messaging is allowed.</p>
            </div>
          </label>
        </RadioGroup>
      </Card>

      <AlertDialog open={confirmAutomaticOpen} onOpenChange={(open) => !saving && setConfirmAutomaticOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable automatic AI SMS replies?</AlertDialogTitle>
            <AlertDialogDescription>
              AI-generated replies to inbound SMS conversations may be sent without human review. Consent rules and Emergency Pause still apply.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void applyMode("automatic");
              }}
              disabled={saving}
            >
              {saving ? "Enabling…" : "Enable Automatic Replies"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
