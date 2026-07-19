import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { workflowDetailLink, ROUTES } from "@/lib/routes";
import { PageHeader } from "@/components/layout/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Plus, Search, Loader2, MoreHorizontal, Pencil,
  Trash2, Zap, TrendingUp, Workflow as WorkflowIcon, XCircle,
  Clock, Play, Eye, Copy, CheckCircle2, Bell,
} from "lucide-react";
import { toast } from "sonner";
import {
  useWorkflows, createWorkflow, updateWorkflowStatus,
  deleteWorkflow, type DbWorkflow, type DbWorkflowRun,
} from "@/lib/workflows-store";
import {
  CATEGORY_STYLE, NODES_BY_CATEGORY, NODE_META_MAP,
  type WfNodeType,
} from "@/lib/workflow-types";
import {
  WORKFLOW_TEMPLATES, TEMPLATE_CATEGORY_STYLE, instantiateTemplate,
  type WorkflowTemplate, type TemplateCategory,
} from "@/lib/workflow-templates";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/automation/workflows/")({
  component: WorkflowsPage,
});

// ── Page ─────────────────────────────────────────────────────────────────────

function WorkflowsPage() {
  const { workflows, runs, loading } = useWorkflows();
  const [tab, setTab] = useState<"library" | "templates" | "history">("library");

  const active   = workflows.filter((w) => w.status === "active").length;
  const totalRuns = workflows.reduce((s, w) => s + w.runsCount, 0);
  const failed24h = runs.filter((r) => r.status === "failed").length;
  const activeWithRuns = workflows.filter((w) => w.runsCount > 0);
  const avgSuccess =
    activeWithRuns.length === 0
      ? 0
      : Math.round(activeWithRuns.reduce((s, w) => s + w.successRate, 0) / activeWithRuns.length);

  return (
    <div className="flex flex-col">
      <PageHeader
        icon={Zap}
        iconBg="bg-info-soft"
        iconColor="text-info"
        title="Workflows"
        subtitle={loading ? "Loading…" : `${active} active · ${totalRuns.toLocaleString()} runs`}
        breadcrumb={["Automation", "Workflows"]}
        actions={
          <div className="flex items-center gap-2">
            <Link to={ROUTES.TRIGGERS}>
              <Button variant="outline" size="sm" className="h-8 gap-1.5">
                <Bell className="h-3.5 w-3.5" /> Triggers
              </Button>
            </Link>
            <NewWorkflowButton />
          </div>
        }
      />

      {/* KPIs */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi icon={WorkflowIcon} label="Active" value={loading ? "…" : String(active)} sub={`${workflows.length} total`} />
        <Kpi icon={Zap} label="Runs this month" value={loading ? "…" : totalRuns.toLocaleString()} sub="+18% vs last" subTone="success" />
        <Kpi icon={TrendingUp} label="Avg. success" value={loading ? "…" : `${avgSuccess}%`} sub="across active" />
        <Kpi icon={XCircle} label="Failed (24h)" value={loading ? "…" : String(failed24h)} sub="needs review" subTone={failed24h > 2 ? "warning" : "muted"} />
      </div>

      {/* Tabs */}
      <div className="mb-3 flex items-center gap-1 border-b border-border">
        <TabBtn active={tab === "library"} onClick={() => setTab("library")} label="Library" count={workflows.length} />
        <TabBtn active={tab === "templates"} onClick={() => setTab("templates")} label="Templates" count={WORKFLOW_TEMPLATES.length} />
        <TabBtn active={tab === "history"} onClick={() => setTab("history")} label="Run History" count={runs.length} />
      </div>

      {tab === "library"   && <LibraryView workflows={workflows} loading={loading} />}
      {tab === "templates" && <TemplatesView />}
      {tab === "history"   && <HistoryView runs={runs} workflows={workflows} />}
    </div>
  );
}

// ── New Workflow dialog ───────────────────────────────────────────────────────

const TRIGGER_GROUPS = [
  { label: "CRM", nodes: NODES_BY_CATEGORY.trigger.filter((n) => ["new_lead","lead_status_changed","contact_created","estimate_approved"].includes(n.type)) },
  { label: "Projects", nodes: NODES_BY_CATEGORY.trigger.filter((n) => ["project_status_changed","appointment_scheduled"].includes(n.type)) },
  { label: "Finance", nodes: NODES_BY_CATEGORY.trigger.filter((n) => ["invoice_created","invoice_overdue"].includes(n.type)) },
  { label: "Communication", nodes: NODES_BY_CATEGORY.trigger.filter((n) => ["form_submitted","missed_call"].includes(n.type)) },
  { label: "Other", nodes: NODES_BY_CATEGORY.trigger.filter((n) => ["manual"].includes(n.type)) },
];

function NewWorkflowButton() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<WfNodeType | "">("");

  const handleCreate = async () => {
    if (!name.trim()) { toast.error("Give the workflow a name"); return; }
    if (!triggerType) { toast.error("Choose a starting trigger"); return; }
    setSaving(true);

    const triggerMeta = NODE_META_MAP[triggerType as WfNodeType];
    const { data, error } = await createWorkflow({
      name: name.trim(),
      triggerType: triggerType as WfNodeType,
      nodes: [
        {
          id: "trigger_1",
          type: "wfNode" as const,
          data: {
            nodeType: triggerType as WfNodeType,
            label: triggerMeta.label,
            subtitle: triggerMeta.defaultSubtitle,
            config: { ...triggerMeta.defaultConfig },
            category: "trigger" as const,
          },
          position: { x: 300, y: 80 },
        },
      ],
      edges: [],
    });
    setSaving(false);
    if (error || !data) { toast.error("Failed to create workflow"); return; }
    setOpen(false);
    setName("");
    setTriggerType("");
    toast.success(`"${data.name}" created`);
    navigate(workflowDetailLink(data.id));
  };

  return (
    <>
      <Button size="sm" className="h-8" onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" /> New Workflow
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New Workflow</DialogTitle>
            <DialogDescription>Choose a name and a starting trigger.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Workflow name *
              </label>
              <Input
                placeholder="e.g. New lead → welcome SMS"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Starting trigger *
              </label>
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {TRIGGER_GROUPS.map((g) => (
                  <div key={g.label}>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{g.label}</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {g.nodes.map((meta) => {
                        const Icon = meta.icon;
                        const selected = triggerType === meta.type;
                        return (
                          <button
                            key={meta.type}
                            onClick={() => setTriggerType(meta.type)}
                            className={cn(
                              "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-all",
                              selected
                                ? "border-primary bg-primary/5 text-foreground"
                                : "border-border bg-card hover:border-primary/40 hover:bg-secondary/40",
                            )}
                          >
                            <div className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded border", CATEGORY_STYLE.trigger.bg, CATEGORY_STYLE.trigger.border)}>
                              <Icon className={cn("h-3.5 w-3.5", CATEGORY_STYLE.trigger.text)} />
                            </div>
                            <span className="truncate text-[12px] font-medium">{meta.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={saving || !name.trim() || !triggerType}>
              {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Create &amp; open builder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Library view ─────────────────────────────────────────────────────────────

function LibraryView({ workflows, loading }: { workflows: DbWorkflow[]; loading: boolean }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused" | "draft">("all");

  const filtered = useMemo(
    () => workflows.filter((w) => {
      if (statusFilter !== "all" && w.status !== statusFilter) return false;
      if (search && !w.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    }),
    [workflows, search, statusFilter],
  );

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search workflows…" className="h-8 pl-7 text-xs" />
        </div>
        <FilterPill
          options={["all", "active", "paused", "draft"]}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as typeof statusFilter)}
        />
      </div>

      {filtered.length === 0 && workflows.length === 0 ? (
        <EmptyState />
      ) : (
        <Card className="overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-secondary/40 text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="w-12 px-3 py-2 text-left font-medium">On</th>
                <th className="px-3 py-2 text-left font-medium">Workflow</th>
                <th className="px-3 py-2 text-left font-medium">Trigger</th>
                <th className="px-3 py-2 text-right font-medium">Runs</th>
                <th className="px-3 py-2 text-right font-medium">Success</th>
                <th className="px-3 py-2 text-left font-medium">Last run</th>
                <th className="w-10 px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((w) => <WorkflowRow key={w.id} w={w} />)}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="p-12 text-center text-sm text-muted-foreground">No workflows match the filter.</div>
          )}
        </Card>
      )}
    </>
  );
}

function EmptyState() {
  return (
    <Card className="flex flex-col items-center gap-3 p-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
        <WorkflowIcon className="h-6 w-6 text-muted-foreground" />
      </div>
      <div>
        <div className="font-semibold">No workflows yet</div>
        <p className="mt-1 text-sm text-muted-foreground">Click "New Workflow" to build your first automation.</p>
      </div>
    </Card>
  );
}

function WorkflowRow({ w }: { w: DbWorkflow }) {
  const [localStatus, setLocalStatus] = useState(w.status);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const triggerMeta = w.triggerType ? NODE_META_MAP[w.triggerType] : null;
  const TriggerIcon = triggerMeta?.icon;

  const handleToggle = async (checked: boolean) => {
    if (localStatus === "draft") { toast.info(`"${w.name}" is in draft — open the builder to finish setup.`); return; }
    const next = checked ? "active" : "paused";
    setLocalStatus(next);
    const { error } = await updateWorkflowStatus(w.id, next);
    if (error) { setLocalStatus(localStatus); toast.error("Failed to update status"); }
  };

  const handleDelete = async () => {
    setDeleting(true);
    const { error } = await deleteWorkflow(w.id);
    setDeleting(false);
    if (error) { toast.error("Failed to delete workflow"); }
    else { toast.success(`"${w.name}" deleted`); setConfirmOpen(false); }
  };

  return (
    <>
      <tr className="h-12 border-b border-border last:border-b-0 hover:bg-secondary/30">
        <td className="px-3" onClick={(e) => e.stopPropagation()}>
          <Switch checked={localStatus === "active"} onCheckedChange={handleToggle} disabled={localStatus === "draft"} />
        </td>
        <td className="px-3">
          <Link {...workflowDetailLink(w.id)} className="group flex items-center gap-2">
            <span className="font-medium group-hover:text-primary">{w.name}</span>
            {localStatus === "active" && (
              <Badge variant="secondary" className="h-4 rounded bg-success/15 px-1.5 text-[9px] text-success">Live</Badge>
            )}
            {localStatus === "draft" && (
              <Badge variant="secondary" className="h-4 rounded bg-muted px-1.5 text-[9px] text-muted-foreground">Draft</Badge>
            )}
          </Link>
        </td>
        <td className="px-3">
          {triggerMeta && TriggerIcon ? (
            <div className="flex items-center gap-1.5">
              <div className={cn("flex h-5 w-5 items-center justify-center rounded border", CATEGORY_STYLE.trigger.bg, CATEGORY_STYLE.trigger.border)}>
                <TriggerIcon className={cn("h-3 w-3", CATEGORY_STYLE.trigger.text)} />
              </div>
              <span className="text-xs text-muted-foreground">{triggerMeta.label}</span>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">{w.triggerEvent || "—"}</span>
          )}
        </td>
        <td className="px-3 text-right tabular-nums text-sm">{w.runsCount.toLocaleString()}</td>
        <td className="px-3 text-right">
          <SuccessBar value={w.successRate} runs={w.runsCount} />
        </td>
        <td className="px-3 text-xs text-muted-foreground">
          {w.lastRunAt ? fmtDate(w.lastRunAt) : "—"}
        </td>
        <td className="px-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 px-1.5"><MoreHorizontal className="h-3.5 w-3.5" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem asChild>
                <Link {...workflowDetailLink(w.id)} className="flex items-center gap-2">
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setConfirmOpen(true)}>
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </td>
      </tr>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete workflow?</DialogTitle>
            <DialogDescription>"{w.name}" and all its run history will be permanently deleted.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />} Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Templates view ────────────────────────────────────────────────────────────

const TEMPLATE_CATEGORIES: { id: TemplateCategory | "all"; label: string }[] = [
  { id: "all",           label: "All" },
  { id: "lead",          label: "Lead Nurturing" },
  { id: "project",       label: "Project Management" },
  { id: "financial",     label: "Financial" },
  { id: "communication", label: "Communication" },
];

function TemplatesView() {
  const navigate = useNavigate();
  const [categoryFilter, setCategoryFilter] = useState<TemplateCategory | "all">("all");
  const [previewTemplate, setPreviewTemplate] = useState<WorkflowTemplate | null>(null);
  const [activating, setActivating] = useState<string | null>(null);

  const filtered = useMemo(
    () => WORKFLOW_TEMPLATES.filter((t) => categoryFilter === "all" || t.category === categoryFilter),
    [categoryFilter],
  );

  const handleUseTemplate = async (template: WorkflowTemplate) => {
    setActivating(template.id);
    const { nodes, edges } = instantiateTemplate(template);
    const { data, error } = await createWorkflow({
      name: template.name,
      triggerType: template.trigger_type,
      nodes,
      edges,
    });
    setActivating(null);
    if (error || !data) { toast.error("Failed to create workflow from template"); return; }
    toast.success(`"${template.name}" created as a draft`);
    navigate(workflowDetailLink(data.id));
  };

  return (
    <>
      {/* Category filter */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {TEMPLATE_CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategoryFilter(c.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              categoryFilter === c.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
            )}
          >
            {c.label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground">{filtered.length} templates</span>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
            activating={activating === template.id}
            onPreview={() => setPreviewTemplate(template)}
            onUse={() => handleUseTemplate(template)}
          />
        ))}
      </div>

      {/* Preview sheet */}
      <Sheet open={!!previewTemplate} onOpenChange={(o) => !o && setPreviewTemplate(null)}>
        <SheetContent className="w-full sm:max-w-md">
          {previewTemplate && (
            <TemplatePreview
              template={previewTemplate}
              activating={activating === previewTemplate.id}
              onUse={() => handleUseTemplate(previewTemplate)}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function TemplateCard({
  template,
  activating,
  onPreview,
  onUse,
}: {
  template: WorkflowTemplate;
  activating: boolean;
  onPreview: () => void;
  onUse: () => void;
}) {
  const catStyle = TEMPLATE_CATEGORY_STYLE[template.category];
  const triggerMeta = NODE_META_MAP[template.trigger_type];
  const TriggerIcon = triggerMeta?.icon;

  return (
    <Card className="group flex flex-col p-4 transition-all hover:border-primary/30 hover:shadow-md">
      {/* Header row */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <Badge variant="outline" className={cn("h-5 rounded text-[10px]", catStyle.badge)}>
          {catStyle.label}
        </Badge>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Clock className="h-3 w-3" /> {template.estimated_time}
        </span>
      </div>

      {/* Name */}
      <h3 className="mb-1 text-sm font-semibold leading-snug">{template.name}</h3>
      <p className="mb-3 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
        {template.description}
      </p>

      {/* Trigger + steps */}
      <div className="mb-3 flex items-center gap-3 text-[10px] text-muted-foreground">
        {triggerMeta && TriggerIcon && (
          <span className="flex items-center gap-1">
            <div className={cn("flex h-4 w-4 items-center justify-center rounded border", CATEGORY_STYLE.trigger.bg, CATEGORY_STYLE.trigger.border)}>
              <TriggerIcon className={cn("h-2.5 w-2.5", CATEGORY_STYLE.trigger.text)} />
            </div>
            {triggerMeta.label}
          </span>
        )}
        <span className="flex items-center gap-1">
          <WorkflowIcon className="h-3 w-3" />
          {template.steps} steps
        </span>
      </div>

      {/* Actions */}
      <div className="mt-auto flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 flex-1 text-xs"
          onClick={onPreview}
        >
          <Eye className="mr-1 h-3 w-3" /> Preview
        </Button>
        <Button
          size="sm"
          className="h-7 flex-1 text-xs"
          onClick={onUse}
          disabled={activating}
        >
          {activating
            ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            : <Copy className="mr-1 h-3 w-3" />}
          Use template
        </Button>
      </div>
    </Card>
  );
}

function TemplatePreview({
  template,
  activating,
  onUse,
}: {
  template: WorkflowTemplate;
  activating: boolean;
  onUse: () => void;
}) {
  const catStyle = TEMPLATE_CATEGORY_STYLE[template.category];

  return (
    <>
      <SheetHeader className="space-y-2 pb-4">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn("h-5 rounded text-[10px]", catStyle.badge)}>
            {catStyle.label}
          </Badge>
          <span className="text-[10px] text-muted-foreground">
            {template.steps} steps · {template.estimated_time}
          </span>
        </div>
        <SheetTitle className="text-base">{template.name}</SheetTitle>
        <SheetDescription className="text-xs leading-relaxed">{template.description}</SheetDescription>
      </SheetHeader>

      <ScrollArea className="h-[calc(100vh-280px)]">
        <div className="space-y-0 pr-2">
          {template.nodes.map((node, i) => {
            const meta = NODE_META_MAP[node.data.nodeType];
            const catSty = CATEGORY_STYLE[node.data.category];
            const Icon = meta?.icon;
            const isLast = i === template.nodes.length - 1;

            return (
              <div key={node.id} className="flex items-start gap-3">
                {/* Vertical connector */}
                <div className="flex flex-col items-center">
                  <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border", catSty.bg, catSty.border)}>
                    {Icon && <Icon className={cn("h-3.5 w-3.5", catSty.text)} />}
                  </div>
                  {!isLast && <div className="my-1 h-5 w-px bg-border" />}
                </div>

                {/* Node info */}
                <div className={cn("pb-1", isLast ? "" : "")}>
                  <div className="text-[11px] font-semibold leading-tight">{node.data.label}</div>
                  {node.data.subtitle && (
                    <div className="text-[10px] text-muted-foreground">{node.data.subtitle}</div>
                  )}
                  {/* Show yes/no labels for if_else */}
                  {node.data.nodeType === "if_else" && (
                    <div className="mt-0.5 flex gap-2">
                      <span className="text-[10px] text-emerald-600">↙ Yes branch</span>
                      <span className="text-[10px] text-rose-500">↘ No branch</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      <div className="mt-4 border-t border-border pt-4">
        <Button className="w-full" onClick={onUse} disabled={activating}>
          {activating
            ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            : <CheckCircle2 className="mr-2 h-3.5 w-3.5" />}
          Use this template
        </Button>
        <p className="mt-2 text-center text-[10px] text-muted-foreground">
          Creates a draft workflow — you can customise it before going live.
        </p>
      </div>
    </>
  );
}

// ── History view ─────────────────────────────────────────────────────────────

function HistoryView({ runs, workflows }: { runs: DbWorkflowRun[]; workflows: DbWorkflow[] }) {
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "failed" | "running">("all");
  const filtered = runs.filter((r) => statusFilter === "all" || r.status === statusFilter);

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <FilterPill options={["all", "success", "failed", "running"]} value={statusFilter} onChange={(v) => setStatusFilter(v as typeof statusFilter)} />
        <span className="ml-auto text-[11px] text-muted-foreground">{filtered.length} runs</span>
      </div>
      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-secondary/40 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-2"></th>
              <th className="px-3 py-2 text-left font-medium">Workflow</th>
              <th className="px-3 py-2 text-left font-medium">Contact</th>
              <th className="px-3 py-2 text-left font-medium">Started</th>
              <th className="px-3 py-2 text-right font-medium">Duration</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const wf = workflows.find((w) => w.id === r.workflowId);
              return (
                <tr key={r.id} className="h-10 border-b border-border last:border-b-0 hover:bg-secondary/30">
                  <td className="px-3">
                    {r.status === "success" && <div className="h-2 w-2 rounded-full bg-success" />}
                    {r.status === "failed"  && <div className="h-2 w-2 rounded-full bg-destructive" />}
                    {r.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                  </td>
                  <td className="px-3 text-xs font-medium">
                    {wf ? <Link {...workflowDetailLink(wf.id)} className="hover:text-primary">{wf.name}</Link> : r.workflowId}
                  </td>
                  <td className="px-3 text-xs text-muted-foreground">{r.contactName}</td>
                  <td className="px-3 text-xs text-muted-foreground">{fmtDateTime(r.startedAt)}</td>
                  <td className="px-3 text-right text-xs tabular-nums text-muted-foreground">
                    {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : "—"}
                  </td>
                  <td className="px-3">
                    <Badge variant="secondary" className={cn("h-5 rounded px-1.5 text-[10px]",
                      r.status === "success" ? "bg-success/15 text-success" :
                      r.status === "failed"  ? "bg-destructive/15 text-destructive" :
                      "bg-primary/10 text-primary",
                    )}>
                      {r.status}
                    </Badge>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="p-12 text-center text-sm text-muted-foreground">
                {runs.length === 0 ? "No runs yet — runs appear here after workflows execute." : "No runs match this filter."}
              </td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ── Shared primitives ────────────────────────────────────────────────────────

function TabBtn({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button onClick={onClick} className={cn("relative flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors", active ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
      {label}
      <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{count}</span>
      {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
    </button>
  );
}

function Kpi({ icon: Icon, label, value, sub, subTone = "muted" }: { icon: typeof Zap; label: string; value: string; sub: string; subTone?: "muted" | "success" | "warning" }) {
  return (
    <Card className="p-3.5">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><Icon className="h-3.5 w-3.5" /> {label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className={cn("text-[11px]", subTone === "success" ? "text-success" : subTone === "warning" ? "text-warning" : "text-muted-foreground")}>{sub}</div>
    </Card>
  );
}

function SuccessBar({ value, runs }: { value: number; runs: number }) {
  if (runs === 0) return <span className="text-xs text-muted-foreground">—</span>;
  const tone = value >= 90 ? "bg-success" : value >= 70 ? "bg-warning" : "bg-destructive";
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-secondary"><div className={`h-full ${tone}`} style={{ width: `${value}%` }} /></div>
      <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{value}%</span>
    </div>
  );
}

function FilterPill({ options, value, onChange }: { options: readonly string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center rounded-md border border-border bg-card p-0.5">
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)} className={cn("rounded px-2 py-1 text-[11px] font-medium transition-colors capitalize", value === o ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary")}>
          {o}
        </button>
      ))}
    </div>
  );
}

function fmtDate(iso: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(iso));
}
function fmtDateTime(iso: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(iso));
}

