// src/components/ui/contact-avatar.tsx
import { useEffect, useState } from "react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { pickAvatarForSeed, resolveAvatarKey, initialsFrom } from "@/lib/avatar-catalog";
import { cn } from "@/lib/utils";

const SIZE_CLASSES = {
  xs: "h-5 w-5",
  sm: "h-8 w-8",
  md: "h-10 w-10",
  lg: "h-12 w-12",
} as const;

// Universal avatar precedence (Messenger Attribution + Avatar Consistency
// Cleanup): 1) a real remote photo (contacts.avatar_url — e.g. a Meta/
// Facebook profile picture), 2) an explicitly user-picked local avatar
// (avatarKey), 3) the deterministic generated fallback seeded by id/name,
// 4) initials (Radix AvatarFallback, automatic once no <img> loads). This
// is now the ONE place that decides which image wins — every caller across
// Conversations/Contacts/Leads/etc. renders consistently as long as it
// passes the same `id` and the real `avatarUrl` when it has one.
export function ContactAvatar({
  id,
  name,
  avatarKey,
  avatarUrl,
  size = "sm",
  className,
}: {
  /** Stable identifier (contact id — NOT a lead/deal id; use the linked Contact's own id so the same person renders identically everywhere) — seed for the deterministic generated fallback. */
  id?: string | null;
  name: string;
  /** Explicit avatar id (e.g. user-picked via an avatar picker) — used when there's no real avatarUrl. */
  avatarKey?: string | null;
  /** Real remote photo URL (contacts.avatar_url, e.g. a Meta profile picture) — wins over avatarKey/generated fallback whenever non-empty. Rendered as-is, never transformed. */
  avatarUrl?: string | null;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  const explicit = resolveAvatarKey(avatarKey);
  const generated = explicit ?? pickAvatarForSeed(id || name || "unknown");

  const hasRemote = !!avatarUrl && avatarUrl.trim().length > 0;
  const [remoteFailed, setRemoteFailed] = useState(false);
  // Reset the failure flag if the remote URL itself changes (e.g. a
  // different Contact is now being rendered by the same mounted element).
  useEffect(() => { setRemoteFailed(false); }, [avatarUrl]);

  const useRemote = hasRemote && !remoteFailed;
  const src = useRemote ? (avatarUrl as string) : generated.path;

  return (
    <Avatar className={cn(SIZE_CLASSES[size], "shrink-0 ring-1 ring-black/5", className)}>
      <AvatarImage
        src={src}
        alt={name}
        className={useRemote ? "object-cover" : undefined}
        onLoadingStatusChange={(status) => {
          // Broken remote image (Part 10) — fall back to the generated/
          // custom avatar instead of ever showing a broken-image icon or
          // bare initials when a perfectly good local fallback exists.
          if (status === "error" && useRemote) setRemoteFailed(true);
        }}
      />
      <AvatarFallback className="bg-primary-soft text-[10px] font-semibold text-primary">
        {initialsFrom(name)}
      </AvatarFallback>
    </Avatar>
  );
}
