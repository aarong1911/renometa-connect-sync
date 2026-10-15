// src/components/ai-center/business-knowledge-settings.tsx
//
// AI Center -> Business Knowledge. The owner teaches the AI how THIS
// business works; every ACTIVE entry here is injected into the trusted
// context of every AI agent (netlify/functions/lib/ai/context-builder.ts)
// as an authoritative company fact, and a customer question these entries
// answer never reaches the owner as a Knowledge Clarification.
//
// Reads: direct Supabase SELECT (tenant-scoped RLS). Writes: ONLY via
// netlify/functions/business-knowledge.ts (owner/admin-gated; org + role
// resolved server-side) — this component never writes the table and never
// sends an org id.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
import { supabase } from "@/lib/supabase";
import { useOrgId } from "@/lib/org-id";
import { queryKeys } from "@/lib/query-keys";
import {
  BUSINESS_KNOWLEDGE_CATALOG,
  CUSTOM_CATEGORY,
  MAX_ANSWER_LENGTH,
  MAX_QUESTION_LENGTH,
  type KnowledgeCategoryDefinition,
} from "@/lib/agentic/business-knowledge-catalog";

type EntryRow = {
  key: string;
  category: string;
  question: string;
  answer: string;
  status: "active" | "inactive";
  source: string;
  metadata: { optionId?: string } | null;
  updated_at: string;
};

const CUSTOM_OPTION = "__custom__";

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not authenticated.");
  return { Authorization: `Bearer ${token}` };
}

async function writeKnowledge(body: Record<string, unknown>): Promise<void> {
  const res = await fetch("/.netlify/functions/business-knowledge", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Could not save.");
  }
}

function sourceLabel(source: string): string {
  if (source === "owner_clarification") return "From a customer question";
  if (source === "system_seeded") return "Preset";
  return "You configured";
}

// ── A catalog (predefined) entry ────────────────────────────────────────

