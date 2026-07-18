// src/components/calendar/new-booking-dialog.tsx
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";

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

function todayInputValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const BLANK = {
  service: "",
  contactName: "",
  contactPhone: "",
  contactEmail: "",
  address: "",
  date: todayInputValue(),
  time: "09:00",
  durationMin: "60",
  notes: "",
};

/**
 * Real "New Booking" dialog for Calendar — inserts directly into the
 * `appointments` table (same table `calendar.tsx` reads from), since this
 * page previously had a "New event" button with no onClick wired at all.
 */
export function NewBookingDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}) {
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);

  function close() {
    onOpenChange(false);
    setForm(BLANK);
  }

  async function handleCreate() {
    if (!form.contactName.trim()) { toast.error("Contact name is required"); return; }
    if (!form.date || !form.time) { toast.error("Date and time are required"); return; }

    const orgId = await getOrgId();
    if (!orgId) { toast.error("Still loading your organization…"); return; }

    const [year, month, day] = form.date.split("-").map(Number);
    const [hour, minute] = form.time.split(":").map(Number);
    const scheduledAt = new Date(year, month - 1, day, hour, minute);

    setSaving(true);
    const { error } = await supabase.from("appointments").insert({
      org_id: orgId,
      service: form.service.trim() || "Appointment",
      contact_name: form.contactName.trim(),
      contact_phone: form.contactPhone.trim() || null,
      contact_email: form.contactEmail.trim() || null,
      address: form.address.trim() || null,
      notes: form.notes.trim() || null,
      scheduled_at: scheduledAt.toISOString(),
      duration_min: Number(form.durationMin) || 60,
      status: "scheduled",
      source: "Manual",
    });
    setSaving(false);

    if (error) {
      console.error("[new-booking-dialog]", error);
      toast.error("Failed to create booking");
      return;
    }
    toast.success("Booking created");
    onCreated?.();
    close();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); else onOpenChange(o); }}>
      <DialogContent
        className="sm:max-w-md"
        onInteractOutside={(e) => {
          const target = ((e as CustomEvent).detail?.originalEvent?.target ?? e.target) as HTMLElement | null;
          if (target?.closest?.(".pac-container")) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>New Booking</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="nb-service">Service / title</Label>
            <Input
              id="nb-service"
              value={form.service}
              onChange={(e) => setForm((f) => ({ ...f, service: e.target.value }))}
              placeholder="Site visit, install, consultation…"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="nb-contact">Contact name <span className="text-destructive">*</span></Label>
            <Input
              id="nb-contact"
              value={form.contactName}
              onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))}
              placeholder="Full name"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="nb-phone">Phone</Label>
              <Input
                id="nb-phone"
                type="tel"
                value={form.contactPhone}
                onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))}
                placeholder="(555) 123-4567"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nb-email">Email</Label>
              <Input
                id="nb-email"
                type="email"
                value={form.contactEmail}
                onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))}
                placeholder="email@example.com"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Address</Label>
            <AddressAutocomplete
              value={form.address}
              onChange={(v) => setForm((f) => ({ ...f, address: v }))}
              onSelect={(parts) =>
                setForm((f) => ({
                  ...f,
                  address: [parts.street, parts.city, `${parts.state} ${parts.zip}`].filter(Boolean).join(", "),
                }))
              }
              placeholder="123 Main St, City, ST"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-1 grid gap-1.5">
              <Label htmlFor="nb-date">Date</Label>
              <Input
                id="nb-date"
                type="date"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
            </div>
            <div className="col-span-1 grid gap-1.5">
              <Label htmlFor="nb-time">Time</Label>
              <Input
                id="nb-time"
                type="time"
                value={form.time}
                onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
              />
            </div>
            <div className="col-span-1 grid gap-1.5">
              <Label htmlFor="nb-duration">Duration (min)</Label>
              <Input
                id="nb-duration"
                type="number"
                min={15}
                step={15}
                value={form.durationMin}
                onChange={(e) => setForm((f) => ({ ...f, durationMin: e.target.value }))}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="nb-notes">Notes</Label>
            <Textarea
              id="nb-notes"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Optional notes…"
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button onClick={handleCreate} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Create Booking
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
