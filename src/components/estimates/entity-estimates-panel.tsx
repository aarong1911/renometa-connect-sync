// src/components/estimates/entity-estimates-panel.tsx
//
// Phase 10.4 — one reusable "linked estimates" panel for CRM detail views
// (Contact, Account, Lead, Deal, Project), mirroring the shape of
// src/components/appointments/entity-appointments-panel.tsx. Reads the same
// `estimates` table the full Estimates page uses (no separate store — the
// list is a light read, and the editor itself is a full-page-sized sheet
// that belongs on /estimates, not duplicated inline here); "New Estimate"
// deep-links to /estimates?openNew=1&<entityIdParam>=... which the page's
// own prefill effect already consumes.
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Plus, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { ESTIMATE_STATUS_LABELS, ESTIMATE_STATUS_TINT, normalizeEstimateStatus, type EstimateStatus } from "@/lib/estimate-status";

export type EstimateEntityType = "contact" | "company" | "lead" | "deal" | "project";

const ENTITY_COLUMN: Record<EstimateEntityType, string> = {
  contact: "client_id", company: "company_id", lead: "lead_id", deal: "deal_id", project: "project_id",
};
const SEARCH_PARAM: Record<EstimateEntityType, string> = {
  contact: "contactId", company: "companyId", lead: "leadId", deal: "dealId", project: "projectId",
};

type PanelRow = { id: string; number: string | null; title: string; status: EstimateStatus; version_number: number; total: number; valid_until: string | null; updated_at: string };

function fmtDate(s: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(s));
}
function formatMoney(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);
}

export function EntityEstimatesPanel({
  entityType, entityId, entityLabel,
}: {
  entityType: EstimateEntityType;
  entityId: string;
  /** e.g. "contact" / "account" / "lead" / "deal" / "project" — used in empty-state copy. */
  entityLabel: string;
}) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<PanelRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    supabase
      .from("estimates")
      .select("id, number, title, status, version_number, total, valid_until, updated_at")
      .eq(ENTITY_COLUMN[entityType], entityId)
      .order("created_at", { ascending: false })
      .limit(10)
      .then(({ data }) => {
        setRows((data ?? []).map((r: any) => ({ ...r, status: normalizeEstimateStatus(r.status) })));
        setLoading(false);
      });
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [entityType, entityId]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Estimates</h3>
        <Button
          size="sm" variant="outline" className="h-8 gap-1.5"
          onClick={() => navigate({ to: "/estimates", search: { openNew: true, [SEARCH_PARAM[entityType]]: entityId } as any })}
        >
          <Plus className="h-3.5 w-3.5" /> New estimate
        </Button>
      </div>

      {loading ? (
        <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
          No estimates linked to this {entityLabel}.
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map(e => {
            const tint = ESTIMATE_STATUS_TINT[e.status];
            return (
              <button
                key={e.id}
                onClick={() => navigate({ to: "/estimates", search: { q: e.number ?? undefined } as any })}
                className="flex w-full items-start gap-2.5 rounded-md border border-border p-2.5 text-left hover:bg-secondary/30 transition-colors"
              >
                <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-[13px] font-medium">{e.number ?? "Estimate"}</p>
                    <span className="shrink-0 text-[10px] text-muted-foreground">v{e.version_number}</span>
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">{e.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className={cn("h-4.5 rounded px-1.5 text-[9.5px]", tint.badge)}>{ESTIMATE_STATUS_LABELS[e.status]}</Badge>
                    <span className="text-[10.5px] text-muted-foreground">{formatMoney(e.total)}</span>
                    {e.valid_until && <span className="text-[10.5px] text-muted-foreground">Valid {fmtDate(e.valid_until)}</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
