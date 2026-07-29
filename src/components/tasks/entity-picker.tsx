// src/components/tasks/entity-picker.tsx
//
// Phase 10.2 — searchable Lead/Deal combobox for the global Tasks page's
// "Related to" picker. Filters the already-loaded useLeads()/useDeals()
// stores client-side (both are already fetched org-scoped elsewhere in the
// app) — no new search service, no per-keystroke query.

import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Target, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useLeads } from "@/lib/leads-store";
import { useDeals } from "@/lib/deals-store";
import type { TaskEntityType } from "@/lib/mock-data";

export function EntityPicker({
  entityType,
  value,
  onSelect,
  disabled,
}: {
  entityType: TaskEntityType;
  value: string | null;
  onSelect: (entityId: string) => void;
  disabled?: boolean;
}) {
  const leads = useLeads();
  const deals = useDeals();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const options = useMemo(() => {
    if (entityType === "lead") {
      return leads.map((l) => ({ id: l.id, primary: l.name, secondary: l.email || "" }));
    }
    return deals.map((d) => ({ id: d.id, primary: d.name, secondary: d.companyName || d.contactName || "" }));
  }, [entityType, leads, deals]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.primary.toLowerCase().includes(q) || o.secondary.toLowerCase().includes(q),
    );
  }, [options, query]);

  const selected = options.find((o) => o.id === value) ?? null;
  const Icon = entityType === "lead" ? Target : TrendingUp;
  const noun = entityType === "lead" ? "lead" : "deal";

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
                    onSelect={() => { onSelect(o.id); setOpen(false); setQuery(""); }}
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
