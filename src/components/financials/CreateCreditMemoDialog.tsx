// src/components/financials/CreateCreditMemoDialog.tsx — Phase 13.10.
// Always submits through the trusted customer-credit-create Netlify
// function — never writes customer_credit_memos directly from the browser.
// Revenue account is derived server-side from the invoice's own posted
// entry — no account picker here (see netlify/functions/customer-credit-
// create.ts).
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { todayDateOnlyValue } from "@/lib/format";

const CREDIT_REASONS = ["Customer concession", "Invoice adjustment", "Scope reduction", "Billing correction", "Other"];

function money(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}

type Props = {
  open: boolean; onClose: () => void; invoiceId: string; invoiceNumber: string;
  /** Current effective outstanding balance — prefills Amount and caps what the server will accept. */
  balance: number;
  onCreated: () => void;
};

export function CreateCreditMemoDialog({ open, onClose, invoiceId, invoiceNumber, balance, onCreated }: Props) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState(CREDIT_REASONS[0]);
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(todayDateOnlyValue);
  const [saving, setSaving] = useState(false);
  // Phase 13.10A, Part 7/9 — a stable key per dialog "session," regenerated
  // only when the dialog reopens, so a network retry of the SAME submit
  // reuses the SAME key (collapsing into the RPC's idempotency check)
  // while a genuinely new credit memo (dialog closed and reopened) gets a
  // fresh one.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!open) return;
    setAmount(balance > 0 ? balance.toFixed(2) : "");
    setReason(CREDIT_REASONS[0]);
    setDescription("");
    setDate(todayDateOnlyValue());
    setIdempotencyKey(crypto.randomUUID());
  }, [open, balance]);

  const handleSubmit = async () => {
    if (saving) return;
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast.error("Enter a valid credit amount"); return; }
    setSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("You must be signed in to create a credit memo");
      const res = await fetch("/.netlify/functions/customer-credit-create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ invoiceId, amount: amt, reason, description: description || undefined, creditDate: date, idempotencyKey }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not create this credit memo");
      if (body.accountingWarning) toast.warning(body.accountingWarning);
      else toast.success(`Credit memo ${body.creditNumber ?? ""} created for ${invoiceNumber}`.trim());
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create this credit memo");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle className="text-base font-semibold">Create Credit Memo</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Amount</Label>
            <Input className="h-9" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">Current balance: {money(balance)}</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{CREDIT_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Date</Label>
            <Input className="h-9" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Description (optional)</Label>
            <Input className="h-9" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Defaults to the reason" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={handleSubmit} disabled={saving}>
            {saving ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Creating…</> : "Create credit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
