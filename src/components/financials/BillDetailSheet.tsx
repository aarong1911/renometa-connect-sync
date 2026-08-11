// src/components/financials/BillDetailSheet.tsx — Phase 13.8, Part 17.
// Draft bills: Post Bill (draft -> open, posts Dr expense/COGS Cr A/P).
// Open/partial bills: Record Payment (Dr A/P Cr bank/card). Once posted,
// financial fields are immutable at the DB layer (Part 18) — this sheet
// never offers editing line items/totals on a non-draft bill.
import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Send, CreditCard, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { formatMoney, formatDateOnlyShort, todayDateOnlyValue } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  fetchVendorBillLines, fetchVendorPaymentsForBill, getVendorBillEffectiveBalance,
  type VendorBill, type VendorBillLine, type VendorPayment,
} from "@/lib/vendors";
import { ReversalReasonDialog } from "@/components/financials/ReversalReasonDialog";

const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" }, { value: "check", label: "Check" }, { value: "card", label: "Card" },
  { value: "ach", label: "ACH" }, { value: "bank_transfer", label: "Bank transfer" }, { value: "wire", label: "Wire" }, { value: "other", label: "Other" },
];

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  open: "bg-info-soft text-info",
  partial: "bg-warning-soft text-warning-soft-foreground",
  paid: "bg-success-soft text-success",
  overdue: "bg-destructive-soft text-destructive",
  cancelled: "bg-secondary text-muted-foreground",
  reversed: "bg-destructive-soft text-destructive",
};

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("You must be signed in to do this");
  return { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` };
}

type Props = {
  bill: VendorBill | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
};

export function BillDetailSheet({ bill, open, onClose, onChanged }: Props) {
  const [lines, setLines] = useState<VendorBillLine[]>([]);
  const [payments, setPayments] = useState<VendorPayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [reverseBillOpen, setReverseBillOpen] = useState(false);
  const [reversingPaymentId, setReversingPaymentId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !bill) return;
    setLoading(true);
    Promise.all([fetchVendorBillLines(bill.id), fetchVendorPaymentsForBill(bill.id)])
      .then(([l, p]) => { setLines(l); setPayments(p); })
      .finally(() => setLoading(false));
  }, [open, bill?.id]);

  if (!bill) return null;
  const balance = getVendorBillEffectiveBalance(bill);

  const handlePost = async () => {
    if (posting) return;
    setPosting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("You must be signed in to post this bill");
      const res = await fetch("/.netlify/functions/vendor-bill-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ billId: bill.id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not post this bill");
      toast.success("Bill posted to the ledger");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not post this bill");
    } finally {
      setPosting(false);
    }
  };

  const handleReverseBill = async (reason: string) => {
    try {
      const headers = await authHeader();
      const res = await fetch("/.netlify/functions/vendor-bill-reverse", {
        method: "POST", headers, body: JSON.stringify({ billId: bill.id, reason }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not reverse this bill");
      toast.success(body.reversalEntryNumber ? `Bill reversed — ${body.reversalEntryNumber}` : "Bill reversed");
      setReverseBillOpen(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reverse this bill");
    }
  };

  const handleReversePayment = async (paymentId: string, reason: string) => {
    try {
      const headers = await authHeader();
      const res = await fetch("/.netlify/functions/vendor-payment-reverse", {
        method: "POST", headers, body: JSON.stringify({ paymentId, reason }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not reverse this payment");
      if (body.accountingWarning) toast.warning(body.accountingWarning);
      else toast.success("Payment reversed");
      setReversingPaymentId(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reverse this payment");
    }
  };

  const reversingPayment = payments.find((p) => p.id === reversingPaymentId) ?? null;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-base font-semibold">
            {bill.billNumber ?? "Bill (no number)"}
            <Badge className={cn("capitalize", STATUS_STYLES[bill.status])}>{bill.status}</Badge>
          </SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><p className="text-[11px] text-muted-foreground">Vendor</p><p className="font-medium">{bill.vendorName}</p></div>
            <div><p className="text-[11px] text-muted-foreground">Project</p><p className="font-medium">{bill.projectName}</p></div>
            <div><p className="text-[11px] text-muted-foreground">Bill date</p><p className="font-medium">{formatDateOnlyShort(bill.billDate)}</p></div>
            <div><p className="text-[11px] text-muted-foreground">Due date</p><p className="font-medium">{bill.dueDate ? formatDateOnlyShort(bill.dueDate) : "—"}</p></div>
          </div>

          <div className="rounded-lg border border-border">
            <div className="grid grid-cols-[1fr_70px_90px_90px] gap-2 border-b border-border bg-secondary/40 px-3 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              <div>Description</div><div>Qty</div><div className="text-right">Unit</div><div className="text-right">Amount</div>
            </div>
            {loading ? (
              <div className="p-4 text-center text-sm text-muted-foreground">Loading…</div>
            ) : (
              <ul className="divide-y divide-border">
                {lines.map((l) => (
                  <li key={l.id} className="grid grid-cols-[1fr_70px_90px_90px] gap-2 px-3 py-2 text-[13px]">
                    <div><p className="font-medium">{l.description}</p><p className="text-[11px] text-muted-foreground">{l.accountName}</p></div>
                    <div className="tabular-nums">{l.quantity}</div>
                    <div className="text-right tabular-nums">{formatMoney(l.unitCost)}</div>
                    <div className="text-right font-medium tabular-nums">{formatMoney(l.amount)}</div>
                  </li>
                ))}
              </ul>
            )}
            <div className="space-y-1 border-t border-border px-3 py-2 text-[13px]">
              <div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span className="tabular-nums">{formatMoney(bill.subtotal)}</span></div>
              <div className="flex justify-between text-muted-foreground"><span>Tax</span><span className="tabular-nums">{formatMoney(bill.taxAmount)}</span></div>
              <div className="flex justify-between font-semibold"><span>Total</span><span className="tabular-nums">{formatMoney(bill.totalAmount)}</span></div>
              {bill.status !== "draft" && (
                <>
                  <div className="flex justify-between text-success"><span>Paid</span><span className="tabular-nums">{formatMoney(bill.amountPaid)}</span></div>
                  <div className="flex justify-between font-semibold"><span>Balance</span><span className="tabular-nums">{formatMoney(balance)}</span></div>
                </>
              )}
            </div>
          </div>

          {bill.status === "reversed" && bill.reversalReason && (
            <div className="rounded-md bg-destructive-soft px-3 py-2 text-[12px] text-destructive">
              <span className="font-medium">Reversed:</span> {bill.reversalReason}
            </div>
          )}

          {payments.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Payments</p>
              <ul className="space-y-1.5">
                {payments.map((p) => {
                  const isReversal = Boolean(p.reversesPaymentId);
                  const canReverse = p.status === "succeeded" && !isReversal && !p.isReversed;
                  return (
                    <li key={p.id} className={cn("rounded-md px-3 py-2 text-[12.5px]", isReversal ? "bg-destructive-soft/60" : "bg-secondary/40")}>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">
                          {formatDateOnlyShort(p.paidAt)} · {p.paymentMethod}
                          {isReversal && <Badge variant="outline" className="ml-1.5 text-[10px]">Reversal</Badge>}
                          {p.isReversed && <Badge variant="outline" className="ml-1.5 text-[10px]">Reversed</Badge>}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className={cn("font-medium tabular-nums", isReversal && "text-destructive")}>{isReversal ? "−" : ""}{formatMoney(p.amount)}</span>
                          {canReverse && (
                            <button title="Reverse this payment" onClick={() => setReversingPaymentId(p.id)} className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-destructive">
                              <Undo2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                      {p.reversalReason && <p className="mt-0.5 text-[11px] text-muted-foreground">Reason: {p.reversalReason}</p>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            {bill.status === "draft" && (
              <Button size="sm" onClick={handlePost} disabled={posting}>
                {posting ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Posting…</> : <><Send className="mr-1.5 h-3.5 w-3.5" />Post bill</>}
              </Button>
            )}
            {(bill.status === "open" || bill.status === "partial" || bill.status === "overdue") && (
              <Button size="sm" onClick={() => setPayOpen(true)}><CreditCard className="mr-1.5 h-3.5 w-3.5" />Record payment</Button>
            )}
            {bill.status === "open" && bill.amountPaid === 0 && (
              <Button size="sm" variant="outline" onClick={() => setReverseBillOpen(true)}><Undo2 className="mr-1.5 h-3.5 w-3.5" />Reverse bill</Button>
            )}
            {(bill.status === "partial" || bill.status === "paid") && (
              <p className="self-center text-[11px] text-muted-foreground">Reverse vendor payments first before reversing this bill.</p>
            )}
            {bill.status === "draft" && <p className="self-center text-[11px] text-muted-foreground">Draft — no accounting entry yet.</p>}
          </div>
        </div>
      </SheetContent>

      <RecordBillPaymentDialog open={payOpen} onClose={() => setPayOpen(false)} bill={bill} balance={balance} onRecorded={() => { setPayOpen(false); onChanged(); }} />

      <ReversalReasonDialog
        open={reverseBillOpen} onClose={() => setReverseBillOpen(false)}
        title="Reverse Bill" confirmLabel="Reverse bill"
        description={`This posts a reversing journal entry for ${bill.billNumber ?? "this bill"} and marks it Reversed. It will no longer count toward A/P.`}
        onConfirm={handleReverseBill}
      />
      <ReversalReasonDialog
        open={Boolean(reversingPayment)} onClose={() => setReversingPaymentId(null)}
        title="Reverse Payment" confirmLabel="Reverse payment"
        description={reversingPayment ? `This posts a reversing entry for the ${formatMoney(reversingPayment.amount)} payment made ${formatDateOnlyShort(reversingPayment.paidAt)}. The bill's balance will increase accordingly.` : ""}
        onConfirm={(reason) => reversingPayment ? handleReversePayment(reversingPayment.id, reason) : Promise.resolve()}
      />
    </Sheet>
  );
}

function RecordBillPaymentDialog({ open, onClose, bill, balance, onRecorded }: {
  open: boolean; onClose: () => void; bill: VendorBill; balance: number; onRecorded: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [date, setDate] = useState(todayDateOnlyValue);
  const [reference, setReference] = useState("");
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmount(balance > 0 ? balance.toFixed(2) : "");
    setMethod("cash"); setDate(todayDateOnlyValue()); setReference("");
  }, [open, balance]);

  const handleSubmit = async () => {
    if (recording) return;
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast.error("Enter a valid payment amount"); return; }
    setRecording(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("You must be signed in to record a payment");
      const res = await fetch("/.netlify/functions/vendor-bill-record-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ billId: bill.id, amount: amt, method, paidAt: date, reference: reference || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not record this payment");
      if (body.accountingWarning) toast.warning(body.accountingWarning);
      else toast.success(`Payment of ${formatMoney(amt)} recorded`);
      onRecorded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record this payment");
    } finally {
      setRecording(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !recording && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle className="text-base font-semibold">Record Payment</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Amount</Label>
            <Input className="h-9" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">Remaining balance: {formatMoney(balance)}</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Payment method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{PAYMENT_METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
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
