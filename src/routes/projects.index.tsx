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
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Plus, Search, LayoutGrid, List as ListIcon, Download, Loader2, MapPin,
  MoreHorizontal, ChevronsUpDown, Check, Mail, Phone, MessageSquare, X,
  TrendingUp, Clock, PauseCircle, DollarSign, Filter, ChevronRight, Calendar,
  User, Circle, CheckCircle2, AlertCircle, XCircle, FileText, Send, Trash2, Flag,
  ExternalLink, ImageIcon, Camera, FolderOpen, Building2, UserRound,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  useProjects, updateProjectStatus, createProject,
  type Project, type ProjectStatus, type CreateProjectInput,
} from "@/lib/projects-store";
import { useContacts } from "@/lib/contacts-store";
import { useCompanies } from "@/lib/companies-store";
import { useTeam } from "@/lib/organization";
import { composeAddress } from "@/lib/address";
import {
  PROJECT_TYPE_ORDER, PROJECT_TYPE_LABELS, PROJECT_PRIORITY_ORDER, PROJECT_PRIORITY_LABELS,
  PROJECT_PRIORITY_TINT, BUDGET_RANGE_ORDER, BUDGET_RANGE_LABELS, budgetRangeMidpoint,
  type ProjectType, type ProjectPriority, type BudgetRange,
} from "@/lib/project-status";
import { useTasks, addTask, updateTask, deleteTask } from "@/lib/tasks-store";
import { EntityAppointmentsPanel } from "@/components/appointments/entity-appointments-panel";
import type { Task } from "@/lib/mock-data";
import { supabase } from "@/lib/supabase";
import { InviteToPortalModal } from "@/components/portal/InviteToPortalModal";
import { InvoiceModal } from "@/components/projects/InvoiceModal";
import { InvoiceDetailModal } from "@/components/projects/InvoiceDetailModal";

type ProjectsSearch = { slug?: string };

export const Route = createFileRoute("/projects/")({
  validateSearch: (raw: Record<string, unknown>): ProjectsSearch => ({
    slug: typeof raw.slug === "string" ? raw.slug : undefined,
  }),
  component: ProjectsPage,
});

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab  = "active" | "on-hold" | "cancelled";
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

type ProjectFile = {
  id: string; file_name: string; file_path: string; file_type: string | null;
  mime_type: string | null; description: string | null; created_at: string;
};

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

// ─── KPI Card ─────────────────────────────────────────────────────────────────

// ─── Project Detail Sheet ─────────────────────────────────────────────────────

