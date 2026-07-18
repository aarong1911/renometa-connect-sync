// src/components/automation/ai-tools-tab.tsx
import { useState, useMemo, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Search,
  Play,
  Copy,
  FileDown,
  Loader2,
  FileText,
  TrendingUp,
  Brain,
  MessageSquare,
  ListChecks,
  BarChart3,
  Bot,
  Image as ImageIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import type { LucideIcon } from "lucide-react";
import {
  useAICenterTools,
  runTool,
  type ToolDefinition,
  type ToolFieldDef,
} from "@/lib/ai-center-store";

// ── Icon mapping ──────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, LucideIcon> = {
  "file-text": FileText,
  brain: Brain,
  "message-square": MessageSquare,
  "list-checks": ListChecks,
  "bar-chart-3": BarChart3,
  "trending-up": TrendingUp,
};

function resolveIcon(name: string): LucideIcon {
  return ICON_MAP[name] ?? Bot;
}

// ── Category styles ───────────────────────────────────────────────────────────

type ToolCategory = "sales" | "crm" | "operations";

const CATEGORY_LABEL: Record<ToolCategory, string> = {
  sales: "Sales",
  crm: "CRM Intelligence",
  operations: "Operations & Insights",
};

const CATEGORY_COLOR: Record<ToolCategory, string> = {
  sales: "bg-primary/15 text-primary border-primary/30",
  crm: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  operations: "bg-success/15 text-success border-success/30",
};

const CATEGORY_ACCENT: Record<ToolCategory, string> = {
  sales: "ring-primary/20",
  crm: "ring-purple-500/20",
  operations: "ring-success/20",
};

type CategoryFilter = "all" | ToolCategory;

// ── Create Ad Campaign — dedicated call, bypasses run-tool.mjs entirely ───────
// This tool creates a real PAUSED campaign via the Meta Marketing API rather
// than generating text with Claude, so it needs its own request shape and
// its own Netlify function (meta-create-ad-campaign.ts) instead of the
// generic Claude-prompt pipeline every other AI Tool goes through.

async function runCreateAdCampaign(
  values: Record<string, string>,
): Promise<{ sections: Record<string, string>; error?: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { sections: {}, error: "Not authenticated" };

  const dailyBudgetDollars = Number(values.daily_budget);
  if (!values.name?.trim()) return { sections: {}, error: "Campaign name is required" };
  if (!Number.isFinite(dailyBudgetDollars) || dailyBudgetDollars < 1) {
    return { sections: {}, error: "Daily budget must be at least $1" };
  }

  const res = await fetch("/.netlify/functions/meta-create-ad-campaign", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({
      name: values.name.trim(),
      dailyBudgetCents: Math.round(dailyBudgetDollars * 100),
      objective: values.objective || "OUTCOME_TRAFFIC",
      imageUrl: values.image || undefined,
      headline: values.headline || undefined,
      primaryText: values.primary_text || undefined,
      description: values.description || undefined,
      cta: values.cta || undefined,
      destinationUrl: values.destination_url || undefined,
    }),
  });
  const data = await res.json();
  if (!res.ok) return { sections: {}, error: data.error ?? "Campaign creation failed" };

  return {
    sections: {
      Result: data.adId
        ? "Campaign, ad set, and ad created successfully in PAUSED status — no spend will occur until you activate it."
        : "Campaign created successfully in PAUSED status — no spend will occur until you activate it.",
      "Campaign ID": data.campaignId,
      "Ad Set ID": data.adSetId ?? "Not created (campaign-only)",
      "Ad ID": data.adId ?? (data.adCreativeError ? `Not created — ${data.adCreativeError}` : "Not created (no creative provided)"),
      "Ad Account": data.adAccountName ?? "—",
      "Next step": "Open Meta Ads Manager to add creative and activate when ready.",
    },
  };
}

// ── Tab ───────────────────────────────────────────────────────────────────────

