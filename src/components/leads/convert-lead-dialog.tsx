// src/components/leads/convert-lead-dialog.tsx
//
// Transactional Lead -> Deal conversion. Reuses the New Deal dialog's visual
// conventions (max-h-[90vh] max-w-3xl overflow-y-auto, SectionHeading style)
// but is a distinct component: it adds Contact-matching and Account
// resolution steps before handing off to convert_lead_to_deal, which
// NewDealDialog has no concept of.

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { formatPhone } from "@/lib/format";
import { useTeam } from "@/lib/organization";
import { supabase } from "@/lib/supabase";
import {
  convertLeadToDeal,
  useLeadNotes,
  clearLeadNotes,
} from "@/lib/leads-store";
import type { Lead } from "@/lib/mock-data";
import { upsertDealFromCanonical, usePipelines, usePipelineStages } from "@/lib/deals-store";
import { upsertContactFromRow } from "@/lib/contacts-store";
import { flattenLeadNotes, sha256Hex } from "@/lib/notes-hash";
import type { Deal } from "@/lib/sales/types";

type ContactMatch = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
};

type AccountOption = { id: string; name: string };

const RPC_ERROR_MESSAGES: Record<string, string> = {
  LEAD_NOT_FOUND_OR_FORBIDDEN: "This lead could not be found in your organization.",
  IDEMPOTENCY_KEY_REUSED: "This conversion attempt conflicted with another one. Please try again.",
  CONTACT_NOT_FOUND: "The selected contact no longer exists. Refresh and try again.",
  COMPANY_NOT_FOUND: "The selected account no longer exists. Refresh and try again.",
  PIPELINE_NOT_FOUND: "The selected pipeline is not available. Choose another pipeline.",
  STAGE_NOT_IN_PIPELINE: "The selected stage doesn't belong to the selected pipeline.",
  OWNER_NOT_IN_ORG: "The selected owner is not a member of your organization.",
  CANONICAL_CONVERSION_DATA_INVALID: "This lead's existing conversion has an inconsistency and could not be reopened. Contact support.",
  ORPHANED_CONVERSION: "This lead's linked deal is missing. Contact support before retrying.",
  INVALID_NOTES_PAYLOAD: "Something went wrong preparing this lead's notes. Please try again.",
  AUTH_REQUIRED: "Your session has expired. Please sign in again.",
  IDEMPOTENCY_KEY_REQUIRED: "Something went wrong starting this conversion. Please try again.",
  NO_ACTIVE_PIPELINE: "Your organization has no active pipeline configured.",
  NO_OPEN_STAGE: "The selected pipeline has no open stage to convert into.",
  INVALID_INPUT: "Please check the contact and account selections and try again.",
};

function friendlyRpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = Object.keys(RPC_ERROR_MESSAGES).find((key) => message.startsWith(key));
  return code ? RPC_ERROR_MESSAGES[code] : message || "Failed to convert lead to deal.";
}

async function resolveOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (profile?.organization_id) return profile.organization_id;
  const { data: membership } = await supabase
    .from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return membership?.org_id ?? null;
}

type ConvertLeadDialogProps = {
  lead: Lead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConverted: (deal: Deal) => void;
};