function ProjectDetailSheet({ project, open, onClose, onReload }: {
  project: Project | null; open: boolean; onClose: () => void; onReload: () => void;
}) {
  const contacts = useContacts();
  const allTasks = useTasks();

  const [activeTab,        setActiveTab]        = useState<"overview" | "financials" | "schedule" | "communications" | "photos">("overview");
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
  const [lightboxPhoto,      setLightboxPhoto]      = useState<{ url: string; name: string } | null>(null);
  const [photos,           setPhotos]            = useState<ProjectFile[]>([]);
  const [photosLoading,    setPhotosLoading]     = useState(false);
  const [uploading,        setUploading]         = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) setActiveTab("overview"); }, [open, project?.id]);

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

  useEffect(() => {
    if (activeTab !== "photos" || !project) return;
    setPhotosLoading(true);
    supabase.from("project_files").select("*")
      .eq("project_id", project.id)
      .or("mime_type.ilike.image/%,file_type.eq.image")
      .order("created_at", { ascending: false })
      .then(({ data }) => { setPhotos((data ?? []) as ProjectFile[]); setPhotosLoading(false); });
  }, [activeTab, project?.id]);

  if (!project) return null;

  const projectTasks = allTasks.filter(t => t.projectId === project.id);
  const contact      = contacts.find(c => c.id === (project as any).client_id || c.name === project.client_name);

  const handleAddTask = async () => {
    if (!newTaskTitle.trim()) return;
    setAddingTask(true);
    await addTask({ projectId: project.id, title: newTaskTitle.trim(), due: new Date().toISOString(), status: "not_started", priority: "med", recurrence: "none" });
    setNewTaskTitle(""); setAddingTask(false);
  };

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

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setUploading(true);
    const { data: { user } } = await supabase.auth.getUser();
    // Resolve orgId — prefer from project obj, fall back to user profile
    let uploadOrgId: string | null = (project as any).org_id ?? null;
    if (!uploadOrgId && user) {
      const { data: prof } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
      uploadOrgId = prof?.organization_id ?? null;
    }
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const ext  = file.name.split(".").pop();
      const path = `${project.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { error: upErr } = await supabase.storage.from("project-photos").upload(path, file, { contentType: file.type });
      if (upErr) { toast.error(`Failed to upload ${file.name}`); continue; }
      const { error: dbErr } = await supabase.from("project_files").insert({
        org_id:     uploadOrgId,
        project_id: project.id,
        file_name:  file.name,
        file_path:  path,
        file_type:  "image",
        mime_type:  file.type,
        file_size:  file.size,
        uploaded_by: user?.id,
      });
      if (dbErr) console.error("[photo upload] db insert failed:", dbErr.message);
    }
    const { data } = await supabase.from("project_files").select("*")
      .eq("project_id", project.id)
      .or("mime_type.ilike.image/%,file_type.eq.image")
      .order("created_at", { ascending: false });
    setPhotos((data ?? []) as ProjectFile[]);
    setUploading(false);
    toast.success(`${files.length} photo${files.length > 1 ? "s" : ""} uploaded`);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const col        = getColumnForStatus(project.status);
  const stepperIdx = getStepperIndex(project.status);
  const cityLine   = getCityFromAddress(project.address);
  const remaining  = project.budget_total - project.actual_cost;
  const budgetPct  = project.budget_total > 0 ? Math.min(100, Math.round((project.actual_cost / project.budget_total) * 100)) : 0;
  const projId     = `#PRJ-${project.id.slice(0, 6).toUpperCase()}`;
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;

  const SHEET_TABS = [
    { id: "overview",       label: "Overview" },
    { id: "financials",     label: "Financials" },
    { id: "schedule",       label: "Schedule & Tasks" },
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
      <SheetContent side="right" className="w-full sm:max-w-170 overflow-y-auto p-0 flex flex-col">

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
            <div className="flex items-center gap-2 shrink-0">
              {contact?.email && (
                <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
                  onClick={() => window.open(`mailto:${contact.email}`)}>
                  <MessageSquare className="h-3.5 w-3.5" />Message
                </Button>
              )}
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
                onClick={() => setPortalInviteOpen(true)}>
                <ExternalLink className="h-3.5 w-3.5" />Client Portal
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-2 gap-3 px-6 py-4 shrink-0 sm:grid-cols-4">
          {[
            { label: "Budget",     main: formatMoney(project.budget_total), sub: `${formatMoney(project.actual_cost)} spent` },
            { label: "Timeline",   main: project.start_date ? new Date(project.start_date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—", sub: project.end_date ? `→ ${new Date(project.end_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : "No end date" },
            { label: "Completion", main: `${project.completion_percentage}%`, progress: true },
            { label: "Stage",      main: col.label, sub: col.description },
          ].map(item => (
            <div key={item.label} className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground font-medium">{item.label}</p>
              <p className="mt-1 text-base font-bold leading-tight">{item.main}</p>
              {item.progress ? <Progress value={project.completion_percentage} className="mt-1.5 h-1.5" /> : <p className="mt-0.5 text-[11px] text-muted-foreground truncate">{(item as any).sub}</p>}
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

        {/* Tab bar */}
        <div className="flex border-b border-border px-6 shrink-0 overflow-x-auto">
          {SHEET_TABS.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)}
              className={cn("pb-2.5 pt-1 mr-5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                activeTab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">

          {/* ── Overview ── */}
          {activeTab === "overview" && (
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-3 sm:col-span-2 space-y-4">
                <Card>
                  <CardHeader className="pb-2 pt-4 px-4"><CardTitle className="text-sm font-semibold">Scope & Details</CardTitle></CardHeader>
                  <CardContent className="px-4 pb-4">
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                      {[
                        ["Address",     project.address || "—"],
                        ["Status",      col.label],
                        ["Budget",      formatMoneyFull(project.budget_total)],
                        ["Actual Cost", formatMoneyFull(project.actual_cost)],
                        ["Start Date",  formatDate(project.start_date)],
                        ["End Date",    formatDate(project.end_date)],
                      ].map(([dt, dd]) => (
                        <div key={dt}>
                          <dt className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">{dt}</dt>
                          <dd className="mt-0.5 font-medium">{dd}</dd>
                        </div>
                      ))}
                    </dl>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2 pt-4 px-4"><CardTitle className="text-sm font-semibold">Recent Activity</CardTitle></CardHeader>
                  <CardContent className="px-4 pb-4">
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
              <div className="col-span-3 sm:col-span-1 space-y-4">
                <Card>
                  <CardHeader className="pb-2 pt-4 px-4"><CardTitle className="text-sm font-semibold">Primary Contact</CardTitle></CardHeader>
                  <CardContent className="px-4 pb-4">
                    {contact ? (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">{getInitials(contact.name)}</div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold truncate">{contact.name}</p>
                            {contact.company && <p className="text-[11px] text-muted-foreground truncate">{contact.company}</p>}
                          </div>
                        </div>
                        {contact.email && <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><Mail className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{contact.email}</span></div>}
                        {contact.phone && <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><Phone className="h-3.5 w-3.5 shrink-0" /><span>{contact.phone}</span></div>}
                        <div className="grid grid-cols-3 gap-1.5 pt-1">
                          <Button variant="outline" size="sm" className="h-7 text-[11px] gap-1 w-full" disabled={!contact.email} onClick={() => contact.email && window.open(`mailto:${contact.email}`)}><Mail className="h-3 w-3" />Email</Button>
                          <Button variant="outline" size="sm" className="h-7 text-[11px] gap-1 w-full" disabled={!contact.phone} onClick={() => contact.phone && window.open(`sms:${contact.phone}`)}><MessageSquare className="h-3 w-3" />SMS</Button>
                          <Button variant="outline" size="sm" className="h-7 text-[11px] gap-1 w-full" disabled={!contact.phone} onClick={() => contact.phone && window.open(`tel:${contact.phone}`)}><Phone className="h-3 w-3" />Call</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="py-4 text-center">
                        <User className="mx-auto h-8 w-8 text-muted-foreground/30 mb-2" />
                        <p className="text-sm font-medium">{project.client_name || "No client"}</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">Contact not found in directory</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2 pt-4 px-4"><CardTitle className="text-sm font-semibold">Budget Snapshot</CardTitle></CardHeader>
                  <CardContent className="px-4 pb-4 space-y-3">
                    {[
                      { label: "Total Budget", val: formatMoneyFull(project.budget_total), cls: "" },
                      { label: "Spent",        val: formatMoneyFull(project.actual_cost),  cls: "text-amber-600" },
                      { label: "Remaining",    val: formatMoneyFull(remaining), cls: remaining < 0 ? "text-destructive" : "text-green-600" },
                    ].map(row => (
                      <div key={row.label} className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{row.label}</span>
                        <span className={cn("font-semibold tabular-nums", row.cls)}>{row.val}</span>
                      </div>
                    ))}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground">Used</span>
                        <span className={cn("font-medium", budgetPct > 90 ? "text-destructive" : "text-foreground")}>{budgetPct}%</span>
                      </div>
                      <Progress value={budgetPct} className={cn("h-2", budgetPct > 90 ? "[&>div]:bg-destructive" : budgetPct > 70 ? "[&>div]:bg-amber-500" : "")} />
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {/* ── Schedule & Tasks ── */}
          {activeTab === "schedule" && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <Input placeholder="Add a task…" value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") void handleAddTask(); }} className="h-8 text-sm" />
                <Button size="sm" className="h-8 shrink-0" disabled={addingTask || !newTaskTitle.trim()} onClick={() => void handleAddTask()}>
                  {addingTask ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                </Button>
              </div>
              {projectTasks.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-10 text-center">
                  <CheckCircle2 className="mx-auto h-8 w-8 text-muted-foreground/30 mb-2" />
                  <p className="text-sm text-muted-foreground">No tasks yet — add one above</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {projectTasks.map(task => (
                    <div key={task.id} className="group flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 hover:bg-secondary/30">
                      <button onClick={() => void updateTask(task.id, { status: task.status === "completed" ? "not_started" : "completed" })} className="shrink-0">{STATUS_ICONS[task.status]}</button>
                      <span className={cn("flex-1 text-sm", task.status === "completed" && "line-through text-muted-foreground")}>{task.title}</span>
                      <Flag className={cn("h-3.5 w-3.5 shrink-0", PRIORITY_COLORS[task.priority])} />
                      {task.due && <span className="text-[11px] text-muted-foreground shrink-0">{new Date(task.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
                      <button onClick={() => void deleteTask(task.id)} className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                </div>
              )}
              {projectTasks.length > 0 && (
                <div className="flex items-center gap-4 rounded-lg bg-secondary/40 px-3 py-2 text-[11px] text-muted-foreground">
                  <span>{projectTasks.filter(t => t.status === "completed").length} / {projectTasks.length} done</span>
                  <span>{projectTasks.filter(t => t.status === "in_progress").length} in progress</span>
                  <span>{projectTasks.filter(t => t.priority === "high" && t.status !== "completed").length} high priority</span>
                </div>
              )}

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

          {/* ── Financials ── */}
          {activeTab === "financials" && (
            <div className="space-y-4">
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
            <div className="space-y-4">
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

          {/* ── Photos ── */}
          {activeTab === "photos" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">{photos.length} photo{photos.length !== 1 ? "s" : ""}</p>
                <div>
                  <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handlePhotoUpload} />
                  <Button size="sm" className="h-8 gap-1.5" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                    {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
                    {uploading ? "Uploading…" : "Upload photos"}
                  </Button>
                </div>
              </div>
              {photosLoading ? (
                <div className="grid grid-cols-3 gap-2">
                  {[...Array(6)].map((_, i) => <Skeleton key={i} className="aspect-square rounded-lg" />)}
                </div>
              ) : photos.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-14 text-center cursor-pointer hover:bg-secondary/20 transition"
                  onClick={() => fileInputRef.current?.click()}>
                  <ImageIcon className="mx-auto h-10 w-10 text-muted-foreground/30 mb-3" />
                  <p className="text-sm font-medium text-muted-foreground">No photos yet</p>
                  <p className="text-xs text-muted-foreground mt-1">Click to upload site photos</p>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {photos.map(photo => {
                    const url = `${supabaseUrl}/storage/v1/object/public/project-photos/${photo.file_path}`;
                    return (
                      <div key={photo.id} className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-secondary cursor-pointer"
                        onClick={() => setLightboxPhoto({ url, name: photo.file_name })}>
                        <img src={url} alt={photo.file_name}
                          className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                          onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/60 to-transparent p-2 opacity-0 group-hover:opacity-100 transition">
                          <p className="text-[10px] text-white truncate">{photo.file_name}</p>
                        </div>
                        {/* Delete button */}
                        <button
                          onClick={async e => {
                            e.stopPropagation();
                            if (!confirm("Delete this photo?")) return;
                            await supabase.storage.from("project-photos").remove([photo.file_path]);
                            await supabase.from("project_files").delete().eq("id", photo.id);
                            setPhotos(prev => prev.filter(p => p.id !== photo.id));
                            toast.success("Photo deleted");
                          }}
                          className="absolute top-1.5 right-1.5 h-6 w-6 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition hover:bg-destructive">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
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
      {lightboxPhoto && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
          onClick={() => setLightboxPhoto(null)}>
          <button className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={() => setLightboxPhoto(null)}>
            <X className="h-5 w-5" />
          </button>
          <img src={lightboxPhoto.url} alt={lightboxPhoto.name}
            className="max-h-[90vh] max-w-full rounded-xl object-contain shadow-2xl"
            onClick={e => e.stopPropagation()} />
        </div>
      )}
    </Sheet>
  );
}

// ─── Project Card ─────────────────────────────────────────────────────────────

function ProjectCard({ project: p, onClick, onDelete }: { project: Project; onClick: () => void; onDelete: () => void }) {
  const col      = getColumnForStatus(p.status);
  const age      = daysSince((p as any).created_at);
  const cityLine = getCityFromAddress(p.address);
  const typeTag  = p.name.split(" ")[0] ?? "General";
  return (
    <Card className="cursor-pointer p-0 overflow-hidden transition-shadow hover:shadow-md active:shadow-sm select-none" onClick={onClick}>
      <div className="flex items-start justify-between gap-2 px-3 pt-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">{p.name}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{p.client_name}{cityLine && <span> · {cityLine}</span>}</div>
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
      <div className="mt-2.5 px-3">
        <div className="flex items-center justify-between text-[11px] mb-1">
          <span className="font-medium text-foreground">{p.completion_percentage}%</span>
          {p.end_date && <span className="text-muted-foreground">Due {new Date(p.end_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
        </div>
        <Progress value={p.completion_percentage} className="h-1.5" />
      </div>
      <div className="mt-2.5 flex items-center justify-between border-t border-border px-3 py-2.5">
        <span className="text-sm font-semibold tabular-nums text-foreground">{formatMoney(p.budget_total)}</span>
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="h-5 rounded px-1.5 text-[10px] font-medium">{typeTag}</Badge>
          <div className={cn("flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white", col.dotColor)}>
            {getInitials(p.client_name)}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── Board View ───────────────────────────────────────────────────────────────

function BoardView({ projects, onCardClick, onDragEnd, onDelete }: {
  projects: Project[]; onCardClick: (p: Project) => void;
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
                  <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
                    <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", col.dotColor)} />
                    <span className="text-[13px] font-semibold flex-1 truncate">{col.label}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{items.length}</span>
                    <span className="text-[11px] font-medium text-muted-foreground tabular-nums ml-1">{formatMoney(colValue)}</span>
                  </div>
                  <p className="px-3 pb-1 pt-1 text-[10px] text-muted-foreground">{col.description}</p>
                  <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                    {items.map((p, i) => (
                      <Draggable draggableId={p.id} index={i} key={p.id}>
                        {(drag, snapshot) => (
                          <div ref={drag.innerRef} {...drag.draggableProps} {...drag.dragHandleProps}
                            className={cn("cursor-grab active:cursor-grabbing rounded-xl outline-none", snapshot.isDragging && "opacity-80 rotate-1 shadow-xl scale-[1.02]")}>
                            <ProjectCard project={p} onClick={() => onCardClick(p)} onDelete={() => onDelete(p.id, p.name)} />
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
                  <div className="flex items-center gap-2">
                    <Progress value={p.completion_percentage} className="h-1.5 w-24" />
                    <span className="text-[11px] text-muted-foreground">{p.completion_percentage}%</span>
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

function NewProjectDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
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

  /** Resolves the real contacts.id a project's NOT NULL client_id FK requires. Contact -> itself. Company -> its first linked contact (the schema has no direct company_id on projects — see the migration header) — null when the account has no contacts yet. */
  function resolveClientId(customer: CustomerOption): string | null {
    if (customer.kind === "contact") return customer.id;
    const linked = contacts.find((c) => c.company_id === customer.id);
    return linked?.id ?? null;
  }

  function applyCustomer(customer: CustomerOption) {
    const resolvedClientId = resolveClientId(customer);
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
                            <CommandItem key={`${o.kind}-${o.id}`} value={`${o.kind}-${o.id}`} onSelect={() => applyCustomer(o)}>
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
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {saving ? "Creating…" : "Create Project"}
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
  const { slug } = useSearch({ from: "/projects/" });
  const navigate = useNavigate({ from: "/projects/" });
  const { projects, loading, reload } = useProjects();
  const [tab,       setTab]       = useState<Tab>("active");
  const [view,      setView]      = useState<View>("board");
  const [search,    setSearch]    = useState("");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [optimisticStatuses, setOptimisticStatuses] = useState<Record<string, ProjectStatus>>({});

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

  const counts = useMemo(() => ({
    active:    projects.filter(p => ACTIVE_STATUSES.includes(p.status)).length,
    "on-hold": projects.filter(p => p.status === "on-hold").length,
    cancelled: projects.filter(p => p.status === "cancelled").length,
  }), [projects]);

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

  const tabProjects = useMemo(() => {
    const q = search.toLowerCase();
    return projectsWithOptimistic.filter(p => {
      const matchTab = tab === "active" ? ACTIVE_STATUSES.includes(p.status) : tab === "on-hold" ? p.status === "on-hold" : p.status === "cancelled";
      if (!matchTab) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.client_name.toLowerCase().includes(q) || (p.address ?? "").toLowerCase().includes(q);
    });
  }, [projectsWithOptimistic, tab, search]);

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

  const TAB_DEFS: { id: Tab; label: string; count: number }[] = [
    { id: "active",    label: "Active Pipeline", count: counts.active },
    { id: "on-hold",   label: "On Hold",         count: counts["on-hold"] },
    { id: "cancelled", label: "Cancelled",       count: counts.cancelled },
  ];

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
      <PageHeader icon={FolderOpen} iconBg="bg-info-soft" iconColor="text-info" title="Projects" subtitle={`${counts.active} active · ${formatMoney(kpis.pipelineValue)} pipeline`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm"><Download className="mr-1.5 h-3.5 w-3.5" />Export</Button>
            <Button size="sm" className="h-8" onClick={() => setNewProjectOpen(true)}><Plus className="mr-1.5 h-3.5 w-3.5" />New Project</Button>
          </div>
        } />

      <div className="mb-4 flex gap-4 shrink-0">
        <MetricCard icon={TrendingUp} label="Active Pipeline Value" value={formatMoney(kpis.pipelineValue)} sub={`${counts.active} active projects`} tone="info" className="flex-1 min-w-0" />
        <MetricCard icon={DollarSign} label="Avg Project Value"     value={formatMoney(kpis.avgValue)}      sub="per active project"               tone="success" className="flex-1 min-w-0" />
        <MetricCard icon={Clock}      label="Avg Cycle Time"        value={kpis.avgCycle > 0 ? `${kpis.avgCycle}d` : "—"} sub="from start to close" tone="violet" className="flex-1 min-w-0" />
        <MetricCard icon={PauseCircle} label="On Hold"              value={String(kpis.onHold)}             sub="projects paused"                  tone="warning" className="flex-1 min-w-0" />
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex gap-1">
          {TAB_DEFS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cn("h-8 rounded-md px-3 text-xs font-medium transition-colors", tab === t.id ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60")}>
              {t.label} <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold">{t.count}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search projects…" value={search} onChange={e => setSearch(e.target.value)} className="h-8 w-52 pl-8 text-xs" />
          </div>
          <Select defaultValue="all">
            <SelectTrigger className="h-8 w-32 text-xs"><SelectValue placeholder="Owner: All" /></SelectTrigger>
            <SelectContent><SelectItem value="all">Owner: All</SelectItem></SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs"><Filter className="h-3.5 w-3.5" />Filters</Button>
          <div className="flex items-center rounded-md border border-border p-0.5">
            <Button variant={view === "board" ? "secondary" : "ghost"} size="sm" className="h-7 px-2" onClick={() => setView("board")} title="Board view"><LayoutGrid className="h-3.5 w-3.5" /></Button>
            <Button variant={view === "list"  ? "secondary" : "ghost"} size="sm" className="h-7 px-2" onClick={() => setView("list")}  title="List view"><ListIcon   className="h-3.5 w-3.5" /></Button>
          </div>
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
          ? <BoardView projects={tabProjects} onCardClick={openDetail} onDragEnd={onDragEnd} onDelete={handleDelete} />
          : <ListView  projects={tabProjects} onRowClick={openDetail}  onDelete={handleDelete} />}
      </div>

      <NewProjectDialog open={newProjectOpen} onClose={() => setNewProjectOpen(false)} onCreated={reload} />
      <ProjectDetailSheet project={selectedProject} open={sheetOpen} onClose={closeDetail} onReload={reload} />
    </div>
  );
}