export function AIToolsTab() {
  const { tools, loading } = useAICenterTools();
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [selectedTool, setSelectedTool] = useState<ToolDefinition | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tools.filter((t) => {
      if (categoryFilter !== "all" && t.category !== categoryFilter) return false;
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
    });
  }, [tools, query, categoryFilter]);

  const grouped = useMemo(() => {
    const map = new Map<ToolCategory, ToolDefinition[]>();
    filtered.forEach((t) => {
      const cat = t.category as ToolCategory;
      const arr = map.get(cat) ?? [];
      arr.push(t);
      map.set(cat, arr);
    });
    return map;
  }, [filtered]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-55 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools…"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Tabs value={categoryFilter} onValueChange={(v) => setCategoryFilter(v as CategoryFilter)}>
          <TabsList className="h-8">
            <TabsTrigger value="all" className="h-7 px-2.5 text-xs">All</TabsTrigger>
            <TabsTrigger value="sales" className="h-7 px-2.5 text-xs">Sales</TabsTrigger>
            <TabsTrigger value="crm" className="h-7 px-2.5 text-xs">CRM Intelligence</TabsTrigger>
            <TabsTrigger value="operations" className="h-7 px-2.5 text-xs">Operations & Insights</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-5">
          {(["sales", "crm", "operations"] as ToolCategory[]).map((cat) => {
            const items = grouped.get(cat);
            if (!items || items.length === 0) return null;
            return (
              <section key={cat}>
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {CATEGORY_LABEL[cat]}
                  </h2>
                  <span className="text-[10px] text-muted-foreground">· {items.length}</span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {items.map((tool) => (
                    <ToolCard key={tool.id} tool={tool} onOpen={() => setSelectedTool(tool)} />
                  ))}
                </div>
              </section>
            );
          })}
          {filtered.length === 0 && (
            <Card className="p-8 text-center text-xs text-muted-foreground">
              No tools match your filters.
            </Card>
          )}
        </div>
      )}

      <ToolDrawer tool={selectedTool} onOpenChange={(open) => !open && setSelectedTool(null)} />
    </div>
  );
}

// ── ToolCard ──────────────────────────────────────────────────────────────────

function ToolCard({ tool, onOpen }: { tool: ToolDefinition; onOpen: () => void }) {
  const Icon = resolveIcon(tool.icon);
  const cat = tool.category as ToolCategory;
  return (
    <Card
      className={cn(
        "group cursor-pointer p-3.5 transition-all hover:shadow-md ring-1 ring-inset",
        CATEGORY_ACCENT[cat] ?? "ring-border/20",
      )}
      onClick={onOpen}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-sm font-semibold">{tool.name}</h3>
          </div>
          <div className="mt-1">
            <Badge
              variant="secondary"
              className={cn("h-4 rounded border px-1.5 text-[9px]", CATEGORY_COLOR[cat] ?? "")}
            >
              {CATEGORY_LABEL[cat] ?? tool.category}
            </Badge>
          </div>
          <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
            {tool.description}
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end border-t border-border pt-2.5">
        <Button size="sm" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
          <Play className="h-3 w-3" />
          Run
        </Button>
      </div>
    </Card>
  );
}

// ── ToolDrawer ────────────────────────────────────────────────────────────────

function ToolDrawer({ tool, onOpenChange }: { tool: ToolDefinition | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={!!tool} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {tool && <ToolDrawerContent key={tool.id} tool={tool} />}
      </SheetContent>
    </Sheet>
  );
}

