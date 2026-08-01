// src/lib/proposal-templates-store.ts
//
// Phase 10.4 continuation — organization-owned Proposal Content templates,
// backed by estimate_proposal_templates (20260810), extended by 20260811
// with a `work_type` column and a fifth category, `scope_of_work`. The
// built-in, read-only starter presets for the four text categories live in
// proposal-presets.ts; Scope of Work's built-ins live in
// scope-of-work-presets.ts — neither ever touches this table. This store
// is only for what an org has explicitly saved as its own template.
//
// useOrgTemplates() fetches ALL of an org's templates (every category) in
// one query — Scope templates are just rows with category='scope_of_work'
// and a non-null work_type among them. Filtering by category/work_type is
// a cheap client-side operation on that one already-loaded array (see
// getScopeTemplates/resolveDefaultScopeContent below) rather than a second
// network round trip per Work Type change.
//
// Defensive by design: until 20260810 (and now 20260811) are deployed,
// every query here 404s or hits the old category check constraint. Every
// function catches that and degrades to an empty list / a clear error
// rather than crashing the estimate drawer.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getOrgId } from "@/lib/contacts-store";
import type { ProposalPresetCategory } from "@/lib/proposal-presets";
import type { WorkType } from "@/lib/estimate-status";

export type TemplateCategory = ProposalPresetCategory | "scope_of_work";

