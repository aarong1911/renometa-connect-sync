// src/components/ai-center/knowledge-clarification-card.tsx
//
// The owner-facing "Knowledge Clarification" card shown in AI Center ->
// Approvals. Deliberately NOT worded as an agent action approval: the owner
// is not approving a risky action, they are answering a customer's question
// once ("How should the AI answer?"), and optionally teaching the AI so the
// next customer gets the answer instantly.
//
// This component never writes a table or calls a provider directly — it
// posts to netlify/functions/ai-clarification-resolve.ts (owner/admin-gated,
// org + role resolved server-side), which sends the answer through the
// trusted outbound path and optionally saves Business Knowledge.

import { useState } from "react";
import { toast } from "sonner";
import { BookOpenCheck, Loader2, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/lib/supabase";
import { getCatalogCategory, MAX_ANSWER_LENGTH } from "@/lib/agentic/business-knowledge-catalog";
import type { ClarificationRow, ClarificationStatus } from "@/lib/ai-clarifications-list";
import type { ContactSummary, InboundMessage } from "@/lib/ai-approvals-list";

const CUSTOM = "__custom__";

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "—";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "•••-•••-••••";
  return `•••-•••-${digits.slice(-4)}`;
}

function statusLabel(status: ClarificationStatus): string {
  switch (status) {
    case "pending": return "Needs answer";
    case "sending": return "Sending…";
    case "send_failed": return "Not delivered";
    case "resolved": return "Answered";
    case "dismissed": return "Dismissed";
  }
}

function statusVariant(status: ClarificationStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "resolved") return "default";
  if (status === "send_failed") return "destructive";
  if (status === "dismissed") return "secondary";
  return "outline";
}

