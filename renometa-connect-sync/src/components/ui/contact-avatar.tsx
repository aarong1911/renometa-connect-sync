// src/components/ui/contact-avatar.tsx
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { pickAvatarForSeed, resolveAvatarKey, initialsFrom } from "@/lib/avatar-catalog";
import { cn } from "@/lib/utils";

const SIZE_CLASSES = {
  xs: "h-5 w-5",
  sm: "h-8 w-8",
  md: "h-10 w-10",
  lg: "h-12 w-12",
} as const;

export function ContactAvatar({
  id,
  name,
  avatarKey,
  size = "sm",
  className,
}: {
  /** Stable identifier (contact/lead id) — preferred seed so the same person always gets the same avatar even if their name changes. */
  id?: string | null;
  name: string;
  /** Explicit avatar id (e.g. user-picked via an avatar picker) — takes priority over the deterministic pick. */
  avatarKey?: string | null;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  const explicit = resolveAvatarKey(avatarKey);
  const avatar = explicit ?? pickAvatarForSeed(id || name || "unknown");
  return (
    <Avatar className={cn(SIZE_CLASSES[size], "shrink-0 ring-1 ring-black/5", className)}>
      <AvatarImage src={avatar.path} alt={name} />
      <AvatarFallback className="bg-primary-soft text-[10px] font-semibold text-primary">
        {initialsFrom(name)}
      </AvatarFallback>
    </Avatar>
  );
}
