// src/components/pricing/suggest-pricing-panel.tsx
//
// Staff-only "Suggest Pricing" for the open estimate. Calls the trusted server function (which resolves the unpriced lines itself
// and reads Price Book -> organization history), then displays the result with the shared StaffPricingView.
//
// READ ONLY: this component has no apply/accept control and never writes to the estimate. Do not render it on any customer-facing
// surface (public proposal, portal). It lives in the internal estimate detail sheet only.

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StaffOnlyBadge, StaffPricingView } from "@/components/pricing/staff-pricing-view";
import { suggestEstimatePricing, type SuggestPricingResponse } from "@/lib/price-book-api";

export function SuggestPricingPanel({ estimateId }: { estimateId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SuggestPricingResponse | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      setResult(await suggestEstimatePricing(estimateId));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : "Could not calculate pricing suggestions.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="suggest-pricing-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold">Pricing suggestions</span>
          <StaffOnlyBadge />
        </div>
        <Button type="button" size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {result ? "Refresh" : "Suggest Pricing"}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {result?.kind === "all_priced" && <p className="text-xs text-muted-foreground">{result.message}</p>}
      {result?.kind === "suggestions" && (
        <>
          <StaffPricingView payload={result.pricing} />
          {result.capped && <p className="text-[11px] text-muted-foreground">Only the first {result.requestedItems} unpriced lines were checked.</p>}
        </>
      )}
      {!result && !error && !loading && (
        <p className="text-[11px] text-muted-foreground">Suggests prices for unpriced lines from your Price Book or past estimates. Nothing is applied to the estimate.</p>
      )}
    </div>
  );
}
