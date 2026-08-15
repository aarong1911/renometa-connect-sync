// src/components/financials/RefundDialog.tsx — Phase 13.11.
// Full/partial Stripe refund confirmation. Distinct from
// ReversalReasonDialog (Phase 13.9) — a refund moves real money back
// through Stripe and has an amount to choose; a reversal is a fixed-amount
// accounting-only correction with no amount input at all.
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Undo2 } from "lucide-react";

function money(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}

type Props = {
  open: boolean;
  onClose: () => void;
  originalAmount: number;
  refundableAmount: number;
  onConfirm: (amount: number, reason: string) => Promise<void>;
};

export function RefundDialog({ open, onClose, originalAmount, refundableAmount, onConfirm }: Props) {
  const [amountInput, setAmountInput] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmountInput(refundableAmount.toFixed(2));
    setReason("");
  }, [open, refundableAmount]);

  const amount = Number(amountInput);
  const isFull = Math.abs(amount - refundableAmount) < 0.005;
  const valid = Number.isFinite(amount) && amount > 0 && amount <= refundableAmount + 0.005;

  const handleSubmit = async () => {
    if (submitting || !valid) return;
    setSubmitting(true);
    try {
      await onConfirm(Math.round(amount * 100) / 100, reason.trim());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !submitting && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <Undo2 className="h-4 w-4 text-destructive" />
            Refund payment
          </DialogTitle>
          <DialogDescription className="text-[13px]">
            This sends a real refund through Stripe for the amount below. Original payment {money(originalAmount)} · refundable {money(refundableAmount)}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Refund amount</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number" min={0.01} max={refundableAmount} step={0.01}
                value={amountInput} onChange={(e) => setAmountInput(e.target.value)}
                className="h-8 text-sm"
              />
              {!isFull && (
                <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 px-2 text-[11px]" onClick={() => setAmountInput(refundableAmount.toFixed(2))}>
                  Full refund
                </Button>
              )}
            </div>
            {!valid && amountInput !== "" && (
              <p className="text-[11px] text-destructive">Enter an amount between $0.01 and {money(refundableAmount)}.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Reason (optional)</Label>
            <textarea
              value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
              placeholder="Describe why this is being refunded…"
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">Refunds can take a few days to appear on the customer's statement. This cannot be undone once submitted.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button size="sm" variant="destructive" onClick={handleSubmit} disabled={submitting || !valid}>
            {submitting ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Refunding…</> : isFull ? "Refund full amount" : "Refund partial amount"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
