// src/components/calendar/appointment-detail-sheet.tsx
//
// Phase 10.3 — real appointment detail Sheet with real, org-scoped
// lifecycle actions and a real, guarded delete flow. Replaces the old
// calendar.tsx popover whose Edit action showed a "coming soon" toast and
// whose Delete action showed "Event deleted" without ever calling
// Supabase (see the Phase 10.3 report's root-cause section).

import { useState } from "react";
import { toast } from "sonner";
import {
  Phone, Mail, MapPin, Clock, User, Link2, Bell, RefreshCcw,
  CheckCircle2, PlayCircle, XCircle, RotateCcw, UserX, Pencil, Trash2, Loader2,
} from "lucide-react";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { formatUsPhone } from "@/lib/phone";
import {
  APPOINTMENT_STATUS_LABELS, APPOINTMENT_STATUS_TINT, APPOINTMENT_STATUS_ICONS,
  APPOINTMENT_TYPE_LABELS, APPOINTMENT_SOURCE_LABELS, APPOINTMENT_ENTITY_TYPE_LABELS,
  MEETING_LOCATION_TYPE_LABELS, getMeetingLocationFromAppointment,
} from "@/lib/appointment-status";
import {
  useAppointment, useAppointmentActivities, deleteAppointment,
  confirmAppointment, startAppointment, completeAppointment, reopenAppointment,
  cancelAppointment, restoreAppointment, markAppointmentNoShow,
} from "@/lib/appointments-store";

function fmtDateTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function fmtActivityTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const ACTIVITY_LABELS: Record<string, string> = {
  created: "Created", rescheduled: "Rescheduled", assigned: "Assigned", unassigned: "Unassigned",
  confirmed: "Confirmed", started: "Started", completed: "Completed", reopened: "Reopened",
  cancelled: "Cancelled", restored: "Restored", marked_no_show: "Marked no-show",
  relationship_changed: "Related record changed", location_changed: "Location changed",
  reminder_changed: "Reminders changed", google_synced: "Synced to Google Calendar",
  google_sync_failed: "Google Calendar sync failed",
};

