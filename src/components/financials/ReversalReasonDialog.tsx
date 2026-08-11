// src/components/financials/ReversalReasonDialog.tsx — Phase 13.9 (Tier 1).
// Shared confirm-with-reason dialog for every financial reversal action
// (expense, vendor bill, vendor payment) — one place for the "a reason is
// required" UX instead of three ad hoc copies (Part 40: "Do not allow blank
// generic reversal").
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, AlertTriangle } from "lucide-react";

const REASON_PRESETS = [
  "Duplicate entry", "Wrong vendor", "Wrong amount", "Entered twice",
  "Wrong category", "Customer/vendor correction", "Other",
];

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: (reason: string) => Promise<void>;
};

export function ReversalReasonDialog({ open, onClose, title, description, confirmLabel = "Reverse", onConfirm }: Props) {
  const [preset, setPreset] = useState(REASON_PRESETS[0]);
  const [customReason, setCustomReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreset(REASON_PRESETS[0]);
    setCustomReason("");
  }, [open]);

  const reason = preset === "Other" ? customReason.trim() : preset;

  const handleSubmit = async () => {
    if (submitting) return;
    if (!reason) { return; }
    setSubmitting(true);
    try {
      await onConfirm(reason);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !submitting && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold"><AlertTriangle className="h-4 w-4 text-warning-soft-foreground" />{title}</DialogTitle>
          <DialogDescription className="text-[13px]">{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Reason</Label>
            <div className="flex flex-wrap gap-1.5">
              {REASON_PRESETS.map((p) => (
                <button key={p} type="button" onClick={() => setPreset(p)}
                  className={`rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors ${preset === p ? "border-primary bg-primary-soft text-primary" : "border-border text-muted-foreground hover:bg-secondary"}`}>
                  {p}
                </button>
              ))}
            </div>
            {preset === "Other" && (
              <textarea value={customReason} onChange={(e) => setCustomReason(e.target.value)} rows={2} autoFocus
                placeholder="Describe why this is being reversed…"
                className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring" />
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">This posts a new, permanent correcting entry to the ledger — it does not delete or edit the original record.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button size="sm" variant="destructive" onClick={handleSubmit} disabled={submitting || !reason}>
            {submitting ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Reversing…</> : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
