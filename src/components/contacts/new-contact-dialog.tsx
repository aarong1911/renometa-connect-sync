// src/components/contacts/new-contact-dialog.tsx
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { Loader2 } from "lucide-react";
import { addContact } from "@/lib/contacts-store";
import { formatPhone } from "@/lib/format";
import type { Contact } from "@/lib/mock-data";

const BLANK_FORM = { name: "", email: "", phone: "", address: "", company: "", tags: "" };

/**
 * Shared "New Contact" dialog — used by the Contacts page and reused from
 * Command Center Quick Actions so both trigger the same real creation flow
 * (addContact() store mutation) instead of duplicating the form.
 */
export function NewContactDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (contact: Contact) => void;
}) {
  const [form, setForm] = useState(BLANK_FORM);
  const [saving, setSaving] = useState(false);

  function close() {
    onOpenChange(false);
    setForm(BLANK_FORM);
  }

  async function handleCreate() {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    setSaving(true);
    const tags = form.tags ? form.tags.split(/[,;]+/).map((t) => t.trim()).filter(Boolean) : [];
    const result = await addContact({
      name: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      company: form.company.trim(),
      address: form.address.trim(),
      tags,
      owner: "—",
      lastActivity: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    setSaving(false);
    if (result) {
      toast.success("Contact created");
      onCreated?.(result);
      close();
    } else {
      toast.error("Failed to create contact");
    }
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
          <DialogTitle>New Contact</DialogTitle>
          <DialogDescription>Add a new contact to your CRM.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 grid gap-1.5">
              <Label htmlFor="nc-name">Name <span className="text-destructive">*</span></Label>
              <Input
                id="nc-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Full name"
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nc-email">Email</Label>
              <Input
                id="nc-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="email@example.com"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nc-phone">Phone</Label>
              <Input
                id="nc-phone"
                type="tel"
                inputMode="tel"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: formatPhone(e.target.value) }))}
                placeholder="(555) 123-4567"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nc-company">Company</Label>
              <Input
                id="nc-company"
                value={form.company}
                onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                placeholder="Company name"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nc-tags">Tags</Label>
              <Input
                id="nc-tags"
                value={form.tags}
                onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
                placeholder="Homeowner, VIP…"
              />
            </div>
            <div className="col-span-2 grid gap-1.5">
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
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button onClick={handleCreate} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Create Contact
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