export function AppointmentDetailSheet({
  open,
  onOpenChange,
  appointmentId,
  onEdit,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointmentId: string | null;
  onEdit: () => void;
  onChanged?: () => void;
}) {
  const { appointment, loading, refresh } = useAppointment(open ? appointmentId : null);
  const { activity } = useAppointmentActivities(open ? appointmentId : null);
  const [busy, setBusy] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function runAction(label: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (!result.ok) { toast.error(`Could not ${label.toLowerCase()}`, { description: result.error }); return; }
    toast.success(label);
    await refresh();
    onChanged?.();
  }

  async function handleDelete() {
    if (!appointment) return;
    setDeleting(true);
    const result = await deleteAppointment(appointment.id);
    setDeleting(false);
    if (!result.ok) {
      toast.error("Could not delete the appointment", { description: result.error });
      return;
    }
    setConfirmDeleteOpen(false);
    toast.success("Appointment deleted", { description: appointment.title });
    onOpenChange(false);
    onChanged?.();
  }

  if (!appointment && !loading) {
    return null;
  }

  const StatusIcon = appointment ? APPOINTMENT_STATUS_ICONS[appointment.status] : null;
  const tint = appointment ? APPOINTMENT_STATUS_TINT[appointment.status] : null;
  const meetingLocation = appointment ? getMeetingLocationFromAppointment(appointment) : null;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md">
          {loading || !appointment ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <SheetHeader className="space-y-2 text-left">
                <div className="flex items-center gap-2">
                  {StatusIcon && <StatusIcon className={cn("h-4 w-4", tint?.icon)} />}
                  <Badge variant="outline" className={cn("h-5 rounded px-1.5 text-[10px]", tint?.badge)}>
                    {APPOINTMENT_STATUS_LABELS[appointment.status]}
                  </Badge>
                  <Badge variant="outline" className="h-5 rounded px-1.5 text-[10px]">
                    {APPOINTMENT_TYPE_LABELS[appointment.appointmentType]}
                  </Badge>
                </div>
                <SheetTitle className="text-base">{appointment.title}</SheetTitle>
              </SheetHeader>

              <div className="mt-4 flex-1 space-y-4 text-sm">
                <div className="flex items-start gap-2 text-muted-foreground">
                  <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div>
                    <div className="text-foreground">
                      {fmtDateTime(appointment.scheduledAt, appointment.timeZone)} – {new Date(appointment.endsAt).toLocaleTimeString("en-US", { timeZone: appointment.timeZone, hour: "numeric", minute: "2-digit" })}
                    </div>
                    <div className="text-[11px]">{appointment.timeZone} · {appointment.durationMin} min · {APPOINTMENT_SOURCE_LABELS[appointment.source] ?? appointment.source}</div>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-muted-foreground">
                  <User className="h-3.5 w-3.5 shrink-0" />
                  <span>{appointment.assigneeName ?? "Unassigned"}</span>
                </div>

                {appointment.entityType && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Link2 className="h-3.5 w-3.5 shrink-0" />
                    <span>{APPOINTMENT_ENTITY_TYPE_LABELS[appointment.entityType]} linked</span>
                  </div>
                )}

                {(appointment.contactName || appointment.contactPhone || appointment.contactEmail) && (
                  <div className="space-y-1.5 rounded-lg border border-border bg-background p-2.5">
                    {appointment.contactName && <div className="text-xs font-medium">{appointment.contactName}</div>}
                    {appointment.contactPhone && (
                      <a href={`tel:${appointment.contactPhone}`} className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
                        <Phone className="h-3 w-3" /> {formatUsPhone(appointment.contactPhone)}
                      </a>
                    )}
                    {appointment.contactEmail && (
                      <a href={`mailto:${appointment.contactEmail}`} className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
                        <Mail className="h-3 w-3" /> {appointment.contactEmail}
                      </a>
                    )}
                  </div>
                )}

                {(appointment.address || appointment.meetingUrl) && (
                  <div className="space-y-1 rounded-md border border-border bg-background p-2.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {meetingLocation && MEETING_LOCATION_TYPE_LABELS[meetingLocation.meetingLocationType]}
                      {meetingLocation?.meetingLocationType === "other" && meetingLocation.meetingLocationLabel
                        ? ` · ${meetingLocation.meetingLocationLabel}`
                        : ""}
                    </div>
                    {appointment.address && (
                      <a
                        href={`https://maps.google.com/?q=${encodeURIComponent(appointment.address)}`}
                        target="_blank" rel="noopener noreferrer"
                        className="flex items-start gap-2 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {appointment.address}
                      </a>
                    )}
                    {appointment.meetingUrl && (
                      <a href={appointment.meetingUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-[11px] text-primary hover:underline">
                        <Link2 className="h-3.5 w-3.5 shrink-0" /> Open meeting link
                      </a>
                    )}
                  </div>
                )}

                {appointment.reminderMinutes && appointment.reminderMinutes.length > 0 && (
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Bell className="h-3.5 w-3.5 shrink-0" />
                    Reminders: {appointment.reminderMinutes.map((m) => (m >= 1440 ? `${m / 1440}d` : m >= 60 ? `${m / 60}h` : `${m}m`)).join(", ")} before
                  </div>
                )}

                {appointment.googleSyncStatus && (
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <RefreshCcw className="h-3.5 w-3.5 shrink-0" />
                    Google Calendar: {appointment.googleSyncStatus}
                    {appointment.googleSyncStatus === "failed" && appointment.googleLastError && (
                      <span className="text-destructive"> — {appointment.googleLastError}</span>
                    )}
                  </div>
                )}

                {appointment.notes && (
                  <div className="rounded-lg border border-dashed border-border p-2.5 text-[12px] text-muted-foreground">
                    {appointment.notes}
                  </div>
                )}

                {activity.length > 0 && (
                  <div className="space-y-1.5 border-t border-border pt-3">
                    <h4 className="text-xs font-semibold">Activity</h4>
                    <div className="space-y-1.5">
                      {activity.map((a) => (
                        <div key={a.id} className="text-[11px] text-muted-foreground">
                          <span className="text-foreground">{ACTIVITY_LABELS[a.activityType] ?? a.activityType}</span>
                          {" · "}{fmtActivityTime(a.createdAt)}{a.actorId ? "" : " · System"}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4 space-y-2 border-t border-border pt-3">
                <div className="flex flex-wrap gap-1.5">
                  {appointment.status === "scheduled" && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => runAction("Confirmed", () => confirmAppointment(appointment.id))}>
                      <CheckCircle2 className="h-3 w-3" /> Confirm
                    </Button>
                  )}
                  {(appointment.status === "scheduled" || appointment.status === "confirmed") && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => runAction("Started", () => startAppointment(appointment.id))}>
                      <PlayCircle className="h-3 w-3" /> Start
                    </Button>
                  )}
                  {(appointment.status === "scheduled" || appointment.status === "confirmed" || appointment.status === "in_progress") && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => runAction("Completed", () => completeAppointment(appointment.id))}>
                      <CheckCircle2 className="h-3 w-3" /> Complete
                    </Button>
                  )}
                  {appointment.status === "completed" && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => runAction("Reopened", () => reopenAppointment(appointment.id))}>
                      <RotateCcw className="h-3 w-3" /> Reopen
                    </Button>
                  )}
                  {(appointment.status === "cancelled" || appointment.status === "no_show") && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => runAction("Restored", () => restoreAppointment(appointment.id))}>
                      <RotateCcw className="h-3 w-3" /> Restore
                    </Button>
                  )}
                  {(appointment.status === "scheduled" || appointment.status === "confirmed" || appointment.status === "in_progress") && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => runAction("Marked no-show", () => markAppointmentNoShow(appointment.id))}>
                      <UserX className="h-3 w-3" /> No Show
                    </Button>
                  )}
                  {appointment.status !== "cancelled" && appointment.status !== "completed" && (
                    <Button size="sm" variant="outline" className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={busy} onClick={() => runAction("Cancelled", () => cancelAppointment(appointment.id))}>
                      <XCircle className="h-3 w-3" /> Cancel
                    </Button>
                  )}
                </div>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="outline" className="h-8 flex-1 text-xs" onClick={onEdit}>
                    <Pencil className="h-3 w-3" /> Edit
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 flex-1 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setConfirmDeleteOpen(true)}>
                    <Trash2 className="h-3 w-3" /> Delete
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete appointment?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes {appointment ? `"${appointment.title}"` : "this appointment"} from RenoMeta Connect. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => { e.preventDefault(); void handleDelete(); }}
            >
              {deleting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Delete appointment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