export type OrgProposalTemplate = {
  id: string;
  org_id: string;
  category: TemplateCategory;
  work_type: WorkType | null;
  name: string;
  content: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

// Module-level, session-lifetime cache: once we've confirmed the table
// doesn't exist yet, every subsequent useOrgTemplates() mount (the New and
// Edit sheets each mount their own instance) skips the network call
// entirely instead of re-issuing the same 404 on every open — one warning,
// one failed request, for the whole session. saveOrgTemplate() clears this
// the moment a write actually succeeds, so deploying a migration mid-
// session without a full reload still starts working immediately.
let tableConfirmedMissing = false;
let warnedMissingTable = false;
function isMissingTableError(message: string | undefined): boolean {
  return !!message && (message.includes("does not exist") || message.includes("schema cache"));
}
function isCategoryCheckError(message: string | undefined): boolean {
  return !!message && message.includes("estimate_proposal_templates_category_check");
}

export function useOrgTemplates(): { templates: OrgProposalTemplate[]; loading: boolean; refresh: () => void } {
  const [templates, setTemplates] = useState<OrgProposalTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    if (tableConfirmedMissing) { setTemplates([]); setLoading(false); return; }
    setLoading(true);
    getOrgId().then((orgId) => {
      if (!orgId) { setTemplates([]); setLoading(false); return; }
      supabase
        .from("estimate_proposal_templates")
        .select("*")
        .eq("org_id", orgId)
        .order("category", { ascending: true })
        .order("name", { ascending: true })
        .then(({ data, error }) => {
          if (error) {
            if (isMissingTableError(error.message)) {
              tableConfirmedMissing = true;
              if (!warnedMissingTable) {
                warnedMissingTable = true;
                console.warn("[proposal-templates] estimate_proposal_templates table not found — deploy supabase/migrations/20260810_estimate_proposal_templates.sql (then 20260811) to enable organization templates. Shared presets remain fully usable.");
              }
            } else {
              console.error("[proposal-templates] load failed", error);
            }
            setTemplates([]);
          } else {
            setTemplates((data ?? []) as OrgProposalTemplate[]);
          }
          setLoading(false);
        });
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  return { templates, loading, refresh };
}

export async function saveOrgTemplate(input: {
  category: TemplateCategory; name: string; content: string; workType?: WorkType | null; setAsDefault?: boolean;
}): Promise<{ data?: OrgProposalTemplate; error?: string }> {
  const orgId = await getOrgId();
  if (!orgId) return { error: "Not signed in" };
  const name = input.name.trim();
  if (!name) return { error: "Template name is required" };
  if (name.length > 120) return { error: "Template name must be 120 characters or fewer" };
  if (input.category === "scope_of_work" && !input.workType) return { error: "A Work Type is required to save a Scope of Work template." };
  if (!input.content.trim()) return { error: "Template content is required" };

  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("estimate_proposal_templates")
    .insert({
      org_id: orgId, category: input.category, work_type: input.category === "scope_of_work" ? input.workType : null,
      name, content: input.content,
      created_by: user?.id ?? null, updated_by: user?.id ?? null,
    })
    .select("*")
    .single();

  if (error) {
    if (isMissingTableError(error.message)) {
      return { error: "Organization templates aren't set up yet — the estimate_proposal_templates migration hasn't been deployed." };
    }
    if (isCategoryCheckError(error.message)) {
      return { error: "Scope of Work templates aren't set up yet — deploy supabase/migrations/20260811_scope_of_work_templates.sql." };
    }
    return { error: error.message };
  }

  if (input.setAsDefault) {
    const defaultResult = await setDefaultTemplate(orgId, input.category, data.id, input.category === "scope_of_work" ? input.workType ?? null : null);
    if (defaultResult.error) return { data: data as OrgProposalTemplate, error: defaultResult.error };
  }
  return { data: data as OrgProposalTemplate };
}

export async function updateOrgTemplate(id: string, patch: { name?: string; content?: string }): Promise<{ error?: string }> {
  const { data: { user } } = await supabase.auth.getUser();
  const update: Record<string, unknown> = { updated_by: user?.id ?? null };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) return { error: "Template name is required" };
    update.name = name;
  }
  if (patch.content !== undefined) update.content = patch.content;
  const { error } = await supabase.from("estimate_proposal_templates").update(update).eq("id", id);
  return error ? { error: error.message } : {};
}

export async function deleteOrgTemplate(id: string): Promise<{ error?: string }> {
  const { error } = await supabase.from("estimate_proposal_templates").delete().eq("id", id);
  return error ? { error: error.message } : {};
}

/**
 * Clears the existing default for this org+category(+work_type), then sets
 * templateId as the new default (or clears entirely when templateId is
 * null). Two sequential updates rather than a single transaction — matches
 * the rest of this codebase's Supabase-client-only architecture; the
 * unique partial index on (org_id, category, coalesce(work_type,'')) WHERE
 * is_default is the real backstop against two defaults ever existing at
 * once. `workType` must be omitted/null for the four non-Scope categories
 * (matches their "one default per org+category" behavior unchanged since
 * 20260810) and provided for scope_of_work (one default per work type).
 */
export async function setDefaultTemplate(
  orgId: string, category: TemplateCategory, templateId: string | null, workType: WorkType | null = null,
): Promise<{ error?: string }> {
  let clearQuery = supabase
    .from("estimate_proposal_templates")
    .update({ is_default: false })
    .eq("org_id", orgId).eq("category", category).eq("is_default", true);
  clearQuery = workType ? clearQuery.eq("work_type", workType) : clearQuery.is("work_type", null);
  const { error: clearErr } = await clearQuery;
  if (clearErr) return { error: clearErr.message };

  if (templateId) {
    const { error } = await supabase.from("estimate_proposal_templates").update({ is_default: true }).eq("id", templateId);
    if (error) return { error: error.message };
  }
  return {};
}

/** The org's default template content for one of the four general categories (customer_note/exclusions/assumptions/terms), or "" when none is set — used to prefill a brand-new estimate's Proposal Content once. */
export function resolveDefaultContent(templates: OrgProposalTemplate[], category: ProposalPresetCategory): string {
  return templates.find((t) => t.category === category && t.is_default)?.content ?? "";
}

/** Org-owned Scope of Work templates for one Work Type, filtered client-side from the already-loaded template list (see the module comment for why this isn't a second network call). */
export function getScopeTemplates(templates: OrgProposalTemplate[], workType: WorkType): OrgProposalTemplate[] {
  return templates.filter((t) => t.category === "scope_of_work" && t.work_type === workType);
}

/** The org's default Scope of Work template content for a Work Type, or "" when none is set. */
export function resolveDefaultScopeContent(templates: OrgProposalTemplate[], workType: WorkType): string {
  return getScopeTemplates(templates, workType).find((t) => t.is_default)?.content ?? "";
}
