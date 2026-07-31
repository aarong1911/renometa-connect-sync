// src/routes/calendar.tsx
//
// Phase 10.3 — Calendar and Appointments Completion. Reads/writes the
// canonical public.appointments table via src/lib/appointments-store.ts.
// New appointment / Edit / Delete are now real (see appointment-dialog.tsx
// and appointment-detail-sheet.tsx) — the old page had all three wired to
// nothing but toasts (New event had no handler at all; Edit showed "coming
// soon"; Delete showed "Event deleted" without ever calling Supabase).
import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/layout/app-shell";
import {
  ChevronLeft, ChevronRight, RefreshCw, Plus, CheckCircle2,
  Calendar as CalendarIcon, Loader2, Clock, AlertTriangle, ListChecks,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useOrganization, useTeam } from "@/lib/organization";
import {
  listAppointments, getAppointment, type Appointment,
} from "@/lib/appointments-store";
import {
  APPOINTMENT_STATUS_ORDER, APPOINTMENT_STATUS_LABELS, APPOINTMENT_STATUS_TINT,
  APPOINTMENT_TYPE_ORDER, APPOINTMENT_TYPE_LABELS, APPOINTMENT_TYPE_ICONS,
  APPOINTMENT_ENTITY_TYPE_LABELS, isActiveAppointmentStatus,
  type AppointmentStatus, type AppointmentType, type AppointmentEntityType,
} from "@/lib/appointment-status";
import { AppointmentDialog } from "@/components/calendar/appointment-dialog";
import { AppointmentDetailSheet } from "@/components/calendar/appointment-detail-sheet";

export const Route = createFileRoute("/calendar")({
  component: CalendarPage,
});

// ── date helpers ──

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function buildWeekDays(anchor: Date): Date[] {
  const day = anchor.getDay();
  const offset = (day + 6) % 7;
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - offset);
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
}
function buildMonthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - startOffset);
  return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
}
function formatRelative(d: Date, now: Date): string {
  const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}
function apptDateKey(a: Appointment): string {
  return new Date(a.scheduledAt).toLocaleDateString("en-CA", { timeZone: a.timeZone });
}
function apptTimeLabel(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
}
function apptMinutes(iso: string, tz: string): number {
  const [h, m] = apptTimeLabel(iso, tz).split(":").map(Number);
  return h * 60 + m;
}

type ViewMode = "month" | "week" | "day" | "agenda";
type EntityFilter = "all" | "unlinked" | AppointmentEntityType;

// ── main page ──

