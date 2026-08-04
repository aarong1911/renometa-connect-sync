// src/components/projects/ProjectDailyLogsTab.tsx
//
// Phase 13.3A — Project → Daily Logs. Self-contained: fetches its own data
// keyed on projectId (same "fetch once per open tab" shape the Photos/
// Financials/Communications tabs already use in projects.index.tsx), so
// projects.index.tsx only needs to render <ProjectDailyLogsTab projectId=.../>.
import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays, Cloud, HardHat, Loader2, Plus, Search, ShieldAlert, Thermometer, Users,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { useTeam, type TeamMember } from "@/lib/organization";
import { VisibilityBadge } from "@/components/projects/VisibilityBadge";
import {
  fetchProjectDailyLogs, createDailyLog, updateDailyLog, publishDailyLog, archiveDailyLog,
  restoreDailyLogToDraft, deleteDailyLog,
  DAILY_LOG_STATUS_LABELS, type ProjectDailyLog, type DailyLogStatus,
} from "@/lib/project-daily-logs";

function todayLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtLogDate(d: string): string {
  // date-only string — parse as local midnight, never a UTC-shifted `new Date(d)`.
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, day ?? 1).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function authorName(profileId: string | null, teamById: Map<string, TeamMember>): string {
  if (!profileId) return "Unknown";
  return teamById.get(profileId)?.name ?? "Former team member";
}

