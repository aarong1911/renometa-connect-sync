// src/components/appointments/entity-appointments-panel.tsx
//
// Phase 10.3 — one reusable "linked appointments" panel for CRM detail
// views (Lead, Contact, Company/Account, Deal, Project). Reads/writes
// through the SAME shared src/lib/appointments-store.ts used by the global
// Calendar page — an appointment created here is a real row, immediately
// visible on /calendar, and vice versa. Mirrors the shape of
// src/components/tasks/entity-tasks-panel.tsx.

import { useState } from "react";
import { Plus, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  useAppointmentsForEntity, getAppointment, type Appointment,
} from "@/lib/appointments-store";
import {
  APPOINTMENT_STATUS_LABELS, APPOINTMENT_STATUS_TINT, APPOINTMENT_TYPE_ICONS,
  type AppointmentEntityType,
} from "@/lib/appointment-status";
import { AppointmentDialog, type AppointmentDialogPrefill } from "@/components/calendar/appointment-dialog";
import { AppointmentDetailSheet } from "@/components/calendar/appointment-detail-sheet";

function fmtWhen(iso: string, tz: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function EntityAppointmentsPanel({
  entityType,
  entityId,
  entityLabel,
  contactName,
  contactPhone,
  contactEmail,
  address,
}: {
  entityType: AppointmentEntityType;
  entityId: string;
  /** e.g. "lead" / "contact" / "account" / "deal" / "project" — used in empty-state copy. */
  entityLabel: string;
  /** Prefills the create dialog's customer fields when available (e.g. from a Lead/Contact record). */
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  /** Best-known address for this record — prefills the Property Address meeting location. */
  address?: string;
}) {
  const { appointments, loading, refresh } = useAppointmentsForEntity(entityType, entityId);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);

  const now = Date.now();
  const upcoming = appointments.filter((a) => new Date(a.scheduledAt).getTime() >= now && a.status !== "cancelled").sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const past = appointments.filter((a) => new Date(a.scheduledAt).getTime() < now || a.status === "cancelled").sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));
  const ordered = [...upcoming, ...past];

  const prefill: AppointmentDialogPrefill = {
    entityType, entityId, entityLabel,
    contactName, contactPhone, contactEmail, address,
    source: entityType,
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Appointments</h3>
        <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> Schedule appointment
        </Button>
      </div>

      {loading ? (
        <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">Loading…</div>
      ) : ordered.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
          No appointments linked to this {entityLabel}.
        </div>
      ) : (
        <div className="space-y-1.5">
          {ordered.map((a) => {
            const TypeIcon = APPOINTMENT_TYPE_ICONS[a.appointmentType];
            const tint = APPOINTMENT_STATUS_TINT[a.status];
            return (
              <button
                key={a.id}
                onClick={() => setDetailId(a.id)}
                className="flex w-full items-start gap-2.5 rounded-md border border-border p-2.5 text-left hover:bg-secondary/30 transition-colors"
              >
                <TypeIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{a.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className={cn("h-4.5 rounded px-1.5 text-[9.5px]", tint.badge)}>
                      {APPOINTMENT_STATUS_LABELS[a.status]}
                    </Badge>
                    <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
                      <Clock className="h-3 w-3" /> {fmtWhen(a.scheduledAt, a.timeZone)}
                    </span>
                    {a.assigneeName && <span className="text-[10.5px] text-muted-foreground">{a.assigneeName}</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <AppointmentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        prefill={prefill}
        onSaved={() => { void refresh(); }}
      />
      <AppointmentDialog
        open={!!editingAppointment}
        onOpenChange={(o) => { if (!o) setEditingAppointment(null); }}
        appointment={editingAppointment}
        onSaved={() => { void refresh(); }}
      />
      <AppointmentDetailSheet
        open={!!detailId}
        onOpenChange={(o) => { if (!o) setDetailId(null); }}
        appointmentId={detailId}
        onEdit={async () => {
          if (!detailId) return;
          const appt = await getAppointment(detailId);
          if (appt) { setDetailId(null); setEditingAppointment(appt); }
        }}
        onChanged={() => { void refresh(); }}
      />
    </div>
  );
}