function ToolDrawerContent({ tool }: { tool: ToolDefinition }) {
  const Icon = resolveIcon(tool.icon);
  const cat = tool.category as ToolCategory;
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<Record<string, string> | null>(null);

  const setValue = (key: string, val: string) =>
    setValues((prev) => ({ ...prev, [key]: val }));

  const handleRun = async () => {
    setRunning(true);
    setOutput(null);
    try {
      if (tool.name === "Create Ad Campaign") {
        const result = await runCreateAdCampaign(values);
        if (result.error) {
          toast.error(result.error);
          return;
        }
        setOutput(result.sections);
        return;
      }

      const result = await runTool(tool.id, values);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setOutput(result.sections);
    } catch (err: any) {
      toast.error("Failed to run AI tool. Please try again.");
    } finally {
      setRunning(false);
    }
  };

  const handleCopy = () => {
    if (!output) return;
    const text = Object.entries(output)
      .map(([k, v]) => `## ${k}\n${v}`)
      .join("\n\n");
    navigator.clipboard.writeText(text);
    toast.success("Output copied to clipboard");
  };

  const handleExport = () => {
    if (!output) return;
    const w = window.open("", "_blank");
    if (!w) { toast.error("Allow popups to download PDF"); return; }

    const ts = new Date().toLocaleDateString("en-US", {
      month: "long", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
    const catLabel = CATEGORY_LABEL[cat] ?? tool.category;

    const sectionsHtml = Object.entries(output).map(([heading, body]) => `
      <div class="section">
        <div class="section-title">${heading}</div>
        <div class="section-body">${body.replace(/\n/g, "<br>")}</div>
      </div>`).join("");

    w.document.write(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${tool.name}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#111;padding:48px;max-width:800px;margin:0 auto}
.hdr{border-bottom:2px solid #e5e7eb;padding-bottom:20px;margin-bottom:24px}
.tool-name{font-size:22px;font-weight:800;color:#111;margin-bottom:4px}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;background:#ede9fe;color:#6d28d9;border:1px solid #c4b5fd}
.meta{font-size:11px;color:#9ca3af;margin-top:8px}
.desc{font-size:13px;color:#4b5563;margin-top:8px;line-height:1.6}
.section{margin-bottom:20px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
.section-title{background:#f9fafb;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#6b7280;padding:10px 16px;border-bottom:1px solid #e5e7eb}
.section-body{padding:14px 16px;font-size:13px;color:#374151;line-height:1.7;white-space:pre-wrap}
.footer{margin-top:32px;padding-top:12px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;font-size:11px;color:#9ca3af}
@media print{body{padding:24px}@page{margin:16mm}}
</style></head><body>
<div class="hdr">
  <div class="tool-name">${tool.name}</div>
  <span class="badge">${catLabel}</span>
  <div class="meta">Generated ${ts}</div>
  <div class="desc">${tool.description}</div>
</div>
${sectionsHtml}
<div class="footer">
  <span>RenoMeta Connect · AI Tools</span>
  <span>Page 1 of 1</span>
</div>
<script>window.onload=function(){window.print();}</script>
</body></html>`);
    w.document.close();
  };

  return (
    <div className="space-y-4">
      <SheetHeader className="space-y-2 px-0 text-left">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <SheetTitle className="text-base">{tool.name}</SheetTitle>
            <Badge
              variant="secondary"
              className={cn("mt-1 h-5 rounded border px-1.5 text-[10px]", CATEGORY_COLOR[cat] ?? "")}
            >
              {CATEGORY_LABEL[cat] ?? tool.category}
            </Badge>
          </div>
        </div>
        <SheetDescription className="text-xs leading-relaxed">{tool.description}</SheetDescription>
      </SheetHeader>

      <Separator />

      {/* Inputs driven by input_schema from tool_definition */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Inputs</h3>
        {(tool.input_schema ?? []).map((field: ToolFieldDef) => (
          <FieldRenderer key={field.key} field={field} value={values[field.key] ?? ""} onChange={(v) => setValue(field.key, v)} />
        ))}
        <Button size="sm" className="h-8 w-full" onClick={handleRun} disabled={running}>
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          <span className="text-xs">{running ? "Running…" : "Run"}</span>
        </Button>
      </div>

      {output && (
        <>
          <Separator />
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Output</h3>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleCopy}>
                  <Copy className="h-3 w-3" />
                  Copy
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleExport}>
                  <FileDown className="h-3 w-3" />
                  Export PDF
                </Button>
              </div>
            </div>
            {Object.entries(output).map(([section, content]) => (
              <div key={section} className="rounded-md border border-border bg-secondary/30 p-3">
                <h4 className="mb-1.5 text-xs font-semibold">{section}</h4>
                <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">{content}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Field renderer (driven by input_schema) ────────────────────────────────────

function FieldRenderer({
  field,
  value,
  onChange,
}: {
  field: ToolFieldDef;
  value: string;
  onChange: (v: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error("Image must be under 8MB");
      return;
    }

    setUploading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const { data: profile } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
      const orgId = profile?.organization_id;
      if (!orgId) throw new Error("No organization");

      const ext = file.name.split(".").pop() || "jpg";
      const path = `${orgId}/ai-tools/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

      // project-photos is the existing public bucket used for site/project
      // images elsewhere in the app (see CLAUDE.md storage buckets table)
      // — reused here rather than creating a new bucket, since ad creative
      // images are conceptually similar (public, org-scoped media).
      const { error: uploadErr } = await supabase.storage
        .from("project-photos")
        .upload(path, file, { cacheControl: "3600", upsert: false });
      if (uploadErr) throw uploadErr;

      const { data: urlData } = supabase.storage.from("project-photos").getPublicUrl(path);
      onChange(urlData.publicUrl);
      toast.success("Image uploaded");
    } catch (err: any) {
      toast.error(`Upload failed: ${err.message ?? "unknown error"}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-1">
      <Label className="text-xs">{field.label}</Label>
      {field.type === "image" ? (
        <div className="space-y-2">
          {value ? (
            <div className="relative w-full overflow-hidden rounded-md border border-border">
              <img src={value} alt={field.label} className="h-32 w-full object-cover" />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="absolute right-1.5 top-1.5 h-6 px-2 text-[10px]"
                onClick={() => onChange("")}
              >
                Remove
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex h-24 w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-xs text-muted-foreground hover:bg-secondary disabled:opacity-50"
            >
              {uploading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Uploading…
                </>
              ) : (
                <>
                  <ImageIcon className="h-4 w-4" />
                  Click to upload an image
                </>
              )}
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleImageSelect}
          />
        </div>
      ) : field.type === "textarea" ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="min-h-20 text-xs"
        />
      ) : field.type === "select" ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={field.placeholder ?? `Select ${field.label.toLowerCase()}`} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((opt) => (
              <SelectItem key={opt} value={opt} className="text-xs">
                {/* For AI Insights date_range, show human-friendly label */}
                {field.key === "date_range" ? `Last ${opt} days` : opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className="relative">
          {field.prefix && (
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              {field.prefix}
            </span>
          )}
          <Input
            type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            className={cn("h-8 text-xs", field.prefix && "pl-6", field.suffix && "pr-8")}
          />
          {field.suffix && (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              {field.suffix}
            </span>
          )}
        </div>
      )}
    </div>
  );
}