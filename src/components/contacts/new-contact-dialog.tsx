// src/components/contacts/new-contact-dialog.tsx
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { Loader2, AlertTriangle } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTeam } from "@/lib/organization";
import { addContact, getOrgId } from "@/lib/contacts-store";
import { findDuplicateContactCandidates, type ContactDuplicateCandidate } from "@/lib/identity-normalization";
import { parseTagInput } from "@/lib/tag-utils";
import { formatPhone } from "@/lib/format";
import type { Contact } from "@/lib/mock-data";

const BLANK_FORM = { name: "", email: "", phone: "", address: "", company: "", companyId: "", tags: "", owner: "" };

/**
 * Shared "New Contact" dialog — used by the Contacts page and reused from
 * Command Center Quick Actions so both trigger the same real creation flow
 * (addContact() store mutation) instead of duplicating the form.
 */
export function NewContactDialog({
  open,
  onOpenChange,
  onCreated,
  companies = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (contact: Contact) => void;
  /** Org-scoped company list for the company picker (Priority 2) — optional so existing callers (e.g. Command Center Quick Actions) that haven't loaded a company list yet keep working with the legacy free-text field only. */
  companies?: { id: string; name: string }[];
}) {
  const [form, setForm] = useState(BLANK_FORM);
  const [saving, setSaving] = useState(false);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [duplicates, setDuplicates] = useState<ContactDuplicateCandidate[] | null>(null);
  // The exact (email, phone) pair `duplicates` was computed for — if the
  // user edits either field after seeing a duplicate warning, the stale
  // warning is cleared and re-checked on the next submit rather than
  // silently letting them "Create anyway" past a warning for different
  // values than what's now in the form.
  const [duplicatesCheckedFor, setDuplicatesCheckedFor] = useState<string | null>(null);
  const teamMembers = useTeam();

  function close() {
    onOpenChange(false);
    setForm(BLANK_FORM);
    setDuplicates(null);
    setDuplicatesCheckedFor(null);
  }

  function updateForm(patch: Partial<typeof BLANK_FORM>) {
    setForm((f) => ({ ...f, ...patch }));
    // Any edit invalidates a previously-shown duplicate warning so a stale
    // "Create anyway" can't apply to different values.
    setDuplicates(null);
    setDuplicatesCheckedFor(null);
  }

  async function handleCreate() {
    if (!form.name.trim()) { toast.error("Name is required"); return; }

    const checkKey = `${form.email.trim().toLowerCase()}|${form.phone.trim()}`;
    const alreadyConfirmed = duplicates !== null && duplicatesCheckedFor === checkKey;

    if (!alreadyConfirmed && (form.email.trim() || form.phone.trim())) {
      setCheckingDuplicates(true);
      const orgId = await getOrgId();
      setCheckingDuplicates(false);
      if (orgId) {
        const matches = await findDuplicateContactCandidates(orgId, { email: form.email, phone: form.phone });
        if (matches.length > 0) {
          setDuplicates(matches);
          setDuplicatesCheckedFor(checkKey);
          return; // Block the insert — surface for manual review, never auto-merge.
        }
      }
      setDuplicates([]);
      setDuplicatesCheckedFor(checkKey);
    }

    setSaving(true);
    const tags = parseTagInput(form.tags);
    const result = await addContact({
      name: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      company: form.companyId ? "" : form.company.trim(),
      company_id: form.companyId || null,
      address: form.address.trim(),
      tags,
      owner: form.owner || "—",
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
                onChange={(e) => updateForm({ email: e.target.value })}
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
                onChange={(e) => updateForm({ phone: formatPhone(e.target.value) })}
                placeholder="(555) 123-4567"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nc-company">Account</Label>
              {companies.length > 0 ? (
                <>
                  <Select
                    value={form.companyId || "__none__"}
                    onValueChange={(v) => setForm((f) => ({ ...f, companyId: v === "__none__" ? "" : v }))}
                  >
                    <SelectTrigger id="nc-company"><SelectValue placeholder="No account" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No account</SelectItem>
                      {companies.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {!form.companyId && (
                    <Input
                      className="mt-1"
                      value={form.company}
                      onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                      placeholder="Or type an account name (no linked record)"
                    />
                  )}
                </>
              ) : (
                <Input
                  id="nc-company"
                  value={form.company}
                  onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                  placeholder="Account name"
                />
              )}
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
              <Label>Owner</Label>
              <Select
                value={form.owner || "__unassigned__"}
                onValueChange={(value) =>
                  setForm((f) => ({
                    ...f,
                    owner: value === "__unassigned__" ? "" : value,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Assign owner" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unassigned__">Unassigned</SelectItem>
                  {teamMembers
                    .filter((member) => member.status === "active")
                    .map((member) => (
                      <SelectItem key={member.id} value={member.name}>
                        {member.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
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

          {duplicates && duplicates.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
              <div className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                Possible duplicate {duplicates.length === 1 ? "contact" : "contacts"} found
              </div>
              <ul className="mt-1.5 space-y-1">
                {duplicates.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 text-xs text-amber-900 dark:text-amber-300">
                    <span className="truncate">
                      {d.full_name} — matched by {d.matchedOn === "email" ? d.email : d.phone}
                    </span>
                    <Link
                      to="/contacts"
                      search={{ contactId: d.id }}
                      onClick={close}
                      className="shrink-0 font-medium underline underline-offset-2 hover:text-amber-950 dark:hover:text-amber-200"
                    >
                      Open
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-500">
                Click "Create anyway" to add this as a new, separate contact.
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button onClick={handleCreate} disabled={saving || checkingDuplicates}>
            {(saving || checkingDuplicates) && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {checkingDuplicates ? "Checking…" : duplicates && duplicates.length > 0 ? "Create anyway" : "Create Contact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}