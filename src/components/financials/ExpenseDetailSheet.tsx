// src/components/financials/ExpenseDetailSheet.tsx — Phase 13.9 (Tier 1).
// Read-only detail + the one available correction action: Reverse Expense,
// for a posted, unreversed expense. No editing — posted financial fields
// are immutable at the DB layer (see 20260822's enforce_expense_
// immutability), so this sheet never offers anything but reversal.
import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Undo2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { formatMoney, formatDateOnlyShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { type Expense } from "@/lib/vendors";
import { ReversalReasonDialog } from "@/components/financials/ReversalReasonDialog";

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  posted: "bg-success-soft text-success",
  cancelled: "bg-secondary text-muted-foreground",
  reversed: "bg-destructive-soft text-destructive",
};

type Props = {
  expense: Expense | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
};

export function ExpenseDetailSheet({ expense, open, onClose, onChanged }: Props) {
  const [reverseOpen, setReverseOpen] = useState(false);
  if (!expense) return null;

  const handleReverse = async (reason: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("You must be signed in to do this");
      const res = await fetch("/.netlify/functions/expense-reverse", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ expenseId: expense.id, reason }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not reverse this expense");
      toast.success(body.reversalEntryNumber ? `Expense reversed — ${body.reversalEntryNumber}` : "Expense reversed");
      setReverseOpen(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reverse this expense");
    }
  };

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-base font-semibold">
            {expense.description}
            <Badge className={cn("capitalize", STATUS_STYLES[expense.status])}>{expense.status}</Badge>
          </SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><p className="text-[11px] text-muted-foreground">Amount</p><p className="font-medium tabular-nums">{formatMoney(expense.amount)}</p></div>
            <div><p className="text-[11px] text-muted-foreground">Date</p><p className="font-medium">{formatDateOnlyShort(expense.expenseDate)}</p></div>
            <div><p className="text-[11px] text-muted-foreground">Category</p><p className="font-medium">{expense.accountName}{expense.isCogs && <Badge variant="outline" className="ml-1.5 text-[10px]">Direct cost</Badge>}</p></div>
            <div><p className="text-[11px] text-muted-foreground">Payment method</p><p className="font-medium capitalize">{expense.paymentMethod ?? "—"}</p></div>
            <div><p className="text-[11px] text-muted-foreground">Vendor</p><p className="font-medium">{expense.vendorName}</p></div>
            <div><p className="text-[11px] text-muted-foreground">Project</p><p className="font-medium">{expense.projectName}</p></div>
            {expense.reference && <div><p className="text-[11px] text-muted-foreground">Reference</p><p className="font-medium">{expense.reference}</p></div>}
          </div>

          {expense.status === "reversed" && expense.reversalReason && (
            <div className="rounded-md bg-destructive-soft px-3 py-2 text-[12px] text-destructive">
              <span className="font-medium">Reversed:</span> {expense.reversalReason}
            </div>
          )}

          <div className="flex gap-2 border-t border-border pt-3">
            {expense.status === "posted" && (
              <Button size="sm" variant="outline" onClick={() => setReverseOpen(true)}><Undo2 className="mr-1.5 h-3.5 w-3.5" />Reverse expense</Button>
            )}
            {expense.status === "reversed" && <p className="self-center text-[11px] text-muted-foreground">This expense has been reversed and cannot be modified further.</p>}
          </div>
        </div>
      </SheetContent>

      <ReversalReasonDialog
        open={reverseOpen} onClose={() => setReverseOpen(false)}
        title="Reverse Expense" confirmLabel="Reverse expense"
        description={`This posts a reversing journal entry for the ${formatMoney(expense.amount)} expense "${expense.description}" and marks it Reversed.`}
        onConfirm={handleReverse}
      />
    </Sheet>
  );
}
