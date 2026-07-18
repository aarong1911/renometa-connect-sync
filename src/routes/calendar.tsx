// src/routes/calendar.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ChevronLeft, ChevronRight, RefreshCw, Plus, CheckCircle2,
  Calendar as CalendarIcon, Pencil, Trash2, ExternalLink, Users,
  Clock, Loader2, Phone, Mail, MapPin, DollarSign, StickyNote,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useOrganization } from "@/lib/organization";
import { supabase } from "@/lib/supabase";

export const Route = createFileRoute("/calendar")({
  component: CalendarPage,
});

// ── Types ──

type EventType = "site-visit" | "client-meeting" | "install" | "inspection" | "internal";

type CalEvent = {
  id: string;
  title: string;
  date: string;       // YYYY-MM-DD
  start: string;      // HH:mm
  end: string;        // HH:mm
  type: EventType;
  project?: string;
  attendees: string[];
  source: "google" | "internal" | "voice-ai";
  // Contact / appointment details
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  address: string | null;
  budget: string | null;
  notes: string | null;
  status: string;
};

const TYPE_STYLES: Record<EventType, string> = {
  "site-visit":     "bg-primary/15 text-primary border-primary/30",
  "client-meeting": "bg-success/15 text-success border-success/30",
  install:          "bg-warning/15 text-warning border-warning/30",
  inspection:       "bg-destructive/15 text-destructive border-destructive/30",
  internal:         "bg-muted text-muted-foreground border-border",
};

const TYPE_LABEL: Record<EventType, string> = {
  "site-visit":     "Site visit",
  "client-meeting": "Client meeting",
  install:          "Install",
  inspection:       "Inspection",
  internal:         "Internal",
};

// ── Helpers ──

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
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function buildMonthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - startOffset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function formatRelative(d: Date, now: Date): string {
  const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// ── Org ID helper ──

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (profile?.organization_id) return profile.organization_id;
  const { data: membership } = await supabase
    .from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return membership?.org_id ?? null;
}

// ── Classify service → event type ──

function classifyService(service: string): EventType {
  const s = (service ?? "").toLowerCase();
  if (s.includes("visit") || s.includes("walkthrough") || s.includes("punch")) return "site-visit";
  if (s.includes("install")) return "install";
  if (s.includes("inspect")) return "inspection";
  if (s.includes("internal") || s.includes("sync") || s.includes("meeting")) return "internal";
  return "client-meeting";
}

// ── Map Supabase row → CalEvent ──

function mapAppointment(row: any, tz: string): CalEvent {
  const scheduled = new Date(row.scheduled_at);
  const durationMin = row.duration_min ?? 60;

  const dateStr = scheduled.toLocaleDateString("en-CA", { timeZone: tz });
  const startH = scheduled.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const endDate = new Date(scheduled.getTime() + durationMin * 60000);
  const endH = endDate.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });

  const contactName = row.contact_name || "—";
  const service = row.service || "Appointment";
  const title = `${service} — ${contactName}`;

  return {
    id: row.id,
    title,
    date: dateStr,
    start: startH,
    end: endH,
    type: classifyService(service),
    project: undefined,
    attendees: [],
    source: row.source === "Voice AI" ? "voice-ai" : "internal",
    contactName,
    contactPhone: row.contact_phone || null,
    contactEmail: row.contact_email || null,
    address: row.address || null,
    budget: row.budget || null,
    notes: row.notes || null,
    status: row.status || "scheduled",
  };
}

// ── View mode ──

type ViewMode = "month" | "week" | "day";

// ── Main page ──

