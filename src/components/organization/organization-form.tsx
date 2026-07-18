// Reusable Organization details form. Shape matches the onboarding
// CompanyStep + BrandingStep so it can be embedded in either flow.
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Check, ChevronDown, ImagePlus, Loader2, X } from "lucide-react";
import {
  CRM_GOALS,
  INDUSTRIES,
  TIMEZONE_OPTIONS,
  guessTimezoneFromAddress,
  type Organization,
} from "@/lib/organization";

import { formatPhone } from "@/lib/format";

export type OrganizationFormProps = {
  value: Organization;
  onChange: (next: Organization) => void;
  onSubmit?: () => void | Promise<void>;
  submitLabel?: string;
  saving?: boolean;
  /** Hide the submit row (e.g. when caller renders its own footer). */
  hideActions?: boolean;
  /** Optional secondary action (e.g. Cancel / Back). */
  secondaryAction?: { label: string; onClick: () => void };
};

export function OrganizationForm({
  value,
  onChange,
  onSubmit,
  submitLabel = "Save changes",
  saving,
  hideActions,
  secondaryAction,
}: OrganizationFormProps) {
  const set = <K extends keyof Organization>(k: K, v: Organization[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Field label="Company name">
          <Input
            value={value.companyName}
            onChange={(e) => set("companyName", e.target.value)}
            placeholder="e.g. RenoMeta Builders"
          />
        </Field>

        <Field label="Primary phone">
          <Input
            value={value.primaryPhone}
            onChange={(e) => set("primaryPhone", formatPhone(e.target.value))}
            placeholder="(555) 555-5555"
            inputMode="tel"
          />
        </Field>

        <Field label="Website">
          <Input
            value={value.website}
            onChange={(e) => set("website", e.target.value)}
            placeholder="https://yourcompany.com"
          />
        </Field>

        <Field label="Business type">
          <Select
            value={value.industry ?? ""}
            onValueChange={(v) => set("industry", v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a business type" />
            </SelectTrigger>
            <SelectContent>
              {INDUSTRIES.map((i) => (
                <SelectItem key={i} value={i}>
                  {i}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Primary business address" className="md:col-span-2">
          <Input
            value={value.address}
            onChange={(e) => {
              const addr = e.target.value;
              set("address", addr);
              const tz = guessTimezoneFromAddress(addr);
              if (tz && tz !== value.timezone) set("timezone", tz);
            }}
            placeholder="Street, City, State"
          />
        </Field>

        <Field label="Timezone">
          <Select
            value={value.timezone}
            onValueChange={(v) => set("timezone", v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select timezone" />
            </SelectTrigger>
            <SelectContent>
              {TIMEZONE_OPTIONS.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Primary CRM goals" className="md:col-span-2">
          <GoalsMultiSelect
            value={value.crmGoals}
            onChange={(next) => set("crmGoals", next)}
          />
        </Field>

        <Field label="Company logo" className="md:col-span-2">
          <LogoPicker
            value={value.logoUrl}
            onChange={(url) => set("logoUrl", url)}
          />
        </Field>
      </div>

      {!hideActions && (
        <div className="flex items-center justify-between border-t border-border pt-4">
          <div>
            {secondaryAction && (
              <Button variant="outline" size="sm" onClick={secondaryAction.onClick}>
                {secondaryAction.label}
              </Button>
            )}
          </div>
          <Button size="sm" onClick={() => onSubmit?.()} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : submitLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function GoalsMultiSelect({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const label =
    value.length === 0
      ? "Select CRM goals"
      : value.length === 1
        ? value[0]
        : `${value.length} selected`;

  const toggle = (g: string) => {
    onChange(value.includes(g) ? value.filter((v) => v !== g) : [...value, g]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-9 w-full justify-between text-sm font-normal"
        >
          <span className={value.length ? "" : "text-muted-foreground"}>
            {label}
          </span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="z-50 w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        sideOffset={4}
      >
        <Command>
          <CommandInput placeholder="Search goals…" />
          <CommandList>
            <CommandEmpty>No goals found.</CommandEmpty>
            <CommandGroup>
              {CRM_GOALS.map((g) => {
                const selected = value.includes(g);
                return (
                  <CommandItem
                    key={g}
                    onSelect={() => toggle(g)}
                    className="cursor-pointer"
                  >
                    <span className="mr-2 inline-flex h-4 w-4 items-center justify-center rounded border">
                      {selected && <Check className="h-3 w-3" />}
                    </span>
                    {g}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        <div className="flex justify-end border-t p-2">
          <Button size="sm" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

async function uploadLogoFile(file: File): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", session.user.id)
    .maybeSingle();

  const orgId = profile?.organization_id;
  if (!orgId) return null;

  const ext = file.name.split(".").pop() ?? "png";
  const path = `logos/${orgId}/logo.${ext}`;

  const { error } = await supabase.storage
    .from("org-assets")
    .upload(path, file, { upsert: true, contentType: file.type });

  if (error) {
    console.error("[logo] upload error:", error);
    return null;
  }

  const { data } = supabase.storage.from("org-assets").getPublicUrl(path);
  return `${data.publicUrl}?t=${Date.now()}`;
}

function LogoPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
}) {
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File) => {
    setUploading(true);
    const url = await uploadLogoFile(file);
    setUploading(false);
    if (!url) {
      toast.error("Logo upload failed — check your Supabase Storage bucket");
      return;
    }
    onChange(url);
  };

  const displaySrc = value && !value.startsWith("blob:") ? value : null;

  return (
    <div className="flex items-center gap-3">
      <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-md border border-dashed border-border bg-secondary/40">
        {displaySrc ? (
          <img src={displaySrc} alt="Logo preview" className="h-full w-full object-cover" />
        ) : (
          <ImagePlus className="h-5 w-5 text-muted-foreground" />
        )}
      </div>
      <label className={uploading ? "pointer-events-none cursor-wait opacity-60" : "cursor-pointer"}>
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />
        <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-secondary">
          {uploading && <Loader2 className="h-3 w-3 animate-spin" />}
          {displaySrc ? "Replace logo" : "Upload logo"}
        </span>
      </label>
      {displaySrc && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs text-muted-foreground"
          onClick={() => onChange(null)}
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}
