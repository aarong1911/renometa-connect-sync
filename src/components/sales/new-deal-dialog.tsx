// src/components/sales/new-deal-dialog.tsx

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import {
  addDeal as storeAddDeal,
  usePipelines,
  usePipelineStages,
} from "@/lib/deals-store";
import { formatPhone } from "@/lib/format";
import { useTeam } from "@/lib/organization";
import { useCompanies } from "@/lib/companies-store";
import type { AddDealInput, Deal } from "@/lib/sales/types";
import { supabase } from "@/lib/supabase";

const SOURCE_OPTIONS = [
  "Website",
  "Referral",
  "Google Ads",
  "Facebook",
  "Instagram",
  "Angi",
  "Thumbtack",
  "Walk-in",
  "Phone",
  "Other",
];

const SERVICE_OPTIONS = [
  "Kitchen Remodel",
  "Bathroom Remodel",
  "Whole Home Renovation",
  "Addition",
  "Basement Finish",
  "Outdoor Living",
  "Roofing",
  "Windows and Doors",
  "Other",
];

const BUDGET_OPTIONS = [
  "Under $10,000",
  "$10,000–$25,000",
  "$25,000–$50,000",
  "$50,000–$100,000",
  "$100,000–$250,000",
  "$250,000+",
  "Not sure",
];

const TIMELINE_OPTIONS = [
  "Immediately",
  "Within 30 days",
  "Within 60 days",
  "Within 90 days",
  "3–6 months",
  "6–12 months",
  "Just researching",
];

const TAG_OPTIONS = [
  "High Value",
  "Priority",
  "Referral",
  "Hot Lead",
  "Needs Follow-Up",
  "Decision Maker",
  "Financing Needed",
  "Repeat Customer",
  "Commercial",
  "Residential",
  "Insurance Claim",
  "Permit Required",
  "Design Needed",
  "Ready to Start",
];

type ContactOption = {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  companyId: string;
};

type DealForm = {
  name: string;
  contactId: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  companyId: string;
  pipelineId: string;
  stage: string;
  value: string;
  probability: string;
  expectedClose: string;
  ownerId: string;
  source: string;
  serviceType: string;
  budget: string;
  timeline: string;
  tags: string;
  notes: string;
};

const BLANK_DEAL: DealForm = {
  name: "",
  contactId: "",
  contactName: "",
  email: "",
  phone: "",
  address: "",
  companyId: "",
  pipelineId: "",
  stage: "",
  value: "",
  probability: "",
  expectedClose: "",
  ownerId: "",
  source: "",
  serviceType: "",
  budget: "",
  timeline: "",
  tags: "",
  notes: "",
};

type NewDealDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValues?: Partial<DealForm>;
  onCreated?: (deal: Deal) => void;
};

