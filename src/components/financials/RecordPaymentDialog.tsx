// src/components/financials/RecordPaymentDialog.tsx
//
// Phase 13.4 follow-up — extracted from InvoiceDetailModal so Main
// Financials' InvoiceDetailsSheet can offer the identical Record Payment
// workflow without a second implementation. Always submits through the
// trusted invoice-record-payment Netlify function — never writes
// invoice_payments directly from the browser.
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { todayDateOnlyValue } from "@/lib/format";

const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "card", label: "Card" },
  { value: "ach", label: "ACH" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "other", label: "Other" },
];

function money(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}

export type RecordPaymentResult = { status: string; amountPaid: number };

type Props = {
  open: boolean;
  onClose: () => void;
  invoiceId: string;
  invoiceNumber: string;
  /** Remaining balance — prefills Amount and caps what the server will accept. */
  balance: number;
  onRecorded: (result: RecordPaymentResult) => void;
};

export function RecordPaymentDialog({ open, onClose, invoiceId, invoiceNumber, balance, onRecorded }: Props) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [date, setDate] = useState(todayDateOnlyValue);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [recording, setRecording] = useState(false);
  // Phase 13.10B, Part 15/29 — one key per submit attempt, reused verbatim
  // on a failed-submit retry (not regenerated until the dialog reopens for
  // a genuinely new logical payment) so a double-click or network retry
  // collapses into the same operational payment instead of creating two.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!open) return;
    setAmount(balance > 0 ? balance.toFixed(2) : "");
    setMethod("cash");
    setDate(todayDateOnlyValue());
    setReference("");
    setNotes("");
    setIdempotencyKey(crypto.randomUUID());
  }, [open, balance]);

  const handleSubmit = async () => {
    if (recording) return;
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast.error("Enter a valid payment amount"); return; }
    // Phase 13.10C, Part 15/42 — `date` is stable form state (set once when
    // the dialog opens/resets, only changed by deliberate user edit — never
    // regenerated from wall-clock time), so re-reading it here on every
    // submit/retry is already deterministic: a failed-submit retry with no
    // user edit in between sends the exact same paidAt both times, closing
    // the loop with the DB's now-mandatory, non-defaulted p_paid_at.
    if (!date) { toast.error("A payment date is required"); return; }
    setRecording(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("You must be signed in to record a payment");
      const res = await fetch("/.netlify/functions/invoice-record-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          invoiceId, amount: amt, method, paidAt: date,
          reference: reference || undefined, notes: notes || undefined, idempotencyKey,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not record this payment");
      toast.success(`Payment of ${money(amt)} recorded for ${invoiceNumber}`);
      onRecorded({ status: body.status, amountPaid: body.amountPaid });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record this payment");
    } finally {
      setRecording(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !recording && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Record Payment</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Amount</Label>
            <Input className="h-9" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">Remaining balance: {money(balance)}</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Payment method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{PAYMENT_METHODS.map(m => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Date</Label>
            <Input className="h-9" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Reference (optional)</Label>
            <Input className="h-9" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Check #, transaction id…" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Notes (optional)</Label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={recording}>Cancel</Button>
          <Button size="sm" onClick={handleSubmit} disabled={recording}>
            {recording ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Recording…</> : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
