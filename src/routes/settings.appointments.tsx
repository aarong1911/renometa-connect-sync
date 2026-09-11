// src/routes/settings.appointments.tsx
//
// AI-H1.1 platform correction — organization-level Appointment Reminder
// settings. Appointment confirmation/reminders are a platform-wide
// appointment feature (Voice Agent, Calendar, workflows all create
// appointments), so this setting deliberately lives here rather than on
// the Voice Agent page. Route access is gated the same way every other
// /settings/* page already is (owner-only, via the root RoleGuard) — no
// separate permission check was added, to stay consistent with the
// existing convention rather than invent a second one.
import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Save, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useOrgId } from "@/lib/org-id";

export const Route = createFileRoute("/settings/appointments")({
  component: AppointmentSettings,
});

// Matches the "Supported timing choices" list exactly — do not add values
// the settings UI/DB pair doesn't actually support yet.
const TIMING_OPTIONS = [
  { label: "15 minutes before", value: 15 },
  { label: "30 minutes before", value: 30 },
  { label: "1 hour before", value: 60 },
  { label: "2 hours before", value: 120 },
  { label: "24 hours before", value: 1440 },
];

const DEFAULT_MINUTES_BEFORE = 60;

function AppointmentSettings() {
  const orgId = useOrgId();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [migrationPending, setMigrationPending] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [minutesBefore, setMinutesBefore] = useState(DEFAULT_MINUTES_BEFORE);

  useEffect(() => {
    if (!orgId) return;
    (async () => {
      const { data, error } = await supabase
        .from("organizations")
        .select("appointment_sms_reminder_enabled, appointment_sms_reminder_minutes_before")
        .eq("id", orgId)
        .maybeSingle();

      if (error?.code === "42703") {
        // Migration not applied yet in this environment — show the page
        // with the safe defaults (reminders OFF) rather than erroring.
        setMigrationPending(true);
        setEnabled(false);
        setMinutesBefore(DEFAULT_MINUTES_BEFORE);
      } else if (data) {
        setEnabled(!!data.appointment_sms_reminder_enabled);
        setMinutesBefore(data.appointment_sms_reminder_minutes_before ?? DEFAULT_MINUTES_BEFORE);
      }
      setLoading(false);
    })();
  }, [orgId]);

  const handleSave = async () => {
    if (!orgId || migrationPending) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("organizations")
        .update({
          appointment_sms_reminder_enabled: enabled,
          appointment_sms_reminder_minutes_before: minutesBefore,
        })
        .eq("id", orgId);

      if (error) {
        toast.error("Failed to save: " + error.message);
        return;
      }
      toast.success("Appointment reminder settings saved");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <CalendarClock className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">Appointment Reminders</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Applies to every appointment on your calendar, however it was created — Voice Agent, manual scheduling, or automated workflows.
      </p>

      {migrationPending && (
        <Card className="border-warning/30 bg-warning/10 p-3 text-xs text-warning-foreground">
          Appointment reminder settings are not yet available in this environment. Reminders remain off until this is enabled.
        </Card>
      )}

      <Card className="max-w-md space-y-4 p-4">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">Send SMS reminders</Label>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Customers will receive one SMS reminder before scheduled appointments.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={migrationPending} />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Reminder timing</Label>
          <Select
            value={String(minutesBefore)}
            onValueChange={(v) => setMinutesBefore(Number(v))}
            disabled={!enabled || migrationPending}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMING_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={String(opt.value)} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving || migrationPending}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {saving ? "Saving…" : "Save"}
        </Button>
      </Card>
    </div>
  );
}
