// src/components/calendar/appointment-dialog.tsx
//
// Phase 10.3 — reusable create/edit appointment dialog. Replaces the old
// new-booking-dialog.tsx (which only handled create, against the
// pre-migration schema, and was never actually wired to Calendar's "New
// event" button). One component handles both create and edit — pass
// `appointment` to prefill and switch to edit mode.
//
// Targets the full schema added by
// supabase/migrations/20260807_calendar_appointments_completion.sql —
// requires that migration to be deployed (see the Phase 10.3 report).

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { supabase } from "@/lib/supabase";
import { useTeam, useOrganization, TIMEZONE_OPTIONS } from "@/lib/organization";
import {
  APPOINTMENT_TYPE_ORDER, APPOINTMENT_TYPE_LABELS,
  APPOINTMENT_STATUS_ORDER, APPOINTMENT_STATUS_LABELS,
  MEETING_LOCATION_TYPE_LABELS, MEETING_MODE_LABELS, getMeetingLocationFromAppointment,
  type AppointmentType, type AppointmentStatus, type AppointmentEntityType,
  type MeetingLocationType, type MeetingMode,
} from "@/lib/appointment-status";
import {
  createAppointment, updateAppointment, getSessionContext,
  type Appointment,
} from "@/lib/appointments-store";
import { AppointmentEntityPicker } from "@/components/appointments/entity-picker";
import { formatUsPhone } from "@/lib/phone";

const ENTITY_TYPE_OPTIONS: { value: AppointmentEntityType | "none"; label: string }[] = [
  { value: "none", label: "None" },
  { value: "lead", label: "Lead" },
  { value: "contact", label: "Contact" },
  { value: "company", label: "Account" },
  { value: "deal", label: "Deal" },
  { value: "project", label: "Project" },
];

const REMINDER_OPTIONS = [
  { minutes: 10, label: "10 minutes before" },
  { minutes: 30, label: "30 minutes before" },
  { minutes: 60, label: "1 hour before" },
  { minutes: 120, label: "2 hours before" },
  { minutes: 1440, label: "1 day before" },
];

function todayInputValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = (h * 60 + m + minutes + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

type FormState = {
  title: string;
  appointmentType: AppointmentType;
  status: AppointmentStatus;
  date: string;
  startTime: string;
  endTime: string;
  timeZone: string;
  assignedTo: string;
  entityType: AppointmentEntityType | "none";
  entityId: string | null;
  entityLabel: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  address: string;
  meetingLocationType: MeetingLocationType;
  meetingLocationLabel: string;
  meetingMode: MeetingMode;
  meetingUrl: string;
  notes: string;
  reminderMinutes: number[];
};

function blankForm(timeZone: string): FormState {
  return {
    title: "", appointmentType: "consultation", status: "scheduled",
    date: todayInputValue(), startTime: "09:00", endTime: "10:00", timeZone,
    assignedTo: "unassigned", entityType: "none", entityId: null, entityLabel: "",
    contactName: "", contactPhone: "", contactEmail: "", address: "",
    meetingLocationType: "property_address", meetingLocationLabel: "", meetingMode: "in_person", meetingUrl: "",
    notes: "", reminderMinutes: [],
  };
}

function formFromAppointment(a: Appointment): FormState {
  const start = new Date(a.scheduledAt);
  const end = new Date(a.endsAt);
  const dateStr = start.toLocaleDateString("en-CA", { timeZone: a.timeZone });
  const startTime = start.toLocaleTimeString("en-GB", { timeZone: a.timeZone, hour: "2-digit", minute: "2-digit", hour12: false });
  const endTime = end.toLocaleTimeString("en-GB", { timeZone: a.timeZone, hour: "2-digit", minute: "2-digit", hour12: false });
  const location = getMeetingLocationFromAppointment(a);
  return {
    title: a.title, appointmentType: a.appointmentType, status: a.status,
    date: dateStr, startTime, endTime, timeZone: a.timeZone,
    assignedTo: a.assignedTo ?? "unassigned",
    entityType: a.entityType ?? "none", entityId: a.entityId, entityLabel: a.assigneeName ?? "",
    contactName: a.contactName ?? "", contactPhone: formatUsPhone(a.contactPhone), contactEmail: a.contactEmail ?? "",
    address: a.address ?? "",
    meetingLocationType: location.meetingLocationType,
    meetingLocationLabel: location.meetingLocationLabel ?? "",
    meetingMode: location.meetingMode ?? "in_person",
    meetingUrl: a.meetingUrl ?? "",
    notes: a.notes ?? "",
    reminderMinutes: a.reminderMinutes ?? [],
  };
}

export type AppointmentDialogPrefill = {
  entityType?: AppointmentEntityType;
  entityId?: string;
  entityLabel?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  /** Best-known address for this CRM context — prefills the Property Address meeting location. */
  address?: string;
  source?: Appointment["source"];
  scheduledAt?: string;
  metadata?: Record<string, unknown>;
};

export function AppointmentDialog({
  open,
  onOpenChange,
  appointment,
  prefill,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present = edit mode, absent = create mode. */
  appointment?: Appointment | null;
  /** Create-mode only — prefills relationship/contact/source from the calling context (Contact panel, Inbox, etc.). */
  prefill?: AppointmentDialogPrefill;
  onSaved?: (appointment: Appointment) => void;
}) {
  const org = useOrganization();
  const teamMembers = useTeam().filter((m) => m.status === "active");
  const isEdit = !!appointment;

  const [form, setForm] = useState<FormState>(() => blankForm(org.timezone));
  const [saving, setSaving] = useState(false);
  const [conflictWarning, setConflictWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (appointment) {
      setForm(formFromAppointment(appointment));
    } else {
      setForm({
        ...blankForm(org.timezone),
        entityType: prefill?.entityType ?? "none",
        entityId: prefill?.entityId ?? null,
        entityLabel: prefill?.entityLabel ?? "",
        contactName: prefill?.contactName ?? "",
        contactPhone: formatUsPhone(prefill?.contactPhone),
        contactEmail: prefill?.contactEmail ?? "",
        address: prefill?.address ?? "",
        // A known CRM address defaults the location to Property Address
        // (the common case — scheduling at the customer's property);
        // otherwise default to Other rather than silently picking Property
        // Address with nothing to show.
        meetingLocationType: prefill?.address ? "property_address" : "other",
        ...(prefill?.scheduledAt
          ? {
              date: new Date(prefill.scheduledAt).toLocaleDateString("en-CA", { timeZone: org.timezone }),
              startTime: new Date(prefill.scheduledAt).toLocaleTimeString("en-GB", { timeZone: org.timezone, hour: "2-digit", minute: "2-digit", hour12: false }),
            }
          : {}),
      });
    }
    setConflictWarning(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, appointment?.id]);

  const scheduledAtIso = useMemo(() => {
    if (!form.date || !form.startTime) return null;
    return new Date(`${form.date}T${form.startTime}:00`).toISOString();
  }, [form.date, form.startTime]);

  const endsAtIso = useMemo(() => {
    if (!form.date || !form.endTime) return null;
    return new Date(`${form.date}T${form.endTime}:00`).toISOString();
  }, [form.date, form.endTime]);

  // Non-blocking same-assignee overlap check (Part 31) — queries just that
  // one day for that one assignee, not the whole store.
  useEffect(() => {
    if (!open || form.assignedTo === "unassigned" || !scheduledAtIso || !endsAtIso) { setConflictWarning(null); return; }
    let cancelled = false;
    (async () => {
      const { orgId } = await getSessionContext();
      if (!orgId) return;
      const dayStart = new Date(`${form.date}T00:00:00`).toISOString();
      const dayEnd = new Date(`${form.date}T23:59:59`).toISOString();
      const { data } = await supabase
        .from("appointments")
        .select("id, scheduled_at, ends_at, duration_min, status, title, service")
        .eq("org_id", orgId)
        .eq("assigned_to", form.assignedTo)
        .gte("scheduled_at", dayStart)
        .lte("scheduled_at", dayEnd)
        .not("status", "in", "(cancelled,no_show)");
      if (cancelled || !data) return;
      const newStart = new Date(scheduledAtIso).getTime();
      const newEnd = new Date(endsAtIso).getTime();
      const conflict = data.find((row: any) => {
        if (appointment && row.id === appointment.id) return false;
        const rStart = new Date(row.scheduled_at).getTime();
        const rEnd = row.ends_at ? new Date(row.ends_at).getTime() : rStart + (row.duration_min ?? 60) * 60000;
        return rStart < newEnd && rEnd > newStart;
      });
      setConflictWarning(conflict ? `This team member has another appointment (${conflict.title || conflict.service || "appointment"}) during this time.` : null);
    })();
    return () => { cancelled = true; };
  }, [open, form.assignedTo, form.date, form.startTime, form.endTime, scheduledAtIso, endsAtIso, appointment]);

  function close() {
    onOpenChange(false);
  }

  function toggleReminder(minutes: number) {
    setForm((f) => ({
      ...f,
      reminderMinutes: f.reminderMinutes.includes(minutes)
        ? f.reminderMinutes.filter((m) => m !== minutes)
        : [...f.reminderMinutes, minutes].sort((a, b) => a - b),
    }));
  }

  async function handleSave() {
    if (!form.title.trim()) { toast.error("Title is required"); return; }
    if (!form.date || !form.startTime || !form.endTime) { toast.error("Date and time are required"); return; }
    if (!scheduledAtIso || !endsAtIso) { toast.error("Invalid date or time"); return; }
    if (new Date(endsAtIso).getTime() <= new Date(scheduledAtIso).getTime()) {
      toast.error("End time must be after the start time");
      return;
    }
    if (form.contactEmail.trim() && !/^\S+@\S+\.\S+$/.test(form.contactEmail.trim())) {
      toast.error("Enter a valid email address");
      return;
    }
    if (form.meetingLocationType === "other") {
      if (!form.meetingLocationLabel.trim()) { toast.error("Enter a location label (e.g. Customer's office)"); return; }
      if (form.meetingMode === "in_person" && !form.address.trim()) { toast.error("Address is required for an in-person meeting"); return; }
      if (form.meetingMode === "video") {
        if (!form.meetingUrl.trim()) { toast.error("Enter a meeting link"); return; }
        if (!/^https?:\/\/\S+$/i.test(form.meetingUrl.trim())) { toast.error("Enter a valid meeting URL (starting with http:// or https://)"); return; }
      }
    }

    setSaving(true);

    // Resolve the persisted address/meeting_url from the selected Meeting
    // Location mode — address and meeting_url stay the existing, honest
    // columns; only the *choice* the user made goes into metadata (see
    // getMeetingLocationFromAppointment in appointment-status.ts).
    const resolvedAddress =
      form.meetingLocationType === "property_address" ? form.address || null :
      form.meetingLocationType === "office" ? org.address || null :
      form.address || null; // "other": in_person/phone use the typed address, video may leave it empty
    const resolvedMeetingUrl =
      form.meetingLocationType === "other" && form.meetingMode === "video" ? form.meetingUrl.trim() || null : null;
    const existingMetadata = (isEdit ? appointment?.metadata : prefill?.metadata) ?? {};
    const meetingMetadata: Record<string, unknown> = {
      ...existingMetadata,
      meetingLocationType: form.meetingLocationType,
      ...(form.meetingLocationType === "other" ? { meetingLocationLabel: form.meetingLocationLabel.trim(), meetingMode: form.meetingMode } : {}),
    };

    const entityType = form.entityType === "none" ? null : form.entityType;
    const commonPatch = {
      title: form.title.trim(),
      appointmentType: form.appointmentType,
      timeZone: form.timeZone,
      assignedTo: form.assignedTo === "unassigned" ? null : form.assignedTo,
      entityType,
      entityId: entityType ? form.entityId : null,
      contactName: form.contactName || null,
      // Re-formatted defensively at save time too (not just on keystroke) —
      // covers paste/autofill, which can populate the field without firing
      // the onChange handler above. Matches the existing contacts.phone
      // storage convention (formatted display string, not digits-only).
      contactPhone: formatUsPhone(form.contactPhone) || null,
      contactEmail: form.contactEmail || null,
      address: resolvedAddress,
      meetingUrl: resolvedMeetingUrl,
      notes: form.notes || null,
      reminderMinutes: form.reminderMinutes.length ? form.reminderMinutes : null,
      metadata: meetingMetadata,
    };

    if (isEdit && appointment) {
      const result = await updateAppointment(appointment.id, {
        ...commonPatch,
        scheduledAt: scheduledAtIso,
        endsAt: endsAtIso,
        status: form.status,
      });
      setSaving(false);
      if (!result.ok) { toast.error("Could not save changes", { description: result.error }); return; }
      toast.success("Appointment updated");
      onSaved?.(result.appointment);
      close();
      return;
    }

    const result = await createAppointment({
      ...commonPatch,
      scheduledAt: scheduledAtIso,
      endsAt: endsAtIso,
      source: prefill?.source ?? "manual",
      status: "scheduled",
    });
    setSaving(false);
    if (!result.ok) { toast.error("Could not create the appointment", { description: result.error }); return; }
    toast.success("Appointment created");
    onSaved?.(result.appointment);
    close();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); else onOpenChange(o); }}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        onInteractOutside={(e) => {
          const target = ((e as CustomEvent).detail?.originalEvent?.target ?? e.target) as HTMLElement | null;
          if (target?.closest?.(".pac-container")) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Appointment" : "New Appointment"}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ap-title">Title <span className="text-destructive">*</span></Label>
            <Input
              id="ap-title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Site visit, install, consultation…"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Type</Label>
              <Select value={form.appointmentType} onValueChange={(v) => setForm((f) => ({ ...f, appointmentType: v as AppointmentType }))}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {APPOINTMENT_TYPE_ORDER.map((t) => (
                    <SelectItem key={t} value={t}>{APPOINTMENT_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {isEdit && (
              <div className="grid gap-1.5">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as AppointmentStatus }))}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {APPOINTMENT_STATUS_ORDER.map((s) => (
                      <SelectItem key={s} value={s}>{APPOINTMENT_STATUS_LABELS[s]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-1 grid gap-1.5">
              <Label htmlFor="ap-date">Date</Label>
              <Input id="ap-date" type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="col-span-1 grid gap-1.5">
              <Label htmlFor="ap-start">Start</Label>
              <Input
                id="ap-start"
                type="time"
                value={form.startTime}
                onChange={(e) => {
                  const start = e.target.value;
                  setForm((f) => ({ ...f, startTime: start, endTime: addMinutesToTime(start, 60) }));
                }}
              />
            </div>
            <div className="col-span-1 grid gap-1.5">
              <Label htmlFor="ap-end">End</Label>
              <Input id="ap-end" type="time" value={form.endTime} onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))} />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Timezone</Label>
            <Select value={form.timeZone} onValueChange={(v) => setForm((f) => ({ ...f, timeZone: v }))}>
              <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIMEZONE_OPTIONS.map((tz) => (
                  <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label>Assigned to</Label>
            <Select value={form.assignedTo} onValueChange={(v) => setForm((f) => ({ ...f, assignedTo: v }))}>
              <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                {teamMembers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {conflictWarning && (
              <p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {conflictWarning}
              </p>
            )}
          </div>

          <div className="grid grid-cols-[110px_1fr] gap-2">
            <div className="grid gap-1.5">
              <Label>Related to</Label>
              <Select
                value={form.entityType}
                onValueChange={(v) => setForm((f) => ({ ...f, entityType: v as AppointmentEntityType | "none", entityId: null, entityLabel: "" }))}
              >
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ENTITY_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="opacity-0 select-none">Record</Label>
              {form.entityType === "none" ? (
                <div className="flex h-9 items-center text-xs text-muted-foreground">No related record</div>
              ) : (
                <AppointmentEntityPicker
                  entityType={form.entityType}
                  value={form.entityId}
                  onSelect={(id, label) => setForm((f) => ({ ...f, entityId: id, entityLabel: label }))}
                />
              )}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ap-contact">Customer name</Label>
            <Input id="ap-contact" value={form.contactName} onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))} placeholder="Full name" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ap-phone">Phone</Label>
              <Input id="ap-phone" type="tel" value={form.contactPhone} onChange={(e) => setForm((f) => ({ ...f, contactPhone: formatUsPhone(e.target.value) }))} placeholder="(555) 123-4567" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ap-email">Email</Label>
              <Input id="ap-email" type="email" value={form.contactEmail} onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))} placeholder="email@example.com" />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ap-location-type">Meeting Location</Label>
            <Select
              value={form.meetingLocationType}
              onValueChange={(v) => setForm((f) => ({ ...f, meetingLocationType: v as MeetingLocationType }))}
            >
              <SelectTrigger id="ap-location-type" className="h-9 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["property_address", "office", "other"] as MeetingLocationType[]).map((t) => (
                  <SelectItem key={t} value={t}>{MEETING_LOCATION_TYPE_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {form.meetingLocationType === "property_address" && (
            <div className="grid gap-1.5">
              <Label htmlFor="ap-property-address">Property address</Label>
              <AddressAutocomplete
                value={form.address}
                onChange={(v) => setForm((f) => ({ ...f, address: v }))}
                onSelect={(parts) =>
                  setForm((f) => ({ ...f, address: [parts.street, parts.city, `${parts.state} ${parts.zip}`].filter(Boolean).join(", ") }))
                }
                placeholder="123 Main St, City, ST"
              />
              {!form.address && (
                <p className="text-[11px] text-muted-foreground">No property address on file — enter one above, or switch to Office or Other.</p>
              )}
            </div>
          )}

          {form.meetingLocationType === "office" && (
            <div className="grid gap-1.5">
              <Label>Office address</Label>
              {org.address ? (
                <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs text-foreground">{org.address}</div>
              ) : (
                <div className="flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:border-amber-900/40 dark:bg-amber-500/10 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  Office address has not been configured. Add it in Settings → Organization, or choose a different location.
                </div>
              )}
            </div>
          )}

          {form.meetingLocationType === "other" && (
            <div className="grid gap-3 rounded-md border border-border p-3">
              <div className="grid gap-1.5">
                <Label htmlFor="ap-location-label">Location <span className="text-destructive">*</span></Label>
                <Input
                  id="ap-location-label"
                  value={form.meetingLocationLabel}
                  onChange={(e) => setForm((f) => ({ ...f, meetingLocationLabel: e.target.value }))}
                  placeholder="Customer's office, Showroom, Job site entrance…"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ap-meeting-mode">Meeting type</Label>
                <Select value={form.meetingMode} onValueChange={(v) => setForm((f) => ({ ...f, meetingMode: v as MeetingMode }))}>
                  <SelectTrigger id="ap-meeting-mode" className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(["in_person", "phone", "video"] as MeetingMode[]).map((m) => (
                      <SelectItem key={m} value={m}>{MEETING_MODE_LABELS[m]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {form.meetingMode === "video" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="ap-meeting-url">Meeting Link <span className="text-destructive">*</span></Label>
                  <Input id="ap-meeting-url" type="url" value={form.meetingUrl} onChange={(e) => setForm((f) => ({ ...f, meetingUrl: e.target.value }))} placeholder="https://meet.google.com/…" />
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label htmlFor="ap-other-address">
                    Address {form.meetingMode === "in_person" && <span className="text-destructive">*</span>}
                    {form.meetingMode === "phone" && <span className="text-muted-foreground">(optional)</span>}
                  </Label>
                  <AddressAutocomplete
                    value={form.address}
                    onChange={(v) => setForm((f) => ({ ...f, address: v }))}
                    onSelect={(parts) =>
                      setForm((f) => ({ ...f, address: [parts.street, parts.city, `${parts.state} ${parts.zip}`].filter(Boolean).join(", ") }))
                    }
                    placeholder="Start typing an address…"
                  />
                </div>
              )}
            </div>
          )}

          <div className="grid gap-1.5">
            <Label>Reminders</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {REMINDER_OPTIONS.map((r) => (
                <label key={r.minutes} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={form.reminderMinutes.includes(r.minutes)}
                    onCheckedChange={() => toggleReminder(r.minutes)}
                  />
                  {r.label}
                </label>
              ))}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ap-notes">Notes</Label>
            <Textarea id="ap-notes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Optional notes…" rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {isEdit ? "Save changes" : "Create appointment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