export function NewDealDialog({
  open,
  onOpenChange,
  initialValues,
  onCreated,
}: NewDealDialogProps) {
  const teamMembers = useTeam();
  const pipelines = usePipelines();
  const dbStages = usePipelineStages();

  const [form, setForm] = useState<DealForm>({
    ...BLANK_DEAL,
    ...initialValues,
  });
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  // Store consolidation (Phase 9.4 consistency pass) — reads from the
  // canonical companies-store instead of this dialog's own ad hoc fetch.
  const accounts = useCompanies();
  const [loadingOptions, setLoadingOptions] = useState(false);
  const selectedTags = useMemo(
    () =>
      form.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    [form.tags],
  );

  const [creating, setCreating] = useState(false);

  const activePipelines = useMemo(
    () => pipelines.filter((pipeline) => pipeline.isActive),
    [pipelines],
  );

  const selectedPipelineId =
    form.pipelineId ||
    activePipelines.find((pipeline) => pipeline.isDefault)?.id ||
    activePipelines[0]?.id ||
    "";

  const stages = useMemo(
    () =>
      dbStages.filter(
        (stage) =>
          stage.pipelineId === selectedPipelineId &&
          stage.slug !== "won" &&
          stage.slug !== "lost",
      ),
    [dbStages, selectedPipelineId],
  );

  const selectedStage = useMemo(
    () => stages.find((stage) => stage.slug === form.stage) ?? stages[0] ?? null,
    [form.stage, stages],
  );

  useEffect(() => {
    if (!open) return;

    setForm({
      ...BLANK_DEAL,
      ...initialValues,
    });

    void loadOptions();
  }, [open, initialValues]);

  useEffect(() => {
    if (!open || form.pipelineId || !selectedPipelineId) return;

    setForm((current) => ({
      ...current,
      pipelineId: selectedPipelineId,
    }));
  }, [open, form.pipelineId, selectedPipelineId]);

  useEffect(() => {
    if (!open || form.stage || !stages[0]) return;

    setForm((current) => ({
      ...current,
      stage: stages[0].slug,
      probability: String(stages[0].probability),
    }));
  }, [open, form.stage, stages]);

  async function loadOptions() {
    setLoadingOptions(true);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) return;

      const { data: profile } = await supabase
        .from("profiles")
        .select("organization_id")
        .eq("id", user.id)
        .maybeSingle();

      let orgId = profile?.organization_id ?? null;

      if (!orgId) {
        const { data: membership } = await supabase
          .from("org_memberships")
          .select("org_id")
          .eq("member_id", user.id)
          .maybeSingle();

        orgId = membership?.org_id ?? null;
      }

      if (!orgId) return;

      const contactsResult = await supabase
        .from("contacts")
        .select("id, full_name, email, phone, address, company_id")
        .eq("org_id", orgId)
        .order("full_name");

      if (contactsResult.error) throw contactsResult.error;

      setContacts(
        (contactsResult.data ?? []).map((contact) => ({
          id: contact.id,
          name: contact.full_name ?? "Unnamed contact",
          email: contact.email ?? "",
          phone: contact.phone ?? "",
          address: contact.address ?? "",
          companyId: contact.company_id ?? "",
        })),
      );
    } catch (error) {
      console.error("[new-deal-dialog] option load failed:", error);
      toast.error("Could not load contacts and accounts.");
    } finally {
      setLoadingOptions(false);
    }
  }

  function updateField<K extends keyof DealForm>(field: K, value: DealForm[K]) {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function handleContactChange(contactId: string) {
    if (contactId === "new-contact") {
      setForm((current) => ({
        ...current,
        contactId: "",
        contactName: "",
        email: "",
        phone: "",
        address: "",
      }));
      return;
    }

    const contact = contacts.find((item) => item.id === contactId);
    if (!contact) return;

    setForm((current) => ({
      ...current,
      contactId: contact.id,
      contactName: contact.name,
      email: contact.email,
      phone: formatPhone(contact.phone),
      address: contact.address,
      companyId: contact.companyId || current.companyId,
    }));
  }

  function handlePipelineChange(pipelineId: string) {
    const firstStage = dbStages
      .filter(
        (stage) =>
          stage.pipelineId === pipelineId &&
          stage.slug !== "won" &&
          stage.slug !== "lost",
      )
      .sort((a, b) => a.position - b.position)[0];

    setForm((current) => ({
      ...current,
      pipelineId,
      stage: firstStage?.slug ?? "",
      probability: firstStage ? String(firstStage.probability) : "",
    }));
  }

  function handleStageChange(stageSlug: string) {
    const stage = stages.find((item) => item.slug === stageSlug);

    setForm((current) => ({
      ...current,
      stage: stageSlug,
      probability: stage ? String(stage.probability) : current.probability,
    }));
  }

  function toggleTag(tag: string) {
    const nextTags = selectedTags.includes(tag)
      ? selectedTags.filter((item) => item !== tag)
      : [...selectedTags, tag];

    updateField("tags", nextTags.join(", "));
  }

  async function handleCreate() {
    if (!form.name.trim()) {
      toast.error("Deal name is required.");
      return;
    }

    const ownerMember =
      teamMembers.find((member) => member.id === form.ownerId) ??
      teamMembers.find((member) => member.status === "active");

    const input: AddDealInput = {
      name: form.name.trim(),
      contactId: form.contactId || null,
      contactName: form.contactName.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      address: form.address.trim(),
      companyId: form.companyId || null,
      pipelineId: selectedPipelineId || null,
      stageId: selectedStage?.id ?? null,
      stage: selectedStage?.slug ?? null,
      value: Number(form.value) || 0,
      probability: form.probability ? Number(form.probability) : undefined,
      expectedClose: form.expectedClose || null,
      ownerId: ownerMember?.id ?? null,
      ownerName: ownerMember?.name ?? "Unassigned",
      source: form.source.trim() || null,
      serviceType: form.serviceType.trim() || null,
      budget: form.budget.trim() || null,
      timeline: form.timeline.trim() || null,
      projectAddress: form.address.trim() || null,
      tags: form.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      notes: form.notes.trim() || null,
    };

    setCreating(true);

    try {
      const createdDeal = await storeAddDeal(input);
      setForm(BLANK_DEAL);
      onOpenChange(false);
      onCreated?.(createdDeal);
      toast.success(`Deal "${input.name}" created`);
    } catch (error) {
      console.error("[new-deal-dialog] create failed:", error);
      toast.error("Failed to create deal. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] max-w-3xl overflow-y-auto [&>button]:hidden"
        onInteractOutside={(event) => {
          const originalEvent = (event as CustomEvent).detail?.originalEvent;
          const target = (originalEvent?.target ?? event.target) as HTMLElement | null;

          if (target?.closest?.(".pac-container")) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader className="items-start text-left">
          <DialogTitle
            className="inline-flex rounded-full border border-[#E3CA9A]
              bg-[#FAF3E4] px-4 py-1.5 text-sm font-semibold text-foreground"
          >
            Add Deal
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-5 py-1">
          <section className="grid gap-3">
            <SectionHeading>Deal Details</SectionHeading>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="deal-name">Deal name</Label>
                <Input className="bg-white"
                  id="deal-name"
                  value={form.name}
                  onChange={(event) => updateField("name", event.target.value)}
                  placeholder="e.g. Kitchen remodel"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Pipeline</Label>
                <Select
                  value={selectedPipelineId}
                  onValueChange={handlePipelineChange}
                >
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder="Select pipeline" />
                  </SelectTrigger>
                  <SelectContent>
                    {activePipelines.map((pipeline) => (
                      <SelectItem key={pipeline.id} value={pipeline.id}>
                        {pipeline.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Starting stage</Label>
                <Select value={form.stage} onValueChange={handleStageChange}>
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder="Select stage" />
                  </SelectTrigger>
                  <SelectContent>
                    {stages.map((stage) => (
                      <SelectItem key={stage.id} value={stage.slug}>
                        {stage.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="deal-value">Deal value ($)</Label>
                <Input className="bg-white"
                  id="deal-value"
                  type="number"
                  min="0"
                  value={form.value}
                  onChange={(event) => updateField("value", event.target.value)}
                  placeholder="25000"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="deal-probability">Probability (%)</Label>
                <Input className="bg-white"
                  id="deal-probability"
                  type="number"
                  min="0"
                  max="100"
                  value={form.probability}
                  onChange={(event) =>
                    updateField("probability", event.target.value)
                  }
                  placeholder="50"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="expected-close">Expected close date</Label>
                <Input className="bg-white"
                  id="expected-close"
                  type="date"
                  value={form.expectedClose}
                  onChange={(event) =>
                    updateField("expectedClose", event.target.value)
                  }
                />
              </div>

              <div className="space-y-1.5">
                <Label>Owner</Label>
                <Select
                  value={form.ownerId}
                  onValueChange={(value) => updateField("ownerId", value)}
                >
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder="Select team member" />
                  </SelectTrigger>
                  <SelectContent>
                    {teamMembers
                      .filter((member) => member.status === "active")
                      .map((member) => (
                        <SelectItem key={member.id} value={member.id}>
                          {member.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </section>

          <section className="mt-6 grid gap-3 pt-1">
            <SectionHeading>Contact & Account</SectionHeading>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Contact</Label>
                <Select
                  value={form.contactId || "new-contact"}
                  onValueChange={handleContactChange}
                  disabled={loadingOptions}
                >
                  <SelectTrigger className="bg-white">
                    <SelectValue
                      placeholder={
                        loadingOptions ? "Loading contacts..." : "Select contact"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new-contact">Create new contact</SelectItem>
                    {contacts.map((contact) => (
                      <SelectItem key={contact.id} value={contact.id}>
                        {contact.name}
                        {contact.email ? ` · ${contact.email}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="contact-name">Contact name</Label>
                <Input className="bg-white"
                  id="contact-name"
                  value={form.contactName}
                  onChange={(event) =>
                    updateField("contactName", event.target.value)
                  }
                  placeholder="e.g. John Smith"
                  disabled={Boolean(form.contactId)}
                />
              </div>

              <div className="space-y-1.5">
                <Label>Account</Label>
                <Select
                  value={form.companyId || "no-account"}
                  onValueChange={(value) =>
                    updateField("companyId", value === "no-account" ? "" : value)
                  }
                  disabled={loadingOptions}
                >
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder="No account" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no-account">No account</SelectItem>
                    {accounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="contact-email">Email</Label>
                <Input className="bg-white"
                  id="contact-email"
                  type="email"
                  value={form.email}
                  onChange={(event) => updateField("email", event.target.value)}
                  placeholder="john@example.com"
                  disabled={Boolean(form.contactId)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="contact-phone">Phone</Label>
                <Input className="bg-white"
                  id="contact-phone"
                  type="tel"
                  inputMode="tel"
                  value={form.phone}
                  onChange={(event) =>
                    updateField("phone", formatPhone(event.target.value))
                  }
                  placeholder="(555) 123-4567"
                  disabled={Boolean(form.contactId)}
                />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label>Project address</Label>
                <AddressAutocomplete
                  value={form.address}
                  onChange={(value) => updateField("address", value)}
                  onSelect={(parts) => {
                    const address = [
                      parts.street,
                      parts.city,
                      `${parts.state} ${parts.zip}`.trim(),
                    ]
                      .filter(Boolean)
                      .join(", ");

                    updateField("address", address);
                  }}
                  placeholder="123 Main St, City, ST"
                className="bg-white"
                />
              </div>
            </div>
          </section>

          <section className="mt-6 grid gap-3 pt-1">
            <SectionHeading>Project Information</SectionHeading>

            <div className="grid gap-3 sm:grid-cols-2">
              <DealSelectField
                label="Source"
                value={form.source}
                placeholder="Select source"
                options={SOURCE_OPTIONS}
                onValueChange={(value) => updateField("source", value)}
              />

              <DealSelectField
                label="Service type"
                value={form.serviceType}
                placeholder="Select service"
                options={SERVICE_OPTIONS}
                onValueChange={(value) => updateField("serviceType", value)}
              />

              <DealSelectField
                label="Budget"
                value={form.budget}
                placeholder="Select budget"
                options={BUDGET_OPTIONS}
                onValueChange={(value) => updateField("budget", value)}
              />

              <DealSelectField
                label="Timeline"
                value={form.timeline}
                placeholder="Select timeline"
                options={TIMELINE_OPTIONS}
                onValueChange={(value) => updateField("timeline", value)}
              />

              <div className="space-y-1.5 sm:col-span-2">
                <Label>Tags</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10 w-full justify-between bg-white font-normal
                        focus-visible:ring-0 focus-visible:ring-offset-0
                        data-[state=open]:border-[#E3CA9A]
                        data-[state=open]:bg-[#FAF3E4]"
                    >
                      <span className="truncate text-left">
                        {selectedTags.length
                          ? selectedTags.join(", ")
                          : "Select tags"}
                      </span>
                      <ChevronDown className="ml-2 h-4 w-4 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>

                  <DropdownMenuContent
                    className="w-[var(--radix-dropdown-menu-trigger-width)]"
                  >
                    {TAG_OPTIONS.map((tag) => (
                      <DropdownMenuCheckboxItem
                        key={tag}
                        checked={selectedTags.includes(tag)}
                        onCheckedChange={() => toggleTag(tag)}
                        onSelect={(event) => event.preventDefault()}
                        className="data-[highlighted]:bg-[#FAF3E4]"
                      >
                        {tag}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                {selectedTags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {selectedTags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-[#E3CA9A]
                          bg-[#FAF3E4] px-2.5 py-1 text-xs font-medium"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="deal-notes">Notes</Label>
                <Textarea className="bg-white"
                  id="deal-notes"
                  value={form.notes}
                  onChange={(event) => updateField("notes", event.target.value)}
                  placeholder="Add important details about this opportunity..."
                  rows={4}
                />
              </div>
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            Cancel
          </Button>
          <Button
            className="bg-blue-600 text-white hover:bg-blue-700"
            onClick={handleCreate}
            disabled={!form.name.trim() || !selectedPipelineId || creating}
          >
            {creating ? "Creating…" : "Create Deal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SectionHeading({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2 text-center">
      <h3 className="text-base font-semibold text-foreground">
        {children}
      </h3>
      <div className="h-px w-full bg-[#E3CA9A]" />
    </div>
  );
}

function DealSelectField({
  label,
  value,
  placeholder,
  options,
  onValueChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  options: string[];
  onValueChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="bg-white focus:ring-0 focus:ring-offset-0">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