export function KnowledgeClarificationCard({
  clarification,
  contact,
  inbound,
  onChanged,
}: {
  clarification: ClarificationRow;
  contact?: ContactSummary;
  inbound?: InboundMessage;
  /** Called after any server-confirmed change so the list/badge refetch from the database. */
  onChanged: () => void;
}) {
  const c = clarification;
  const options = Array.isArray(c.suggested_options) ? c.suggested_options : [];
  const catalog = getCatalogCategory(c.knowledge_key);
  const isActionable = c.status === "pending" || c.status === "send_failed";

  // A retry after a failed send re-opens with the owner's earlier answer.
  const priorOption = c.answer ? options.find((o) => o.answer === c.answer) : undefined;
  const [selected, setSelected] = useState<string>(
    priorOption ? priorOption.id : c.answer || options.length === 0 ? CUSTOM : "",
  );
  const [custom, setCustom] = useState<string>(priorOption ? "" : c.answer ?? "");
  const [save, setSave] = useState<boolean>(c.save_to_knowledge || c.status === "pending");
  const [busy, setBusy] = useState<"send" | "dismiss" | null>(null);

  const chosenOption = options.find((o) => o.id === selected);
  const answer = (selected === CUSTOM ? custom : chosenOption?.answer ?? "").trim();
  const canSend = isActionable && !busy && answer.length > 0 && answer.length <= MAX_ANSWER_LENGTH;
  const customerName = contact?.name ?? "The customer";

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/.netlify/functions/ai-clarification-resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ clarificationId: c.id, ...body }),
    });
    return { res, data: await res.json().catch(() => ({})) };
  }

  async function handleSend() {
    setBusy("send");
    try {
      const { res, data } = await post({ action: "answer", answer, optionId: chosenOption?.id, saveToKnowledge: save });
      if (!res.ok) {
        toast.error(data.error ?? "Could not send this answer.");
      } else if (data.success === false) {
        // Delivery failed (e.g. opted out, messaging paused, provider error). The answer is kept.
        toast.error(
          /pause|consent|eligib|policy/i.test(data.error ?? "")
            ? "The answer couldn't be sent because current messaging policy doesn't allow it."
            : (data.error ?? "The answer couldn't be delivered."),
        );
        if (save && data.knowledge === "failed") toast.error("It also couldn't be saved to Business Knowledge.");
      } else {
        toast.success(data.status === "already_resolved" ? "Already answered — nothing was sent again." : "Answer sent to the customer.");
        if (save && data.knowledge === "saved") toast.success("Saved to Business Knowledge.");
        if (save && data.knowledge === "failed") toast.error("Sent, but it couldn't be saved to Business Knowledge. Add it under Business Knowledge.");
      }
      onChanged();
    } catch {
      toast.error("Network error — please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function handleDismiss() {
    setBusy("dismiss");
    try {
      const { res, data } = await post({ action: "dismiss" });
      if (!res.ok) toast.error(data.error ?? "Could not dismiss this question.");
      else toast.success("Dismissed. Nothing was sent to the customer.");
      onChanged();
    } catch {
      toast.error("Network error — please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="min-w-0 border-amber-200/70 p-4 dark:border-amber-900/40">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <BookOpenCheck className="h-4 w-4 shrink-0 text-amber-600" />
          <h3 className="truncate text-sm font-semibold">Knowledge Clarification</h3>
        </div>
        <Badge variant={statusVariant(c.status)} className="h-5 shrink-0 rounded px-1.5 text-[10px]">
          {statusLabel(c.status)}
        </Badge>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          <User className="h-3 w-3" />
          <span className="font-medium text-foreground">{contact?.name ?? "Unknown contact"}</span>
          <span>·</span>
          <span>{maskPhone(contact?.phone)}</span>
          <span>·</span>
          <span className="uppercase">{c.channel}</span>
        </div>

        <div className="rounded-md border bg-secondary/40 p-2 text-xs">
          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{customerName} asked</div>
          <span className="break-words">"{inbound?.body ?? c.question}"</span>
        </div>

        {catalog && <p className="text-[11px] text-muted-foreground">Topic: {catalog.label}</p>}

        {c.status === "send_failed" && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            Your answer was saved but couldn't be delivered{c.send_error ? `: ${c.send_error}` : "."} You can try again.
          </div>
        )}

        {isActionable ? (
          <div className="space-y-2 pt-1">
            <div className="text-xs font-medium">How should the AI answer?</div>
            <RadioGroup value={selected} onValueChange={setSelected} className="gap-1.5">
              {options.map((o) => (
                <Label key={o.id} htmlFor={`${c.id}-${o.id}`} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs font-normal leading-snug has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-primary-soft">
                  <RadioGroupItem id={`${c.id}-${o.id}`} value={o.id} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 break-words">{o.label}</span>
                </Label>
              ))}
              <Label htmlFor={`${c.id}-custom`} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs font-normal leading-snug has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-primary-soft">
                <RadioGroupItem id={`${c.id}-custom`} value={CUSTOM} className="mt-0.5 shrink-0" />
                <span>{options.length > 0 ? "Write custom answer" : "Write your answer"}</span>
              </Label>
            </RadioGroup>

            {selected === CUSTOM && (
              <Textarea
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                maxLength={MAX_ANSWER_LENGTH}
                rows={3}
                placeholder={catalog?.placeholder ?? "Type the answer the customer should receive."}
                className="text-xs"
                aria-label="Custom answer"
              />
            )}

            {answer && (
              <div className="rounded-md border border-violet-200/70 bg-violet-50/70 p-2 text-xs dark:border-violet-900/40 dark:bg-violet-500/5">
                <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Will be sent as</div>
                <span className="break-words">"{answer}"</span>
              </div>
            )}

            <Label htmlFor={`${c.id}-save`} className="flex cursor-pointer items-start gap-2 text-xs font-normal leading-snug">
              <Checkbox id={`${c.id}-save`} checked={save} onCheckedChange={(v) => setSave(v === true)} className="mt-0.5" />
              <span>Save this answer to Business Knowledge so the AI can answer this instantly next time</span>
            </Label>

            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" disabled={!canSend} onClick={() => void handleSend()}>
                {busy === "send" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {c.status === "send_failed" ? "Retry Send" : "Send Answer"}
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void handleDismiss()}>
                {busy === "dismiss" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Dismiss
              </Button>
            </div>
          </div>
        ) : (
          c.answer && (
            <div className="rounded-md border border-violet-200/70 bg-violet-50/70 p-2 text-xs dark:border-violet-900/40 dark:bg-violet-500/5">
              <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {c.status === "resolved" ? "Answer sent" : "Answer"}
              </div>
              <span className="break-words">"{c.answer}"</span>
              {c.status === "resolved" && c.save_to_knowledge && (
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {c.knowledge_saved_at ? "Saved to Business Knowledge." : "Not saved to Business Knowledge yet."}
                </div>
              )}
            </div>
          )
        )}

        {c.status === "sending" && (
          <p className="text-[11px] text-muted-foreground">This answer is being sent. Refresh in a moment.</p>
        )}
      </div>

      <div className="mt-2 text-[11px] text-muted-foreground">Asked {new Date(c.created_at).toLocaleString()}</div>
    </Card>
  );
}