export function ProjectDailyLogsTab({ projectId }: { projectId: string }) {
  const teamMembers = useTeam();
  const teamById = useMemo(() => new Map(teamMembers.map((m) => [m.id, m])), [teamMembers]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  useEffect(() => { void supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id ?? null)); }, []);

  const [logs, setLogs] = useState<ProjectDailyLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | DailyLogStatus | "all">("active");
  const [createOpen, setCreateOpen] = useState(false);
  const [editingLog, setEditingLog] = useState<ProjectDailyLog | null>(null);
  const [viewingLog, setViewingLog] = useState<ProjectDailyLog | null>(null);

  const load = async () => {
    setLoading(true);
    const { logs: rows, error } = await fetchProjectDailyLogs(projectId);
    setLogs(rows);
    setLoadError(error);
    setLoading(false);
  };

  useEffect(() => { void load(); }, [projectId]);

  // Keep an open detail drawer in sync with the list after edits/publish/archive.
  useEffect(() => {
    if (!viewingLog) return;
    const fresh = logs.find((l) => l.id === viewingLog.id);
    if (!fresh) { setViewingLog(null); return; }
    if (fresh !== viewingLog) setViewingLog(fresh);
  }, [logs, viewingLog]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.filter((log) => {
      if (statusFilter === "active" && log.status === "archived") return false;
      if (statusFilter !== "active" && statusFilter !== "all" && log.status !== statusFilter) return false;
      if (!q) return true;
      return (
        (log.title ?? "").toLowerCase().includes(q) ||
        log.summary.toLowerCase().includes(q) ||
        (log.workCompleted ?? "").toLowerCase().includes(q) ||
        (log.delaysIssues ?? "").toLowerCase().includes(q)
      );
    });
  }, [logs, search, statusFilter]);

  const handleCreate = async (input: Parameters<typeof createDailyLog>[0]) => {
    const { log, error } = await createDailyLog(input);
    if (error || !log) { toast.error("Could not create Daily Log", { description: error ?? undefined }); return false; }
    setLogs((prev) => [log, ...prev]);
    toast.success("Daily Log created");
    return true;
  };

  const handleUpdate = async (id: string, patch: Parameters<typeof updateDailyLog>[1]) => {
    const { log, error } = await updateDailyLog(id, patch);
    if (error || !log) { toast.error("Could not update Daily Log", { description: error ?? undefined }); return false; }
    setLogs((prev) => prev.map((l) => (l.id === id ? log : l)));
    toast.success("Daily Log updated");
    return true;
  };

  const handlePublish = async (log: ProjectDailyLog) => {
    const { log: updated, error } = await publishDailyLog(log);
    if (error || !updated) { toast.error("Could not publish Daily Log", { description: error ?? undefined }); return; }
    setLogs((prev) => prev.map((l) => (l.id === log.id ? updated : l)));
    toast.success("Daily Log published");
  };

  const handleArchive = async (id: string) => {
    const { log: updated, error } = await archiveDailyLog(id);
    if (error || !updated) { toast.error("Could not archive Daily Log", { description: error ?? undefined }); return; }
    setLogs((prev) => prev.map((l) => (l.id === id ? updated : l)));
    toast.success("Daily Log archived");
  };

  const handleRestore = async (id: string) => {
    const { log: updated, error } = await restoreDailyLogToDraft(id);
    if (error || !updated) { toast.error("Could not restore Daily Log", { description: error ?? undefined }); return; }
    setLogs((prev) => prev.map((l) => (l.id === id ? updated : l)));
    toast.success("Daily Log restored to Draft");
  };

  const handleDelete = async (id: string) => {
    const { error } = await deleteDailyLog(id);
    if (error) { toast.error("Could not delete Daily Log", { description: error }); return; }
    setLogs((prev) => prev.filter((l) => l.id !== id));
    setViewingLog(null);
    toast.success("Daily Log deleted");
  };

  return (
    <div role="tabpanel" id="project-panel-daily-logs" aria-labelledby="project-tab-daily-logs" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Daily Logs</h3>
          <p className="text-xs text-muted-foreground">Document work completed, site conditions, delays, safety notes, and progress photos.</p>
        </div>
        <Button size="sm" className="h-8 gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> New Daily Log
        </Button>
      </div>

      {loadError && <p className="text-xs text-destructive">{loadError}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search logs…" className="h-8 pl-8 text-xs" />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Draft + Published</SelectItem>
            <SelectItem value="draft">Draft only</SelectItem>
            <SelectItem value="published">Published only</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
            <SelectItem value="all">All statuses</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-14 text-center">
          <CalendarDays className="mx-auto mb-3 h-8 w-8 text-muted-foreground/30" />
          <p className="text-sm font-medium text-muted-foreground">
            {logs.length === 0 ? "No Daily Logs yet" : "No records match these filters"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {logs.length === 0 ? "Document site progress, completed work, delays, safety notes, and photos." : ""}
          </p>
          {logs.length === 0 ? (
            <Button size="sm" variant="outline" className="mt-3 h-8 text-xs" onClick={() => setCreateOpen(true)}>New Daily Log</Button>
          ) : (
            <Button size="sm" variant="outline" className="mt-3 h-8 text-xs" onClick={() => { setSearch(""); setStatusFilter("active"); }}>Clear Filters</Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((log) => (
            <DailyLogCard key={log.id} log={log} teamById={teamById} onOpen={() => setViewingLog(log)} />
          ))}
        </div>
      )}

      <DailyLogFormDialog
        key={editingLog?.id ?? (createOpen ? "new" : "closed")}
        open={createOpen || editingLog !== null}
        projectId={projectId}
        log={editingLog}
        onClose={() => { setCreateOpen(false); setEditingLog(null); }}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
      />

      <DailyLogDetailDrawer
        log={viewingLog}
        teamById={teamById}
        currentUserId={currentUserId}
        onClose={() => setViewingLog(null)}
        onEdit={(l) => { setViewingLog(null); setEditingLog(l); }}
        onPublish={handlePublish}
        onArchive={handleArchive}
        onRestore={handleRestore}
        onDelete={handleDelete}
        onVisibilityChange={(id, patch) => void handleUpdate(id, patch)}
      />
    </div>
  );
}

