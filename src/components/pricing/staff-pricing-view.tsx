// src/components/pricing/staff-pricing-view.tsx
//
// Pricing Intelligence — the STAFF-ONLY suggestion list, shared by the AI Run Inspector and the estimate "Suggest Pricing" panel
// so both render exactly the same thing from the same validated payload (src/lib/pricing/staff-pricing.ts).
//
// It only ever DISPLAYS a suggestion. It has no apply/accept control, never writes anything, and never implies the price was
// written: every suggested row says "Suggested only — not applied." Do not render this on any customer-facing surface.

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { describeStaffPricing, type StaffPricingIntelligence } from "@/lib/pricing/staff-pricing";

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xs">{value}</div>
    </div>
  );
}

export function StaffPricingView({ payload }: { payload: StaffPricingIntelligence }) {
  const pricing = describeStaffPricing(payload);
  if (!pricing.available) return <p className="text-[11px] text-muted-foreground">{pricing.note}</p>;
  return (
    <div className="space-y-2" data-testid="staff-pricing-view">
      {pricing.rows.map((row, i) => (
        <div key={`${row.itemName}-${i}`} className="space-y-1 rounded-md border border-border/60 p-2">
          <div className="text-xs font-medium">{row.itemName}</div>
          {row.status === "suggested" ? (
            <>
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <Field label="Suggested unit price" value={row.price ?? "—"} />
                <Field label="Range" value={row.range ?? "—"} />
                <Field label="Suggested total" value={row.total ?? "—"} />
                <Field label="Confidence" value={<span className="capitalize">{row.confidence ?? "—"}</span>} />
                <Field label="Source" value={row.source ?? "—"} />
                {row.scopeLabel && <Field label="Entry" value={row.scopeLabel} />}
                {row.matchBasis && <Field label="Match" value={row.matchBasis} />}
                {row.reviewState && <Field label="Review" value={row.reviewState} />}
                {row.sampleCount !== null && <Field label="Samples" value={row.sampleCount} />}
                {row.sameProjectTypeCount !== null && <Field label="Same project type" value={row.sameProjectTypeCount} />}
              </div>
              {row.quantityNote && <p className="text-[11px] text-muted-foreground">{row.quantityNote}</p>}
              <p className="text-[11px] font-medium text-muted-foreground">{row.message}</p>
              {row.assumptions.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                  {row.assumptions.map((a, j) => <li key={j}>{a}</li>)}
                </ul>
              )}
              {row.missingInputs.length > 0 && <p className="text-[11px] text-muted-foreground">Missing inputs: {row.missingInputs.join(", ")}</p>}
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">{row.message}</p>
          )}
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground">{pricing.note}</p>
    </div>
  );
}

export function StaffOnlyBadge() {
  return <Badge variant="outline" className="h-5 rounded text-[10px]">Staff only</Badge>;
}
