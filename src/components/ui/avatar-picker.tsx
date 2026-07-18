// src/components/ui/avatar-picker.tsx
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { AVAILABLE_AVATARS } from "@/lib/avatar-catalog";
import { cn } from "@/lib/utils";
import { Pencil, Loader2 } from "lucide-react";

/**
 * Click-to-open grid of the 20 local illustrated avatars. Wraps a
 * ContactAvatar with a small edit affordance; calling onSelect persists
 * the choice (caller owns the actual mutation, e.g. updateContact).
 */
export function AvatarPicker({
  id,
  name,
  avatarKey,
  size = "lg",
  onSelect,
}: {
  id?: string | null;
  name: string;
  avatarKey?: string | null;
  size?: "xs" | "sm" | "md" | "lg";
  onSelect: (avatarKey: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  async function handlePick(key: string) {
    setSaving(key);
    try {
      await onSelect(key);
      setOpen(false);
    } finally {
      setSaving(null);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="group relative rounded-full" title="Change avatar">
          <ContactAvatar id={id} name={name} avatarKey={avatarKey} size={size} />
          <span className="absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
            <Pencil className="h-2.5 w-2.5" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className="mb-1.5 px-1 text-[11px] font-medium text-muted-foreground">Choose an avatar</div>
        <div className="grid grid-cols-5 gap-1.5">
          {AVAILABLE_AVATARS.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => handlePick(a.id)}
              disabled={saving !== null}
              className={cn(
                "relative grid h-9 w-9 place-items-center overflow-hidden rounded-full ring-1 ring-black/5 transition-opacity hover:opacity-80",
                avatarKey === a.id && "ring-2 ring-primary",
              )}
            >
              <img src={a.path} alt="" className="h-full w-full object-cover" />
              {saving === a.id && (
                <span className="absolute inset-0 grid place-items-center bg-background/70">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                </span>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