function CalendarPage() {
  const org = useOrganization();
  const today = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);

  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [view, setView] = useState<ViewMode>("week");
  const [typeFilter, setTypeFilter] = useState<EventType | "all">("all");
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [selectedDay, setSelectedDay] = useState<string>(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  });
  const [nowTick, setNowTick] = useState<Date | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAppointments = useCallback(async () => {
    const orgId = await getOrgId();
    if (!orgId) { setLoading(false); return; }

    const rangeStart = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
    const rangeEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 2, 0);

    const { data, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("org_id", orgId)
      .neq("status", "cancelled")
      .gte("scheduled_at", rangeStart.toISOString())
      .lte("scheduled_at", rangeEnd.toISOString())
      .order("scheduled_at", { ascending: true });

    if (error) { console.error("[calendar] fetch failed:", error); setLoading(false); return; }

    setEvents((data ?? []).map((row: any) => mapAppointment(row, org.timezone)));
    setLoading(false);
    setLastSynced(new Date());
  }, [cursor, org.timezone]);

  useEffect(() => { fetchAppointments(); }, [fetchAppointments]);

  useEffect(() => {
    const update = () => setNowTick(new Date());
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(
    () => typeFilter === "all" ? events : events.filter((e) => e.type === typeFilter),
    [events, typeFilter],
  );

  const eventsByDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    filtered.forEach((e) => { const arr = m.get(e.date) ?? []; arr.push(e); m.set(e.date, arr); });
    return m;
  }, [filtered]);

  const selectedDate = useMemo(() => parseYmd(selectedDay), [selectedDay]);
  const weekDays = useMemo(() => buildWeekDays(selectedDate), [selectedDate]);

  const headerLabel = useMemo(() => {
    if (view === "month") return cursor.toLocaleString("default", { month: "long", year: "numeric" });
    if (view === "day") return selectedDate.toLocaleDateString("default", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const last = weekDays[6];
    const sameMonth = weekDays[0].getMonth() === last.getMonth();
    const left = weekDays[0].toLocaleDateString("default", { month: "short", day: "numeric" });
    const right = sameMonth ? `${last.getDate()}, ${last.getFullYear()}` : last.toLocaleDateString("default", { month: "short", day: "numeric", year: "numeric" });
    return `${left} – ${right}`;
  }, [view, cursor, selectedDate, weekDays]);

  const daysGrid = useMemo(() => buildMonthGrid(cursor), [cursor]);
  const selectedEvents = (eventsByDay.get(selectedDay) ?? []).slice().sort((a, b) => a.start.localeCompare(b.start));

  const shift = (dir: -1 | 1) => {
    if (view === "month") {
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

  const handleSync = async () => {
    setSyncing(true);
    await fetchAppointments();
    setSyncing(false);
    toast.success("Calendar refreshed", { description: `${events.length} appointments loaded` });
  };

  const counts = useMemo(() => {
    const c: Record<EventType, number> = { "site-visit": 0, "client-meeting": 0, install: 0, inspection: 0, internal: 0 };
    events.forEach((e) => (c[e.type] += 1));
    return c;
  }, [events]);

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="flex h-[calc(100vh-160px)] flex-col gap-3">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-cyan-soft ring-1 ring-black/5">
          <CalendarIcon className="h-4 w-4 text-cyan-soft-foreground" />
        </div>
        <div>
          <h1 className="text-[17px] font-semibold leading-tight tracking-tight">Calendar</h1>
          <p className="text-[11.5px] text-muted-foreground">Manage bookings, appointments, and your team's schedule.</p>
        </div>
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
        <div className="flex items-center gap-2">
          <ToggleGroup type="single" value={view} onValueChange={(v) => v && setView(v as ViewMode)} className="h-8 rounded-md border border-border p-0.5">
            <ToggleGroupItem value="month" className="h-7 px-2.5 text-xs data-[state=on]:bg-secondary">Month</ToggleGroupItem>
            <ToggleGroupItem value="week"  className="h-7 px-2.5 text-xs data-[state=on]:bg-secondary">Week</ToggleGroupItem>
            <ToggleGroupItem value="day"   className="h-7 px-2.5 text-xs data-[state=on]:bg-secondary">Day</ToggleGroupItem>
          </ToggleGroup>
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as EventType | "all")}>
            <SelectTrigger className="h-8 w-[160px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="site-visit">Site visits</SelectItem>
              <SelectItem value="client-meeting">Client meetings</SelectItem>
              <SelectItem value="install">Installs</SelectItem>
              <SelectItem value="inspection">Inspections</SelectItem>
              <SelectItem value="internal">Internal</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-8" onClick={handleSync} disabled={syncing}>
            <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
            <span className="text-xs">{syncing ? "Syncing…" : "Refresh"}</span>
          </Button>
          <Button size="sm" className="h-8"><Plus className="h-3.5 w-3.5" /><span className="text-xs">New event</span></Button>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
        <span>
          {lastSynced ? `Last refreshed ${nowTick ? formatRelative(lastSynced, nowTick) : "recently"}` : "Loading…"} · {events.length} appointments
        </span>
        <span className="mx-1 text-border">|</span>
        {(Object.keys(TYPE_LABEL) as EventType[]).map((t) => (
          <span key={t} className="inline-flex items-center gap-1">
            <span className={cn("h-2 w-2 rounded-sm border", TYPE_STYLES[t])} />
            <span>{TYPE_LABEL[t]} ({counts[t]})</span>
          </span>
        ))}
      </div>

      {/* Main grid */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[1fr_320px]">

        {/* Calendar view */}
        {view === "month" && (
          <Card className="flex flex-col overflow-hidden p-0">
            <div className="grid flex-shrink-0 grid-cols-7 border-b border-border bg-secondary/40">
              {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => (
                <div key={d} className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{d}</div>
              ))}
            </div>
            <div className="grid flex-1 grid-cols-7 auto-rows-fr">
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
                      {dayEvents.slice(0, 3).map((e) => (
                        <div key={e.id} className={cn("truncate rounded border px-1 py-0.5 text-[10px] font-medium", TYPE_STYLES[e.type])}>
                          {e.start} {e.title}
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
          <TimeGrid days={weekDays} today={today} now={nowTick} selectedDay={selectedDay} onSelectDay={setSelectedDay} eventsByDay={eventsByDay} />
        )}
        {view === "day" && (
          <TimeGrid days={[selectedDate]} today={today} now={nowTick} selectedDay={selectedDay} onSelectDay={setSelectedDay} eventsByDay={eventsByDay} />
        )}

        {/* ── Improved side card ── */}
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
              <Button size="sm" variant="outline" className="mt-1 h-7 text-xs">
                <Plus className="h-3 w-3" /> New Event
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {selectedEvents.map((e) => (
                <AppointmentCard key={e.id} event={e} />
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ── Appointment card (side panel) ──

function AppointmentCard({ event: e }: { event: CalEvent }) {
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(e.notes ?? "");
  const [saving, setSaving] = useState(false);

  const handleSaveNotes = async () => {
    setSaving(true);
    const { error } = await supabase
      .from("appointments")
      .update({ notes, updated_at: new Date().toISOString() })
      .eq("id", e.id);
    setSaving(false);
    if (error) { toast.error("Failed to save notes"); return; }
    toast.success("Notes saved");
    setEditing(false);
  };

  return (
    <div className="rounded-lg border border-border bg-background p-3 space-y-2.5">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold leading-snug">{e.contactName}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{e.title.split(" — ")[0]}</div>
        </div>
        <Badge variant="secondary" className={cn("h-5 shrink-0 rounded border px-1.5 text-[10px]", TYPE_STYLES[e.type])}>
          {TYPE_LABEL[e.type]}
        </Badge>
      </div>

      {/* Time */}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Clock className="h-3 w-3" />
        <span className="font-medium tabular-nums text-foreground">{e.start}–{e.end}</span>
        <span>·</span>
        <span className="capitalize">{e.source === "voice-ai" ? "Voice AI" : e.source}</span>
      </div>

      {/* Contact details */}
      <div className="space-y-1.5 border-t border-border pt-2">
        {e.contactPhone && (
          <a href={`tel:${e.contactPhone}`} className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
            <Phone className="h-3 w-3 shrink-0" />
            <span>{e.contactPhone}</span>
          </a>
        )}
        {e.contactEmail && (
          <a href={`mailto:${e.contactEmail}`} className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
            <Mail className="h-3 w-3 shrink-0" />
            <span className="truncate">{e.contactEmail}</span>
          </a>
        )}
        {e.address && (
          <a
            href={`https://maps.google.com/?q=${encodeURIComponent(e.address)}`}
            target="_blank" rel="noopener noreferrer"
            className="flex items-start gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
            <span className="line-clamp-2">{e.address}</span>
          </a>
        )}
        {e.budget && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <DollarSign className="h-3 w-3 shrink-0" />
            <span>Budget: <span className="text-foreground font-medium">{e.budget}</span></span>
          </div>
        )}

        {/* Notes — inline edit */}
        <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <StickyNote className="h-3 w-3 mt-0.5 shrink-0" />
          {editing ? (
            <div className="flex-1 space-y-1.5">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full rounded border border-border bg-background px-2 py-1 text-[11px] text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex gap-1.5">
                <Button size="sm" className="h-6 text-[10px]" onClick={handleSaveNotes} disabled={saving}>
                  {saving ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : "Save"}
                </Button>
                <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => { setNotes(e.notes ?? ""); setEditing(false); }}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <span
              className="line-clamp-2 cursor-pointer hover:text-foreground transition-colors"
              onClick={() => setEditing(true)}
            >
              {notes || <span className="italic">Add notes…</span>}
            </span>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-1.5 border-t border-border pt-2">
        {e.contactPhone && (
          <a
            href={`tel:${e.contactPhone}`}
            className="flex-1 inline-flex h-7 items-center justify-center gap-1 rounded-md border border-input bg-background px-2 text-[11px] font-medium hover:bg-accent transition-colors"
          >
            <Phone className="h-3 w-3" /> Call
          </a>
        )}
        {e.contactEmail && (
          <a
            href={`mailto:${e.contactEmail}`}
            className="flex-1 inline-flex h-7 items-center justify-center gap-1 rounded-md border border-input bg-background px-2 text-[11px] font-medium hover:bg-accent transition-colors"
          >
            <Mail className="h-3 w-3" /> Email
          </a>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2"
          onClick={() => setEditing(!editing)}
        >
          <Pencil className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

// ── Time grid ──

const HOUR_PX = 44;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function TimeGrid({
  days, today, now, selectedDay, onSelectDay, eventsByDay,
}: {
  days: Date[]; today: Date; now: Date | null;
  selectedDay: string; onSelectDay: (d: string) => void;
  eventsByDay: Map<string, CalEvent[]>;
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
            const dayEvents = (eventsByDay.get(key) ?? []).slice().sort((a, b) => a.start.localeCompare(b.start));
            const showNow = nowMinutes !== null && key === todayKey;
            return (
              <div key={key} className="relative border-l border-border" style={{ height: HOUR_PX * 24 }}>
                {HOURS.map((h) => (<div key={h} className="absolute inset-x-0 border-t border-border/60" style={{ top: h * HOUR_PX }} />))}
                {dayEvents.map((e) => {
                  const startMin = toMinutes(e.start);
                  const endMin = Math.max(toMinutes(e.end), startMin + 30);
                  const top = (startMin / 60) * HOUR_PX;
                  const height = ((endMin - startMin) / 60) * HOUR_PX - 2;
                  return (
                    <Popover key={e.id}>
                      <PopoverTrigger asChild>
                        <button type="button"
                          className={cn("absolute left-1 right-1 cursor-pointer overflow-hidden rounded border px-1.5 py-1 text-left text-[10px] shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40", TYPE_STYLES[e.type])}
                          style={{ top, height }}
                        >
                          <div className="truncate font-semibold">{e.contactName}</div>
                          <div className="truncate opacity-80">{e.start}–{e.end} · {e.title.split(" — ")[0]}</div>
                        </button>
                      </PopoverTrigger>
                      <EventDetailPopover event={e} />
                    </Popover>
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

// ── Event detail popover (hover on time grid) ──

function EventDetailPopover({ event: e }: { event: CalEvent }) {
  return (
    <PopoverContent align="start" side="right" className="w-72 p-0">
      <div className={cn("border-b px-3 py-2", TYPE_STYLES[e.type])}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold leading-tight">{e.contactName}</h4>
            <p className="text-[11px] opacity-80">{e.title.split(" — ")[0]}</p>
          </div>
          <Badge variant="secondary" className="h-5 shrink-0 rounded border px-1.5 text-[10px]">
            {TYPE_LABEL[e.type]}
          </Badge>
        </div>
      </div>
      <div className="space-y-2 px-3 py-2.5 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          <span className="tabular-nums">{e.start}–{e.end}</span>
          <span className="ml-auto text-[10px] capitalize">{e.source === "voice-ai" ? "Voice AI" : e.source}</span>
        </div>
        {e.contactPhone && (
          <div className="flex items-center gap-2"><Phone className="h-3.5 w-3.5 text-muted-foreground" /><a href={`tel:${e.contactPhone}`} className="hover:underline">{e.contactPhone}</a></div>
        )}
        {e.contactEmail && (
          <div className="flex items-center gap-2"><Mail className="h-3.5 w-3.5 text-muted-foreground" /><a href={`mailto:${e.contactEmail}`} className="hover:underline truncate">{e.contactEmail}</a></div>
        )}
        {e.address && (
          <div className="flex items-start gap-2"><MapPin className="h-3.5 w-3.5 mt-0.5 text-muted-foreground" /><a href={`https://maps.google.com/?q=${encodeURIComponent(e.address)}`} target="_blank" rel="noopener noreferrer" className="hover:underline line-clamp-2">{e.address}</a></div>
        )}
        {e.budget && (
          <div className="flex items-center gap-2"><DollarSign className="h-3.5 w-3.5 text-muted-foreground" /><span>Budget: {e.budget}</span></div>
        )}
      </div>
      <div className="flex items-center gap-1 border-t border-border p-1.5">
        <Button variant="ghost" size="sm" className="h-7 flex-1 text-xs" onClick={() => toast.info(`Edit "${e.title}" — coming soon`)}>
          <Pencil className="h-3 w-3" /> Edit
        </Button>
        <Button variant="ghost" size="sm" className="h-7 flex-1 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => toast.success("Event deleted", { description: e.title })}>
          <Trash2 className="h-3 w-3" /> Delete
        </Button>
      </div>
    </PopoverContent>
  );
}