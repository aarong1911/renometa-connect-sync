// src/components/inbox/unmatched-gmail-sender-banner.tsx
//
// Shown in Conversations, right under the thread header, only for a Gmail
// conversation whose sender doesn't match any saved contact. Gives the
// user three manual ways to resolve that — Create Contact, Create Lead,
// Link to Existing Contact — without leaving Conversations. Nothing here
// runs automatically; every action is an explicit click (see
// src/lib/gmail-contact-actions.ts for the underlying, dedupe-aware logic).

import { useMemo, useState } from "react";
import { UserPlus, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { useContacts } from "@/lib/contacts-store";
import {
  createContactFromGmailSender,
  createLeadFromGmailSender,
  linkExistingContactToGmailSender,
  resolveGmailSenderName,
} from "@/lib/gmail-contact-actions";
import type { Contact } from "@/lib/mock-data";
import { toast } from "sonner";

export function UnmatchedGmailSenderBanner({
  conversationId,
  senderEmail,
  senderName,
  senderDisplayName,
  subject,
  snippet,
  onConverted,
}: {
  /** The Gmail conversation's id (`gm-<thread_id>`) — used to target the explicit conversation_states link, never contacts.email. */
  conversationId: string;
  senderEmail: string;
  senderName: string;
  /** The Gmail From header's display-name portion, parsed directly — see resolveGmailSenderName. */
  senderDisplayName?: string;
  subject?: string;
  snippet?: string;
  onConverted: () => void;
}) {
  const [createContactOpen, setCreateContactOpen] = useState(false);
  const [createLeadOpen, setCreateLeadOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  if (!senderEmail) return null;

  const resolvedName = resolveGmailSenderName({
    parsedDisplayName: senderDisplayName,
    conversationName: senderName,
    email: senderEmail,
  });

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-5 py-2.5">
      <span className="text-xs text-muted-foreground">This sender isn't in your contacts yet.</span>
      <div className="flex flex-wrap gap-1.5">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setCreateContactOpen(true)}>
          <UserPlus className="mr-1 h-3 w-3" /> Create contact
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setCreateLeadOpen(true)}>
          <UserPlus className="mr-1 h-3 w-3" /> Create lead
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setLinkOpen(true)}>
          <Link2 className="mr-1 h-3 w-3" /> Link to existing contact
        </Button>
      </div>

      <CreateContactDialog
        open={createContactOpen}
        onOpenChange={setCreateContactOpen}
        senderEmail={senderEmail}
        resolvedName={resolvedName}
        onConverted={onConverted}
      />
      <CreateLeadDialog
        open={createLeadOpen}
        onOpenChange={setCreateLeadOpen}
        senderEmail={senderEmail}
        resolvedName={resolvedName}
        subject={subject}
        snippet={snippet}
        onConverted={onConverted}
      />
      <LinkExistingContactDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        conversationId={conversationId}
        onConverted={onConverted}
      />
    </div>
  );
}

function CreateContactDialog({
  open, onOpenChange, senderEmail, resolvedName, onConverted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  senderEmail: string;
  resolvedName: string;
  onConverted: () => void;
}) {
  const [name, setName] = useState(resolvedName);
  const [saving, setSaving] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) { onOpenChange(o); if (o) setName(resolvedName); } }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Create contact</DialogTitle>
          <DialogDescription>Save this Gmail sender as a new contact.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="gmail-create-contact-name">Full name</Label>
            <Input id="gmail-create-contact-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gmail-create-contact-email">Email</Label>
            {/* value, not placeholder — the real sender address, entered
                text the user can see and that gets submitted. readOnly (not
                disabled) so it still renders as normal, non-greyed text —
                users aren't meant to change the Gmail sender's identity here. */}
            <Input id="gmail-create-contact-email" value={senderEmail} readOnly />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            size="sm"
            disabled={saving || !senderEmail.trim()}
            onClick={async () => {
              setSaving(true);
              try {
                const contact = await createContactFromGmailSender({ name: name.trim(), email: senderEmail });
                if (!contact) { toast.error("Could not create contact"); return; }
                toast.success(`${contact.name} saved as a contact`);
                onOpenChange(false);
                onConverted();
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving…" : "Create contact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateLeadDialog({
  open, onOpenChange, senderEmail, resolvedName, subject, snippet, onConverted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  senderEmail: string;
  resolvedName: string;
  subject?: string;
  snippet?: string;
  onConverted: () => void;
}) {
  const [name, setName] = useState(resolvedName);
  const [saving, setSaving] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) { onOpenChange(o); if (o) setName(resolvedName); } }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Create lead</DialogTitle>
          <DialogDescription>Adds a new lead sourced from Gmail. The original subject/message is kept as lead notes.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="gmail-create-lead-name">Name</Label>
            <Input id="gmail-create-lead-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gmail-create-lead-email">Email</Label>
            <Input id="gmail-create-lead-email" value={senderEmail} readOnly />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            size="sm"
            disabled={saving || !senderEmail.trim()}
            onClick={async () => {
              setSaving(true);
              try {
                const result = await createLeadFromGmailSender({ name: name.trim(), email: senderEmail, subject, snippet });
                if (!result.ok) { toast.error(result.error); return; }
                if (result.duplicate) { toast.error(result.reason); return; }
                toast.success("Lead created");
                onOpenChange(false);
                onConverted();
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving…" : "Create lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkExistingContactDialog({
  open, onOpenChange, conversationId, onConverted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  onConverted: () => void;
}) {
  const contacts = useContacts();
  const [linkingId, setLinkingId] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...contacts].sort((a, b) => a.name.localeCompare(b.name)),
    [contacts],
  );

  async function handleSelect(contact: Contact) {
    setLinkingId(contact.id);
    try {
      const result = await linkExistingContactToGmailSender({ id: conversationId, channel: "email" }, contact);
      if (!result.ok) { toast.error(result.error); return; }
      toast.success(`Linked to ${contact.name}`);
      onOpenChange(false);
      onConverted();
    } finally {
      setLinkingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !linkingId && onOpenChange(o)}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="px-4 pb-0 pt-4">
          <DialogTitle>Link to existing contact</DialogTitle>
          <DialogDescription>Search by name or email. This won't create a new contact.</DialogDescription>
        </DialogHeader>
        <Command className="mt-2">
          <CommandInput placeholder="Search contacts…" />
          <CommandList className="max-h-80">
            <CommandEmpty>No contacts found.</CommandEmpty>
            <CommandGroup>
              {sorted.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`${c.name} ${c.email} ${c.phone}`}
                  disabled={!!linkingId}
                  onSelect={() => handleSelect(c)}
                  className="flex items-center gap-2.5 py-2"
                >
                  <ContactAvatar id={c.id} name={c.name} avatarKey={c.avatar_key} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{c.email || "No email"}{c.phone ? ` · ${c.phone}` : ""}</p>
                  </div>
                  {linkingId === c.id && <span className="text-xs text-muted-foreground">Linking…</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