function CalendarPage() {
  const org = useOrganization();
  const teamMembers = useTeam().filter((m) => m.status === "active");

  const today = useMemo(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()); }, []);
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [view, setView] = useState<ViewMode>("week");
  const [selectedDay, setSelectedDay] = useState<string>(() => ymd(new Date()));
  const [nowTick, setNowTick] = useState<Date | null>(null);

  const [statusFilter, setStatusFilter] = useState<AppointmentStatus | "all">("all");
  const [typeFilter, setTypeFilter] = useState<AppointmentType | "all">("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [entityFilter, setEntityFilter] = useState<EntityFilter>("all");
  const [hideCancelled, setHideCancelled] = useState(true);

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const fetchAppointments = useCallback(async () => {
    const rangeStart = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
    const rangeEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 2, 0);
    const rows = await listAppointments(rangeStart, rangeEnd);
    setAppointments(rows);
    setLoading(false);
    setLastSynced(new Date());
  }, [cursor]);

  useEffect(() => { void fetchAppointments(); }, [fetchAppointments]);

  useEffect(() => {
    const update = () => setNowTick(new Date());
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    await fetchAppointments();
    setSyncing(false);
    toast.success("Calendar refreshed", { description: `${appointments.length} appointments loaded` });
  };

  const filtered = useMemo(() => {
    return appointments.filter((a) => {
      if (hideCancelled && a.status === "cancelled") return false;
      if (statusFilter !== "all" && a.status !== statusFilter) return false;
      if (typeFilter !== "all" && a.appointmentType !== typeFilter) return false;
      if (assigneeFilter !== "all") {
        if (assigneeFilter === "unassigned" ? a.assignedTo !== null : a.assignedTo !== assigneeFilter) return false;
      }
      if (entityFilter === "unlinked" && a.entityType !== null) return false;
      if (entityFilter !== "all" && entityFilter !== "unlinked" && a.entityType !== entityFilter) return false;
      return true;
    });
  }, [appointments, hideCancelled, statusFilter, typeFilter, assigneeFilter, entityFilter]);

  const eventsByDay = useMemo(() => {
    const m = new Map<string, Appointment[]>();
    filtered.forEach((a) => { const key = apptDateKey(a); const arr = m.get(key) ?? []; arr.push(a); m.set(key, arr); });
    return m;
  }, [filtered]);

  const selectedDate = useMemo(() => parseYmd(selectedDay), [selectedDay]);
  const weekDays = useMemo(() => buildWeekDays(selectedDate), [selectedDate]);
  const daysGrid = useMemo(() => buildMonthGrid(cursor), [cursor]);

  const headerLabel = useMemo(() => {
    if (view === "month") return cursor.toLocaleString("default", { month: "long", year: "numeric" });
    if (view === "day") return selectedDate.toLocaleDateString("default", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    if (view === "agenda") return "Agenda";
    const last = weekDays[6];
    const sameMonth = weekDays[0].getMonth() === last.getMonth();
    const left = weekDays[0].toLocaleDateString("default", { month: "short", day: "numeric" });
    const right = sameMonth ? `${last.getDate()}, ${last.getFullYear()}` : last.toLocaleDateString("default", { month: "short", day: "numeric", year: "numeric" });
    return `${left} – ${right}`;
  }, [view, cursor, selectedDate, weekDays]);

  const shift = (dir: -1 | 1) => {
    if (view === "month" || view === "agenda") {
      setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
    } else if (view === "week") {
      const d = new Date(selectedDate); d.setDate(d.getDate() + dir * 7);
      setSelectedDay(ymd(d)); setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
    } else {
      const d = new Date(selectedDate); d.setDate(d.getDate() + dir);
      setSelectedDay(ymd(d)); setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
    }
  };
  const goToday = () => { setSelectedDay(ymd(today)); setCursor(new Date(today.getFullYear(), today.getMonth(), 1)); };

  const openDetail = (id: string) => setDetailId(id);
  const openEdit = async (id: string) => {
    const appt = await getAppointment(id);
    if (!appt) { toast.error("Could not load this appointment"); return; }
    setDetailId(null);
    setEditingAppointment(appt);
  };
  const handleSaved = () => { void fetchAppointments(); };

  // ── KPI cards (Part 16 / 38) — computed over the loaded 3-month window,
  // same range the page already queries; "Today"/"Upcoming"/"Confirmed" are
  // effectively exact since that window always covers the current month.
  const kpis = useMemo(() => {
    const now = nowTick ?? new Date();
    const todayKey = ymd(now);
    const todayCount = appointments.filter((a) => a.status !== "cancelled" && apptDateKey(a) === todayKey).length;
    const upcoming = appointments.filter((a) => isActiveAppointmentStatus(a.status) && new Date(a.scheduledAt).getTime() >= now.getTime());
    const confirmed = appointments.filter((a) => a.status === "confirmed" && new Date(a.scheduledAt).getTime() >= new Date(todayKey).getTime());
    const needsAttention = appointments.filter((a) =>
      a.googleSyncStatus === "failed" ||
      (isActiveAppointmentStatus(a.status) && !a.assignedTo && new Date(a.scheduledAt).getTime() >= now.getTime()),
    );
    return { today: todayCount, upcoming: upcoming.length, confirmed: confirmed.length, needsAttention: needsAttention.length };
  }, [appointments, nowTick]);

  const selectedEvents = (eventsByDay.get(selectedDay) ?? []).slice().sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="flex h-[calc(100vh-190px)] flex-col gap-3">
      <PageHeader
        title="Calendar"
        subtitle="Schedule appointments, manage availability, and coordinate customer meetings."
        icon={CalendarIcon}
        iconBg="bg-cyan-soft"
        iconColor="text-cyan-soft-foreground"
        actions={
          <Button size="sm" className="h-8" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5" /><span className="text-xs">New appointment</span>
          </Button>
        }
      />

      {/* KPI cards */}
      <div className="grid flex-shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
        <KpiCard label="Today" value={kpis.today} icon={CalendarIcon} tint="text-blue-600 bg-blue-50 dark:text-blue-400 dark:bg-blue-500/10" />
        <KpiCard label="Upcoming" value={kpis.upcoming} icon={Clock} tint="text-cyan-600 bg-cyan-50 dark:text-cyan-400 dark:bg-cyan-500/10" />
        <KpiCard label="Confirmed" value={kpis.confirmed} icon={CheckCircle2} tint="text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-500/10" />
        <KpiCard label="Needs Attention" value={kpis.needsAttention} icon={AlertTriangle} tint="text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-500/10" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8" onClick={goToday}>Today</Button>
          <div className="flex items-center rounded-md border border-border">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => shift(-1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => shift(1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
          <h2 className="text-base font-semibold">{headerLabel}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup type="single" value={view} onValueChange={(v) => v && setView(v as ViewMode)} className="h-8 rounded-md border border-border p-0.5">
            <ToggleGroupItem value="month" className="h-7 px-2.5 text-xs data-[state=on]:bg-secondary">Month</ToggleGroupItem>
            <ToggleGroupItem value="week" className="h-7 px-2.5 text-xs data-[state=on]:bg-secondary">Week</ToggleGroupItem>
            <ToggleGroupItem value="day" className="h-7 px-2.5 text-xs data-[state=on]:bg-secondary">Day</ToggleGroupItem>
            <ToggleGroupItem value="agenda" className="h-7 px-2.5 text-xs data-[state=on]:bg-secondary"><ListChecks className="h-3 w-3" /></ToggleGroupItem>
          </ToggleGroup>
          <Button variant="outline" size="sm" className="h-8" onClick={handleSync} disabled={syncing}>
            <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
            <span className="text-xs">{syncing ? "Syncing…" : "Refresh"}</span>
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as AppointmentStatus | "all")}>
          <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {APPOINTMENT_STATUS_ORDER.map((s) => <SelectItem key={s} value={s}>{APPOINTMENT_STATUS_LABELS[s]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as AppointmentType | "all")}>
          <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {APPOINTMENT_TYPE_ORDER.map((t) => <SelectItem key={t} value={t}>{APPOINTMENT_TYPE_LABELS[t]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
          <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All assignees</SelectItem>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {teamMembers.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={entityFilter} onValueChange={(v) => setEntityFilter(v as EntityFilter)}>
          <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All related records</SelectItem>
            <SelectItem value="unlinked">Unlinked</SelectItem>
            {(Object.keys(APPOINTMENT_ENTITY_TYPE_LABELS) as AppointmentEntityType[]).map((e) => (
              <SelectItem key={e} value={e}>{APPOINTMENT_ENTITY_TYPE_LABELS[e]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={!hideCancelled} onCheckedChange={(v) => setHideCancelled(!v)} /> Show cancelled
        </label>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 text-success" />
          {lastSynced ? `Last refreshed ${nowTick ? formatRelative(lastSynced, nowTick) : "recently"}` : "Loading…"} · {filtered.length} appointments
        </span>
      </div>

      {/* Main grid */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[1fr_320px]">
        {view === "month" && (
          <Card className="flex flex-col overflow-hidden p-0">
            <div className="grid flex-shrink-0 grid-cols-7 border-b border-border bg-secondary/40">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                <div key={d} className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{d}</div>
              ))}
            </div>
            <div className="grid flex-1 grid-cols-7 auto-rows-fr overflow-y-auto">
              {daysGrid.map((cell, i) => {
                const inMonth = cell.getMonth() === cursor.getMonth();
                const key = ymd(cell);
                const dayEvents = eventsByDay.get(key) ?? [];
                const isToday = ymd(today) === key;
                const isSelected = selectedDay === key;
                return (
                  <button key={i} onClick={() => setSelectedDay(key)}
                    className={cn(
                      "min-h-0 border-b border-r border-border p-1.5 text-left transition-colors hover:bg-secondary/40",
                      !inMonth && "bg-muted/30 text-muted-foreground",
                      isSelected && "bg-primary/5 ring-1 ring-inset ring-primary/40",
                      (i + 1) % 7 === 0 && "border-r-0",
                      i >= daysGrid.length - 7 && "border-b-0",
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium", isToday && "bg-primary text-primary-foreground")}>
                        {cell.getDate()}
                      </span>
                      {dayEvents.length > 0 && <span className="text-[10px] text-muted-foreground">{dayEvents.length}</span>}
                    </div>
                    <div className="space-y-0.5">
                      {dayEvents.slice(0, 3).map((a) => (
                        <div key={a.id} onClick={(e) => { e.stopPropagation(); openDetail(a.id); }}
                          className={cn("truncate rounded border px-1 py-0.5 text-[10px] font-medium", APPOINTMENT_STATUS_TINT[a.status].chip)}>
                          {apptTimeLabel(a.scheduledAt, a.timeZone)} {a.title}
                        </div>
                      ))}
                      {dayEvents.length > 3 && <div className="px-1 text-[10px] text-muted-foreground">+{dayEvents.length - 3} more</div>}
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>
        )}

        {view === "week" && (
          <TimeGrid days={weekDays} today={today} now={nowTick} selectedDay={selectedDay} onSelectDay={setSelectedDay} eventsByDay={eventsByDay} onOpen={openDetail} />
        )}
        {view === "day" && (
          <TimeGrid days={[selectedDate]} today={today} now={nowTick} selectedDay={selectedDay} onSelectDay={setSelectedDay} eventsByDay={eventsByDay} onOpen={openDetail} />
        )}
        {view === "agenda" && (
          <AgendaView appointments={filtered} onOpen={openDetail} />
        )}

        {/* Side card — day detail (Month/Week/Day views only; Agenda already shows everything) */}
        {view !== "agenda" && (
          <Card className="min-h-0 overflow-y-auto p-3">
            <div className="mb-3 flex items-center gap-2">
              <CalendarIcon className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">
                {parseYmd(selectedDay).toLocaleDateString("default", { weekday: "long", month: "short", day: "numeric" })}
              </h3>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {selectedEvents.length === 0 ? "No events" : `${selectedEvents.length} event${selectedEvents.length !== 1 ? "s" : ""}`}
              </span>
            </div>

            {selectedEvents.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <CalendarIcon className="h-7 w-7 text-muted-foreground/40" />
                <p className="text-xs text-muted-foreground">No appointments scheduled</p>
                <Button size="sm" variant="outline" className="mt-1 h-7 text-xs" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-3 w-3" /> New appointment
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {selectedEvents.map((a) => (
                  <AppointmentCard key={a.id} appointment={a} onOpen={() => openDetail(a.id)} />
                ))}
              </div>
            )}
          </Card>
        )}
      </div>

      <AppointmentDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={handleSaved} />
      <AppointmentDialog
        open={!!editingAppointment}
        onOpenChange={(o) => { if (!o) setEditingAppointment(null); }}
        appointment={editingAppointment}
        onSaved={handleSaved}
      />
      <AppointmentDetailSheet
        open={!!detailId}
        onOpenChange={(o) => { if (!o) setDetailId(null); }}
        appointmentId={detailId}
        onEdit={() => detailId && void openEdit(detailId)}
        onChanged={handleSaved}
      />
    </div>
  );
}

// ── KPI card ──

function KpiCard({ label, value, icon: Icon, tint }: { label: string; value: number; icon: typeof CalendarIcon; tint: string }) {
  return (
    <Card className="flex items-center gap-2.5 p-2.5">
      <div className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", tint)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-lg font-semibold leading-tight">{value}</div>
        <div className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      </div>
    </Card>
  );
}

// ── appointment side card ──

function AppointmentCard({ appointment: a, onOpen }: { appointment: Appointment; onOpen: () => void }) {
  const TypeIcon = APPOINTMENT_TYPE_ICONS[a.appointmentType];
  const tint = APPOINTMENT_STATUS_TINT[a.status];
  return (
    <button onClick={onOpen} className="w-full rounded-lg border border-border bg-background p-3 text-left space-y-2 hover:bg-secondary/30 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold leading-snug">{a.contactName || a.title}</div>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            <TypeIcon className="h-3 w-3" /> {APPOINTMENT_TYPE_LABELS[a.appointmentType]}
          </div>
        </div>
        <Badge variant="outline" className={cn("h-5 shrink-0 rounded border px-1.5 text-[10px]", tint.badge)}>
          {APPOINTMENT_STATUS_LABELS[a.status]}
        </Badge>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Clock className="h-3 w-3" />
        <span className="font-medium tabular-nums text-foreground">{apptTimeLabel(a.scheduledAt, a.timeZone)}–{apptTimeLabel(a.endsAt, a.timeZone)}</span>
        {a.assigneeName && <><span>·</span><span className="truncate">{a.assigneeName}</span></>}
      </div>
    </button>
  );
}

// ── time grid (Week/Day) ──

const HOUR_PX = 44;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function TimeGrid({
  days, today, now, selectedDay, onSelectDay, eventsByDay, onOpen,
}: {
  days: Date[]; today: Date; now: Date | null;
  selectedDay: string; onSelectDay: (d: string) => void;
  eventsByDay: Map<string, Appointment[]>;
  onOpen: (id: string) => void;
}) {
  const todayKey = ymd(today);
  const nowMinutes = now ? now.getHours() * 60 + now.getMinutes() : null;
  const nowTop = nowMinutes !== null ? (nowMinutes / 60) * HOUR_PX : 0;
  const nowLabel = now ? now.toLocaleTimeString("default", { hour: "numeric", minute: "2-digit" }) : "";

  return (
    <Card className="flex flex-col overflow-hidden p-0">
      <div className="grid border-b border-border bg-secondary/40" style={{ gridTemplateColumns: `48px repeat(${days.length}, minmax(0, 1fr))` }}>
        <div />
        {days.map((d) => {
          const key = ymd(d);
          const isToday = ymd(today) === key;
          const isSelected = selectedDay === key;
          return (
            <button key={key} onClick={() => onSelectDay(key)} className={cn("border-l border-border px-2 py-1.5 text-left transition-colors hover:bg-secondary", isSelected && "bg-primary/5")}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{d.toLocaleDateString("default", { weekday: "short" })}</div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium", isToday && "bg-primary text-primary-foreground")}>{d.getDate()}</span>
                <span className="text-[10px] text-muted-foreground">{(eventsByDay.get(key) ?? []).length} ev</span>
              </div>
            </button>
          );
        })}
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: `48px repeat(${days.length}, minmax(0, 1fr))` }}>
          <div className="relative border-r border-border" style={{ height: HOUR_PX * 24 }}>
            {HOURS.map((h) => (
              <div key={h} className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground" style={{ top: h * HOUR_PX }}>
                {h === 0 ? "" : `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`}
              </div>
            ))}
          </div>
          {days.map((d) => {
            const key = ymd(d);
            const dayEvents = (eventsByDay.get(key) ?? []).slice().sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
            const showNow = nowMinutes !== null && key === todayKey;
            return (
              <div key={key} className="relative border-l border-border" style={{ height: HOUR_PX * 24 }}>
                {HOURS.map((h) => (<div key={h} className="absolute inset-x-0 border-t border-border/60" style={{ top: h * HOUR_PX }} />))}
                {dayEvents.map((a) => {
                  const startMin = apptMinutes(a.scheduledAt, a.timeZone);
                  const endMin = Math.max(apptMinutes(a.endsAt, a.timeZone), startMin + 30);
                  const top = (startMin / 60) * HOUR_PX;
                  const height = ((endMin - startMin) / 60) * HOUR_PX - 2;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onOpen(a.id)}
                      className={cn("absolute left-1 right-1 cursor-pointer overflow-hidden rounded border px-1.5 py-1 text-left text-[10px] shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40", APPOINTMENT_STATUS_TINT[a.status].chip)}
                      style={{ top, height }}
                    >
                      <div className="truncate font-semibold">{a.contactName || a.title}</div>
                      <div className="truncate opacity-80">{apptTimeLabel(a.scheduledAt, a.timeZone)}–{apptTimeLabel(a.endsAt, a.timeZone)} · {a.title}</div>
                    </button>
                  );
                })}
                {showNow && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: nowTop }}>
                    <span className="-ml-1 h-2 w-2 rounded-full bg-destructive shadow-[0_0_0_2px_var(--background)]" />
                    <span className="h-px flex-1 bg-destructive" />
                    <span className="ml-1 rounded bg-destructive px-1 py-0.5 text-[9px] font-semibold text-destructive-foreground">{nowLabel}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

// ── agenda view ──

function AgendaView({ appointments, onOpen }: { appointments: Appointment[]; onOpen: (id: string) => void }) {
  const grouped = useMemo(() => {
    const m = new Map<string, Appointment[]>();
    appointments.forEach((a) => { const key = apptDateKey(a); const arr = m.get(key) ?? []; arr.push(a); m.set(key, arr); });
    return Array.from(m.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, rows]) => [date, rows.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))] as const);
  }, [appointments]);

  if (grouped.length === 0) {
    return (
      <Card className="flex flex-col items-center justify-center gap-2 p-10 text-center">
        <CalendarIcon className="h-7 w-7 text-muted-foreground/40" />
        <p className="text-xs text-muted-foreground">No appointments scheduled</p>
      </Card>
    );
  }

  return (
    <Card className="min-h-0 overflow-y-auto p-0">
      <div className="divide-y divide-border">
        {grouped.map(([date, rows]) => (
          <div key={date} className="p-3">
            <h4 className="mb-2 text-xs font-semibold text-muted-foreground">
              {parseYmd(date).toLocaleDateString("default", { weekday: "long", month: "short", day: "numeric" })}
            </h4>
            <div className="space-y-1.5">
              {rows.map((a) => {
                const TypeIcon = APPOINTMENT_TYPE_ICONS[a.appointmentType];
                const tint = APPOINTMENT_STATUS_TINT[a.status];
                return (
                  <button
                    key={a.id}
                    onClick={() => onOpen(a.id)}
                    className="flex w-full items-center gap-3 rounded-md border border-border p-2 text-left hover:bg-secondary/30 transition-colors"
                  >
                    <span className="w-16 shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                      {apptTimeLabel(a.scheduledAt, a.timeZone)}–{apptTimeLabel(a.endsAt, a.timeZone)}
                    </span>
                    <TypeIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{a.title}</span>
                    {a.assigneeName && <span className="hidden shrink-0 truncate text-[11px] text-muted-foreground sm:inline">{a.assigneeName}</span>}
                    {a.address && <span className="hidden shrink-0 max-w-[160px] truncate text-[11px] text-muted-foreground md:inline">{a.address}</span>}
                    <Badge variant="outline" className={cn("h-5 shrink-0 rounded border px-1.5 text-[10px]", tint.badge)}>
                      {APPOINTMENT_STATUS_LABELS[a.status]}
                    </Badge>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
