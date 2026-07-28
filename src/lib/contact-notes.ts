// src/lib/contact-notes.ts
//
// Real, persisted notes — Phase 9.3 (contacts) / Phase 9.4 (generalized).
// Reuses the existing `notes` table (org_id, entity_type, entity_id,
// content, is_pinned, created_by, created_at, updated_at, project_id,
// note_type, subject) — confirmed live via a direct schema check to
// already exist with real `entity_type: "contact"/"deal"/"project"` rows.
//
// `useEntityNotes(entityType, entityId)` is the generic hook; `useContactNotes`
// is now a thin compatibility wrapper over it (`entityType: "contact"`) so
// existing Contacts-page callers don't need to change. Phase 9.4 considered
// wiring this same hook into the Companies detail page for
// `entity_type: "company"`, but accounts_.$accountSlug.tsx already has a
// real, working, richer `company_notes` table (title, is_pinned,
// author_name — a proper dedicated table, not a stub) wired end-to-end.
// Migrating that to this generic table would trade a working, richer
// feature for a plainer one and risk regressing it, so it was deliberately
// left as-is — see the Phase 9.4 report for the full reconciliation
// rationale. This hook remains available for leads/deals/projects (or
// companies, later) to adopt the same generic pattern without a new
// migration, whenever that's wanted.
//
// Deliberately NOT localStorage (unlike src/lib/leads-store.ts's lead
// notes, which remain a separate, pre-existing localStorage feature this
// pass does not touch).

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.organization_id) return profile.organization_id;
  const { data: membership } = await supabase
    .from("org_memberships")
    .select("org_id")
    .eq("member_id", user.id)
    .maybeSingle();
  return membership?.org_id ?? null;
}

export type EntityType = "contact" | "company" | "deal" | "project" | "lead";

export type ContactNote = {
  id: string;
  content: string;
  createdBy: string | null;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  isPinned: boolean;
  /** True once we've confirmed the signed-in user authored this row — the only row a "delete/edit own note" action should be offered for. */
  isOwn: boolean;
};

function mapNoteRow(row: any, currentUserId: string | null, authorName: string): ContactNote {
  return {
    id: row.id,
    content: row.content ?? "",
    createdBy: row.created_by ?? null,
    authorName,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    isPinned: !!row.is_pinned,
    isOwn: !!currentUserId && row.created_by === currentUserId,
  };
}

export function useEntityNotes(entityType: EntityType, entityId: string | null): {
  notes: ContactNote[];
  loading: boolean;
  error: string | null;
  addNote: (content: string) => Promise<boolean>;
  updateNote: (noteId: string, content: string) => Promise<boolean>;
  deleteNote: (noteId: string) => Promise<boolean>;
} {
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!entityId) { setNotes([]); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const uid = user?.id ?? null;
      const org = await getOrgId();
      setOrgId(org);
      if (!org) { setNotes([]); setLoading(false); return; }

      const { data, error: fetchError } = await supabase
        .from("notes")
        .select("id, content, created_by, created_at, updated_at, is_pinned")
        .eq("org_id", org)
        .eq("entity_type", entityType)
        .eq("entity_id", entityId)
        .order("is_pinned", { ascending: false })
        .order("created_at", { ascending: false });

      if (fetchError) {
        console.error("[entity-notes] fetch failed:", fetchError);
        setError("Couldn't load notes right now.");
        setNotes([]);
        setLoading(false);
        return;
      }

      const authorIds = [...new Set((data ?? []).map((r: any) => r.created_by).filter(Boolean))] as string[];
      let nameById = new Map<string, string>();
      if (authorIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, first_name, last_name, email")
          .in("id", authorIds);
        nameById = new Map((profiles ?? []).map((p: any) => [
          p.id,
          `${p.first_name || ""} ${p.last_name || ""}`.trim() || p.email || "Team member",
        ]));
      }

      setNotes((data ?? []).map((row: any) => mapNoteRow(row, uid, row.created_by ? (nameById.get(row.created_by) ?? "Team member") : "Team member")));
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  useEffect(() => { void load(); }, [load]);

  const addNote = useCallback(async (content: string): Promise<boolean> => {
    const trimmed = content.trim();
    if (!trimmed || !entityId) return false;
    const org = orgId ?? await getOrgId();
    const { data: { user } } = await supabase.auth.getUser();
    if (!org || !user) {
      console.error("[entity-notes] addNote: no organization or session");
      return false;
    }
    const { error: insertError } = await supabase.from("notes").insert({
      org_id: org,
      entity_type: entityType,
      entity_id: entityId,
      content: trimmed,
      created_by: user.id,
    });
    if (insertError) {
      console.error("[entity-notes] insert failed:", insertError);
      return false;
    }
    await load();
    return true;
  }, [entityType, entityId, orgId, load]);

  const updateNote = useCallback(async (noteId: string, content: string): Promise<boolean> => {
    const trimmed = content.trim();
    if (!trimmed) return false;
    const { error: updateError } = await supabase
      .from("notes")
      .update({ content: trimmed, updated_at: new Date().toISOString() })
      .eq("id", noteId);
    if (updateError) {
      console.error("[entity-notes] update failed:", updateError);
      return false;
    }
    await load();
    return true;
  }, [load]);

  const deleteNote = useCallback(async (noteId: string): Promise<boolean> => {
    const { error: deleteError } = await supabase.from("notes").delete().eq("id", noteId);
    if (deleteError) {
      console.error("[entity-notes] delete failed:", deleteError);
      return false;
    }
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    return true;
  }, []);

  return { notes, loading, error, addNote, updateNote, deleteNote };
}

/** Compatibility wrapper — existing Contacts-page callers use this name. */
export function useContactNotes(contactId: string | null) {
  return useEntityNotes("contact", contactId);
}
