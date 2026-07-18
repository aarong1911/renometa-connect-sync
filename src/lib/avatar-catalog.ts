// src/lib/avatar-catalog.ts
//
// Real illustrated avatar set (uploaded by Ron) — all 20 entries in
// avatars.json now have image files in public/avatars/.

export type AvatarEntry = { id: string; filename: string; path: string };

export const AVAILABLE_AVATARS: AvatarEntry[] = [
  { id: "avatar-01", filename: "avatar-01.png", path: "/avatars/avatar-01.png" },
  { id: "avatar-02", filename: "avatar-02.png", path: "/avatars/avatar-02.png" },
  { id: "avatar-03", filename: "avatar-03.png", path: "/avatars/avatar-03.png" },
  { id: "avatar-04", filename: "avatar-04.png", path: "/avatars/avatar-04.png" },
  { id: "avatar-05", filename: "avatar-05.png", path: "/avatars/avatar-05.png" },
  { id: "avatar-06", filename: "avatar-06.png", path: "/avatars/avatar-06.png" },
  { id: "avatar-07", filename: "avatar-07.png", path: "/avatars/avatar-07.png" },
  { id: "avatar-08", filename: "avatar-08.png", path: "/avatars/avatar-08.png" },
  { id: "avatar-09", filename: "avatar-09.png", path: "/avatars/avatar-09.png" },
  { id: "avatar-10", filename: "avatar-10.png", path: "/avatars/avatar-10.png" },
  { id: "avatar-11", filename: "avatar-11.png", path: "/avatars/avatar-11.png" },
  { id: "avatar-12", filename: "avatar-12.png", path: "/avatars/avatar-12.png" },
  { id: "avatar-13", filename: "avatar-13.png", path: "/avatars/avatar-13.png" },
  { id: "avatar-14", filename: "avatar-14.png", path: "/avatars/avatar-14.png" },
  { id: "avatar-15", filename: "avatar-15.png", path: "/avatars/avatar-15.png" },
  { id: "avatar-16", filename: "avatar-16.png", path: "/avatars/avatar-16.png" },
  { id: "avatar-17", filename: "avatar-17.png", path: "/avatars/avatar-17.png" },
  { id: "avatar-18", filename: "avatar-18.png", path: "/avatars/avatar-18.png" },
  { id: "avatar-19", filename: "avatar-19.png", path: "/avatars/avatar-19.png" },
  { id: "avatar-20", filename: "avatar-20.png", path: "/avatars/avatar-20.png" },
];

const BY_ID = new Map(AVAILABLE_AVATARS.map(a => [a.id, a]));

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic avatar for a given seed (contact id, name, whatever's stable) — same seed always resolves to the same avatar. */
export function pickAvatarForSeed(seed: string): AvatarEntry {
  const hash = hashSeed(seed || "unknown");
  return AVAILABLE_AVATARS[hash % AVAILABLE_AVATARS.length];
}

/** Resolve an explicit avatar key (e.g. one the user picked) to its file, or null if unknown/unavailable. */
export function resolveAvatarKey(key: string | null | undefined): AvatarEntry | null {
  if (!key) return null;
  return BY_ID.get(key) ?? null;
}

export function initialsFrom(seed: string): string {
  const parts = seed.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