function CatalogCard({ def, entry, onChanged }: { def: KnowledgeCategoryDefinition; entry?: EntryRow; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string>(CUSTOM_OPTION);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);

  function startEdit() {
    const matched = def.options.find((o) => o.answer === entry?.answer);
    setSelected(matched ? matched.id : def.options.length === 0 || entry ? CUSTOM_OPTION : def.options[0].id);
    setCustom(matched ? "" : entry?.answer ?? "");
    setEditing(true);
  }

  const chosen = def.options.find((o) => o.id === selected);
  const answer = (selected === CUSTOM_OPTION ? custom : chosen?.answer ?? "").trim();

  async function save() {
    setBusy(true);
    try {
      await writeKnowledge({ action: "upsert", key: def.key, answer, optionId: chosen?.id });
      toast.success(`${def.label} saved.`);
      setEditing(false);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(next: boolean) {
    try {
      await writeKnowledge({ action: "set_status", key: def.key, status: next ? "active" : "inactive" });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update.");
    }
  }

  return (
    <Card className="min-w-0 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="text-sm font-semibold">{def.label}</h4>
            {entry ? (
              <Badge variant={entry.status === "active" ? "default" : "secondary"} className="h-4.5 rounded px-1.5 text-[10px]">
                {entry.status === "active" ? "Active" : "Disabled"}
              </Badge>
            ) : (
              <Badge variant="outline" className="h-4.5 rounded px-1.5 text-[10px]">Not set</Badge>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{def.question}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {entry && (
            <Switch checked={entry.status === "active"} onCheckedChange={(v) => void toggle(v)} aria-label={`${def.label} enabled`} />
          )}
          {!editing && (
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={startEdit}>
              <Pencil className="mr-1 h-3 w-3" />
              {entry ? "Edit" : "Set"}
            </Button>
          )}
        </div>
      </div>

      {entry && !editing && (
        <div className="mt-2 rounded-md border bg-secondary/40 p-2 text-xs">
          <span className="break-words">{entry.answer}</span>
          <div className="mt-1 text-[10px] text-muted-foreground">{sourceLabel(entry.source)}</div>
        </div>
      )}

      {editing && (
        <div className="mt-3 space-y-2">
          {def.options.length > 0 && (
            <RadioGroup value={selected} onValueChange={setSelected} className="gap-1.5">
              {def.options.map((o) => (
                <Label key={o.id} htmlFor={`${def.key}-${o.id}`} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs font-normal leading-snug has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-primary-soft">
                  <RadioGroupItem id={`${def.key}-${o.id}`} value={o.id} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 break-words">{o.label}</span>
                </Label>
              ))}
              <Label htmlFor={`${def.key}-custom`} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs font-normal leading-snug has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-primary-soft">
                <RadioGroupItem id={`${def.key}-custom`} value={CUSTOM_OPTION} className="mt-0.5 shrink-0" />
                <span>Custom answer</span>
              </Label>
            </RadioGroup>
          )}
          {selected === CUSTOM_OPTION && (
            <Textarea
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              maxLength={MAX_ANSWER_LENGTH}
              rows={3}
              placeholder={def.placeholder}
              className="text-xs"
              aria-label={`${def.label} answer`}
            />
          )}
          {answer && def.options.length > 0 && selected !== CUSTOM_OPTION && (
            <p className="text-[11px] text-muted-foreground">The AI will say: "{answer}"</p>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !answer} onClick={() => void save()}>
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ── A custom entry ──────────────────────────────────────────────────────

function CustomCard({ entry, onChanged }: { entry: EntryRow; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState(entry.answer);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await writeKnowledge({ action: "upsert", key: entry.key, question: entry.question, answer });
      toast.success("Entry saved.");
      setEditing(false);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(next: boolean) {
    try {
      await writeKnowledge({ action: "set_status", key: entry.key, status: next ? "active" : "inactive" });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update.");
    }
  }

  async function remove() {
    try {
      await writeKnowledge({ action: "delete", key: entry.key });
      toast.success("Entry deleted.");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete.");
    } finally {
      setConfirmDelete(false);
    }
  }

  return (
    <Card className="min-w-0 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="break-words text-sm font-semibold">{entry.question}</h4>
          <div className="mt-0.5 text-[10px] text-muted-foreground">{sourceLabel(entry.source)}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Switch checked={entry.status === "active"} onCheckedChange={(v) => void toggle(v)} aria-label="Entry enabled" />
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditing((v) => !v)} aria-label="Edit entry"><Pencil className="h-3.5 w-3.5" /></Button>
          <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => setConfirmDelete(true)} aria-label="Delete entry"><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={MAX_ANSWER_LENGTH} rows={3} className="text-xs" aria-label="Answer" />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !answer.trim()} onClick={() => void save()}>
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { setAnswer(entry.answer); setEditing(false); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 rounded-md border bg-secondary/40 p-2 text-xs">
          <span className="break-words">{entry.answer}</span>
        </div>
      )}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              The AI will no longer know this. If a customer asks again, you'll be asked to answer it. You can disable an entry instead to keep it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function AddCustomForm({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = question.trim().length >= 8 && answer.trim().length > 0;

  async function add() {
    setBusy(true);
    try {
      await writeKnowledge({ action: "upsert", question: question.trim(), answer: answer.trim() });
      toast.success("Entry added.");
      setQuestion("");
      setAnswer("");
      setOpen(false);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" className="h-9 text-xs" onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Add custom entry
      </Button>
    );
  }
  return (
    <Card className="min-w-0 space-y-2 p-3">
      <div className="space-y-1">
        <Label htmlFor="bk-question" className="text-xs">Question customers ask</Label>
        <Input id="bk-question" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={MAX_QUESTION_LENGTH} placeholder="e.g. Do you work on historic homes?" className="text-xs" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="bk-answer" className="text-xs">Your answer</Label>
        <Textarea id="bk-answer" value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={MAX_ANSWER_LENGTH} rows={3} placeholder="What should the AI tell them?" className="text-xs" />
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !valid} onClick={() => void add()}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Add entry
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </Card>
  );
}

export function BusinessKnowledgeSettings() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: orgId ? queryKeys.businessKnowledge.all(orgId) : ["businessKnowledge", "none"],
    enabled: !!orgId,
    staleTime: 15_000,
    queryFn: async (): Promise<EntryRow[]> => {
      const { data, error } = await supabase
        .from("business_knowledge_entries")
        .select("key, category, question, answer, status, source, metadata, updated_at")
        .eq("org_id", orgId as string)
        .order("key", { ascending: true });
      if (error) throw error;
      return (data ?? []) as EntryRow[];
    },
  });

  const refresh = () => {
    if (orgId) void queryClient.invalidateQueries({ queryKey: queryKeys.businessKnowledge.all(orgId) });
  };

  const entries = query.data ?? [];
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const customEntries = entries.filter((e) => e.category === CUSTOM_CATEGORY);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Business Knowledge</h2>
          <p className="text-xs text-muted-foreground">
            Teach your AI agents how your business works so they can answer customer questions accurately. The AI only states company
            facts that are written here — anything missing is asked of you once, in Approvals.
          </p>
        </div>
      </div>

      {query.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : query.isError ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">Couldn't load Business Knowledge. Please refresh.</Card>
      ) : (
        <>
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Common questions</h3>
            <div className="grid grid-cols-1 items-start gap-2 lg:grid-cols-2">
              {BUSINESS_KNOWLEDGE_CATALOG.map((def) => (
                <CatalogCard key={def.key} def={def} entry={byKey.get(def.key)} onChanged={refresh} />
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Custom entries</h3>
            {customEntries.length === 0 && (
              <p className="text-xs text-muted-foreground">Anything else customers ask — add your own question and answer.</p>
            )}
            <div className="grid grid-cols-1 items-start gap-2 lg:grid-cols-2">
              {customEntries.map((e) => (
                <CustomCard key={e.key} entry={e} onChanged={refresh} />
              ))}
            </div>
            <AddCustomForm onChanged={refresh} />
          </section>
        </>
      )}
    </div>
  );
}
