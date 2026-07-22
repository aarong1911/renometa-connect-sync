// src/lib/notes-hash.ts
// Deterministic flattening + hashing for migrating Lead notes
// (renometa.leadnotes.v1) into a Deal during lead conversion. The hash lets
// convert_lead_to_deal prove on a retry whether these exact notes were
// already migrated, without ever assuming it.

import type { LeadNote } from "@/lib/leads-store";

// Newest-first, one block per note, stable regardless of object key order.
export function flattenLeadNotes(notes: LeadNote[]): string | null {
  if (!notes.length) return null;
  return notes
    .map((note) => `[${note.createdAt}] ${note.text}`)
    .join("\n\n");
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