export function ConvertLeadDialog({ lead, open, onOpenChange, onConverted }: ConvertLeadDialogProps) {
  const teamMembers = useTeam();
  const pipelines = usePipelines();
  const dbStages = usePipelineStages();
  const leadNotes = useLeadNotes(lead?.id ?? "");

  const [idempotencyKey, setIdempotencyKey] = useState<string>("");
  const [loadingMatches, setLoadingMatches] = useState(false);
  const [contactMatches, setContactMatches] = useState<ContactMatch[]>([]);
  const [contactChoice, setContactChoice] = useState<string>("new");
  const [newContactName, setNewContactName] = useState("");
  const [newContactEmail, setNewContactEmail] = useState("");
  const [newContactPhone, setNewContactPhone] = useState("");
  const [newContactAddress, setNewContactAddress] = useState("");

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [accountMode, setAccountMode] = useState<"none" | "existing" | "new">("none");
  const [accountId, setAccountId] = useState("");
  const [newAccountName, setNewAccountName] = useState("");
  const [isPrimaryContact, setIsPrimaryContact] = useState(true);

  const [title, setTitle] = useState("");
  const [pipelineId, setPipelineId] = useState("");
  const [stageId, setStageId] = useState("");
  const [value, setValue] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [expectedClose, setExpectedClose] = useState("");
  const [serviceType, setServiceType] = useState("");
  const [projectAddress, setProjectAddress] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Guards against a stale match/account fetch resolving after the dialog
  // has moved on to a different lead (or closed) and overwriting its state.
  const matchRequestIdRef = useRef(0);

  const activePipelines = useMemo(() => pipelines.filter((p) => p.isActive), [pipelines]);
  const selectedPipelineId = pipelineId || activePipelines.find((p) => p.isDefault)?.id || activePipelines[0]?.id || "";
  const stages = useMemo(
    () => dbStages.filter((s) => s.pipelineId === selectedPipelineId && s.slug !== "won" && s.slug !== "lost")
      .sort((a, b) => a.position - b.position),
    [dbStages, selectedPipelineId],
  );

  // Fresh idempotency key + prefilled form each time the dialog opens for a
  // (possibly new) lead. Reused across retries within this same open session.
  useEffect(() => {
    if (!open || !lead) return;

    setIdempotencyKey(crypto.randomUUID());
    setErrorMessage(null);
    setContactChoice("new");
    setNewContactName(lead.name || "");
    setNewContactEmail(lead.email || "");
    setNewContactPhone(lead.phone || "");
    setNewContactAddress(lead.address || "");
    setAccountMode("none");
    setAccountId("");
    setNewAccountName("");
    setIsPrimaryContact(true);
    setTitle(`${lead.name || "Unknown"} — ${lead.projectType || "Project"}`);
    setPipelineId("");
    setStageId("");
    setValue(lead.estimatedBudget ? String(lead.estimatedBudget) : "");
    setOwnerId("");
    setExpectedClose("");
    setServiceType(lead.projectType || "");
    setProjectAddress(lead.address || "");

    void loadContactMatchesAndAccounts(lead);
  }, [open, lead?.id]);

  async function loadContactMatchesAndAccounts(currentLead: Lead) {
    const requestId = ++matchRequestIdRef.current;
    setLoadingMatches(true);
    try {
      const orgId = await resolveOrgId();
      if (!orgId || requestId !== matchRequestIdRef.current) return;

      const email = currentLead.email?.trim().toLowerCase() ?? "";
      const phone = currentLead.phone ? currentLead.phone.replace(/\D/g, "").slice(-10) : "";

      const matches: ContactMatch[] = [];
      const seen = new Set<string>();

      if (email) {
        const { data } = await supabase
          .from("contacts")
          .select("id, full_name, email, phone, address")
          .eq("org_id", orgId)
          .ilike("email", email);
        for (const row of data ?? []) if (!seen.has(row.id)) { seen.add(row.id); matches.push(row); }
      }
      if (phone) {
        const { data } = await supabase
          .from("contacts")
          .select("id, full_name, email, phone, address")
          .eq("org_id", orgId)
          .eq("phone", phone);
        for (const row of data ?? []) if (!seen.has(row.id)) { seen.add(row.id); matches.push(row); }
      }
      if (requestId !== matchRequestIdRef.current) return;
      setContactMatches(matches);

      const { data: accountRows } = await supabase
        .from("companies").select("id, name").eq("org_id", orgId).order("name");
      if (requestId !== matchRequestIdRef.current) return;
      setAccounts((accountRows ?? []).map((a) => ({ id: a.id, name: a.name })));
    } catch (error) {
      console.error("[convert-lead-dialog] match load failed:", error);
    } finally {
      if (requestId === matchRequestIdRef.current) setLoadingMatches(false);
    }
  }

  useEffect(() => {
    if (!open || pipelineId || !selectedPipelineId) return;
    setPipelineId(selectedPipelineId);
  }, [open, pipelineId, selectedPipelineId]);

  useEffect(() => {
    if (!open || stageId || !stages[0]) return;
    setStageId(stages[0].id);
  }, [open, stageId, stages]);

  async function handleSubmit() {
    if (!lead) return;
    if (contactChoice === "new" && !newContactName.trim()) {
      toast.error("Contact name is required.");
      return;
    }
    if (accountMode === "new" && !newAccountName.trim()) {
      toast.error("Account name is required.");
      return;
    }
    if (!selectedPipelineId || !stageId) {
      toast.error("Select a pipeline and stage.");
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);

    try {
      const flattenedNotes = flattenLeadNotes(leadNotes);
      const notesHash = flattenedNotes ? await sha256Hex(flattenedNotes) : null;
      const parsedValue = value.trim() ? Number(value) : NaN;
      const safeValue = Number.isFinite(parsedValue) ? parsedValue : null;

      const result = await convertLeadToDeal({
        leadId: lead.id,
        idempotencyKey,
        contactId: contactChoice !== "new" ? contactChoice : null,
        newContact: contactChoice === "new"
          ? { full_name: newContactName.trim(), email: newContactEmail.trim() || null, phone: newContactPhone.trim() || null, address: newContactAddress.trim() || null }
          : null,
        companyId: accountMode === "existing" ? accountId || null : null,
        newCompany: accountMode === "new" ? { name: newAccountName.trim() } : null,
        companyContactRelationship: accountMode !== "none" ? { is_primary: isPrimaryContact } : null,
        pipelineId: selectedPipelineId,
        stageId,
        title: title.trim() || null,
        value: safeValue,
        ownerId: ownerId || null,
        expectedCloseDate: expectedClose || null,
        serviceType: serviceType.trim() || null,
        projectAddress: projectAddress.trim() || null,
        migratedNotes: flattenedNotes,
        notesHash,
      });

      const mappedDeal = upsertDealFromCanonical({
        deal: result.deal,
        contact: result.contact,
        company: result.account,
        stage: result.stage,
        ownerProfile: result.ownerProfile,
      });

      if (result.contact) upsertContactFromRow(result.contact);

      if (result.conversionState.notesMigrated) {
        clearLeadNotes(lead.id);
      }

      toast.success(
        result.conversionState.created ? `${lead.name} converted to deal` : "This lead was already converted",
        { description: result.conversionState.created ? "A new deal has been created in the pipeline." : "Opening the existing deal." },
      );

      onOpenChange(false);
      onConverted(mappedDeal);
    } catch (error) {
      console.error("[convert-lead-dialog] conversion failed:", error);
      setErrorMessage(friendlyRpcError(error));
    } finally {
      setSubmitting(false);
    }
  }

  if (!lead) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto [&>button]:hidden">
        <DialogHeader className="items-start text-left">
          <DialogTitle
            className="inline-flex rounded-full border border-[#E3CA9A] bg-[#FAF3E4] px-4 py-1.5 text-sm font-semibold text-foreground"
          >
            Convert Lead to Deal
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-5 py-1">
          <section className="grid gap-3">
            <SectionHeading>Contact</SectionHeading>

            {loadingMatches ? (
              <p className="text-sm text-muted-foreground">Searching for matching contacts…</p>
            ) : (
              <RadioGroup value={contactChoice} onValueChange={setContactChoice} className="gap-2">
                {contactMatches.map((match) => (
                  <label
                    key={match.id}
                    className="flex items-center gap-3 rounded-md border bg-card p-3 text-sm"
                  >
                    <RadioGroupItem value={match.id} id={`contact-${match.id}`} />
                    <ContactAvatar id={match.id} name={match.full_name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{match.full_name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {[match.email, match.phone].filter(Boolean).join(" · ") || "No contact details"}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full border border-[#E3CA9A] bg-[#FAF3E4] px-2 py-0.5 text-[10px] font-medium">
                      Possible match
                    </span>
                  </label>
                ))}
                <label className="flex items-center gap-3 rounded-md border bg-card p-3 text-sm">
                  <RadioGroupItem value="new" id="contact-new" />
                  <span className="font-medium">Create new contact</span>
                </label>
              </RadioGroup>
            )}

            {contactChoice === "new" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Contact name</Label>
                  <Input className="bg-white" value={newContactName} onChange={(e) => setNewContactName(e.target.value)} placeholder="e.g. John Smith" />
                </div>
                <div className="space-y-1.5">
                  <Label>Email</Label>
                  <Input className="bg-white" type="email" value={newContactEmail} onChange={(e) => setNewContactEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Phone</Label>
                  <Input className="bg-white" value={newContactPhone} onChange={(e) => setNewContactPhone(formatPhone(e.target.value))} />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Address</Label>
                  <AddressAutocomplete
                    value={newContactAddress}
                    onChange={setNewContactAddress}
                    onSelect={(parts) => setNewContactAddress([parts.street, parts.city, `${parts.state} ${parts.zip}`.trim()].filter(Boolean).join(", "))}
                    placeholder="123 Main St, City, ST"
                    className="bg-white"
                  />
                </div>
              </div>
            )}
          </section>

          <section className="grid gap-3 pt-1">
            <SectionHeading>Account</SectionHeading>

            <RadioGroup value={accountMode} onValueChange={(v) => setAccountMode(v as typeof accountMode)} className="gap-2">
              <label className="flex items-center gap-3 rounded-md border bg-card p-3 text-sm">
                <RadioGroupItem value="none" id="account-none" />
                <span>No account — residential homeowner</span>
              </label>
              <label className="flex items-center gap-3 rounded-md border bg-card p-3 text-sm">
                <RadioGroupItem value="existing" id="account-existing" />
                <span>Link existing account</span>
              </label>
              <label className="flex items-center gap-3 rounded-md border bg-card p-3 text-sm">
                <RadioGroupItem value="new" id="account-new" />
                <span>Create new account</span>
              </label>
            </RadioGroup>

            {accountMode === "existing" && (
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger className="bg-white"><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}

            {accountMode === "new" && (
              <Input className="bg-white" value={newAccountName} onChange={(e) => setNewAccountName(e.target.value)} placeholder="Account name" />
            )}

            {accountMode !== "none" && (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" checked={isPrimaryContact} onChange={(e) => setIsPrimaryContact(e.target.checked)} />
                Primary contact for this account
              </label>
            )}
          </section>

          <section className="grid gap-3 pt-1">
            <SectionHeading>Deal</SectionHeading>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Deal name</Label>
                <Input className="bg-white" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>

              <div className="space-y-1.5">
                <Label>Pipeline</Label>
                <Select value={selectedPipelineId} onValueChange={(v) => { setPipelineId(v); setStageId(""); }}>
                  <SelectTrigger className="bg-white"><SelectValue placeholder="Select pipeline" /></SelectTrigger>
                  <SelectContent>
                    {activePipelines.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Starting stage</Label>
                <Select value={stageId} onValueChange={setStageId}>
                  <SelectTrigger className="bg-white"><SelectValue placeholder="Select stage" /></SelectTrigger>
                  <SelectContent>
                    {stages.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Value ($)</Label>
                <Input className="bg-white" type="number" min="0" value={value} onChange={(e) => setValue(e.target.value)} />
              </div>

              <div className="space-y-1.5">
                <Label>Expected close date</Label>
                <Input className="bg-white" type="date" value={expectedClose} onChange={(e) => setExpectedClose(e.target.value)} />
              </div>

              <div className="space-y-1.5">
                <Label>Owner</Label>
                <Select value={ownerId} onValueChange={setOwnerId}>
                  <SelectTrigger className="bg-white"><SelectValue placeholder="Select team member" /></SelectTrigger>
                  <SelectContent>
                    {teamMembers.filter((m) => m.status === "active").map((m) => (
                      <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Source</Label>
                <Input className="bg-white" value={lead.source} disabled />
              </div>

              <div className="space-y-1.5">
                <Label>Service type</Label>
                <Input className="bg-white" value={serviceType} onChange={(e) => setServiceType(e.target.value)} />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label>Project address</Label>
                <AddressAutocomplete
                  value={projectAddress}
                  onChange={setProjectAddress}
                  onSelect={(parts) => setProjectAddress([parts.street, parts.city, `${parts.state} ${parts.zip}`.trim()].filter(Boolean).join(", "))}
                  placeholder="123 Main St, City, ST"
                  className="bg-white"
                />
              </div>
            </div>
          </section>

          {errorMessage && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {errorMessage}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            className="bg-blue-600 text-white hover:bg-blue-700"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? "Converting…" : "Convert to Deal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2 text-center">
      <h3 className="text-base font-semibold text-foreground">{children}</h3>
      <div className="h-px w-full bg-[#E3CA9A]" />
    </div>
  );
}