function DailyLogCard({ log, teamById, onOpen }: { log: ProjectDailyLog; teamById: Map<string, TeamMember>; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-lg border border-border bg-background p-3 text-left transition-colors hover:bg-secondary/30"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold">{log.title || fmtLogDate(log.logDate)}</span>
            <Badge variant="outline" className={cn("h-5 rounded px-1.5 text-[10px]", log.status === "published" ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400" : log.status === "archived" ? "border-border bg-muted text-muted-foreground" : "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-500/10 dark:text-amber-400")}>
              {DAILY_LOG_STATUS_LABELS[log.status]}
            </Badge>
            <VisibilityBadge isCustomerVisible={log.isCustomerVisible} isFieldVisible={log.isFieldVisible} />
            {log.delaysIssues && <Badge variant="outline" className="h-5 gap-1 rounded border-amber-300 bg-amber-50 px-1.5 text-[10px] text-amber-700 dark:border-amber-800 dark:bg-amber-500/10 dark:text-amber-400"><ShieldAlert className="h-2.5 w-2.5" />Delay</Badge>}
            {log.safetyNotes && <Badge variant="outline" className="h-5 gap-1 rounded border-rose-300 bg-rose-50 px-1.5 text-[10px] text-rose-700 dark:border-rose-800 dark:bg-rose-500/10 dark:text-rose-400"><HardHat className="h-2.5 w-2.5" />Safety</Badge>}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{log.summary}</p>
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">{fmtLogDate(log.logDate)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1"><Users className="h-3 w-3" />{authorName(log.createdBy, teamById)}</span>
        {log.crewCount !== null && <span>{log.crewCount} crew</span>}
        {log.weatherSummary && <span className="flex items-center gap-1"><Cloud className="h-3 w-3" />{log.weatherSummary}</span>}
        {(log.temperatureLow !== null || log.temperatureHigh !== null) && (
          <span className="flex items-center gap-1"><Thermometer className="h-3 w-3" />{log.temperatureLow ?? "—"}°–{log.temperatureHigh ?? "—"}°</span>
        )}
      </div>
    </button>
  );
}

type DailyLogFormValues = {
  logDate: string; title: string; summary: string; workCompleted: string; workPlannedNext: string;
  delaysIssues: string; safetyNotes: string; visitorNotes: string; weatherSummary: string;
  temperatureLow: string; temperatureHigh: string; crewCount: string;
  isCustomerVisible: boolean; isFieldVisible: boolean; status: DailyLogStatus;
};

function emptyFormValues(log: ProjectDailyLog | null): DailyLogFormValues {
  if (!log) {
    return {
      logDate: todayLocalDate(), title: "", summary: "", workCompleted: "", workPlannedNext: "",
      delaysIssues: "", safetyNotes: "", visitorNotes: "", weatherSummary: "",
      temperatureLow: "", temperatureHigh: "", crewCount: "",
      isCustomerVisible: false, isFieldVisible: true, status: "draft",
    };
  }
  return {
    logDate: log.logDate, title: log.title ?? "", summary: log.summary, workCompleted: log.workCompleted ?? "",
    workPlannedNext: log.workPlannedNext ?? "", delaysIssues: log.delaysIssues ?? "", safetyNotes: log.safetyNotes ?? "",
    visitorNotes: log.visitorNotes ?? "", weatherSummary: log.weatherSummary ?? "",
    temperatureLow: log.temperatureLow?.toString() ?? "", temperatureHigh: log.temperatureHigh?.toString() ?? "",
    crewCount: log.crewCount?.toString() ?? "", isCustomerVisible: log.isCustomerVisible, isFieldVisible: log.isFieldVisible,
    status: log.status,
  };
}

function DailyLogFormDialog({
  open, projectId, log, onClose, onCreate, onUpdate,
}: {
  open: boolean;
  projectId: string;
  log: ProjectDailyLog | null;
  onClose: () => void;
  onCreate: (input: Parameters<typeof createDailyLog>[0]) => Promise<boolean>;
  onUpdate: (id: string, patch: Parameters<typeof updateDailyLog>[1]) => Promise<boolean>;
}) {
  const isEdit = log !== null;
  const [values, setValues] = useState<DailyLogFormValues>(() => emptyFormValues(log));
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) setValues(emptyFormValues(log)); }, [open, log]);

  const set = <K extends keyof DailyLogFormValues>(key: K, value: DailyLogFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (status?: DailyLogStatus) => {
    if (!values.summary.trim()) { toast.error("Summary is required"); return; }
    if (saving) return;
    setSaving(true);
    const payload = {
      logDate: values.logDate,
      title: values.title || null,
      summary: values.summary,
      workCompleted: values.workCompleted || null,
      workPlannedNext: values.workPlannedNext || null,
      delaysIssues: values.delaysIssues || null,
      safetyNotes: values.safetyNotes || null,
      visitorNotes: values.visitorNotes || null,
      weatherSummary: values.weatherSummary || null,
      temperatureLow: values.temperatureLow ? Number(values.temperatureLow) : null,
      temperatureHigh: values.temperatureHigh ? Number(values.temperatureHigh) : null,
      crewCount: values.crewCount ? Number(values.crewCount) : null,
      isCustomerVisible: values.isCustomerVisible,
      isFieldVisible: values.isFieldVisible,
      status: status ?? values.status,
    };
    const ok = isEdit && log
      ? await onUpdate(log.id, payload)
      : await onCreate({ projectId, ...payload });
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Daily Log" : "New Daily Log"}</DialogTitle>
          <DialogDescription>Document today's progress, delays, safety notes, and site conditions.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="log-date">Log Date</Label>
              <Input id="log-date" type="date" value={values.logDate} onChange={(e) => set("logDate", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="log-title">Title (optional)</Label>
              <Input id="log-title" value={values.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Framing day 3" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="log-summary">Summary</Label>
            <Textarea id="log-summary" value={values.summary} onChange={(e) => set("summary", e.target.value)} rows={2} placeholder="What happened on site today?" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="log-completed">Work Completed</Label>
              <Textarea id="log-completed" value={values.workCompleted} onChange={(e) => set("workCompleted", e.target.value)} rows={2} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="log-next">Work Planned Next</Label>
              <Textarea id="log-next" value={values.workPlannedNext} onChange={(e) => set("workPlannedNext", e.target.value)} rows={2} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="log-delays">Delays / Issues</Label>
              <Textarea id="log-delays" value={values.delaysIssues} onChange={(e) => set("delaysIssues", e.target.value)} rows={2} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="log-safety">Safety Notes</Label>
              <Textarea id="log-safety" value={values.safetyNotes} onChange={(e) => set("safetyNotes", e.target.value)} rows={2} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="log-visitors">Visitors / Inspections</Label>
            <Input id="log-visitors" value={values.visitorNotes} onChange={(e) => set("visitorNotes", e.target.value)} placeholder="e.g. City inspector — rough plumbing passed" />
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="log-weather">Weather</Label>
              <Input id="log-weather" value={values.weatherSummary} onChange={(e) => set("weatherSummary", e.target.value)} placeholder="e.g. Sunny, light wind" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="log-temp-low">Low °F</Label>
              <Input id="log-temp-low" type="number" value={values.temperatureLow} onChange={(e) => set("temperatureLow", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="log-temp-high">High °F</Label>
              <Input id="log-temp-high" type="number" value={values.temperatureHigh} onChange={(e) => set("temperatureHigh", e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="log-crew">Crew Count</Label>
              <Input id="log-crew" type="number" min={0} value={values.crewCount} onChange={(e) => set("crewCount", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Visibility</Label>
              <div className="flex h-9 items-center gap-4">
                <label className="flex items-center gap-1.5 text-xs">
                  <Checkbox checked={values.isFieldVisible} onCheckedChange={(v) => set("isFieldVisible", !!v)} /> Field
                </label>
                <label className="flex items-center gap-1.5 text-xs">
                  <Checkbox checked={values.isCustomerVisible} onCheckedChange={(v) => set("isCustomerVisible", !!v)} /> Customer
                </label>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void handleSubmit("draft")} disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save as Draft
            </Button>
            <Button onClick={() => void handleSubmit("published")} disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {isEdit ? "Save & Publish" : "Publish"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DailyLogDetailDrawer({
  log, teamById, currentUserId, onClose, onEdit, onPublish, onArchive, onRestore, onDelete, onVisibilityChange,
}: {
  log: ProjectDailyLog | null;
  teamById: Map<string, TeamMember>;
  currentUserId: string | null;
  onClose: () => void;
  onEdit: (log: ProjectDailyLog) => void;
  onPublish: (log: ProjectDailyLog) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onVisibilityChange: (id: string, patch: { isCustomerVisible?: boolean; isFieldVisible?: boolean }) => void;
}) {
  void currentUserId;
  return (
    <Sheet open={log !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {log && (
          <>
            <SheetHeader>
              <SheetTitle>{log.title || fmtLogDate(log.logDate)}</SheetTitle>
              <SheetDescription>
                {fmtLogDate(log.logDate)} · {authorName(log.createdBy, teamById)} · RenoMeta {log.source === "connect" ? "Connect" : log.source === "field" ? "Field" : log.source === "portal" ? "Portal" : log.source}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-4 space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="h-5 rounded px-1.5 text-[10px]">{DAILY_LOG_STATUS_LABELS[log.status]}</Badge>
                <VisibilityBadge isCustomerVisible={log.isCustomerVisible} isFieldVisible={log.isFieldVisible} />
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox checked={log.isFieldVisible} onCheckedChange={(v) => onVisibilityChange(log.id, { isFieldVisible: !!v })} /> Field Visible
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox checked={log.isCustomerVisible} onCheckedChange={(v) => onVisibilityChange(log.id, { isCustomerVisible: !!v })} /> Customer Visible
                </label>
              </div>

              <Field label="Summary" value={log.summary} />
              {log.workCompleted && <Field label="Work Completed" value={log.workCompleted} />}
              {log.workPlannedNext && <Field label="Work Planned Next" value={log.workPlannedNext} />}
              {log.delaysIssues && <Field label="Delays / Issues" value={log.delaysIssues} tone="text-amber-700 dark:text-amber-400" />}
              {log.safetyNotes && <Field label="Safety Notes" value={log.safetyNotes} tone="text-rose-700 dark:text-rose-400" />}
              {log.visitorNotes && <Field label="Visitors / Inspections" value={log.visitorNotes} />}
              {(log.weatherSummary || log.temperatureLow !== null || log.temperatureHigh !== null) && (
                <Field label="Weather" value={`${log.weatherSummary ?? ""}${log.temperatureLow !== null || log.temperatureHigh !== null ? ` (${log.temperatureLow ?? "—"}°–${log.temperatureHigh ?? "—"}°F)` : ""}`} />
              )}
              {log.crewCount !== null && <Field label="Crew Count" value={String(log.crewCount)} />}

              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                <Button variant="outline" size="sm" onClick={() => onEdit(log)}>Edit</Button>
                {log.status === "draft" && <Button size="sm" onClick={() => onPublish(log)}>Publish</Button>}
                {log.status !== "archived" ? (
                  <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => onArchive(log.id)}>Archive</Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => onRestore(log.id)}>Restore to Draft</Button>
                )}
                <Button
                  variant="ghost" size="sm" className="ml-auto text-destructive hover:text-destructive"
                  onClick={() => { if (window.confirm("Delete this Daily Log? Linked photos remain in the Project gallery.")) onDelete(log.id); }}
                >
                  Delete
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 whitespace-pre-wrap text-sm", tone)}>{value}</p>
    </div>
  );
}
