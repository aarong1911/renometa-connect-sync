// src/routes/projects.index.tsx
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DecimalInput } from "@/components/ui/decimal-input";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Plus, Search, LayoutGrid, List as ListIcon, Download, Loader2, MapPin,
  MoreHorizontal, ChevronsUpDown, Check, Mail, Phone, MessageSquare, X,
  TrendingUp, Clock, PauseCircle, DollarSign, Filter, ChevronRight, Calendar,
  User, Circle, CheckCircle2, AlertCircle, XCircle, FileText, Send, Trash2, Flag,
  ExternalLink, ImageIcon, Camera, FolderOpen, Building2, UserRound, Pencil, Save,
  ChevronUp, ChevronDown, Link2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  useProjects, updateProjectStatus, createProject, updateProject,
  type Project, type ProjectStatus, type CreateProjectInput,
} from "@/lib/projects-store";
import { useContacts, getOrgId } from "@/lib/contacts-store";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useCompanies, resolvePrimaryContactForCompany } from "@/lib/companies-store";
import { useTeam } from "@/lib/organization";
import { composeAddress } from "@/lib/address";
import {
  PROJECT_TYPE_ORDER, PROJECT_TYPE_LABELS, PROJECT_PRIORITY_ORDER, PROJECT_PRIORITY_LABELS,
  PROJECT_PRIORITY_TINT, BUDGET_RANGE_ORDER, BUDGET_RANGE_LABELS, budgetRangeMidpoint,
  PROJECT_TYPE_TO_WORK_TYPES, getProjectDisplayProgress, isProgressManual,
  type ProjectType, type ProjectPriority, type BudgetRange,
} from "@/lib/project-status";
import { scopePresetsForWorkType, findScopePreset } from "@/lib/scope-of-work-presets";
import {
  useOrgTemplates, saveOrgTemplate, getScopeTemplates, resolveDefaultScopeContent,
} from "@/lib/proposal-templates-store";
import type { WorkType } from "@/lib/estimate-status";
import { useTasks, addTask, updateTask, deleteTask, refreshTasks, type TaskStatus } from "@/lib/tasks-store";
import { EntityAppointmentsPanel } from "@/components/appointments/entity-appointments-panel";
import type { Task, Contact } from "@/lib/mock-data";
import { supabase } from "@/lib/supabase";
import { openContactConversation } from "@/lib/conversations-nav";
import {
  fetchProjectPhases, createProjectPhase, updateProjectPhase, deleteProjectPhase, movePhase, getPhaseDisplayProgress,
  fetchProjectMilestones, createProjectMilestone, achieveMilestone, deleteProjectMilestone,
  fetchTaskDependencies, createTaskDependency, deleteTaskDependency, getBlockingTask,
  PHASE_STATUS_ORDER, PHASE_STATUS_LABELS, MILESTONE_STATUS_LABELS,
  applyProjectPlanTemplate, hasTemplateBeenApplied,
  type ProjectPhase, type ProjectMilestone, type TaskDependency, type PhaseStatus, type ApplyTemplateMode, type MilestoneStatus,
} from "@/lib/project-planning";
import {
  getProjectScheduleHealth, getNextMilestone, getNextTask, getOverdueCounts, getBlockedTaskCount,
  formatDateOnly, formatDelay, SCHEDULE_HEALTH_LABELS,
  parseDateOnlySafe, differenceInCalendarDaysSafe, todayDateOnly,
} from "@/lib/schedule-health";
import {
  templatesForProjectType, findPlanTemplate, formatTemplateCounts, formatTemplateSummary, pluralizeCount,
  type ProjectPlanTemplate,
} from "@/lib/project-plan-templates";
import { ProjectTimelineGantt } from "@/components/projects/ProjectTimelineGantt";
import { ProjectDailyLogsTab } from "@/components/projects/ProjectDailyLogsTab";
import { ProjectPhotoGallery } from "@/components/projects/ProjectPhotoGallery";
import { InviteToPortalModal } from "@/components/portal/InviteToPortalModal";
import { InvoiceModal } from "@/components/projects/InvoiceModal";
import { InvoiceDetailModal } from "@/components/projects/InvoiceDetailModal";

type ProjectsSearch = {
  slug?: string;
  /** Opens the detail sheet directly by id — used by "Open Project" links from Estimate/Deal detail, which know the project's id but not necessarily its slug. */
  projectId?: string;
  /** Deep-link prefill for the New Project dialog, mirroring the Estimates page's contactId/companyId/openNew pattern (Contact/Account "New Project" entry points, Part 26/27). */
  openNew?: boolean;
  contactId?: string;
  companyId?: string;
  /** Phase 13.2B — Calendar → Project deep links (Part 28/29). tab=schedule opens Schedule & Tasks directly; subview picks Plan/Timeline/Milestones/Tasks; task/milestone/phase are informational hints consumed by the relevant subview (no highlighting/scrolling implemented in this pass — see report). */
  tab?: "overview" | "financials" | "schedule" | "communications" | "photos";
  subview?: "plan" | "timeline" | "milestones" | "tasks";
  task?: string;
  milestone?: string;
  phase?: string;
};

const PROJECT_TABS = ["overview", "financials", "schedule", "communications", "photos"] as const;
const SCHEDULE_SUBVIEWS = ["plan", "timeline", "milestones", "tasks"] as const;

export const Route = createFileRoute("/projects/")({
  validateSearch: (raw: Record<string, unknown>): ProjectsSearch => ({
    slug: typeof raw.slug === "string" ? raw.slug : undefined,
    projectId: typeof raw.projectId === "string" ? raw.projectId : undefined,
    openNew: raw.openNew === true || raw.openNew === "1" ? true : undefined,
    contactId: typeof raw.contactId === "string" ? raw.contactId : undefined,
    companyId: typeof raw.companyId === "string" ? raw.companyId : undefined,
    tab: typeof raw.tab === "string" && (PROJECT_TABS as readonly string[]).includes(raw.tab) ? (raw.tab as ProjectsSearch["tab"]) : undefined,
    subview: typeof raw.subview === "string" && (SCHEDULE_SUBVIEWS as readonly string[]).includes(raw.subview) ? (raw.subview as ProjectsSearch["subview"]) : undefined,
    task: typeof raw.task === "string" ? raw.task : undefined,
    milestone: typeof raw.milestone === "string" ? raw.milestone : undefined,
    phase: typeof raw.phase === "string" ? raw.phase : undefined,
  }),
  component: ProjectsPage,
});

// ─── Types ────────────────────────────────────────────────────────────────────

/** Replaces the old three-button Active Pipeline/On Hold/Cancelled tab row — same partition, now reachable via the Filters control so it doesn't duplicate the KPI cards and stage columns (Phase 13.3). "completed"/"all" are new options that row never offered. */
type StatusFilter = "active" | "on-hold" | "cancelled" | "completed" | "all";
type View = "board"  | "list";

type StageColumn = {
  id: string; statuses: ProjectStatus[]; dbStatus: ProjectStatus;
  label: string; dotColor: string; description: string;
};

type Invoice = {
  id: string; invoice_number: string; status: string;
  issue_date: string | null; due_date: string | null;
  total_amount: number; amount_paid: number;
};

type Note = { id: string; body: string; created_at: string; author: string };

// ─── Stage columns ────────────────────────────────────────────────────────────

const STAGE_COLUMNS: StageColumn[] = [
  { id: "estimating",       statuses: ["planning"],         dbStatus: "planning",         label: "Estimating",       dotColor: "bg-sky-500",    description: "Proposal / bid in progress" },
  { id: "contracted",       statuses: ["contracted"],       dbStatus: "contracted",       label: "Contracted",       dotColor: "bg-violet-500", description: "Signed, deposit received" },
  { id: "pre-construction", statuses: ["pre-construction"], dbStatus: "pre-construction", label: "Pre-Construction", dotColor: "bg-amber-500",  description: "Permits · materials · scheduling" },
  { id: "in-progress",      statuses: ["active"],           dbStatus: "active",           label: "In Progress",      dotColor: "bg-green-500",  description: "Active on-site work" },
  { id: "punch-list",       statuses: ["punch-list"],       dbStatus: "punch-list",       label: "Punch List",       dotColor: "bg-orange-500", description: "Final items · walkthrough" },
  { id: "completed",        statuses: ["completed"],        dbStatus: "completed",        label: "Completed",        dotColor: "bg-gray-400",   description: "Closed out" },
];

const ACTIVE_STATUSES: ProjectStatus[] = ["planning","contracted","pre-construction","active","punch-list","completed"];

