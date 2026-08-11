// src/components/financials/NewExpenseModal.tsx — Phase 13.8, Part 14.
// Always submits through the trusted expense-create Netlify function —
// never writes `expenses` directly from the browser (financial writes are
// backend-only, see 20260822_expenses_vendors_ap.sql RLS).
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
import { type Vendor, type ExpenseCategoryAccount, vendorDisplayName } from "@/lib/vendors";

const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" }, { value: "check", label: "Check" }, { value: "card", label: "Card" },
  { value: "ach", label: "ACH" }, { value: "bank_transfer", label: "Bank transfer" }, { value: "wire", label: "Wire" }, { value: "other", label: "Other" },
];

type Props = {
  open: boolean; onClose: () => void; orgId: string | null;
  vendors: Vendor[]; categories: ExpenseCategoryAccount[]; onCreated: () => void;
};

export function NewExpenseModal({ open, onClose, orgId, vendors, categories, onCreated }: Props) {
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayDateOnlyValue);
  const [vendorId, setVendorId] = useState("none");
  const [projectId, setProjectId] = useState("none");
  const [accountId, setAccountId] = useState("");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !orgId) return;
    supabase.from("projects").select("id,name").eq("org_id", orgId).order("name")
      .then(({ data }) => setProjects((data ?? []) as Array<{ id: string; name: string }>));
  }, [open, orgId]);

  useEffect(() => {
    if (!open) return;
    setDescription(""); setAmount(""); setDate(todayDateOnlyValue()); setVendorId("none"); setProjectId("none");
    setAccountId(categories[0]?.id ?? ""); setMethod("cash"); setReference(""); setNotes("");
  }, [open, categories]);

  const handleSubmit = async () => {
    if (saving) return;
    const amt = parseFloat(amount);
    if (!description.trim()) { toast.error("Description is required"); return; }
    if (!Number.isFinite(amt) || amt <= 0) { toast.error("Enter a valid amount"); return; }
    if (!accountId) { toast.error("Select a category"); return; }
    setSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("You must be signed in to record an expense");
      const res = await fetch("/.netlify/functions/expense-create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          description, amount: amt, expenseDate: date, accountId, paymentMethod: method,
          vendorId: vendorId === "none" ? undefined : vendorId,
          projectId: projectId === "none" ? undefined : projectId,
          reference: reference || undefined, notes: notes || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not record this expense");
      if (body.accountingWarning) toast.warning(body.accountingWarning);
      else toast.success("Expense recorded");
      onCreated();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record this expense");
    } finally {
      setSaving(false);
    }
  };

  const selectedCategory = categories.find((c) => c.id === accountId);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle className="text-base font-semibold">New Expense</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Description</Label>
            <Input className="h-9" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Lumber and framing materials" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Amount</Label>
              <Input className="h-9" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Date</Label>
              <Input className="h-9" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Category</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select a category" /></SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.code} · {c.name}{c.isCogs ? " (direct cost)" : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedCategory?.isCogs && projectId === "none" && (
              <p className="text-[11px] text-warning-soft-foreground">This is a direct-cost category — consider linking a project so it counts toward that project's COGS.</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Vendor (optional)</Label>
              <Select value={vendorId} onValueChange={setVendorId}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">No vendor</SelectItem>{vendors.filter((v) => v.isActive).map((v) => <SelectItem key={v.id} value={v.id}>{vendorDisplayName(v)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Project (optional)</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">No project</SelectItem>{projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Payment method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{PAYMENT_METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Reference (optional)</Label>
            <Input className="h-9" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Receipt #, order #…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={handleSubmit} disabled={saving}>
            {saving ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Saving…</> : "Add expense"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
