// src/components/contacts/tag-picker.tsx
//
// Shared dropdown/combobox tag picker — replaces the old free-text
// "Add a tag…" input + Add button in the contact drawer, and is reused by
// the Contacts bulk Add tag / Remove tag controls so there's exactly one
// tag-selection UI pattern instead of a second competing one.

import { useMemo, useState } from "react";
import { Check, Plus, Tag as TagIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { tagComparisonKey, type CanonicalTagOption, type TagColorClasses } from "@/lib/tag-utils";

export type TagPickerSelection = { key: string; label: string; isNew: boolean };

export function TagPicker({
  options,
  excludeKeys = [],
  colorFor,
  onSelect,
  placeholder = "Select or create a tag…",
  allowCreate = true,
  disabled,
  className,
  emptyText = "No tags found.",
}: {
  /** Full universe of selectable canonical tags (already deduplicated). */
  options: CanonicalTagOption[];
  /** Canonical keys to hide from the list — e.g. tags already on this contact. */
  excludeKeys?: string[];
  colorFor: (key: string) => TagColorClasses;
  /** `isNew` is true only when the user typed a value with no existing canonical match. */
  onSelect: (selection: TagPickerSelection) => void;
  placeholder?: string;
  /** Set false for a select-only picker (e.g. bulk "Remove tag") — no "Create new tag" option. */
  allowCreate?: boolean;
  disabled?: boolean;
  className?: string;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const excludeSet = useMemo(() => new Set(excludeKeys), [excludeKeys]);
  const visibleOptions = useMemo(
    () => options.filter((o) => !excludeSet.has(o.key)),
    [options, excludeSet],
  );

  const trimmedQuery = query.trim();
  const queryKey = trimmedQuery ? tagComparisonKey(trimmedQuery) : "";
  // Case/separator-insensitive dedup guard (Priority 1) — typing "vip" when
  // "VIP" already exists (or "new_lead" when "New Lead" exists) must not
  // offer a redundant "Create" option; the existing canonical option is
  // still shown (and selectable) in the filtered list above it.
  const exactCanonicalMatch = trimmedQuery ? options.some((o) => o.key === queryKey) : false;
  const showCreate = allowCreate && trimmedQuery.length > 0 && !exactCanonicalMatch;

  function close() {
    setOpen(false);
    setQuery("");
  }

  function selectExisting(option: CanonicalTagOption) {
    onSelect({ key: option.key, label: option.label, isNew: false });
    close();
  }

  function createNew() {
    if (!trimmedQuery) return;
    onSelect({ key: queryKey, label: trimmedQuery, isNew: true });
    close();
  }

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("h-7 justify-start gap-1.5 text-xs font-normal text-muted-foreground", className)}
          disabled={disabled}
        >
          <TagIcon className="h-3 w-3 shrink-0" />
          {placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={placeholder} value={query} onValueChange={setQuery} />
          <CommandList className="max-h-56">
            {visibleOptions.length === 0 && !showCreate && <CommandEmpty>{emptyText}</CommandEmpty>}
            {visibleOptions.length > 0 && (
              <CommandGroup heading="Tags">
                {visibleOptions
                  .filter((o) => !trimmedQuery || o.label.toLowerCase().includes(trimmedQuery.toLowerCase()))
                  .map((o) => {
                    const colors = colorFor(o.key);
                    return (
                      <CommandItem key={o.key} value={o.label} onSelect={() => selectExisting(o)}>
                        <span className={cn("mr-2 inline-block h-2.5 w-2.5 shrink-0 rounded-full", colors.dot)} />
                        {o.label}
                      </CommandItem>
                    );
                  })}
              </CommandGroup>
            )}
            {showCreate && (
              <CommandGroup heading="Create">
                <CommandItem value={`__create__${queryKey}`} onSelect={createNew}>
                  <Plus className="mr-2 h-3.5 w-3.5 shrink-0" />
                  Create "{trimmedQuery}"
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