/** Filters control's Status section — replaces the old Active Pipeline/On Hold/Cancelled tab row (Phase 13.3) without inventing a second status list: same ACTIVE_STATUSES grouping the board/KPIs already use, plus "Completed" and "All Statuses" which that row never offered. */
const STATUS_FILTER_OPTIONS: { id: StatusFilter; label: string }[] = [
  { id: "active",    label: "Active" },
  { id: "on-hold",   label: "On Hold" },
  { id: "cancelled", label: "Cancelled" },
  { id: "completed", label: "Completed" },
  { id: "all",       label: "All Statuses" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMoney(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toLocaleString()}`;
}
function formatMoneyFull(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}
function daysSince(dateStr: string | null | undefined) {
  if (!dateStr) return 0;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}
function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function getCityFromAddress(address: string | null): string {
  if (!address) return "";
  const parts = address.split(",").map(s => s.trim());
  if (parts.length >= 3) return `${parts[parts.length - 2]}, ${parts[parts.length - 1].split(" ")[0]}`;
  if (parts.length === 2) return parts[1];
  return "";
}
function getInitials(name: string) {
  return name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
}
function getColumnForStatus(status: ProjectStatus): StageColumn {
  return STAGE_COLUMNS.find(col => col.statuses.includes(status)) ?? STAGE_COLUMNS[0];
}
function getStepperIndex(status: ProjectStatus) {
  return STAGE_COLUMNS.findIndex(col => col.statuses.includes(status));
}

const STEPPER_STAGES = [
  { id: "estimating",       label: "Estimating" },
  { id: "contracted",       label: "Contracted" },
  { id: "pre-construction", label: "Pre-Construction" },
  { id: "in-progress",      label: "In Progress" },
  { id: "punch-list",       label: "Punch List" },
  { id: "completed",        label: "Completed" },
] as const;

const PRIORITY_COLORS: Record<Task["priority"], string> = {
  high: "text-red-500", med: "text-amber-500", low: "text-slate-400",
};
// Canonical DB status values (tasks_status_check) — see src/lib/task-status.ts.
const STATUS_ICONS: Record<Task["status"], React.ReactNode> = {
  not_started: <Circle       className="h-4 w-4 text-muted-foreground" />,
  in_progress: <Clock        className="h-4 w-4 text-blue-500" />,
  on_hold:     <AlertCircle  className="h-4 w-4 text-violet-500" />,
  completed:   <CheckCircle2 className="h-4 w-4 text-green-500" />,
  cancelled:   <XCircle      className="h-4 w-4 text-rose-500" />,
};

// ─── Project Timeline (Phase 13.2 continuation) ────────────────────────────────
//
// A lightweight chronological agenda — every phase start/end, milestone,
// and task with a real date, merged into one list, grouped by month. This
// is a deliberate scope-down from the spec's full horizontal zoomable
// Gantt-bar timeline (Week/Month/Quarter zoom, pixel-positioned bars,
// dependency-line routing) — see the Phase report for the reasoning. It's
// also exactly the "mobile fallback" the spec asks for, just used
// everywhere rather than only on narrow screens, which keeps this one
// simple, fully accessible (plain semantic rows, not a canvas), safe
// implementation instead of two.
function ProjectTimelineAgenda({ project, phases, milestones, tasks }: {
  project: Project; phases: ProjectPhase[]; milestones: ProjectMilestone[]; tasks: Task[];
}) {
  void project; // reserved for a future Project start/end row — not rendered yet, see report
  type AgendaItem = {
    id: string; date: Date; label: string; sublabel: string;
    icon: "phase" | "milestone" | "task"; done: boolean; overdue: boolean;
  };
  const today = todayDateOnly();
  const items: AgendaItem[] = [];

  for (const p of phases) {
    const isDone = p.status === "completed" || p.status === "skipped";
    const ps = parseDateOnlySafe(p.plannedStartDate);
    if (ps) items.push({ id: `${p.id}-start`, date: ps, label: `${p.name} — starts`, sublabel: PHASE_STATUS_LABELS[p.status], icon: "phase", done: isDone, overdue: false });
    const pe = parseDateOnlySafe(p.plannedEndDate);
    if (pe) {
      const overdue = !isDone && (differenceInCalendarDaysSafe(today, pe) ?? -1) > 0;
      items.push({ id: `${p.id}-end`, date: pe, label: `${p.name} — ends`, sublabel: PHASE_STATUS_LABELS[p.status], icon: "phase", done: p.status === "completed", overdue });
    }
  }
  for (const m of milestones) {
    const d = parseDateOnlySafe(m.plannedDate);
    if (d) {
      const overdue = m.status === "pending" && (differenceInCalendarDaysSafe(today, d) ?? -1) > 0;
      items.push({ id: m.id, date: d, label: m.name, sublabel: MILESTONE_STATUS_LABELS[m.status], icon: "milestone", done: m.status === "achieved", overdue });
    }
  }
  for (const t of tasks) {
    const d = parseDateOnlySafe(t.dueDateRaw);
    if (d) {
      const overdue = t.status !== "completed" && t.status !== "cancelled" && (differenceInCalendarDaysSafe(today, d) ?? -1) > 0;
      items.push({ id: t.id, date: d, label: t.title, sublabel: "Task", icon: "task", done: t.status === "completed", overdue });
    }
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border py-12 text-center">
        <p className="text-sm text-muted-foreground">No scheduled dates yet</p>
        <p className="mt-1 text-xs text-muted-foreground">Add dates to phases, milestones, or tasks to see the Project Timeline.</p>
      </div>
    );
  }

  items.sort((a, b) => a.date.getTime() - b.date.getTime());

  const groups = new Map<string, AgendaItem[]>();
  for (const item of items) {
    const key = item.date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  return (
    <div className="space-y-4" role="list" aria-label="Project timeline">
      {[...groups.entries()].map(([month, monthItems]) => (
        <div key={month}>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{month}</h4>
          <div className="space-y-1">
            {monthItems.map((item) => {
              const isToday = item.date.getTime() === today.getTime();
              const Icon = item.icon === "milestone" ? (item.done ? CheckCircle2 : Circle) : item.icon === "phase" ? Flag : Circle;
              return (
                <div
                  key={item.id} role="listitem"
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-3 py-2",
                    item.overdue ? "border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-500/10" : isToday ? "border-primary bg-primary/5" : "border-border bg-background",
                  )}
                >
                  <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{item.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                  <Icon className={cn("h-3.5 w-3.5 shrink-0", item.done ? "text-green-600" : item.overdue ? "text-red-600" : "text-muted-foreground")} />
                  <div className="min-w-0 flex-1">
                    <p className={cn("truncate text-sm", item.done && "text-muted-foreground line-through")}>{item.label}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {item.sublabel}
                      {item.overdue && ` · Overdue by ${formatDelay(differenceInCalendarDaysSafe(today, item.date) ?? 0)}`}
                      {isToday && " · Today"}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

// ─── Project Detail Sheet ─────────────────────────────────────────────────────

/**
 * Canonical Project detail drawer — also reused directly by Calendar
 * (Phase 13.2D, Part 3) for milestone/phase/Project-date clicks, so those
 * events open this exact component in place instead of navigating to
 * /projects or forking a second Project detail UI. Given its size, this is
 * exported and imported directly rather than extracted into a separate
 * shared file (unlike the smaller Task drawer) — see the Phase report.
 */
export function ProjectDetailSheet({ project, open, onClose, onReload, onProjectUpdated, deepLink, onDeepLinkConsumed }: {
  project: Project | null; open: boolean; onClose: () => void; onReload: () => void;
  onProjectUpdated: (p: Project) => void;
  /** Phase 13.2B — optional Calendar deep-link context (Part 28/29); consumed once on open, then cleared by the caller so it isn't re-applied on a later reopen. */
  deepLink?: { tab?: "overview" | "financials" | "schedule" | "communications" | "photos"; subview?: "plan" | "timeline" | "milestones" | "tasks"; taskId?: string; milestoneId?: string; phaseId?: string } | null;
  onDeepLinkConsumed?: () => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const contacts = useContacts();
  const allTasks = useTasks();
  const navigate = useNavigate({ from: "/projects/" });

  const [activeTab,        setActiveTab]        = useState<"overview" | "financials" | "schedule" | "daily-logs" | "communications" | "photos">("overview");
  const [newTaskTitle,     setNewTaskTitle]      = useState("");
  const [addingTask,       setAddingTask]        = useState(false);
  const [invoices,         setInvoices]          = useState<Invoice[]>([]);
  const [invoicesLoading,  setInvoicesLoading]   = useState(false);
  const [notes,            setNotes]             = useState<Note[]>([]);
  const [noteInput,        setNoteInput]         = useState("");
  const [savingNote,       setSavingNote]        = useState(false);
  const [activityNotes,    setActivityNotes]     = useState<Note[]>([]);
  const [portalInviteOpen, setPortalInviteOpen]  = useState(false);
  const [invoiceModalOpen, setInvoiceModalOpen]  = useState(false);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);

  // Phase 13.2 — Project Planning (phases/milestones/dependencies)
  const [phases,           setPhases]            = useState<ProjectPhase[]>([]);
  const [phasesError,      setPhasesError]       = useState<string | null>(null);
  const [milestones,       setMilestones]        = useState<ProjectMilestone[]>([]);
  const [dependencies,     setDependencies]      = useState<TaskDependency[]>([]);
  const [newPhaseName,     setNewPhaseName]      = useState("");
  const [addingPhase,      setAddingPhase]       = useState(false);
  const [newMilestoneName, setNewMilestoneName]  = useState("");
  const [newMilestoneDate, setNewMilestoneDate]  = useState("");
  const [addingMilestone,  setAddingMilestone]   = useState(false);
  const [phaseTaskDrafts,  setPhaseTaskDrafts]   = useState<Record<string, string>>({});
  const [addingPhaseTask,  setAddingPhaseTask]   = useState<string | null>(null);
  const [dependencyPickerFor, setDependencyPickerFor] = useState<string | null>(null);

  // Phase 13.2 continuation — Project Plan Templates
  const [planTemplateKey,  setPlanTemplateKey]   = useState("");
  const [planPreviewOpen,  setPlanPreviewOpen]   = useState(false);
  const [planConfirmOpen,  setPlanConfirmOpen]   = useState(false);
  const [planningStartDate, setPlanningStartDate] = useState("");
  const [applyingTemplate, setApplyingTemplate]  = useState(false);

  useEffect(() => {
    if (!open || !project) return;
    setPlanningStartDate(project.start_date || new Date().toISOString().slice(0, 10));
    setPlanTemplateKey("");
  }, [open, project?.id]);

  // Phase 13.2 continuation — Timeline / schedule health / Milestones & Tasks subviews
  const [scheduleSubview, setScheduleSubview] = useState<"plan" | "timeline" | "milestones" | "tasks">("plan");
  const [milestoneSearch, setMilestoneSearch] = useState("");
  const [milestoneStatusFilter, setMilestoneStatusFilter] = useState<"all" | MilestoneStatus>("all");
  const [milestonePhaseFilter, setMilestonePhaseFilter] = useState<string>("all");
  const [taskSearch, setTaskSearch] = useState("");
  const [taskPhaseFilter, setTaskPhaseFilter] = useState<string>("all");
  const [taskStatusFilter, setTaskStatusFilter] = useState<"all" | TaskStatus>("all");
  const [taskFocusFilter, setTaskFocusFilter] = useState<"all" | "overdue" | "blocked" | "unassigned">("all");

  // deepLink is intentionally read via closure, not listed as a dependency — it should only be applied once, the moment the sheet opens for this project, not re-applied if it changes while already open.
  useEffect(() => { if (open) setScheduleSubview(deepLink?.subview ?? "plan"); }, [open, project?.id]);

  const loadPlanningData = useCallback(async () => {
    if (!project) return;
    const [phasesResult, milestonesResult, dependenciesResult] = await Promise.all([
      fetchProjectPhases(project.id),
      fetchProjectMilestones(project.id),
      fetchTaskDependencies(project.id),
    ]);
    setPhases(phasesResult.phases);
    setPhasesError(phasesResult.error);
    setMilestones(milestonesResult.milestones);
    setDependencies(dependenciesResult.dependencies);
  }, [project?.id]);

  useEffect(() => {
    if (activeTab !== "schedule" || !project) return;
    void loadPlanningData();
  }, [activeTab, project?.id, loadPlanningData]);

  useEffect(() => {
    if (!open) return;
    setActiveTab(deepLink?.tab ?? "overview");
    if (deepLink) onDeepLinkConsumed?.();
  }, [open, project?.id]);

  useEffect(() => {
    if (!open || !project) return;
    supabase.from("project_notes").select("id, body, created_at, author")
      .eq("project_id", project.id).order("created_at", { ascending: false }).limit(10)
      .then(({ data }) => setActivityNotes((data ?? []) as Note[]));
  }, [open, project?.id]);

  useEffect(() => {
    if (activeTab !== "financials" || !project) return;
    setInvoicesLoading(true);
    supabase.from("invoices")
      .select("id, invoice_number, status, issue_date, due_date, total_amount, amount_paid")
      .eq("project_id", project.id).order("issue_date", { ascending: false })
      .then(({ data }) => { setInvoices((data ?? []) as Invoice[]); setInvoicesLoading(false); });
  }, [activeTab, project?.id, invoiceModalOpen]);

  useEffect(() => {
    if (activeTab !== "communications" || !project) return;
    supabase.from("project_notes").select("id, body, created_at, author")
      .eq("project_id", project.id).order("created_at", { ascending: false })
      .then(({ data }) => setNotes((data ?? []) as Note[]));
  }, [activeTab, project?.id]);

  if (!project) return null;

  const projectTasks = allTasks.filter(t => t.projectId === project.id);
  const tasksById = new Map(allTasks.map(t => [t.id, t]));
  const unassignedTasks = projectTasks.filter(t => !t.phaseId);
  const contact      = contacts.find(c => c.id === (project as any).client_id || c.name === project.client_name);
  const displayProgress = getProjectDisplayProgress(project);
  const progressIsManual = isProgressManual(project);

  const handleAddTask = async () => {
    if (!newTaskTitle.trim()) return;
    setAddingTask(true);
    await addTask({ projectId: project.id, title: newTaskTitle.trim(), due: new Date().toISOString(), status: "not_started", priority: "med", recurrence: "none" });
    setNewTaskTitle(""); setAddingTask(false);
  };

  // ── Phase 13.2 planning handlers ──────────────────────────────────────
  const handleAddPhase = async () => {
    if (!newPhaseName.trim() || addingPhase) return;
    setAddingPhase(true);
    const { phase, error } = await createProjectPhase({
      projectId: project.id, name: newPhaseName.trim(), position: phases.length,
    });
    setAddingPhase(false);
    if (error || !phase) { toast.error("Could not add phase", { description: error ?? undefined }); return; }
    setPhases((prev) => [...prev, phase]);
    setNewPhaseName("");
  };

  const handleDeletePhase = async (phase: ProjectPhase) => {
    const phaseTaskCount = projectTasks.filter((t) => t.phaseId === phase.id).length;
    const message = phaseTaskCount > 0
      ? `Delete "${phase.name}"? ${phaseTaskCount} task(s) will move to Unassigned Tasks, not be deleted.`
      : `Delete "${phase.name}"?`;
    if (!window.confirm(message)) return;
    const { error } = await deleteProjectPhase(phase.id);
    if (error) { toast.error("Could not delete phase", { description: error }); return; }
    setPhases((prev) => prev.filter((p) => p.id !== phase.id));
    void refreshTasks();
  };

  const handleMovePhase = async (phaseId: string, direction: "up" | "down") => {
    const { error } = await movePhase(phases, phaseId, direction);
    if (error) { toast.error("Could not reorder phases", { description: error }); return; }
    void loadPlanningData();
  };

  const handlePhaseStatusChange = async (phase: ProjectPhase, status: PhaseStatus) => {
    const { phase: updated, error } = await updateProjectPhase(phase.id, { status });
    if (error || !updated) { toast.error("Could not update phase status", { description: error ?? undefined }); return; }
    setPhases((prev) => prev.map((p) => (p.id === phase.id ? updated : p)));
  };

  const handleAddPhaseTask = async (phaseId: string) => {
    const title = (phaseTaskDrafts[phaseId] ?? "").trim();
    if (!title || addingPhaseTask) return;
    setAddingPhaseTask(phaseId);
    await addTask({ projectId: project.id, phaseId, title, due: new Date().toISOString(), status: "not_started", priority: "med", recurrence: "none" });
    setPhaseTaskDrafts((prev) => ({ ...prev, [phaseId]: "" }));
    setAddingPhaseTask(null);
  };

  const handleAddMilestone = async () => {
    if (!newMilestoneName.trim() || addingMilestone) return;
    setAddingMilestone(true);
    const { milestone, error } = await createProjectMilestone({
      projectId: project.id, name: newMilestoneName.trim(), plannedDate: newMilestoneDate || null, position: milestones.length,
    });
    setAddingMilestone(false);
    if (error || !milestone) { toast.error("Could not add milestone", { description: error ?? undefined }); return; }
    setMilestones((prev) => [...prev, milestone]);
    setNewMilestoneName(""); setNewMilestoneDate("");
  };

  const handleAchieveMilestone = async (milestone: ProjectMilestone) => {
    const { milestone: updated, error } = await achieveMilestone(milestone);
    if (error || !updated) { toast.error("Could not update milestone", { description: error ?? undefined }); return; }
    setMilestones((prev) => prev.map((m) => (m.id === milestone.id ? updated : m)));
    await supabase.from("project_notes").insert({ project_id: project.id, author: "System", body: `Milestone achieved — ${updated.name}.` });
  };

  const handleDeleteMilestone = async (milestone: ProjectMilestone) => {
    if (!window.confirm(`Delete milestone "${milestone.name}"?`)) return;
    const { error } = await deleteProjectMilestone(milestone.id);
    if (error) { toast.error("Could not delete milestone", { description: error }); return; }
    setMilestones((prev) => prev.filter((m) => m.id !== milestone.id));
  };

  const handleAddDependency = async (successorTaskId: string, predecessorTaskId: string) => {
    const { error } = await createTaskDependency({ projectId: project.id, predecessorTaskId, successorTaskId });
    if (error) { toast.error("Could not add dependency", { description: error }); return; }
    setDependencyPickerFor(null);
    void loadPlanningData();
  };

  // ── Phase 13.2 continuation — Project Plan Templates ──────────────────
  const availableTemplates = templatesForProjectType(project.projectType);
  const selectedTemplate = findPlanTemplate(planTemplateKey);
  /** The first Project-Type-matched template, used as the source for the smaller Phase/Milestone/Task template dropdowns below — independent of whatever's picked in the main dropdown, so those stay useful even before the user selects a full plan to apply. */
  const suggestedTemplate = availableTemplates[0];
  const isDuplicateTemplate = selectedTemplate ? hasTemplateBeenApplied(phases, selectedTemplate.key) : false;
  const hasExistingPlan = phases.length > 0 || milestones.length > 0;

  // ── Phase 13.2 continuation — schedule health & upcoming work ─────────
  // Pure derivations from already-loaded phases/milestones/projectTasks/
  // dependencies — no extra queries (Part 28 performance requirement).
  const scheduleHealth = getProjectScheduleHealth({ project, phases, milestones, tasks: projectTasks });
  const nextMilestone = getNextMilestone(milestones);
  const nextUpcomingTask = getNextTask(projectTasks);
  const overdueCounts = getOverdueCounts(milestones, projectTasks);
  const blockedTaskCount = getBlockedTaskCount(projectTasks, dependencies);
  const SCHEDULE_HEALTH_TONE: Record<typeof scheduleHealth.status, string> = {
    not_scheduled: "bg-muted text-muted-foreground border-border",
    on_track: "bg-green-50 text-green-700 border-green-200 dark:bg-green-500/10 dark:text-green-400 dark:border-green-900/40",
    at_risk: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-900/40",
    delayed: "bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-900/40",
    completed: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-900/40",
  };

  const handleApplyTemplate = async (mode: ApplyTemplateMode) => {
    if (!selectedTemplate || applyingTemplate) return;
    setApplyingTemplate(true);
    const { error, summary } = await applyProjectPlanTemplate({
      projectId: project.id,
      template: selectedTemplate,
      planningStartDate: planningStartDate || new Date().toISOString().slice(0, 10),
      mode,
      existingPhases: phases,
      existingMilestones: milestones,
    });
    setApplyingTemplate(false);
    if (error || !summary) { toast.error("Could not apply template", { description: error ?? undefined }); return; }
    setPlanConfirmOpen(false);
    setPlanPreviewOpen(false);
    await loadPlanningData();
    void refreshTasks();
    const summaryText = formatTemplateSummary(summary);
    await supabase.from("project_notes").insert({
      project_id: project.id, author: "System",
      body: `Project plan template applied — "${selectedTemplate.name}" with ${summaryText}.`,
    });
    toast.success(`Applied "${selectedTemplate.name}"`, { description: summaryText });
  };

  /** Case-insensitive name match between a real Phase and a template's phase — the contextual filter for that phase's Task Template dropdown; falls back to the template's full task list when nothing matches so the control is never empty. */
  function taskTemplateOptionsForPhase(phase: ProjectPhase) {
    if (!suggestedTemplate) return [];
    const lower = phase.name.toLowerCase();
    const matched = suggestedTemplate.phases.find((tp) =>
      tp.name.toLowerCase() === lower || lower.includes(tp.name.toLowerCase()) || tp.name.toLowerCase().includes(lower));
    return matched ? suggestedTemplate.tasks.filter((t) => t.phaseKey === matched.key) : suggestedTemplate.tasks;
  }

  /** Shared task row for both the Plan's per-phase lists and Unassigned Tasks — same markup, plus a Blocked badge and a dependency picker driven by the loaded task_dependencies (see Phase 13.2). */
  function renderTaskRow(task: Task) {
    const blocker = getBlockingTask(task.id, dependencies, tasksById);
    return (
      <div key={task.id} className="group flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 hover:bg-secondary/30">
        <button onClick={() => void updateTask(task.id, { status: task.status === "completed" ? "not_started" : "completed" })} className="shrink-0">{STATUS_ICONS[task.status]}</button>
        <div className="min-w-0 flex-1">
          <span className={cn("text-sm", task.status === "completed" && "line-through text-muted-foreground")}>{task.title}</span>
          {blocker && (
            <span className="ml-2 inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
              <Link2 className="h-2.5 w-2.5" />Blocked by {blocker.title}
            </span>
          )}
        </div>
        <Popover open={dependencyPickerFor === task.id} onOpenChange={(o) => setDependencyPickerFor(o ? task.id : null)}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100" title="Add dependency" aria-label={`Add dependency for ${task.title}`}>
              <Link2 className="h-3 w-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-0" align="end">
            <Command>
              <CommandInput placeholder="Depends on…" />
              <CommandList className="max-h-56">
                <CommandEmpty>No other tasks in this Project.</CommandEmpty>
                <CommandGroup>
                  {projectTasks.filter(t => t.id !== task.id).map(t => (
                    <CommandItem key={t.id} value={t.title} onSelect={() => void handleAddDependency(task.id, t.id)}>
                      {t.title}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Flag className={cn("h-3.5 w-3.5 shrink-0", PRIORITY_COLORS[task.priority])} />
        {task.due && <span className="text-[11px] text-muted-foreground shrink-0">{new Date(task.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
        <button onClick={() => void deleteTask(task.id)} className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"><Trash2 className="h-3.5 w-3.5" /></button>
      </div>
    );
  }

  const handleSaveNote = async () => {
    if (!noteInput.trim()) return;
    setSavingNote(true);
    const { data: { user } } = await supabase.auth.getUser();
    const author = user?.user_metadata?.first_name || user?.email?.split("@")[0] || "You";
    const { data } = await supabase.from("project_notes")
      .insert({ project_id: project.id, body: noteInput.trim(), author })
      .select("id, body, created_at, author").single();
    if (data) {
      const n = data as Note;
      setNotes(prev => [n, ...prev]);
      setActivityNotes(prev => [n, ...prev]);
    }
    setNoteInput(""); setSavingNote(false);
  };

  const col        = getColumnForStatus(project.status);
  const stepperIdx = getStepperIndex(project.status);
  const cityLine   = getCityFromAddress(project.address);
  const remaining  = project.budget_total - project.actual_cost;
  const budgetPct  = project.budget_total > 0 ? Math.min(100, Math.round((project.actual_cost / project.budget_total) * 100)) : 0;
  const projId     = `#PRJ-${project.id.slice(0, 6).toUpperCase()}`;

  const SHEET_TABS = [
    { id: "overview",       label: "Overview" },
    { id: "financials",     label: "Financials" },
    { id: "schedule",       label: "Schedule & Tasks" },
    { id: "daily-logs",     label: "Daily Logs" },
    { id: "communications", label: "Communications" },
    { id: "photos",         label: "Photos" },
  ] as const;

  const badgeCls = cn(
    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
    col.dotColor === "bg-green-500"  && "bg-green-100 text-green-700 border-green-200",
    col.dotColor === "bg-sky-500"    && "bg-sky-100 text-sky-700 border-sky-200",
    col.dotColor === "bg-violet-500" && "bg-violet-100 text-violet-700 border-violet-200",
    col.dotColor === "bg-amber-500"  && "bg-amber-100 text-amber-700 border-amber-200",
    col.dotColor === "bg-orange-500" && "bg-orange-100 text-orange-700 border-orange-200",
    col.dotColor === "bg-gray-400"   && "bg-gray-100 text-gray-600 border-gray-200",
  );

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      {/* overflow-hidden (not overflow-y-auto) is deliberate — SheetContent
          is already viewport-height-bounded (h-full via inset-y-0 in
          sheetVariants). Giving it its own scrollbar in addition to the Tab
          content region's overflow-y-auto below produced a redundant outer
          Project detail scrollbar at 90% zoom; the header/KPI/lifecycle/tab
          bar stay put (each shrink-0) and only the tab content region
          scrolls. */}
      <SheetContent side="right" showCloseButton={false} className="w-full sm:max-w-[760px] md:max-w-[900px] lg:max-w-[1080px] xl:max-w-[min(1180px,94vw)] overflow-hidden p-0 flex flex-col">

        {/* Accessibility: visually hidden title for screen readers */}
        <SheetTitle className="sr-only">{project.name} — Project Details</SheetTitle>
        {/* Header */}
        <div className="border-b border-border px-6 py-4 shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
            <span>Projects</span><ChevronRight className="h-3 w-3" />
            <span className="text-foreground font-medium">{project.name}</span>
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-semibold leading-tight">{project.name}</h2>
                <Badge className={badgeCls} variant="outline">
                  <span className={cn("mr-1.5 inline-block h-1.5 w-1.5 rounded-full", col.dotColor)} />{col.label}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {project.client_name}{cityLine && ` · ${cityLine}`}{` · ${projId}`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {project.client_id && (
                <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
                  onClick={() => openContactConversation(navigate, project.client_id)}>
                  <MessageSquare className="h-3.5 w-3.5" />Message
                </Button>
              )}
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
                onClick={() => setPortalInviteOpen(true)}>
                <ExternalLink className="h-3.5 w-3.5" />Client Portal
              </Button>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
                onClick={() => setEditOpen(true)}>
                <Pencil className="h-3.5 w-3.5" />Edit
              </Button>
            </div>
          </div>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-2 gap-3 px-6 pt-5 pb-5 shrink-0 sm:grid-cols-4">
          {[
            { label: "Budget",     main: formatMoney(project.budget_total), sub: `${formatMoney(project.actual_cost)} spent` },
            { label: "Timeline",   main: project.start_date ? new Date(project.start_date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—", sub: project.end_date ? `→ ${new Date(project.end_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : "No end date" },
            { label: "Completion", main: `${displayProgress}%`, progress: true },
            { label: "Stage",      main: col.label, sub: col.description },
          ].map(item => (
            <div key={item.label} className="rounded-lg border border-border bg-muted/30 p-3">
              <p
                className="text-[11px] text-muted-foreground font-medium"
                title={item.progress ? (progressIsManual ? "Manually set progress" : "Estimated from project stage") : undefined}
              >
                {item.label}
              </p>
              <p className="mt-1 text-base font-bold leading-tight">{item.main}</p>
              {item.progress
                ? <Progress value={displayProgress} className="mt-1.5 h-1.5" aria-label={`${project.name} completion — ${progressIsManual ? "manually set" : "estimated from project stage"}`} />
                : <p className="mt-0.5 text-[11px] text-muted-foreground truncate">{(item as any).sub}</p>}
            </div>
          ))}
        </div>

        {/* Stage stepper */}
        <div className="px-6 pb-4 shrink-0">
          <div className="relative flex items-center justify-between">
            <div className="absolute inset-x-0 top-3.5 h-0.5 bg-border" />
            {STEPPER_STAGES.map((stage, idx) => {
              const isDone = idx < stepperIdx; const isCurrent = idx === stepperIdx;
              return (
                <div key={stage.id} className="relative flex flex-col items-center gap-1.5 z-10">
                  <div className={cn("h-7 w-7 rounded-full border-2 flex items-center justify-center text-[10px] font-bold",
                    isDone ? "border-primary bg-primary text-primary-foreground" : isCurrent ? "border-primary bg-background text-primary" : "border-border bg-background text-muted-foreground")}>
                    {isDone ? <Check className="h-3.5 w-3.5" /> : idx + 1}
                  </div>
                  <span className={cn("text-[10px] font-medium whitespace-nowrap", isCurrent ? "text-primary" : "text-muted-foreground")}>{stage.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Tab bar — real Tabs/TabsList/TabsTrigger (role=tablist/tab,
            aria-selected, roving-tabindex arrow-key nav all come from Radix).
            Every tab carries its own visible border (not just the active
            one) with the same warm-cream active background/border pair
            already used on Deal detail tabs (deal-detail-drawer.tsx), so
            Project detail matches the platform's established entity-tab
            treatment instead of a one-off Project color. */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)} className="shrink-0">
          <div className="border-b border-border px-6 py-3 overflow-x-auto">
            <TabsList className="h-auto w-max gap-1.5 bg-transparent p-0">
              {SHEET_TABS.map(t => (
                <TabsTrigger
                  key={t.id} id={`project-tab-${t.id}`} value={t.id} aria-controls={`project-panel-${t.id}`}
                  className="h-9 whitespace-nowrap rounded-md border border-border bg-white px-3.5 text-sm font-medium text-muted-foreground shadow-none transition-colors hover:bg-muted/50 hover:text-foreground
                    data-[state=active]:border-[#EADFC8] data-[state=active]:bg-[#FAF3E4] data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                >
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>

        {/* Tab content — min-h-0 lets this flex child actually shrink to
            the remaining space instead of growing to its content's natural
            height (the classic flexbox trap that would otherwise push the
            content taller than SheetContent and force the parent to scroll
            instead of this element). Overview switches to overflow-hidden
            at lg+ because its own grid below now owns internal per-card
            scrolling — every other tab (and Overview itself below lg, where
            cards stack) keeps this region as the one scroll container,
            which is the preferred/simpler mobile behavior and an
            intentionally-scoped choice for the other four tabs (see the
            Phase report). */}
        <div className={cn("min-h-0 flex-1 overflow-y-auto px-6 py-5", activeTab === "overview" && "lg:overflow-hidden")}>

          {/* ── Overview ── */}
          {activeTab === "overview" && (
            <div
              role="tabpanel" id="project-panel-overview" aria-labelledby="project-tab-overview"
              className="grid grid-cols-1 gap-5 lg:h-full lg:min-h-0 lg:grid-cols-2 lg:grid-rows-2"
            >
              {/* DOM order matches the mobile/tablet stacking order (Scope,
                  Contact, Budget, Activity) — the lg:col/row-start placement
                  below rearranges these same four Cards into a 2x2 grid
                  visually without touching DOM order, so keyboard/screen-
                  reader traversal never disagrees with what's on screen at
                  any width (no CSS `order` trick needed). All four cards are
                  lg:h-full within their equal grid cell — same size — with
                  their own internal overflow-y-auto as a safety net if
                  content ever runs long, instead of growing the grid taller
                  than the drawer. */}
              <Card className="flex flex-col lg:col-start-1 lg:row-start-1 lg:h-full lg:min-h-0 lg:overflow-hidden">
                <CardHeader className="shrink-0 border-b border-[#E5E7EB] bg-gold-soft/50 px-5 py-3"><CardTitle className="text-sm font-semibold leading-5">Scope & Details</CardTitle></CardHeader>
                <CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4">
                    <dl className="grid grid-cols-1 gap-x-5 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
                      <div className="sm:col-span-2 xl:col-span-3">
                        <dt className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">Address</dt>
                        <dd className="mt-0.5 font-medium">{project.address || "—"}</dd>
                      </div>
                      {[
                        ["Status",       col.label],
                        ["Project Type", project.projectType
                          ? (project.projectType === "other" ? (project.customProjectType || "Other") : PROJECT_TYPE_LABELS[project.projectType])
                          : "—"],
                        ["Budget",       formatMoneyFull(project.budget_total)],
                        ["Actual Cost",  formatMoneyFull(project.actual_cost)],
                        ["Start Date",   formatDate(project.start_date)],
                        ["End Date",     formatDate(project.end_date)],
                      ].map(([dt, dd]) => (
                        <div key={dt}>
                          <dt className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">{dt}</dt>
                          <dd className="mt-0.5 font-medium">{dd}</dd>
                        </div>
                      ))}
                    </dl>
                    {(project.estimateId || project.dealId) && (
                      <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
                        {project.estimateId && (
                          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
                            onClick={() => navigate({ to: "/estimates", search: { estimateId: project.estimateId! } })}>
                            <ExternalLink className="h-3.5 w-3.5" />Open Estimate
                          </Button>
                        )}
                        {project.dealId && (
                          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
                            onClick={() => navigate({ to: "/pipeline", search: { dealId: project.dealId! } })}>
                            <ExternalLink className="h-3.5 w-3.5" />Open Deal
                          </Button>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
                <Card className="flex flex-col lg:col-start-2 lg:row-start-1 lg:h-full lg:min-h-0 lg:overflow-hidden">
                  <CardHeader className="shrink-0 border-b border-[#E5E7EB] bg-gold-soft/50 px-5 py-3"><CardTitle className="text-sm font-semibold leading-5">Primary Contact</CardTitle></CardHeader>
                  <CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4">
                    {contact ? (
                      <div className="space-y-4">
                        <div className="flex items-center gap-3">
                          {contact.avatar_url ? (
                            <Avatar className="h-12 w-12 shrink-0 ring-1 ring-black/5">
                              <AvatarImage src={contact.avatar_url} alt={contact.name} className="object-cover" />
                              <AvatarFallback className="bg-primary-soft text-xs font-semibold text-primary">{getInitials(contact.name)}</AvatarFallback>
                            </Avatar>
                          ) : (
                            <ContactAvatar id={contact.id} name={contact.name} avatarKey={contact.avatar_key} size="lg" />
                          )}
                          <div className="min-w-0">
                            <p className="text-sm font-semibold truncate">{contact.name}</p>
                            {contact.company && <p className="text-[11px] text-muted-foreground truncate">{contact.company}</p>}
                          </div>
                        </div>
                        <div className="space-y-2">
                          {contact.email && (
                            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                              <Mail className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate" title={contact.email}>{contact.email}</span>
                            </div>
                          )}
                          {contact.phone && <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><Phone className="h-3.5 w-3.5 shrink-0" /><span>{contact.phone}</span></div>}
                        </div>
                        <Button
                          type="button" variant="outline" size="sm"
                          className="mt-4 h-9 w-full gap-1.5 text-xs"
                          aria-label={`Contact ${contact.name}`}
                          onClick={() => openContactConversation(navigate, project.client_id)}
                        >
                          <MessageSquare className="h-3.5 w-3.5" />Contact
                        </Button>
                      </div>
                    ) : (
                      <div className="py-4 text-center">
                        <User className="mx-auto h-8 w-8 text-muted-foreground/30 mb-2" />
                        <p className="text-sm font-medium">{project.client_name || "No client"}</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">Contact not found in directory</p>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="mt-3 block">
                              <Button type="button" variant="outline" size="sm" className="h-9 w-full gap-1.5 text-xs" disabled>
                                <MessageSquare className="h-3.5 w-3.5" />Contact
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>No Primary Contact is linked to this Project.</TooltipContent>
                        </Tooltip>
                      </div>
                    )}
                  </CardContent>
                </Card>
                <Card className="flex flex-col lg:col-start-2 lg:row-start-2 lg:h-full lg:min-h-0 lg:overflow-hidden">
                  <CardHeader className="shrink-0 border-b border-[#E5E7EB] bg-gold-soft/50 px-5 py-3"><CardTitle className="text-sm font-semibold leading-5">Budget Snapshot</CardTitle></CardHeader>
                  <CardContent className="min-h-0 flex-1 space-y-3.5 overflow-y-auto overscroll-contain px-5 pb-5 pt-4">
                    {[
                      { label: "Total Budget", val: formatMoneyFull(project.budget_total), cls: "" },
                      { label: "Spent",        val: formatMoneyFull(project.actual_cost),  cls: "text-amber-600" },
                      { label: "Remaining",    val: formatMoneyFull(remaining), cls: remaining < 0 ? "text-destructive" : "text-green-600" },
                    ].map(row => (
                      <div key={row.label} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-muted-foreground">{row.label}</span>
                        <span className={cn("shrink-0 whitespace-nowrap font-semibold tabular-nums", row.cls)}>{row.val}</span>
                      </div>
                    ))}
                    <div className="space-y-1.5 pt-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground">Used</span>
                        <span className={cn("font-medium", budgetPct > 90 ? "text-destructive" : "text-foreground")}>{budgetPct}%</span>
                      </div>
                      <Progress value={budgetPct} className={cn("mt-2 h-2", budgetPct > 90 ? "[&>div]:bg-destructive" : budgetPct > 70 ? "[&>div]:bg-amber-500" : "")} />
                    </div>
                  </CardContent>
                </Card>
                <Card className="flex flex-col lg:col-start-1 lg:row-start-2 lg:h-full lg:min-h-0 lg:overflow-hidden">
                  <CardHeader className="shrink-0 border-b border-[#E5E7EB] bg-gold-soft/50 px-5 py-3"><CardTitle className="text-sm font-semibold leading-5">Recent Activity</CardTitle></CardHeader>
                  <CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4">
                    {(() => {
                      type Entry = { id: string; icon: React.ReactNode; tone: string; title: string; sub?: string; at: Date };
                      const entries: Entry[] = [
                        ...projectTasks.map(t => ({
                          id: `task-${t.id}`, at: new Date(t.due),
                          icon: t.status === "completed" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />,
                          tone: t.status === "completed" ? "bg-green-500/10 text-green-600" : "bg-blue-500/10 text-blue-600",
                          title: t.status === "completed" ? `Completed: ${t.title}` : `Task: ${t.title}`,
                          sub: t.priority !== "med" ? `${t.priority} priority` : undefined,
                        })),
                        ...activityNotes.map(n => ({
                          id: `note-${n.id}`, at: new Date(n.created_at),
                          icon: <MessageSquare className="h-3.5 w-3.5" />,
                          tone: "bg-violet-500/10 text-violet-600",
                          title: `Note by ${n.author}`,
                          sub: n.body.length > 60 ? `${n.body.slice(0, 60)}…` : n.body,
                        })),
                      ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 6);
                      if (entries.length === 0) return (
                        <div className="rounded-md border border-dashed border-border py-8 text-center">
                          <p className="text-sm text-muted-foreground">No activity yet — add tasks or notes to see them here</p>
                        </div>
                      );
                      return (
                        <div className="space-y-0">
                          {entries.map((entry, i) => (
                            <div key={entry.id} className="relative flex gap-3 pb-3">
                              {i < entries.length - 1 && <div className="absolute left-3.75 top-7 h-full w-px bg-border" />}
                              <div className={cn("relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-background", entry.tone)}>{entry.icon}</div>
                              <div className="min-w-0 flex-1 pt-1">
                                <div className="flex items-baseline justify-between gap-2">
                                  <p className="truncate text-sm font-medium">{entry.title}</p>
                                  <p className="shrink-0 text-[11px] text-muted-foreground">{entry.at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</p>
                                </div>
                                {entry.sub && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{entry.sub}</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </CardContent>
                </Card>
            </div>
          )}

          {/* ── Schedule & Tasks ── */}
          {activeTab === "schedule" && (
            <div role="tabpanel" id="project-panel-schedule" aria-labelledby="project-tab-schedule" className="space-y-4">

              {/* ── Schedule health + upcoming work (Phase 13.2 continuation) ──
                  Always visible above the subviews below — real data only,
                  derived from the phases/milestones/tasks/dependencies
                  already loaded for this Project, no extra queries. */}
              <div className="flex flex-wrap items-stretch gap-2">
                <div className={cn("flex min-w-40 flex-1 items-center gap-2 rounded-lg border px-3 py-2", SCHEDULE_HEALTH_TONE[scheduleHealth.status])}>
                  <div className="min-w-0">
                    <p className="text-[10px] font-medium uppercase tracking-wide opacity-80">Schedule Health</p>
                    <p className="truncate text-sm font-semibold">{SCHEDULE_HEALTH_LABELS[scheduleHealth.status]}</p>
                    <p className="truncate text-[11px] opacity-90">
                      {scheduleHealth.status === "delayed" && scheduleHealth.delayDays !== null
                        ? `Delayed by ${formatDelay(scheduleHealth.delayDays)}`
                        : scheduleHealth.reasons.length > 0 ? scheduleHealth.reasons[0]
                        : scheduleHealth.status === "on_track" ? "No overdue milestones or tasks"
                        : scheduleHealth.status === "not_scheduled" ? "Add dates to phases, milestones, or tasks"
                        : ""}
                    </p>
                  </div>
                </div>
                <div className="min-w-32 flex-1 rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Next Milestone</p>
                  <p className="truncate text-sm font-semibold">{nextMilestone ? nextMilestone.name : "None scheduled"}</p>
                  {nextMilestone && <p className="truncate text-[11px] text-muted-foreground">{formatDateOnly(nextMilestone.plannedDate)}</p>}
                </div>
                <div className="min-w-32 flex-1 rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Next Task</p>
                  <p className="truncate text-sm font-semibold">{nextUpcomingTask ? nextUpcomingTask.title : "None scheduled"}</p>
                  {nextUpcomingTask && <p className="truncate text-[11px] text-muted-foreground">{formatDateOnly(nextUpcomingTask.dueDateRaw)}</p>}
                </div>
                <div className="min-w-28 flex-1 rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Overdue</p>
                  <p className="text-sm font-semibold">{overdueCounts.tasks + overdueCounts.milestones === 0 ? "None" : overdueCounts.tasks + overdueCounts.milestones}</p>
                  {overdueCounts.tasks + overdueCounts.milestones > 0 && (
                    <p className="truncate text-[11px] text-muted-foreground">{overdueCounts.tasks} task{overdueCounts.tasks === 1 ? "" : "s"} · {overdueCounts.milestones} milestone{overdueCounts.milestones === 1 ? "" : "s"}</p>
                  )}
                </div>
                <div className="min-w-24 flex-1 rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Blocked</p>
                  <p className="text-sm font-semibold">{blockedTaskCount === 0 ? "None" : blockedTaskCount}</p>
                </div>
              </div>

              {/* ── Subviews ── */}
              <Tabs value={scheduleSubview} onValueChange={(v) => setScheduleSubview(v as typeof scheduleSubview)}>
                <div className="overflow-x-auto">
                  <TabsList className="h-auto w-max gap-1.5 bg-transparent p-0">
                    {([
                      ["plan", "Plan"], ["timeline", "Timeline"], ["milestones", "Milestones"], ["tasks", "Tasks"],
                    ] as const).map(([value, label]) => (
                      <TabsTrigger
                        key={value} value={value}
                        className="h-8 whitespace-nowrap rounded-md border border-border bg-white px-3 text-xs font-medium text-muted-foreground shadow-none transition-colors hover:bg-muted/50 hover:text-foreground
                          data-[state=active]:border-[#EADFC8] data-[state=active]:bg-[#FAF3E4] data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                      >
                        {label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
              </Tabs>

              {scheduleSubview === "plan" && (
              <div className="space-y-5">

              {/* ── Project Plan Template (Phase 13.2 continuation) ── */}
              <div className="space-y-2 rounded-lg border border-border bg-secondary/20 p-3">
                <div>
                  <h3 className="text-sm font-semibold">Project Plan Template</h3>
                  <p className="text-xs text-muted-foreground">Use a template to quickly create phases, milestones, and tasks — or build the plan manually below.</p>
                </div>
                {!project.projectType ? (
                  <p className="text-xs text-muted-foreground">Select a Project Type to view planning templates.</p>
                ) : availableTemplates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No planning templates are available for this Project Type. Start manually below.</p>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Select value={planTemplateKey} onValueChange={setPlanTemplateKey}>
                      <SelectTrigger className="h-8 w-72 text-xs" aria-label="Project Plan Template" title={selectedTemplate ? `${selectedTemplate.name} · ${formatTemplateCounts(selectedTemplate.phases.length, selectedTemplate.tasks.length)}` : undefined}>
                        <SelectValue placeholder="Select a template…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectLabel>Built-in Templates</SelectLabel>
                          {availableTemplates.map(t => (
                            <SelectItem key={t.key} value={t.key} className="text-xs" title={`${t.name} · ${formatTemplateCounts(t.phases.length, t.tasks.length)}`}>
                              {t.name} · {formatTemplateCounts(t.phases.length, t.tasks.length)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={!selectedTemplate} onClick={() => setPlanPreviewOpen(true)}>
                      Preview
                    </Button>
                    <Button type="button" size="sm" className="h-8 text-xs" disabled={!selectedTemplate} onClick={() => setPlanConfirmOpen(true)}>
                      Apply Template
                    </Button>
                  </div>
                )}
              </div>

              {/* ── Plan (Phase 13.2) — phases group Tasks; each phase's
                  progress derives from its own Tasks when it has any. ── */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Plan</h3>
                {phasesError && <p className="text-xs text-destructive">{phasesError}</p>}
                <div className="flex flex-wrap gap-2">
                  <Input placeholder="Add a phase…" value={newPhaseName} onChange={e => setNewPhaseName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") void handleAddPhase(); }} className="h-8 min-w-40 flex-1 text-sm" />
                  {suggestedTemplate && (
                    <Select value="" onValueChange={(key) => { const p = suggestedTemplate.phases.find(x => x.key === key); if (p) setNewPhaseName(p.name); }}>
                      <SelectTrigger className="h-8 w-44 text-xs" aria-label="Phase template"><SelectValue placeholder="Phase template…" /></SelectTrigger>
                      <SelectContent>
                        {suggestedTemplate.phases.map(p => <SelectItem key={p.key} value={p.key} className="text-xs">{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                  <Button size="sm" className="h-8 shrink-0" disabled={addingPhase || !newPhaseName.trim()} onClick={() => void handleAddPhase()}>
                    {addingPhase ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  </Button>
                </div>

                {phases.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No phases yet — add one above to start structuring this Project's plan (Estimating, Demolition, Rough-In, etc.).</p>
                ) : (
                  <div className="space-y-3">
                    {phases.map((phase, idx) => {
                      const phaseTasks = projectTasks.filter(t => t.phaseId === phase.id);
                      const progress = getPhaseDisplayProgress(phase, phaseTasks);
                      return (
                        <div key={phase.id} className="rounded-lg border border-border bg-background">
                          <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
                            <div className="flex shrink-0 flex-col">
                              <button type="button" disabled={idx === 0} onClick={() => void handleMovePhase(phase.id, "up")} aria-label={`Move ${phase.name} up`} className="text-muted-foreground hover:text-foreground disabled:opacity-30">
                                <ChevronUp className="h-3 w-3" />
                              </button>
                              <button type="button" disabled={idx === phases.length - 1} onClick={() => void handleMovePhase(phase.id, "down")} aria-label={`Move ${phase.name} down`} className="text-muted-foreground hover:text-foreground disabled:opacity-30">
                                <ChevronDown className="h-3 w-3" />
                              </button>
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">{phase.name}</p>
                              <div className="mt-1 flex items-center gap-2">
                                <Progress value={progress} className="h-1.5 w-24" aria-label={`${phase.name} progress`} />
                                <span className="text-[11px] text-muted-foreground">
                                  {progress}%{phaseTasks.length > 0 && ` · ${phaseTasks.filter(t => t.status === "completed").length}/${phaseTasks.length} tasks`}
                                </span>
                              </div>
                            </div>
                            <Select value={phase.status} onValueChange={v => void handlePhaseStatusChange(phase, v as PhaseStatus)}>
                              <SelectTrigger className="h-7 w-[130px] shrink-0 text-xs" aria-label={`${phase.name} status`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {PHASE_STATUS_ORDER.map(s => <SelectItem key={s} value={s} className="text-xs">{PHASE_STATUS_LABELS[s]}</SelectItem>)}
                              </SelectContent>
                            </Select>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => void handleDeletePhase(phase)} aria-label={`Delete ${phase.name}`}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          <div className="space-y-1 px-3 py-2">
                            {phaseTasks.length === 0 && <p className="py-1 text-xs text-muted-foreground">No tasks in this phase yet.</p>}
                            {phaseTasks.map(task => renderTaskRow(task))}
                            <div className="flex flex-wrap gap-2 pt-1">
                              <Input
                                placeholder="Add a task to this phase…" value={phaseTaskDrafts[phase.id] ?? ""}
                                onChange={e => setPhaseTaskDrafts(prev => ({ ...prev, [phase.id]: e.target.value }))}
                                onKeyDown={e => { if (e.key === "Enter") void handleAddPhaseTask(phase.id); }}
                                className="h-7 min-w-32 flex-1 text-xs"
                              />
                              {suggestedTemplate && (
                                <Select value="" onValueChange={(key) => {
                                  const t = taskTemplateOptionsForPhase(phase).find(x => x.key === key);
                                  if (t) setPhaseTaskDrafts(prev => ({ ...prev, [phase.id]: t.title }));
                                }}>
                                  <SelectTrigger className="h-7 w-40 text-[11px]" aria-label={`Task template for ${phase.name}`}><SelectValue placeholder="Task template…" /></SelectTrigger>
                                  <SelectContent>
                                    {taskTemplateOptionsForPhase(phase).map(t => <SelectItem key={t.key} value={t.key} className="text-xs">{t.title}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              )}
                              <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 text-xs" disabled={addingPhaseTask === phase.id || !(phaseTaskDrafts[phase.id] ?? "").trim()} onClick={() => void handleAddPhaseTask(phase.id)}>
                                {addingPhaseTask === phase.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ── Milestones ── */}
              <div className="space-y-2 border-t border-border pt-4">
                <h3 className="text-sm font-semibold">Milestones</h3>
                <div className="flex flex-wrap gap-2">
                  <Input placeholder="Milestone name…" value={newMilestoneName} onChange={e => setNewMilestoneName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") void handleAddMilestone(); }} className="h-8 min-w-40 flex-1 text-sm" />
                  <Input type="date" value={newMilestoneDate} onChange={e => setNewMilestoneDate(e.target.value)} className="h-8 w-40 text-sm" aria-label="Planned date" />
                  {suggestedTemplate && (
                    <Select value="" onValueChange={(key) => { const m = suggestedTemplate.milestones.find(x => x.key === key); if (m) setNewMilestoneName(m.name); }}>
                      <SelectTrigger className="h-8 w-44 text-xs" aria-label="Milestone template"><SelectValue placeholder="Milestone template…" /></SelectTrigger>
                      <SelectContent>
                        {suggestedTemplate.milestones.map(m => <SelectItem key={m.key} value={m.key} className="text-xs">{m.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                  <Button size="sm" className="h-8 shrink-0" disabled={addingMilestone || !newMilestoneName.trim()} onClick={() => void handleAddMilestone()}>
                    {addingMilestone ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                {milestones.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No milestones yet.</p>
                ) : (
                  <div className="space-y-1">
                    {milestones.map(m => (
                      <div key={m.id} className="group flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2 hover:bg-secondary/30">
                        {m.status === "achieved" ? <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" /> : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />}
                        <span className={cn("flex-1 text-sm", m.status === "achieved" && "line-through text-muted-foreground")}>{m.name}</span>
                        {m.plannedDate && <span className="shrink-0 text-[11px] text-muted-foreground">{formatDate(m.plannedDate)}</span>}
                        {m.status !== "achieved" && (
                          <Button type="button" size="sm" variant="outline" className="h-6 shrink-0 text-[11px]" onClick={() => void handleAchieveMilestone(m)}>Mark Achieved</Button>
                        )}
                        <button onClick={() => void handleDeleteMilestone(m)} className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity" aria-label={`Delete milestone ${m.name}`}><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Unassigned Tasks — the pre-13.2 flat task list, now scoped to Tasks with no phase ── */}
              <div className="space-y-2 border-t border-border pt-4">
                <h3 className="text-sm font-semibold">Unassigned Tasks</h3>
                <div className="flex flex-wrap gap-2">
                  <Input placeholder="Add a task…" value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") void handleAddTask(); }} className="h-8 min-w-40 flex-1 text-sm" />
                  {suggestedTemplate && (
                    <Select value="" onValueChange={(key) => { const t = suggestedTemplate.tasks.find(x => x.key === key); if (t) setNewTaskTitle(t.title); }}>
                      <SelectTrigger className="h-8 w-44 text-xs" aria-label="Task template"><SelectValue placeholder="Task template…" /></SelectTrigger>
                      <SelectContent>
                        {suggestedTemplate.tasks.map(t => <SelectItem key={t.key} value={t.key} className="text-xs">{t.title}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                  <Button size="sm" className="h-8 shrink-0" disabled={addingTask || !newTaskTitle.trim()} onClick={() => void handleAddTask()}>
                    {addingTask ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                {unassignedTasks.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border py-10 text-center">
                    <CheckCircle2 className="mx-auto h-8 w-8 text-muted-foreground/30 mb-2" />
                    <p className="text-sm text-muted-foreground">{projectTasks.length === 0 ? "No tasks yet — add one above" : "All tasks are assigned to a phase"}</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {unassignedTasks.map(task => renderTaskRow(task))}
                  </div>
                )}
                {projectTasks.length > 0 && (
                  <div className="flex items-center gap-4 rounded-lg bg-secondary/40 px-3 py-2 text-[11px] text-muted-foreground">
                    <span>{projectTasks.filter(t => t.status === "completed").length} / {projectTasks.length} done</span>
                    <span>{projectTasks.filter(t => t.status === "in_progress").length} in progress</span>
                    <span>{projectTasks.filter(t => t.priority === "high" && t.status !== "completed").length} high priority</span>
                  </div>
                )}
              </div>

              {/* Linked appointments (Phase 10.3) — real appointments.entity_type="project" rows, shared with the global Calendar page. */}
              <div className="border-t border-border pt-4">
                <EntityAppointmentsPanel
                  entityType="project"
                  entityId={project.id}
                  entityLabel="project"
                  contactName={project.client_name || undefined}
                  contactPhone={contact?.phone || undefined}
                  contactEmail={contact?.email || undefined}
                  address={project.address || contact?.address || undefined}
                />
              </div>
              </div>
              )}

              {/* ── Timeline (Phase 13.2B) — real horizontal Gantt-style
                  timeline on desktop/tablet (phase bars, task bars,
                  milestone markers, Project start/end, Today line, Week/
                  Month/Quarter zoom); the existing chronological agenda is
                  kept as-is and used as the mobile fallback per the spec
                  (Part 13) rather than squeezing the bar chart into a
                  narrow viewport. */}
              {scheduleSubview === "timeline" && (
                <>
                  <div className="hidden lg:block">
                    <ProjectTimelineGantt
                      project={project} phases={phases} milestones={milestones} tasks={projectTasks} dependencies={dependencies}
                      onSelectSubview={(v) => setScheduleSubview(v)}
                    />
                  </div>
                  <div className="lg:hidden">
                    <ProjectTimelineAgenda project={project} phases={phases} milestones={milestones} tasks={projectTasks} />
                  </div>
                </>
              )}

              {/* ── Milestones (dedicated view) ── */}
              {scheduleSubview === "milestones" && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-40 flex-1">
                      <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input placeholder="Search milestones…" value={milestoneSearch} onChange={(e) => setMilestoneSearch(e.target.value)} className="h-8 pl-8 text-sm" />
                    </div>
                    <Select value={milestoneStatusFilter} onValueChange={(v) => setMilestoneStatusFilter(v as typeof milestoneStatusFilter)}>
                      <SelectTrigger className="h-8 w-36 text-xs" aria-label="Filter by status"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all" className="text-xs">All Statuses</SelectItem>
                        {(["pending", "achieved", "missed", "cancelled"] as const).map((s) => <SelectItem key={s} value={s} className="text-xs">{MILESTONE_STATUS_LABELS[s]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Select value={milestonePhaseFilter} onValueChange={setMilestonePhaseFilter}>
                      <SelectTrigger className="h-8 w-36 text-xs" aria-label="Filter by phase"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all" className="text-xs">All Phases</SelectItem>
                        <SelectItem value="none" className="text-xs">No Phase</SelectItem>
                        {phases.map((p) => <SelectItem key={p.id} value={p.id} className="text-xs">{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {(() => {
                    const q = milestoneSearch.trim().toLowerCase();
                    const filtered = milestones
                      .filter((m) => !q || m.name.toLowerCase().includes(q))
                      .filter((m) => milestoneStatusFilter === "all" || m.status === milestoneStatusFilter)
                      .filter((m) => milestonePhaseFilter === "all" || (milestonePhaseFilter === "none" ? !m.phaseId : m.phaseId === milestonePhaseFilter))
                      .sort((a, b) => {
                        const da = parseDateOnlySafe(a.plannedDate);
                        const db = parseDateOnlySafe(b.plannedDate);
                        if (!da && !db) return 0;
                        if (!da) return 1;
                        if (!db) return -1;
                        return da.getTime() - db.getTime();
                      });
                    if (milestones.length === 0) return (
                      <div className="rounded-lg border border-dashed border-border py-10 text-center">
                        <p className="text-sm text-muted-foreground">No milestones yet</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">Add a milestone or apply a Project Plan Template from the Plan tab.</p>
                      </div>
                    );
                    if (filtered.length === 0) return <p className="py-6 text-center text-xs text-muted-foreground">No milestones match your filters.</p>;
                    return (
                      <div className="space-y-1">
                        {filtered.map((m) => {
                          const phase = phases.find((p) => p.id === m.phaseId);
                          const overdueDays = m.status === "pending" ? differenceInCalendarDaysSafe(todayDateOnly(), parseDateOnlySafe(m.plannedDate)) : null;
                          const isOverdue = overdueDays !== null && overdueDays > 0;
                          return (
                            <div key={m.id} className="group flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 hover:bg-secondary/30">
                              {m.status === "achieved" ? <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" /> : isOverdue ? <AlertCircle className="h-4 w-4 shrink-0 text-red-600" /> : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />}
                              <div className="min-w-0 flex-1">
                                <p className={cn("truncate text-sm", m.status === "achieved" && "line-through text-muted-foreground")}>{m.name}</p>
                                <p className="truncate text-[11px] text-muted-foreground">
                                  {phase && `${phase.name} · `}
                                  {m.plannedDate ? formatDateOnly(m.plannedDate) : "No planned date"}
                                  {isOverdue && ` · Overdue by ${formatDelay(overdueDays!)}`}
                                  {m.isCustomerVisible && " · Customer-visible"}
                                </p>
                              </div>
                              {m.status !== "achieved" && (
                                <Button type="button" size="sm" variant="outline" className="h-6 shrink-0 text-[11px]" onClick={() => void handleAchieveMilestone(m)}>Mark Achieved</Button>
                              )}
                              <button onClick={() => void handleDeleteMilestone(m)} className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity" aria-label={`Delete milestone ${m.name}`}><Trash2 className="h-3.5 w-3.5" /></button>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* ── Tasks (dedicated Project-scoped view) ── */}
              {scheduleSubview === "tasks" && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-40 flex-1">
                      <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input placeholder="Search tasks…" value={taskSearch} onChange={(e) => setTaskSearch(e.target.value)} className="h-8 pl-8 text-sm" />
                    </div>
                    <Select value={taskPhaseFilter} onValueChange={setTaskPhaseFilter}>
                      <SelectTrigger className="h-8 w-36 text-xs" aria-label="Filter by phase"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all" className="text-xs">All Phases</SelectItem>
                        <SelectItem value="none" className="text-xs">Unassigned</SelectItem>
                        {phases.map((p) => <SelectItem key={p.id} value={p.id} className="text-xs">{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Select value={taskStatusFilter} onValueChange={(v) => setTaskStatusFilter(v as typeof taskStatusFilter)}>
                      <SelectTrigger className="h-8 w-32 text-xs" aria-label="Filter by status"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all" className="text-xs">All Statuses</SelectItem>
                        {(["not_started", "in_progress", "on_hold", "completed", "cancelled"] as const).map((s) => <SelectItem key={s} value={s} className="text-xs">{s.replace("_", " ")}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Select value={taskFocusFilter} onValueChange={(v) => setTaskFocusFilter(v as typeof taskFocusFilter)}>
                      <SelectTrigger className="h-8 w-32 text-xs" aria-label="Focus filter"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all" className="text-xs">All Tasks</SelectItem>
                        <SelectItem value="overdue" className="text-xs">Overdue</SelectItem>
                        <SelectItem value="blocked" className="text-xs">Blocked</SelectItem>
                        <SelectItem value="unassigned" className="text-xs">Unassigned to Phase</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {(() => {
                    const q = taskSearch.trim().toLowerCase();
                    const today = todayDateOnly();
                    const filtered = projectTasks
                      .filter((t) => !q || t.title.toLowerCase().includes(q))
                      .filter((t) => taskPhaseFilter === "all" || (taskPhaseFilter === "none" ? !t.phaseId : t.phaseId === taskPhaseFilter))
                      .filter((t) => taskStatusFilter === "all" || t.status === taskStatusFilter)
                      .filter((t) => {
                        if (taskFocusFilter === "all") return true;
                        if (taskFocusFilter === "unassigned") return !t.phaseId;
                        if (taskFocusFilter === "overdue") {
                          if (t.status === "completed" || t.status === "cancelled") return false;
                          const d = differenceInCalendarDaysSafe(today, parseDateOnlySafe(t.dueDateRaw));
                          return d !== null && d > 0;
                        }
                        if (taskFocusFilter === "blocked") return !!getBlockingTask(t.id, dependencies, tasksById);
                        return true;
                      })
                      .sort((a, b) => {
                        const da = parseDateOnlySafe(a.dueDateRaw);
                        const db = parseDateOnlySafe(b.dueDateRaw);
                        if (!da && !db) return 0;
                        if (!da) return 1;
                        if (!db) return -1;
                        return da.getTime() - db.getTime();
                      });
                    if (projectTasks.length === 0) return (
                      <div className="rounded-lg border border-dashed border-border py-10 text-center">
                        <p className="text-sm text-muted-foreground">No Project tasks yet</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">Add a task or apply a Project Plan Template from the Plan tab.</p>
                      </div>
                    );
                    if (filtered.length === 0) return <p className="py-6 text-center text-xs text-muted-foreground">No tasks match your filters.</p>;
                    return <div className="space-y-1">{filtered.map((task) => renderTaskRow(task))}</div>;
                  })()}
                </div>
              )}

            </div>
          )}

          {/* ── Financials ── */}
          {activeTab === "financials" && (
            <div role="tabpanel" id="project-panel-financials" aria-labelledby="project-tab-financials" className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Contract Value", val: formatMoneyFull(project.budget_total), cls: "" },
                  { label: "Invoiced",       val: formatMoneyFull(invoices.reduce((s,i) => s + (i.total_amount ?? 0), 0)), cls: "" },
                  { label: "Collected",      val: formatMoneyFull(invoices.reduce((s,i) => s + (i.amount_paid ?? 0), 0)),  cls: "text-green-600" },
                ].map(card => (
                  <div key={card.label} className="rounded-lg border border-border bg-muted/30 p-3">
                    <p className="text-[11px] text-muted-foreground font-medium">{card.label}</p>
                    <p className={cn("mt-1 text-base font-bold tabular-nums", card.cls)}>{card.val}</p>
                  </div>
                ))}
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Invoices</p>
                  <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setInvoiceModalOpen(true)}>
                    <Plus className="h-3 w-3" />New Invoice
                  </Button>
                </div>
                {invoicesLoading ? (
                  <div className="space-y-2">{[...Array(2)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
                ) : invoices.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border py-8 text-center cursor-pointer hover:bg-secondary/20 transition" onClick={() => setInvoiceModalOpen(true)}>
                    <FileText className="mx-auto h-8 w-8 text-muted-foreground/30 mb-2" />
                    <p className="text-sm text-muted-foreground">No invoices yet</p>
                    <p className="text-xs text-muted-foreground mt-1">Click to create one</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {invoices.map(inv => {
                      const isPaid    = inv.status === "paid";
                      const isOverdue = !isPaid && inv.due_date && new Date(inv.due_date) < new Date();
                      return (
                        <div key={inv.id} className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 hover:bg-secondary/20 transition cursor-pointer" onClick={() => setSelectedInvoiceId(inv.id)}>
                          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium">{inv.invoice_number || `INV-${inv.id.slice(0,6).toUpperCase()}`}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {inv.due_date ? `Due ${formatDate(inv.due_date)}` : "No due date"}
                              {inv.amount_paid > 0 && ` · ${formatMoneyFull(inv.amount_paid)} paid`}
                            </p>
                          </div>
                          <p className="text-sm font-semibold tabular-nums shrink-0">{formatMoneyFull(inv.total_amount)}</p>
                          <Badge variant="outline" className={cn("shrink-0 text-[10px] px-1.5",
                            isPaid && "border-green-200 bg-green-50 text-green-700",
                            isOverdue && "border-red-200 bg-red-50 text-red-700",
                            !isPaid && !isOverdue && "border-amber-200 bg-amber-50 text-amber-700")}>
                            {isPaid ? "Paid" : isOverdue ? "Overdue" : inv.status}
                          </Badge>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Cost Breakdown</p>
                {[
                  { label: "Budget",      val: formatMoneyFull(project.budget_total), cls: "" },
                  { label: "Actual cost", val: formatMoneyFull(project.actual_cost),  cls: "text-amber-600" },
                ].map(row => (
                  <div key={row.label} className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{row.label}</span>
                    <span className={cn("font-medium tabular-nums", row.cls)}>{row.val}</span>
                  </div>
                ))}
                <div className="border-t border-border pt-2 flex justify-between text-sm">
                  <span className="text-muted-foreground">Variance</span>
                  <span className={cn("font-semibold tabular-nums", project.budget_total - project.actual_cost >= 0 ? "text-green-600" : "text-destructive")}>
                    {formatMoneyFull(project.budget_total - project.actual_cost)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* ── Communications ── */}
          {activeTab === "communications" && (
            <div role="tabpanel" id="project-panel-communications" aria-labelledby="project-tab-communications" className="space-y-4">
              {contact && (
                <div className="flex gap-2 flex-wrap">
                  {contact.email && <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={() => window.open(`mailto:${contact.email}`)}><Mail className="h-3.5 w-3.5" />Email {contact.name.split(" ")[0]}</Button>}
                  {contact.phone && <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={() => window.open(`sms:${contact.phone}`)}><MessageSquare className="h-3.5 w-3.5" />SMS</Button>}
                  {contact.phone && <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={() => window.open(`tel:${contact.phone}`)}><Phone className="h-3.5 w-3.5" />Call</Button>}
                </div>
              )}
              <div className="rounded-lg border border-border bg-background p-3 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">Add a note</p>
                <textarea value={noteInput} onChange={e => setNoteInput(e.target.value)}
                  placeholder="Write a note about this project…" rows={3}
                  className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring" />
                <div className="flex justify-end">
                  <Button size="sm" className="h-7 text-xs gap-1.5" disabled={!noteInput.trim() || savingNote} onClick={() => void handleSaveNote()}>
                    {savingNote ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}Save note
                  </Button>
                </div>
              </div>
              {notes.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-8 text-center">
                  <MessageSquare className="mx-auto h-8 w-8 text-muted-foreground/30 mb-2" />
                  <p className="text-sm text-muted-foreground">No notes yet</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {notes.map(note => (
                    <div key={note.id} className="rounded-lg border border-border bg-background p-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-semibold">{note.author}</span>
                        <span className="text-[11px] text-muted-foreground">{formatDate(note.created_at)}</span>
                      </div>
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap">{note.body}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Daily Logs (Phase 13.3A) ── */}
          {activeTab === "daily-logs" && <ProjectDailyLogsTab projectId={project.id} />}

          {/* ── Photos (Phase 13.3A — real gallery, see ProjectPhotoGallery) ── */}
          {activeTab === "photos" && <ProjectPhotoGallery projectId={project.id} phases={phases} />}
        </div>
      </SheetContent>

      {/* Modals */}
      <InviteToPortalModal
        open={portalInviteOpen}
        onClose={() => setPortalInviteOpen(false)}
        projectId={project.id}
        projectName={project.name}
        clientEmail={contact?.email}
        clientName={contact?.name}
      />
      <InvoiceModal
        open={invoiceModalOpen}
        onClose={() => setInvoiceModalOpen(false)}
        projectId={project.id}
        clientId={(project as any).client_id ?? ""}
        orgId={(project as any).org_id ?? ""}
        onCreated={() => {
          setInvoiceModalOpen(false);
          setActiveTab("overview");
          setTimeout(() => setActiveTab("financials"), 50);
        }}
      />
      <InvoiceDetailModal
        invoiceId={selectedInvoiceId}
        open={!!selectedInvoiceId}
        onClose={() => setSelectedInvoiceId(null)}
      />
      <EditProjectDialog
        project={project}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSaved={(updated) => { onProjectUpdated(updated); onReload(); }}
      />

      {/* Project Plan Template — Preview */}
      <Dialog open={planPreviewOpen} onOpenChange={setPlanPreviewOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
          <DialogHeader className="shrink-0">
            <DialogTitle>{selectedTemplate?.name}</DialogTitle>
            <DialogDescription>{selectedTemplate?.description}</DialogDescription>
          </DialogHeader>
          {selectedTemplate && (
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
              <p className="text-xs text-muted-foreground">
                {formatTemplateSummary({
                  phaseCount: selectedTemplate.phases.length,
                  milestoneCount: selectedTemplate.milestones.length,
                  taskCount: selectedTemplate.tasks.length,
                  dependencyCount: selectedTemplate.dependencies.length,
                })}
              </p>
              <div className="space-y-2">
                {selectedTemplate.phases.map((p) => {
                  const taskCount = selectedTemplate.tasks.filter((t) => t.phaseKey === p.key).length;
                  const milestoneCount = selectedTemplate.milestones.filter((m) => m.phaseKey === p.key).length;
                  return (
                    <div key={p.key} className="rounded-md border border-border p-2.5">
                      <p className="text-sm font-medium">{p.name} <span className="font-normal text-muted-foreground">· {p.durationDays}d</span></p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {pluralizeCount(taskCount, "task")}{milestoneCount > 0 && ` · ${pluralizeCount(milestoneCount, "milestone")}`}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <DialogFooter className="shrink-0">
            <Button type="button" variant="outline" onClick={() => setPlanPreviewOpen(false)}>Close</Button>
            <Button type="button" onClick={() => { setPlanPreviewOpen(false); setPlanConfirmOpen(true); }}>Apply Template</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Project Plan Template — Apply confirmation (duplicate warning + planning start date + Merge/Replace/Cancel per Part 8) */}
      <Dialog open={planConfirmOpen} onOpenChange={setPlanConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Apply "{selectedTemplate?.name}"?</DialogTitle>
            {hasExistingPlan && (
              <DialogDescription>This Project already contains planning items. Choose how to apply the template.</DialogDescription>
            )}
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {isDuplicateTemplate && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-500/10 dark:text-amber-300">
                This template was already applied to this Project.
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="planning-start-date">Planning start date</Label>
              <Input id="planning-start-date" type="date" value={planningStartDate} onChange={(e) => setPlanningStartDate(e.target.value)} />
              <p className="text-[10.5px] text-muted-foreground">Phase, milestone, and task dates are calculated from this date using the template's durations.</p>
            </div>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={() => setPlanConfirmOpen(false)} disabled={applyingTemplate}>Cancel</Button>
            {hasExistingPlan ? (
              <>
                <Button type="button" variant="outline" disabled={applyingTemplate} onClick={() => void handleApplyTemplate("replace_unstarted")}>
                  {applyingTemplate && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Replace Unstarted Plan
                </Button>
                <Button type="button" disabled={applyingTemplate} onClick={() => void handleApplyTemplate("merge")}>
                  {applyingTemplate && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}{isDuplicateTemplate ? "Merge Anyway" : "Merge with Existing Plan"}
                </Button>
              </>
            ) : (
              <Button type="button" disabled={applyingTemplate} onClick={() => void handleApplyTemplate("empty")}>
                {applyingTemplate && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Apply Template
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </Sheet>
  );
}

// ─── Project Card ─────────────────────────────────────────────────────────────

function ProjectCard({ project: p, contact, onClick, onDelete }: {
  project: Project; contact: Contact | null; onClick: () => void; onDelete: () => void;
}) {
  const age      = daysSince((p as any).created_at);
  const cityLine = getCityFromAddress(p.address);
  const typeTag  = p.name.split(" ")[0] ?? "General";
  const displayProgress = getProjectDisplayProgress(p);
  const progressIsManual = isProgressManual(p);
  return (
    <Card className="cursor-pointer p-0 overflow-hidden transition-shadow hover:shadow-md active:shadow-sm select-none" onClick={onClick}>
      <div className="flex items-start justify-between gap-2 px-3 pt-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">{p.name}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {age > 0 && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{age}d</span>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="-mt-0.5 h-6 w-6 shrink-0" onClick={e => e.stopPropagation()}>
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onClick}>View details</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onSelect={() => onDelete()}>Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Contact row — same shared avatar system as Pipeline's DealCard (ContactAvatar: saved avatar_url > avatarKey > deterministic seed > initials), keyed off project.client_id so the same Contact renders the same avatar everywhere. */}
      <div className="mt-2 flex items-center gap-2 px-3">
        {contact?.avatar_url ? (
          <Avatar className="h-7 w-7 shrink-0 ring-1 ring-black/5">
            <AvatarImage src={contact.avatar_url} alt={p.client_name} className="object-cover" />
            <AvatarFallback className="bg-primary-soft text-[10px] font-semibold text-primary">{getInitials(p.client_name)}</AvatarFallback>
          </Avatar>
        ) : (
          <ContactAvatar id={contact?.id ?? p.client_id} name={p.client_name || "No contact"} avatarKey={contact?.avatar_key} size="sm" className="h-7 w-7" />
        )}
        <div className="min-w-0">
          <p className="truncate text-xs font-medium" title={p.client_name}>{p.client_name || "No contact"}</p>
          {cityLine && <p className="truncate text-[10px] text-muted-foreground">{cityLine}</p>}
        </div>
      </div>

      <div className="mt-2.5 px-3">
        <div className="flex items-center justify-between text-[11px] mb-1">
          <span
            className="font-medium text-foreground"
            title={progressIsManual ? "Manually set progress" : "Estimated from project stage"}
          >
            {displayProgress}%
          </span>
          {p.end_date && <span className="text-muted-foreground">Due {new Date(p.end_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
        </div>
        <Progress value={displayProgress} className="h-1.5" aria-label={`${p.name} completion — ${progressIsManual ? "manually set" : "estimated from project stage"}`} />
      </div>
      <div className="mt-2.5 flex items-center justify-between border-t border-border px-3 py-2.5">
        <span className="text-sm font-semibold tabular-nums text-foreground">{formatMoney(p.budget_total)}</span>
        <Badge variant="secondary" className="h-5 rounded px-1.5 text-[10px] font-medium">{typeTag}</Badge>
      </div>
    </Card>
  );
}

// ─── Board View ───────────────────────────────────────────────────────────────

function BoardView({ projects, contactsById, onCardClick, onDragEnd, onDelete }: {
  projects: Project[]; contactsById: Map<string, Contact>; onCardClick: (p: Project) => void;
  onDragEnd: (result: DropResult) => void; onDelete: (id: string, name: string) => void;
}) {
  const grouped = useMemo(() => {
    const map: Record<string, Project[]> = {};
    for (const col of STAGE_COLUMNS) map[col.id] = [];
    for (const p of projects) map[getColumnForStatus(p.status).id].push(p);
    return map;
  }, [projects]);

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <div className="flex h-full gap-3 pb-4">
        {STAGE_COLUMNS.map(col => {
          const items    = grouped[col.id] ?? [];
          const colValue = items.reduce((s, p) => s + p.budget_total, 0);
          return (
            <Droppable droppableId={col.id} key={col.id}>
              {(provided, snap) => (
                <div ref={provided.innerRef} {...provided.droppableProps}
                  className={cn("flex w-70 shrink-0 flex-col rounded-xl border border-border bg-secondary/40 transition-colors", snap.isDraggingOver && "border-primary/40 bg-primary/5")}>
                  {/* Stage header — white title bar, description directly under the
                      stage name/count/value row, inside the same container. */}
                  <div className="rounded-t-xl border-b border-border bg-white px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", col.dotColor)} />
                      <h3 className="text-[13px] font-semibold flex-1 truncate">{col.label}</h3>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{items.length}</span>
                      <span className="text-[11px] font-medium text-muted-foreground tabular-nums ml-1">{formatMoney(colValue)}</span>
                    </div>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">{col.description}</p>
                  </div>
                  <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2 pt-2">
                    {items.map((p, i) => (
                      <Draggable draggableId={p.id} index={i} key={p.id}>
                        {(drag, snapshot) => (
                          <div ref={drag.innerRef} {...drag.draggableProps} {...drag.dragHandleProps}
                            className={cn("cursor-grab active:cursor-grabbing rounded-xl outline-none", snapshot.isDragging && "opacity-80 rotate-1 shadow-xl scale-[1.02]")}>
                            <ProjectCard project={p} contact={contactsById.get(p.client_id) ?? null} onClick={() => onCardClick(p)} onDelete={() => onDelete(p.id, p.name)} />
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                    {items.length === 0 && <div className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">Drop here</div>}
                  </div>
                </div>
              )}
            </Droppable>
          );
        })}
      </div>
    </DragDropContext>
  );
}

// ─── List View ────────────────────────────────────────────────────────────────

function ListView({ projects, onRowClick, onDelete }: {
  projects: Project[]; onRowClick: (p: Project) => void; onDelete: (id: string, name: string) => void;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <table className="w-full text-sm">
        <thead className="bg-secondary/60 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <tr className="border-b border-border">
            {["Project","Client","Status","Budget","Progress","Dates",""].map((h, i) => (
              <th key={i} className={cn("py-2.5 text-left", i === 0 ? "pl-4 pr-3" : "pr-4", i === 6 && "w-10 pr-3")}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {projects.length === 0 && <tr><td colSpan={7} className="py-12 text-center text-sm text-muted-foreground">No projects found</td></tr>}
          {projects.map(p => {
            const col = getColumnForStatus(p.status);
            const displayProgress = getProjectDisplayProgress(p);
            const progressIsManual = isProgressManual(p);
            return (
              <tr key={p.id} className="border-b border-border hover:bg-secondary/30 cursor-pointer" onClick={() => onRowClick(p)}>
                <td className="py-3 pl-4 pr-3">
                  <div className="font-medium">{p.name}</div>
                  {p.address && <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground"><MapPin className="h-3 w-3" />{p.address}</div>}
                </td>
                <td className="py-3 pr-4 text-muted-foreground">{p.client_name || "—"}</td>
                <td className="py-3 pr-4">
                  <div className="flex items-center gap-1.5">
                    <span className={cn("h-2 w-2 rounded-full shrink-0", col.dotColor)} />
                    <span className="text-[12px] font-medium">{col.label}</span>
                  </div>
                </td>
                <td className="py-3 pr-4 tabular-nums">
                  <div className="text-sm font-semibold">{formatMoney(p.budget_total)}</div>
                  {p.actual_cost > 0 && <div className="text-[11px] text-muted-foreground">{formatMoney(p.actual_cost)} spent</div>}
                </td>
                <td className="py-3 pr-4">
                  <div className="flex items-center gap-2" title={progressIsManual ? "Manually set progress" : "Estimated from project stage"}>
                    <Progress value={displayProgress} className="h-1.5 w-24" aria-label={`${p.name} completion — ${progressIsManual ? "manually set" : "estimated from project stage"}`} />
                    <span className="text-[11px] text-muted-foreground">{displayProgress}%</span>
                  </div>
                </td>
                <td className="py-3 pr-4 text-[11px] text-muted-foreground">
                  {p.start_date && <div className="flex items-center gap-1"><Calendar className="h-3 w-3" />{p.start_date}</div>}
                  {p.end_date && <div className="mt-0.5 text-muted-foreground/70">→ {p.end_date}</div>}
                </td>
                <td className="py-3 pr-3" onClick={e => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-7 w-7"><MoreHorizontal className="h-3.5 w-3.5" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => onRowClick(p)}>View details</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onSelect={() => onDelete(p.id, p.name)}>Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

// ─── New Project Dialog ───────────────────────────────────────────────────────
//
// Project Creation Enhancements pass. Targets the schema added by
// supabase/migrations/20260808_project_creation_enhancements.sql
// (project_type/custom_project_type/priority/owner_id/budget_range/lead_id)
// — requires that migration to be deployed; see the report for the exact
// deployment sequence. Reuses STAGE_COLUMNS (above) for status labels/
// descriptions rather than duplicating them.

type CustomerOption =
  | { kind: "contact"; id: string; name: string; email: string; phone: string; companyName: string | null; address: string | null }
  | { kind: "company"; id: string; name: string; email: string | null; phone: string | null; address: string | null };

type AddressMode = "customer" | "custom";

type NewProjectForm = {
  name: string;
  customer: CustomerOption | null;
  resolvedClientId: string | null;
  projectType: ProjectType | "";
  customProjectType: string;
  addressMode: AddressMode;
  address: string;
  addressTouched: boolean;
  budgetRange: BudgetRange;
  customBudget: string;
  status: ProjectStatus;
  priority: ProjectPriority;
  ownerId: string;
  startDate: string;
  endDate: string;
  scope: string;
};

function emptyProjectForm(defaultOwnerId: string | null): NewProjectForm {
  return {
    name: "", customer: null, resolvedClientId: null,
    projectType: "", customProjectType: "",
    addressMode: "customer", address: "", addressTouched: false,
    budgetRange: "not_specified", customBudget: "",
    status: "planning", priority: "normal", ownerId: defaultOwnerId ?? "unassigned",
    startDate: "", endDate: "", scope: "",
  };
}

/** companies.address/city/state/zip are separate columns — composeAddress avoids the duplicate-looking "city, state, zip, city state zip" output a naive join produces. contacts.address is already one string and needs no composition. */
function companyAddress(c: { address: string | null; city: string | null; state: string | null; zip: string | null }): string | null {
  const composed = composeAddress({ street: c.address, city: c.city, state: c.state, zip: c.zip });
  return composed || null;
}

// ── Save current Project Description / Scope as an organization template ──
// Mirrors estimates.tsx's SaveScopeTemplateDialog exactly (same
// estimate_proposal_templates architecture, category="scope_of_work") so
// Estimates and Projects share one organization Scope library rather than
// two parallel ones.
function SaveProjectScopeTemplateDialog({
  open, workType, content, onClose, onSaved,
}: {
  open: boolean;
  workType: WorkType;
  content: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) setName(""); }, [open]);

  const submit = async (setAsDefault: boolean) => {
    if (saving) return;
    if (!name.trim()) { toast.error("Enter a template name"); return; }
    if (!content.trim()) { toast.error("Description / Scope is empty — nothing to save"); return; }
    setSaving(true);
    const result = await saveOrgTemplate({ category: "scope_of_work", workType, name, content, setAsDefault });
    setSaving(false);
    if (result.error) { toast.error(result.error); return; }
    toast.success(`Saved "${name.trim()}" as an organization Scope template`);
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Save as Organization Template</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="space-y-1">
            <Label htmlFor="proj-scope-tpl-name">Template name</Label>
            <Input id="proj-scope-tpl-name" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Our Standard Kitchen Scope" maxLength={120} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Content preview</Label>
            <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-secondary/30 p-2 text-xs text-muted-foreground">
              {content.trim() || "(empty)"}
            </p>
          </div>
        </div>
        <DialogFooter className="pt-1">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="button" variant="secondary" onClick={() => submit(false)} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save
          </Button>
          <Button type="button" onClick={() => submit(true)} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save &amp; Set as Default
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit Project — Phase 13.2 scope: Project Type + Description/Scope only.
// Name, dates, budget, address still have no edit path yet (see Phase 13.2
// report) — this dialog is deliberately not a full Project editor.
const STATUS_SELECT_OPTIONS: ProjectStatus[] = ["planning", "contracted", "pre-construction", "active", "punch-list", "on-hold", "completed", "cancelled"];

function EditProjectDialog({
  project, open, onClose, onSaved,
}: {
  project: Project | null;
  open: boolean;
  onClose: () => void;
  onSaved: (p: Project) => void;
}) {
  const { templates: orgTemplates, refresh: refreshOrgTemplates } = useOrgTemplates();
  const contacts = useContacts();
  const teamMembers = useTeam().filter((m) => m.status === "active");
  const navigate = useNavigate({ from: "/projects/" });

  const [name, setName] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("planning");
  const [clientId, setClientId] = useState("");
  const [contactOpen, setContactOpen] = useState(false);
  const [contactQuery, setContactQuery] = useState("");
  const [ownerId, setOwnerId] = useState("unassigned");
  const [projectType, setProjectType] = useState<ProjectType | "">("");
  const [customProjectType, setCustomProjectType] = useState("");
  const [priority, setPriority] = useState<ProjectPriority>("normal");
  const [address, setAddress] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [budgetTotal, setBudgetTotal] = useState("0");
  const [actualCost, setActualCost] = useState("0");
  const [description, setDescription] = useState("");
  /** String, not number — a blank field must be able to mean "no manual value" (null on save), which a numeric state can't represent without either forcing 0 or fighting the input while the user is mid-edit. */
  const [completionInput, setCompletionInput] = useState("");
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [pendingType, setPendingType] = useState<ProjectType | null>(null);
  const [templateSelectOpen, setTemplateSelectOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);

  useEffect(() => {
    if (!open || !project) return;
    setName(project.name);
    setStatus(project.status);
    setClientId(project.client_id);
    setContactQuery("");
    setOwnerId(project.ownerId ?? "unassigned");
    setProjectType(project.projectType ?? "");
    setCustomProjectType(project.customProjectType ?? "");
    setPriority(project.priority);
    setAddress(project.address ?? "");
    setStartDate(project.start_date ?? "");
    setEndDate(project.end_date ?? "");
    setBudgetTotal(String(project.budget_total ?? 0));
    setActualCost(String(project.actual_cost ?? 0));
    setDescription(project.description ?? "");
    setCompletionInput(project.completion_percentage === null ? "" : String(project.completion_percentage));
    setCompletionError(null);
    setErrors({});
  }, [open, project?.id]);

  function handleCompletionChange(raw: string) {
    setCompletionInput(raw);
    if (raw.trim() === "") { setCompletionError(null); return; }
    if (!/^\d+$/.test(raw.trim())) { setCompletionError("Enter a whole number"); return; }
    const n = Number(raw.trim());
    setCompletionError(n < 0 || n > 100 ? "Must be between 0 and 100" : null);
  }

  const workTypes: WorkType[] = projectType ? PROJECT_TYPE_TO_WORK_TYPES[projectType] : [];
  const builtinPresets = useMemo(
    () => workTypes.flatMap((wt) => scopePresetsForWorkType(wt)),
    [projectType],
  );
  const orgPresets = useMemo(
    () => workTypes.flatMap((wt) => getScopeTemplates(orgTemplates, wt)),
    [projectType, orgTemplates],
  );

  function applyTemplate(value: string) {
    if (value === "blank") {
      if (description.trim() && !window.confirm("Clear the current Description / Scope text?")) return;
      setDescription("");
      return;
    }
    if (value.startsWith("builtin:")) {
      const preset = findScopePreset(value.slice(8));
      if (preset) setDescription(preset.content);
      return;
    }
    if (value.startsWith("org:")) {
      const tpl = orgPresets.find((t) => t.id === value.slice(4));
      if (tpl) setDescription(tpl.content);
    }
  }

  function commitTypeChange(pt: ProjectType) {
    setProjectType(pt);
    if (pt !== "other") setCustomProjectType("");
  }

  /** Non-empty Description/Scope requires the Keep/Choose/Cancel confirmation instead of silently overwriting — same rule as the Estimate Work Type picker. */
  function handleTypeSelect(v: string) {
    const pt = v as ProjectType;
    if (pt === projectType) return;
    if (description.trim()) { setPendingType(pt); return; }
    commitTypeChange(pt);
  }

  const selectedContact = contacts.find((c) => c.id === clientId) ?? null;
  const filteredContacts = useMemo(() => {
    const q = contactQuery.trim().toLowerCase();
    const list = !q ? contacts : contacts.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      (c.email ?? "").toLowerCase().includes(q) ||
      (c.phone ?? "").toLowerCase().includes(q) ||
      (c.company ?? "").toLowerCase().includes(q));
    return list.slice(0, 50);
  }, [contacts, contactQuery]);

  function validate(): boolean {
    const next: Record<string, string> = {};
    const trimmedName = name.trim();
    if (!trimmedName) next.name = "Project name is required.";
    else if (trimmedName.length > 120) next.name = "Keep the project name under 120 characters.";

    if (!clientId) next.contact = "Select a Primary Contact.";
    if (!projectType) next.projectType = "Select a Project Type.";
    if (projectType === "other" && !customProjectType.trim()) next.customProjectType = "Enter a custom project type.";

    const startObj = startDate ? new Date(`${startDate}T00:00:00`) : null;
    const endObj = endDate ? new Date(`${endDate}T00:00:00`) : null;
    if (startObj && endObj && endObj.getTime() < startObj.getTime()) next.endDate = "End Date cannot be earlier than Start Date.";

    const budgetNum = budgetTotal.trim() === "" ? 0 : Number(budgetTotal);
    if (Number.isNaN(budgetNum) || budgetNum < 0) next.budgetTotal = "Enter a budget of 0 or more.";
    const actualNum = actualCost.trim() === "" ? 0 : Number(actualCost);
    if (Number.isNaN(actualNum) || actualNum < 0) next.actualCost = "Enter an actual cost of 0 or more.";

    if (completionError) next.completion = completionError;

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSave() {
    if (!project || saving) return;
    if (!validate()) { toast.error("Fix the highlighted fields before saving."); return; }
    setSaving(true);

    // Status changes go through the canonical helper FIRST — it owns the
    // progress-on-completion rule, the one "marked Completed" activity
    // note, and the one workflow event. updateProject() below never touches
    // status or completion_percentage-on-completion, so the two calls can
    // never race or double-log for the same change (Part 21).
    if (status !== project.status) {
      const { error: statusErr } = await updateProjectStatus(project.id, status);
      if (statusErr) {
        setSaving(false);
        toast.error("Could not update status", { description: statusErr.message ?? String(statusErr) });
        return;
      }
    }

    const completionPercentage = completionInput.trim() === "" ? null : Number(completionInput.trim());
    const { error, project: updated } = await updateProject(project.id, {
      name: name.trim(),
      clientId,
      ownerId: ownerId === "unassigned" ? null : ownerId,
      projectType: projectType || undefined,
      customProjectType: projectType === "other" ? customProjectType.trim() : null,
      description: description.trim() || null,
      completionPercentage,
      address: address.trim() || null,
      startDate: startDate || null,
      endDate: endDate || null,
      budgetTotal: budgetTotal.trim() === "" ? 0 : Number(budgetTotal),
      actualCost: actualCost.trim() === "" ? 0 : Number(actualCost),
      priority,
    });
    setSaving(false);
    if (error || !updated) { toast.error("Could not save changes", { description: error?.message ?? String(error) }); return; }
    toast.success("Project updated");
    onSaved(updated);
    onClose();
  }

  if (!project) return null;

  const sectionHeading = (label: string, first?: boolean) => (
    <p className={cn("text-[11px] font-semibold uppercase tracking-wide text-muted-foreground", !first && "border-t border-border pt-4")}>{label}</p>
  );

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="flex max-h-[92dvh] flex-col p-0 sm:max-w-[680px] md:max-w-[760px] lg:max-w-[820px]">
          <DialogHeader className="shrink-0 border-b border-border px-6 py-4"><DialogTitle>Edit Project</DialogTitle></DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5 text-sm">
            {sectionHeading("Project Details", true)}
            <div className="space-y-1.5">
              <Label htmlFor="edit-proj-name">Project name <span className="text-destructive">*</span></Label>
              <Input
                id="edit-proj-name" value={name} onChange={(e) => setName(e.target.value)}
                aria-invalid={!!errors.name} aria-describedby={errors.name ? "edit-proj-name-error" : undefined}
              />
              {errors.name && <p id="edit-proj-name-error" className="text-xs text-destructive">{errors.name}</p>}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="edit-proj-status">Status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as ProjectStatus)}>
                  <SelectTrigger id="edit-proj-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUS_SELECT_OPTIONS.map((s) => {
                      const col = STAGE_COLUMNS.find((c) => c.dbStatus === s);
                      const label = s === "on-hold" ? "On Hold" : s === "cancelled" ? "Cancelled" : col?.label ?? s;
                      return <SelectItem key={s} value={s}>{label}</SelectItem>;
                    })}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-proj-priority">Priority</Label>
                <Select value={priority} onValueChange={(v) => setPriority(v as ProjectPriority)}>
                  <SelectTrigger id="edit-proj-priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROJECT_PRIORITY_ORDER.map((p) => (
                      <SelectItem key={p} value={p}>
                        <span className="flex items-center gap-1.5"><Flag className={cn("h-3 w-3", PROJECT_PRIORITY_TINT[p].icon)} /> {PROJECT_PRIORITY_LABELS[p]}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-proj-type">Project type <span className="text-destructive">*</span></Label>
              <Select value={projectType} onValueChange={handleTypeSelect}>
                <SelectTrigger id="edit-proj-type" aria-invalid={!!errors.projectType}><SelectValue placeholder="Select a project type…" /></SelectTrigger>
                <SelectContent>
                  {PROJECT_TYPE_ORDER.map((t) => <SelectItem key={t} value={t}>{PROJECT_TYPE_LABELS[t]}</SelectItem>)}
                </SelectContent>
              </Select>
              {errors.projectType && <p className="text-xs text-destructive">{errors.projectType}</p>}
              {projectType === "other" && (
                <div className="space-y-1.5 pt-1">
                  <Label htmlFor="edit-proj-custom-type">Custom project type <span className="text-destructive">*</span></Label>
                  <Input id="edit-proj-custom-type" value={customProjectType} onChange={(e) => setCustomProjectType(e.target.value)} placeholder="e.g. Deck construction" aria-invalid={!!errors.customProjectType} />
                  {errors.customProjectType && <p className="text-xs text-destructive">{errors.customProjectType}</p>}
                </div>
              )}
            </div>

            {sectionHeading("Customer & Ownership")}
            <div className="space-y-1.5">
              <Label>Primary Contact <span className="text-destructive">*</span></Label>
              <Popover open={contactOpen} onOpenChange={setContactOpen}>
                <PopoverTrigger asChild>
                  {selectedContact ? (
                    <button type="button" className="flex w-full items-center gap-2.5 rounded-md border border-border bg-secondary/30 px-3 py-2 text-left hover:bg-secondary/50">
                      {selectedContact.avatar_url ? (
                        <Avatar className="h-8 w-8 shrink-0 ring-1 ring-black/5">
                          <AvatarImage src={selectedContact.avatar_url} alt={selectedContact.name} className="object-cover" />
                          <AvatarFallback className="bg-primary-soft text-[10px] font-semibold text-primary">{getInitials(selectedContact.name)}</AvatarFallback>
                        </Avatar>
                      ) : (
                        <ContactAvatar id={selectedContact.id} name={selectedContact.name} avatarKey={selectedContact.avatar_key} size="sm" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{selectedContact.name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {[selectedContact.email, selectedContact.phone].filter(Boolean).join(" · ")}
                          {selectedContact.company ? ` · ${selectedContact.company}` : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">Change</span>
                    </button>
                  ) : (
                    <Button type="button" variant="outline" className={cn("w-full justify-between font-normal text-muted-foreground", errors.contact && "border-destructive")}>
                      Search contacts…
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  )}
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput placeholder="Search by name, email, phone, or account…" value={contactQuery} onValueChange={setContactQuery} />
                    <CommandList className="max-h-64">
                      <CommandEmpty>No contacts found.</CommandEmpty>
                      <CommandGroup>
                        {filteredContacts.map((c) => (
                          <CommandItem key={c.id} value={c.id} onSelect={() => { setClientId(c.id); setContactOpen(false); setContactQuery(""); }}>
                            <ContactAvatar id={c.id} name={c.name} avatarKey={c.avatar_key} size="xs" className="mr-2" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm">{c.name}</div>
                              {(c.email || c.phone || c.company) && (
                                <div className="truncate text-xs text-muted-foreground">
                                  {[c.email, c.phone, c.company].filter(Boolean).join(" · ")}
                                </div>
                              )}
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {errors.contact && <p className="text-xs text-destructive">{errors.contact}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-proj-owner">Owner</Label>
              <Select value={ownerId} onValueChange={setOwnerId}>
                <SelectTrigger id="edit-proj-owner"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {teamMembers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <span className="flex items-center gap-2"><ContactAvatarIcon name={m.name} /> {m.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {sectionHeading("Location & Schedule")}
            <div className="space-y-1.5">
              <Label htmlFor="edit-proj-address">Address</Label>
              <AddressAutocomplete
                value={address}
                onChange={setAddress}
                onSelect={(parts) => setAddress([parts.street, parts.city, `${parts.state} ${parts.zip}`].filter(Boolean).join(", "))}
                placeholder="Start typing an address…"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="edit-proj-start">Start date</Label>
                <Input id="edit-proj-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-proj-end">End date</Label>
                <Input id="edit-proj-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} aria-invalid={!!errors.endDate} />
                {errors.endDate && <p className="text-xs text-destructive">{errors.endDate}</p>}
              </div>
            </div>

            {sectionHeading("Financials")}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="edit-proj-budget">Budget</Label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                  <DecimalInput id="edit-proj-budget" value={budgetTotal} onChange={setBudgetTotal} className="pl-6" aria-invalid={!!errors.budgetTotal} />
                </div>
                {errors.budgetTotal && <p className="text-xs text-destructive">{errors.budgetTotal}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-proj-actual">Actual cost</Label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                  <DecimalInput id="edit-proj-actual" value={actualCost} onChange={setActualCost} className="pl-6" aria-invalid={!!errors.actualCost} />
                </div>
                {errors.actualCost && <p className="text-xs text-destructive">{errors.actualCost}</p>}
              </div>
            </div>

            {sectionHeading("Scope & Progress")}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="edit-proj-scope">Description / Scope</Label>
                <div className="flex items-center gap-1">
                  <Select value="" onValueChange={applyTemplate} open={templateSelectOpen} onOpenChange={setTemplateSelectOpen} disabled={!projectType}>
                    <SelectTrigger className="h-6 w-52 text-[10.5px]" aria-label="Description / Scope template"><SelectValue placeholder="Select template…" /></SelectTrigger>
                    <SelectContent>
                      {builtinPresets.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>Built-in Templates</SelectLabel>
                          {builtinPresets.map((p) => <SelectItem key={p.id} value={`builtin:${p.id}`} className="text-xs">{p.name}</SelectItem>)}
                        </SelectGroup>
                      )}
                      {orgPresets.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>Organization Templates</SelectLabel>
                          {orgPresets.map((t) => <SelectItem key={t.id} value={`org:${t.id}`} className="text-xs">{t.name}{t.is_default ? " · Default" : ""}</SelectItem>)}
                        </SelectGroup>
                      )}
                      <SelectItem value="blank" className="text-xs">Start Blank</SelectItem>
                    </SelectContent>
                  </Select>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button type="button" variant="ghost" size="icon" className="h-6 w-6" disabled={!projectType || !description.trim()} onClick={() => setSaveTemplateOpen(true)} aria-label="Save Description / Scope as organization template">
                        <Save className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Save as organization template</TooltipContent>
                  </Tooltip>
                </div>
              </div>
              {!projectType && <p className="text-[10.5px] text-muted-foreground">Select a Project Type to view Scope templates.</p>}
              <Textarea
                id="edit-proj-scope" rows={9} value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the work included in this project…"
                className="min-h-45"
              />
            </div>
            <div className="space-y-1.5 sm:w-1/2">
              <Label htmlFor="edit-proj-completion">Completion percentage</Label>
              <Input
                id="edit-proj-completion" type="text" inputMode="numeric" value={completionInput}
                onChange={(e) => handleCompletionChange(e.target.value)}
                placeholder="Leave blank for automatic progress"
                aria-invalid={!!completionError}
              />
              {completionError
                ? <p className="text-xs text-destructive">{completionError}</p>
                : <p className="text-[10.5px] text-muted-foreground">Track overall job completion. Stage changes may increase the minimum progress but will not reduce a higher manual value.</p>}
            </div>

            {(project.estimateId || project.dealId) && (
              <>
                {sectionHeading("Linked Records")}
                <div className="flex flex-wrap gap-2">
                  {project.estimateId && (
                    <Button type="button" variant="outline" size="sm" className="gap-1.5 text-xs"
                      onClick={() => navigate({ to: "/estimates", search: { estimateId: project.estimateId! } })}>
                      <ExternalLink className="h-3.5 w-3.5" />Open Estimate
                    </Button>
                  )}
                  {project.dealId && (
                    <Button type="button" variant="outline" size="sm" className="gap-1.5 text-xs"
                      onClick={() => navigate({ to: "/pipeline", search: { dealId: project.dealId! } })}>
                      <ExternalLink className="h-3.5 w-3.5" />Open Deal
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>

          <DialogFooter className="shrink-0 border-t border-border bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="button" onClick={() => void handleSave()} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SaveProjectScopeTemplateDialog
        open={saveTemplateOpen}
        workType={workTypes[0] ?? "other"}
        content={description}
        onClose={() => setSaveTemplateOpen(false)}
        onSaved={() => { refreshOrgTemplates(); setSaveTemplateOpen(false); }}
      />

      {/* Project Type change confirmation — never silently overwrite non-empty Description/Scope. */}
      <AlertDialog open={!!pendingType} onOpenChange={(o) => !o && setPendingType(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change Project Type?</AlertDialogTitle>
            <AlertDialogDescription>
              This Project already has Description / Scope content. Would you like to keep it or choose a template for the new Project Type?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel onClick={() => setPendingType(null)}>Cancel</AlertDialogCancel>
            <Button
              type="button" variant="outline"
              onClick={() => { if (pendingType) commitTypeChange(pendingType); setPendingType(null); }}
            >
              Keep Current Scope
            </Button>
            <AlertDialogAction
              onClick={() => {
                if (pendingType) commitTypeChange(pendingType);
                setPendingType(null);
                setTemplateSelectOpen(true);
              }}
            >
              Choose New Template
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function NewProjectDialog({
  open, onClose, onCreated, initialContext,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** Deep-link prefill from a Contact/Account "New Project" entry point (Part 26/27) — applied once per open, never overwrites a customer the user already picked. */
  initialContext?: { contactId?: string; companyId?: string } | null;
}) {
  const contacts = useContacts();
  const companies = useCompanies();
  const teamMembers = useTeam().filter((m) => m.status === "active");

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id ?? null));
  }, [open]);

  const [form, setForm] = useState<NewProjectForm>(() => emptyProjectForm(null));
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");
  const [pendingCustomerAddress, setPendingCustomerAddress] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof NewProjectForm, string>>>({});

  // Default owner = current user, once known and confirmed to be a real
  // active member of this org (never assumed) — only applied to a still-
  // untouched, freshly-opened form, never overwriting a user's own choice.
  useEffect(() => {
    if (!open || !currentUserId) return;
    setForm((f) => (f.ownerId === "unassigned" ? { ...f, ownerId: teamMembers.some((m) => m.id === currentUserId) ? currentUserId : f.ownerId } : f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentUserId, teamMembers.length]);

  const handleClose = () => {
    setForm(emptyProjectForm(null));
    setCustomerOpen(false);
    setCustomerQuery("");
    setPendingCustomerAddress(null);
    setErrors({});
    onClose();
  };

  // ── Customer / Account search — real, org-scoped Contacts + Accounts
  // already loaded by their own stores, merged and filtered client-side
  // (same no-extra-query pattern as src/components/appointments/entity-picker.tsx).
  const customerOptions = useMemo<CustomerOption[]>(() => {
    const contactOpts: CustomerOption[] = contacts.map((c) => ({
      kind: "contact", id: c.id, name: c.name, email: c.email, phone: c.phone,
      companyName: c.companyName ?? (c.company || null),
      address: c.address || null,
    }));
    const companyOpts: CustomerOption[] = companies.map((co) => ({
      kind: "company", id: co.id, name: co.name, email: co.email, phone: co.phone,
      address: companyAddress(co),
    }));
    return [...contactOpts, ...companyOpts];
  }, [contacts, companies]);

  const filteredCustomers = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    if (!q) return customerOptions.slice(0, 50);
    return customerOptions.filter((o) =>
      o.name.toLowerCase().includes(q) ||
      (o.email ?? "").toLowerCase().includes(q) ||
      (o.phone ?? "").toLowerCase().includes(q) ||
      (o.kind === "contact" && (o.companyName ?? "").toLowerCase().includes(q)),
    ).slice(0, 50);
  }, [customerOptions, customerQuery]);

  const [resolvingClient, setResolvingClient] = useState(false);

  /**
   * Resolves the real contacts.id a project's NOT NULL client_id FK
   * requires. Contact -> itself. Company -> its Primary Contact, resolved
   * via the SAME company_contacts query the Account detail page's Primary
   * Contact card uses (see resolvePrimaryContactForCompany) — NOT a
   * contacts.company_id filter, which under-reports because that column is
   * only ever the contact's single *default* company and is not guaranteed
   * to be set for every company_contacts association (documented gap in
   * companies-store.ts). Returns null only when the Account truly has zero
   * linked contacts.
   */
  async function resolveClientId(customer: CustomerOption): Promise<string | null> {
    if (customer.kind === "contact") return customer.id;
    const orgId = await getOrgId();
    if (!orgId) return null;
    const primary = await resolvePrimaryContactForCompany(customer.id, orgId);
    return primary?.id ?? null;
  }

  async function applyCustomer(customer: CustomerOption) {
    setResolvingClient(true);
    const resolvedClientId = await resolveClientId(customer);
    setResolvingClient(false);
    const resolvedAddress = customer.address ?? "";

    setForm((f) => {
      const hasManualAddress = f.addressTouched && f.address.trim().length > 0;
      if (hasManualAddress && f.customer) {
        // Conflict — don't silently overwrite a manually-edited address;
        // surface the compact inline confirmation instead (Part 20).
        setPendingCustomerAddress(resolvedAddress || null);
        return { ...f, customer, resolvedClientId };
      }
      return {
        ...f, customer, resolvedClientId,
        address: resolvedAddress, addressMode: "customer", addressTouched: false,
      };
    });
    setCustomerOpen(false);
    setCustomerQuery("");
  }

  function clearCustomer() {
    setForm((f) => ({ ...f, customer: null, resolvedClientId: null }));
    setPendingCustomerAddress(null);
  }

  // Deep-link prefill (Contact/Account "New Project" entry points) — applies
  // once per open, only while the customer field is still untouched, so it
  // never clobbers a manual selection. Also defaults Project Name from the
  // Account/Contact name (Part 6/21) — only when the name is still blank,
  // never overwriting anything the user already typed.
  useEffect(() => {
    if (!open || !initialContext) return;
    if (initialContext.contactId) {
      const c = contacts.find((x) => x.id === initialContext.contactId);
      if (c) {
        void applyCustomer({ kind: "contact", id: c.id, name: c.name, email: c.email, phone: c.phone, companyName: c.companyName ?? c.company, address: c.address || null });
        setForm((f) => (f.name.trim() ? f : { ...f, name: `${c.name} Project` }));
      }
    } else if (initialContext.companyId) {
      const co = companies.find((x) => x.id === initialContext.companyId);
      if (co) {
        void applyCustomer({ kind: "company", id: co.id, name: co.name, email: co.email, phone: co.phone, address: companyAddress(co) });
        setForm((f) => (f.name.trim() ? f : { ...f, name: `${co.name} Project` }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialContext, contacts, companies]);

  const selectedStage = STAGE_COLUMNS.find((c) => c.dbStatus === form.status) ?? STAGE_COLUMNS[0];
  const startDateObj = form.startDate ? new Date(`${form.startDate}T00:00:00`) : null;
  const endDateObj = form.endDate ? new Date(`${form.endDate}T00:00:00`) : null;

  function validate(): boolean {
    const next: Partial<Record<keyof NewProjectForm, string>> = {};
    const trimmedName = form.name.trim();
    if (!trimmedName) next.name = "Project name is required.";
    else if (trimmedName.length > 120) next.name = "Keep the project name under 120 characters.";

    if (!form.customer) next.customer = "Select a Customer / Account.";
    else if (!form.resolvedClientId) next.customer = "This account has no contacts yet — select a contact instead, or add one to the account first.";

    if (!form.projectType) next.projectType = "Select a project type.";
    if (form.projectType === "other" && !form.customProjectType.trim()) next.customProjectType = "Enter a custom project type.";

    if (form.budgetRange === "custom") {
      const n = Number(form.customBudget);
      if (!form.customBudget.trim() || Number.isNaN(n)) next.customBudget = "Enter an estimated budget.";
      else if (n < 0) next.customBudget = "Budget cannot be negative.";
      else if (n > 100_000_000) next.customBudget = "Enter a realistic budget amount.";
    }

    if (startDateObj && endDateObj && endDateObj.getTime() < startDateObj.getTime()) {
      next.endDate = "Estimated Completion cannot be earlier than Estimated Start.";
    }

    if (form.scope.length > 2000) next.scope = "Keep the scope under 2000 characters.";

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (saving) return; // duplicate-submit guard (Part 18/26)
    if (!validate()) { toast.error("Fix the highlighted fields before creating the project."); return; }

    setSaving(true);

    const budgetTotal = form.budgetRange === "custom"
      ? Number(form.customBudget)
      : budgetRangeMidpoint(form.budgetRange) ?? undefined;

    const input: CreateProjectInput = {
      name: form.name.trim(),
      client_id: form.resolvedClientId!,
      status: form.status,
      address: form.address.trim() || undefined,
      budget_total: budgetTotal,
      budgetRange: form.budgetRange,
      start_date: form.startDate || undefined,
      end_date: form.endDate || undefined,
      description: form.scope.trim() || undefined,
      projectType: form.projectType || undefined,
      customProjectType: form.projectType === "other" ? form.customProjectType.trim() : undefined,
      priority: form.priority,
      ownerId: form.ownerId === "unassigned" ? null : form.ownerId,
    };

    const { error } = await createProject(input);
    setSaving(false);
    if (error) {
      toast.error("Could not create the project", { description: error.message ?? String(error) });
      return; // form state is preserved — nothing is reset on failure
    }
    toast.success(`${form.name} created`);
    onCreated();
    handleClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>New Project</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-1">
            {/* 1. Project Name */}
            <div className="space-y-1.5">
              <Label htmlFor="proj-name">Project name <span className="text-destructive">*</span></Label>
              <Input
                id="proj-name" value={form.name} autoFocus
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Kitchen remodel" aria-invalid={!!errors.name} aria-describedby={errors.name ? "proj-name-error" : undefined}
              />
              {errors.name && <p id="proj-name-error" className="text-xs text-destructive">{errors.name}</p>}
            </div>

            {/* 2. Customer / Account */}
            <div className="space-y-1.5">
              <Label>Customer / Account <span className="text-destructive">*</span></Label>
              {form.customer ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2">
                  {form.customer.kind === "contact" ? <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{form.customer.name}</span>
                      <Badge variant="outline" className="h-4.5 shrink-0 rounded px-1.5 text-[9.5px]">
                        {form.customer.kind === "contact" ? "Contact" : "Account"}
                      </Badge>
                    </div>
                    {(form.customer.email || form.customer.phone) && (
                      <div className="truncate text-[11px] text-muted-foreground">
                        {[form.customer.email, form.customer.phone].filter(Boolean).join(" · ")}
                        {form.customer.kind === "contact" && form.customer.companyName ? ` · ${form.customer.companyName}` : ""}
                      </div>
                    )}
                  </div>
                  <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={clearCustomer} aria-label="Clear selected customer">
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <Popover open={customerOpen} onOpenChange={setCustomerOpen}>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="outline" className={cn("w-full justify-between font-normal text-muted-foreground", errors.customer && "border-destructive")}>
                      Search contacts or accounts…
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                    <Command shouldFilter={false}>
                      <CommandInput placeholder="Search by name, email, phone, or account…" value={customerQuery} onValueChange={setCustomerQuery} />
                      <CommandList className="max-h-64">
                        <CommandEmpty>No contacts or accounts found.</CommandEmpty>
                        <CommandGroup>
                          {filteredCustomers.map((o) => (
                            <CommandItem key={`${o.kind}-${o.id}`} value={`${o.kind}-${o.id}`} onSelect={() => void applyCustomer(o)}>
                              {o.kind === "contact" ? <UserRound className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <Building2 className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate text-sm">{o.name}</span>
                                  <Badge variant="outline" className="h-4 shrink-0 rounded px-1 text-[9px]">{o.kind === "contact" ? "Contact" : "Account"}</Badge>
                                  {!o.address && <span className="shrink-0 text-[9px] text-muted-foreground">no address</span>}
                                </div>
                                {(o.email || o.phone) && <div className="truncate text-xs text-muted-foreground">{[o.email, o.phone].filter(Boolean).join(" · ")}</div>}
                              </div>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}
              {errors.customer && <p className="text-xs text-destructive">{errors.customer}</p>}

              {pendingCustomerAddress !== null && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-500/10 dark:text-amber-300">
                  <span>Replace the current project address with the newly selected customer's address?</span>
                  <div className="flex shrink-0 gap-1.5">
                    <Button type="button" size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => setPendingCustomerAddress(null)}>Keep current</Button>
                    <Button type="button" size="sm" className="h-6 text-[11px]" onClick={() => {
                      setForm((f) => ({ ...f, address: pendingCustomerAddress ?? "", addressMode: "customer", addressTouched: false }));
                      setPendingCustomerAddress(null);
                    }}>Use customer address</Button>
                  </div>
                </div>
              )}
            </div>

            {/* 3. Project Type */}
            <div className="space-y-1.5">
              <Label htmlFor="proj-type">Project type <span className="text-destructive">*</span></Label>
              <Select value={form.projectType} onValueChange={(v) => setForm((f) => ({ ...f, projectType: v as ProjectType }))}>
                <SelectTrigger id="proj-type" aria-invalid={!!errors.projectType}><SelectValue placeholder="Select a project type…" /></SelectTrigger>
                <SelectContent>
                  {PROJECT_TYPE_ORDER.map((t) => <SelectItem key={t} value={t}>{PROJECT_TYPE_LABELS[t]}</SelectItem>)}
                </SelectContent>
              </Select>
              {errors.projectType && <p className="text-xs text-destructive">{errors.projectType}</p>}
              {form.projectType === "other" && (
                <div className="space-y-1.5 pt-1">
                  <Label htmlFor="proj-custom-type">Custom project type <span className="text-destructive">*</span></Label>
                  <Input id="proj-custom-type" value={form.customProjectType} onChange={(e) => setForm((f) => ({ ...f, customProjectType: e.target.value }))} placeholder="e.g. Deck construction" />
                  {errors.customProjectType && <p className="text-xs text-destructive">{errors.customProjectType}</p>}
                </div>
              )}
            </div>

            {/* 4-5. Project address mode + AddressAutocomplete */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="proj-address-mode">Project address</Label>
                {form.customer && (
                  <Select value={form.addressMode} onValueChange={(v) => setForm((f) => ({ ...f, addressMode: v as AddressMode, ...(v === "custom" ? { address: "", addressTouched: true } : { address: f.customer?.address ?? "", addressTouched: false }) }))}>
                    <SelectTrigger id="proj-address-mode" className="h-7 w-[200px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="customer">Use customer address</SelectItem>
                      <SelectItem value="custom">Enter a different address</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
              {form.customer && !form.customer.address && form.addressMode === "customer" && (
                <p className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  <AlertCircle className="h-3 w-3 shrink-0" /> No address is available for this customer — enter one below.
                </p>
              )}
              <AddressAutocomplete
                value={form.address}
                onChange={(v) => setForm((f) => ({ ...f, address: v, addressTouched: true }))}
                onSelect={(parts) => setForm((f) => ({ ...f, address: [parts.street, parts.city, `${parts.state} ${parts.zip}`].filter(Boolean).join(", "), addressTouched: true }))}
                placeholder="Start typing an address…"
              />
            </div>

            {/* 6-7. Budget Range + Custom amount */}
            <div className="space-y-1.5">
              <Label htmlFor="proj-budget-range">Budget range</Label>
              <Select value={form.budgetRange} onValueChange={(v) => setForm((f) => ({ ...f, budgetRange: v as BudgetRange }))}>
                <SelectTrigger id="proj-budget-range"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {BUDGET_RANGE_ORDER.map((r) => <SelectItem key={r} value={r}>{BUDGET_RANGE_LABELS[r]}</SelectItem>)}
                </SelectContent>
              </Select>
              {form.budgetRange === "custom" && (
                <div className="space-y-1.5 pt-1">
                  <Label htmlFor="proj-custom-budget">Estimated budget <span className="text-destructive">*</span></Label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                    <Input
                      id="proj-custom-budget" type="number" min="0" step="0.01" inputMode="decimal"
                      className="pl-6" value={form.customBudget}
                      onChange={(e) => setForm((f) => ({ ...f, customBudget: e.target.value }))}
                      placeholder="75,000" aria-invalid={!!errors.customBudget}
                    />
                  </div>
                  {errors.customBudget && <p className="text-xs text-destructive">{errors.customBudget}</p>}
                </div>
              )}
            </div>

            {/* 8. Status + Priority */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="proj-status">Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as ProjectStatus }))}>
                  <SelectTrigger id="proj-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STAGE_COLUMNS.map((c) => <SelectItem key={c.dbStatus} value={c.dbStatus}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">{selectedStage.description}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="proj-priority">Priority</Label>
                <Select value={form.priority} onValueChange={(v) => setForm((f) => ({ ...f, priority: v as ProjectPriority }))}>
                  <SelectTrigger id="proj-priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROJECT_PRIORITY_ORDER.map((p) => (
                      <SelectItem key={p} value={p}>
                        <span className="flex items-center gap-1.5">
                          <Flag className={cn("h-3 w-3", PROJECT_PRIORITY_TINT[p].icon)} /> {PROJECT_PRIORITY_LABELS[p]}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* 9. Project Owner */}
            <div className="space-y-1.5">
              <Label htmlFor="proj-owner">Project owner</Label>
              <Select value={form.ownerId} onValueChange={(v) => setForm((f) => ({ ...f, ownerId: v }))}>
                <SelectTrigger id="proj-owner"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {teamMembers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <span className="flex items-center gap-2">
                        <ContactAvatarIcon name={m.name} /> {m.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 10. Estimated Start + Estimated Completion */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="proj-start">Estimated start</Label>
                <Input id="proj-start" type="date" value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="proj-end">Estimated completion</Label>
                <Input id="proj-end" type="date" value={form.endDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} aria-invalid={!!errors.endDate} />
                {errors.endDate && <p className="text-xs text-destructive">{errors.endDate}</p>}
              </div>
            </div>

            {/* 11. Description / Scope */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="proj-scope">Description / Scope</Label>
                <span className="text-[10px] text-muted-foreground">{form.scope.length}/2000</span>
              </div>
              <Textarea
                id="proj-scope" rows={3} maxLength={2000} value={form.scope}
                onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}
                placeholder="Kitchen cabinets, countertops, flooring, lighting, and appliance installation."
              />
              {errors.scope && <p className="text-xs text-destructive">{errors.scope}</p>}
            </div>
          </div>

          <DialogFooter className="mt-3 shrink-0 border-t border-border pt-3">
            <Button type="button" variant="outline" onClick={handleClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving || resolvingClient}>
              {(saving || resolvingClient) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {saving ? "Creating…" : resolvingClient ? "Resolving contact…" : "Create Project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Tiny inline initials avatar for the owner Select's options — Select item content can't safely host the full ContactAvatar (image loading inside a closed listbox), so this is a lightweight local stand-in. */
function ContactAvatarIcon({ name }: { name: string }) {
  const initials = name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
  return (
    <span className="grid h-4.5 w-4.5 shrink-0 place-items-center rounded-full bg-secondary text-[8px] font-semibold text-muted-foreground">
      {initials}
    </span>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function ProjectsPage() {
  const { slug, projectId, openNew, contactId, companyId, tab, subview, task, milestone, phase } = useSearch({ from: "/projects/" });
  const navigate = useNavigate({ from: "/projects/" });
  const { projects, loading, reload } = useProjects();
  const contacts = useContacts();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [view,      setView]      = useState<View>("board");
  const [search,    setSearch]    = useState("");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectContext, setNewProjectContext] = useState<{ contactId?: string; companyId?: string } | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [optimisticStatuses, setOptimisticStatuses] = useState<Record<string, ProjectStatus>>({});
  // Phase 13.2B — Calendar → Project deep-link context (Part 28/29), consumed once by ProjectDetailSheet then left alone (not re-applied on every reopen).
  const [deepLink, setDeepLink] = useState<{ tab?: ProjectsSearch["tab"]; subview?: ProjectsSearch["subview"]; taskId?: string; milestoneId?: string; phaseId?: string } | null>(null);

  const openDetail  = useCallback((p: Project) => { setSelectedProject(p); setSheetOpen(true); }, []);
  const closeDetail = useCallback(() => { setSheetOpen(false); }, []);

  // Deep-link support: old /projects/$clientSlug links (e.g. from Inbox)
  // now redirect here with ?slug=... so they open the real detail sheet
  // instead of a separate mock-data page.
  useEffect(() => {
    if (!slug || loading) return;
    const match = projects.find((p) => p.slug === slug);
    if (match) openDetail(match);
    navigate({ search: (s) => ({ ...s, slug: undefined }), replace: true });
  }, [slug, loading, projects, openDetail, navigate]);

  // "Open Project" links from Estimate/Deal detail — by id, since a Project
  // may not have a slug set. Also carries the optional Calendar deep-link
  // context (tab/subview/task/milestone/phase) — an unknown/invalid
  // project id simply finds no match and fails safely (no crash, no sheet).
  useEffect(() => {
    if (!projectId || loading) return;
    const match = projects.find((p) => p.id === projectId);
    if (match) {
      if (tab || subview || task || milestone || phase) {
        setDeepLink({ tab, subview, taskId: task, milestoneId: milestone, phaseId: phase });
      }
      openDetail(match);
    }
    navigate({ search: (s) => ({ ...s, projectId: undefined, tab: undefined, subview: undefined, task: undefined, milestone: undefined, phase: undefined }), replace: true });
  }, [projectId, loading, projects, tab, subview, task, milestone, phase, openDetail, navigate]);

  // New Project deep-link prefill from Contact/Account detail (Part 26/27) —
  // same shape as the Estimates page's own contactId/companyId/openNew handling.
  useEffect(() => {
    if (!openNew) return;
    setNewProjectContext(contactId || companyId ? { contactId, companyId } : null);
    setNewProjectOpen(true);
    navigate({ search: (s) => ({ ...s, openNew: undefined, contactId: undefined, companyId: undefined }), replace: true });
  }, [openNew, contactId, companyId, navigate]);

  const counts = useMemo(() => ({
    active:    projects.filter(p => ACTIVE_STATUSES.includes(p.status)).length,
    "on-hold": projects.filter(p => p.status === "on-hold").length,
    cancelled: projects.filter(p => p.status === "cancelled").length,
    completed: projects.filter(p => p.status === "completed").length,
    all:       projects.length,
  }), [projects]);

  const contactsById = useMemo(() => {
    const map = new Map<string, Contact>();
    for (const c of contacts) map.set(c.id, c);
    return map;
  }, [contacts]);

  const kpis = useMemo(() => {
    const active        = projects.filter(p => ACTIVE_STATUSES.includes(p.status));
    const pipelineValue = active.reduce((s, p) => s + p.budget_total, 0);
    const avgValue      = active.length > 0 ? pipelineValue / active.length : 0;
    const completed     = projects.filter(p => p.status === "completed" && p.start_date && p.end_date);
    const avgCycle      = completed.length > 0
      ? completed.reduce((s, p) => s + Math.round((new Date(p.end_date!).getTime() - new Date(p.start_date!).getTime()) / (1000 * 60 * 60 * 24)), 0) / completed.length
      : 0;
    return { pipelineValue, avgValue, avgCycle: Math.round(avgCycle), onHold: counts["on-hold"] };
  }, [projects, counts]);

  const projectsWithOptimistic = useMemo(() =>
    projects.map(p => optimisticStatuses[p.id] ? { ...p, status: optimisticStatuses[p.id] } : p),
    [projects, optimisticStatuses]);

  const filteredProjects = useMemo(() => {
    const q = search.toLowerCase();
    return projectsWithOptimistic.filter(p => {
      const matchStatus =
        statusFilter === "all"       ? true :
        statusFilter === "active"    ? ACTIVE_STATUSES.includes(p.status) :
        statusFilter === "on-hold"   ? p.status === "on-hold" :
        statusFilter === "cancelled" ? p.status === "cancelled" :
        p.status === "completed";
      if (!matchStatus) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.client_name.toLowerCase().includes(q) || (p.address ?? "").toLowerCase().includes(q);
    });
  }, [projectsWithOptimistic, statusFilter, search]);

  const onDragEnd = async (result: DropResult) => {
    const { destination, source, draggableId } = result;
    if (!destination || destination.droppableId === source.droppableId) return;
    const destCol = STAGE_COLUMNS.find(c => c.id === destination.droppableId);
    if (!destCol) return;
    setOptimisticStatuses(prev => ({ ...prev, [draggableId]: destCol.dbStatus }));
    const { error } = await updateProjectStatus(draggableId, destCol.dbStatus);
    if (error) {
      setOptimisticStatuses(prev => { const n = { ...prev }; delete n[draggableId]; return n; });
      toast.error("Failed to update stage"); return;
    }
    toast.success(`Moved to ${destCol.label}`);
    reload();
    setOptimisticStatuses(prev => { const n = { ...prev }; delete n[draggableId]; return n; });
  };

  const handleDelete = async (id: string, name: string) => {
    const { error } = await supabase.from("projects").delete().eq("id", id);
    if (error) { toast.error("Failed to delete project"); return; }
    toast.success(`${name} deleted`);
    if (selectedProject?.id === id) setSheetOpen(false);
    reload();
  };

  const subtitle = counts.active > 0
    ? `${counts.active} active ${counts.active === 1 ? "project" : "projects"} · ${formatMoney(kpis.pipelineValue)} total value`
    : "No active projects yet";

  if (loading) return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><Skeleton className="h-7 w-32 mb-2" /><Skeleton className="h-4 w-48" /></div>
        <div className="flex gap-2"><Skeleton className="h-8 w-20" /><Skeleton className="h-8 w-28" /></div>
      </div>
      <div className="grid grid-cols-4 gap-4">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
      <div className="flex gap-3">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-72 w-70 rounded-xl" />)}</div>
    </div>
  );

  return (
    // Height ownership: the app shell's <main> (src/components/layout/app-shell.tsx)
    // is already the exact remaining-viewport box via flexbox (h-dvh column,
    // Topbar h-16, main flex-1) — its content-box height (after main's own
    // p-6) is a precise, always-correct value. h-full fills exactly that,
    // so the board below can own its own scrolling (flex-1 + overflow-hidden,
    // per-column overflow-y-auto) without main ever needing to scroll too.
    // Previously this used a hand-guessed h-[calc(100vh-5rem)] (100vh minus
    // an estimate for the topbar) paired with a -mb-6 to reclaim main's
    // bottom padding — the estimate didn't quite match the real topbar +
    // padding total, so the page rendered a few px taller than main's
    // content box, and main's own overflow-y-auto showed a small page-level
    // scrollbar for that difference (worse at 90% zoom due to rounding).
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PageHeader icon={FolderOpen} iconBg="bg-info-soft" iconColor="text-info" title="Projects" subtitle={subtitle}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm"><Download className="mr-1.5 h-3.5 w-3.5" />Export</Button>
            <Button size="sm" className="h-8" onClick={() => { setNewProjectContext(null); setNewProjectOpen(true); }}><Plus className="mr-1.5 h-3.5 w-3.5" />New Project</Button>
          </div>
        } />

      <div className="mb-4 flex gap-4 shrink-0">
        <MetricCard icon={TrendingUp} label="Active Project Value" value={formatMoney(kpis.pipelineValue)} sub={`across ${counts.active} active ${counts.active === 1 ? "project" : "projects"}`} tone="info" className="flex-1 min-w-0" />
        <MetricCard icon={DollarSign} label="Average Project Value" value={formatMoney(kpis.avgValue)}      sub="per active project"                    tone="success" className="flex-1 min-w-0" />
        <MetricCard icon={Clock}      label="Average Cycle Time"    value={kpis.avgCycle > 0 ? `${kpis.avgCycle}d` : "—"} sub="from start to completion" tone="violet" className="flex-1 min-w-0" />
        <MetricCard icon={PauseCircle} label="On Hold"              value={String(kpis.onHold)}             sub="projects paused"                       tone="warning" className="flex-1 min-w-0" />
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-b border-border pb-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search projects" placeholder="Search projects…" value={search} onChange={e => setSearch(e.target.value)} className="h-8 w-52 pl-8 text-xs" />
        </div>
        <Select defaultValue="all">
          <SelectTrigger aria-label="Owner filter" className="h-8 w-32 text-xs"><SelectValue placeholder="Owner: All" /></SelectTrigger>
          <SelectContent><SelectItem value="all">Owner: All</SelectItem></SelectContent>
        </Select>
        <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
              <Filter className="h-3.5 w-3.5" />Filters
              {statusFilter !== "active" && (
                <span className="ml-0.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">1</span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-2">
            <p className="px-1.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Status</p>
            <div className="space-y-0.5">
              {STATUS_FILTER_OPTIONS.map(opt => (
                <button
                  key={opt.id}
                  onClick={() => { setStatusFilter(opt.id); setFiltersOpen(false); }}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    statusFilter === opt.id ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-secondary/60",
                  )}
                >
                  {opt.label}
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold">{counts[opt.id]}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <div className="flex items-center rounded-md border border-border p-0.5">
          <Button variant={view === "board" ? "secondary" : "ghost"} size="sm" className="h-7 px-2" onClick={() => setView("board")} title="Board view"><LayoutGrid className="h-3.5 w-3.5" /></Button>
          <Button variant={view === "list"  ? "secondary" : "ghost"} size="sm" className="h-7 px-2" onClick={() => setView("list")}  title="List view"><ListIcon   className="h-3.5 w-3.5" /></Button>
        </div>
      </div>

      {/* min-h-0 lets this flex child actually shrink to the remaining
          space instead of growing to its content's natural height (the
          classic flexbox trap that would otherwise push the page taller
          than its parent again). overflow-auto is kept on both axes
          deliberately: Board view needs horizontal scroll for the 6
          columns at narrower widths, while List view (the table) has no
          internal scroll region of its own and relies on this wrapper's
          vertical scroll for a long project list — Board view never
          triggers that vertical scrollbar in practice since each column
          already owns its own overflow-y-auto and the wrapper is correctly
          height-bounded by the page root above. */}
      <div className="min-h-0 flex-1 overflow-auto pt-4">
        {view === "board"
          ? <BoardView projects={filteredProjects} contactsById={contactsById} onCardClick={openDetail} onDragEnd={onDragEnd} onDelete={handleDelete} />
          : <ListView  projects={filteredProjects} onRowClick={openDetail}  onDelete={handleDelete} />}
      </div>

      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => { setNewProjectOpen(false); setNewProjectContext(null); }}
        onCreated={reload}
        initialContext={newProjectContext}
      />
      <ProjectDetailSheet
        project={selectedProject} open={sheetOpen} onClose={closeDetail} onReload={reload} onProjectUpdated={setSelectedProject}
        deepLink={deepLink} onDeepLinkConsumed={() => setDeepLink(null)}
      />
    </div>
  );
}