// src/components/appointments/entity-picker.tsx
//
// Phase 10.3 — searchable Lead/Contact/Account/Deal/Project combobox for
// the appointment dialog's "Related record" field. Same shape as
// src/components/tasks/entity-picker.tsx, generalized to the wider
// AppointmentEntityType set. Filters the already-loaded per-domain stores
// client-side — no new search service, no per-keystroke query.

import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Target, User, Building2, TrendingUp, FolderKanban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useLeads } from "@/lib/leads-store";
import { useDeals } from "@/lib/deals-store";
import { useContacts } from "@/lib/contacts-store";
import { useCompanies } from "@/lib/companies-store";
import { useProjects } from "@/lib/projects-store";
import type { AppointmentEntityType } from "@/lib/appointment-status";

const ENTITY_ICON: Record<AppointmentEntityType, typeof Target> = {
  lead: Target, contact: User, company: Building2, deal: TrendingUp, project: FolderKanban,
};

const ENTITY_NOUN: Record<AppointmentEntityType, string> = {
  lead: "lead", contact: "contact", company: "account", deal: "deal", project: "project",
};

export function AppointmentEntityPicker({
  entityType,
  value,
  onSelect,
  disabled,
}: {
  entityType: AppointmentEntityType;
  value: string | null;
  onSelect: (entityId: string, label: string) => void;
  disabled?: boolean;
}) {
  const leads = useLeads();
  const deals = useDeals();
  const contacts = useContacts();
  const companies = useCompanies();
  const { projects } = useProjects();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const options = useMemo(() => {
    switch (entityType) {
      case "lead":
        return leads.map((l) => ({ id: l.id, primary: l.name, secondary: l.email || "" }));
      case "deal":
        return deals.map((d) => ({ id: d.id, primary: d.name, secondary: d.companyName || d.contactName || "" }));
      case "contact":
        return contacts.map((c) => ({ id: c.id, primary: c.name, secondary: c.email || "" }));
      case "company":
        return companies.map((c) => ({ id: c.id, primary: c.name, secondary: c.city ? `${c.city}, ${c.state}` : "" }));
      case "project":
        return projects.map((p) => ({ id: p.id, primary: p.name, secondary: p.client_name || "" }));
      default:
        return [];
    }
  }, [entityType, leads, deals, contacts, companies, projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.primary.toLowerCase().includes(q) || o.secondary.toLowerCase().includes(q),
    );
  }, [options, query]);

  const selected = options.find((o) => o.id === value) ?? null;
  const Icon = ENTITY_ICON[entityType];
  const noun = ENTITY_NOUN[entityType];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className="h-9 w-full justify-between text-xs font-normal"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{selected ? selected.primary : `Select a ${noun}…`}</span>
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={`Search ${noun}s…`} value={query} onValueChange={setQuery} />
          <CommandList className="max-h-64">
            {filtered.length === 0 && <CommandEmpty>No matching {noun}s.</CommandEmpty>}
            {filtered.length > 0 && (
              <CommandGroup>
                {filtered.slice(0, 50).map((o) => (
                  <CommandItem
                    key={o.id}
                    value={o.id}
                    onSelect={() => { onSelect(o.id, o.primary); setOpen(false); setQuery(""); }}
                  >
                    <Check className={cn("mr-2 h-3.5 w-3.5", o.id === value ? "opacity-100" : "opacity-0")} />
                    <div className="min-w-0">
                      <p className="truncate text-sm">{o.primary}</p>
                      {o.secondary && <p className="truncate text-xs text-muted-foreground">{o.secondary}</p>}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
