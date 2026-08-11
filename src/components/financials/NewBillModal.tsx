// src/components/financials/NewBillModal.tsx — Phase 13.8, Part 16.
// Always creates a DRAFT bill through vendor-bill-create (server recomputes
// totals authoritatively from the submitted lines). Posting to the ledger
// happens separately from the bill detail view ("Post Bill") — this modal
// never posts.
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { todayDateOnlyValue, formatMoney } from "@/lib/format";
import { type Vendor, type ExpenseCategoryAccount, vendorDisplayName } from "@/lib/vendors";

type LineItem = { description: string; quantity: string; unitCost: string; accountId: string };
const EMPTY_LINE: LineItem = { description: "", quantity: "1", unitCost: "", accountId: "" };

type Props = {
  open: boolean; onClose: () => void; orgId: string | null;
  vendors: Vendor[]; categories: ExpenseCategoryAccount[]; onCreated: () => void;
};

export function NewBillModal({ open, onClose, orgId, vendors, categories, onCreated }: Props) {
  const [vendorId, setVendorId] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [billDate, setBillDate] = useState(todayDateOnlyValue);
  const [dueDate, setDueDate] = useState("");
  const [projectId, setProjectId] = useState("none");
  const [taxAmount, setTaxAmount] = useState("0");
  const [lines, setLines] = useState<LineItem[]>([{ ...EMPTY_LINE }]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !orgId) return;
    supabase.from("projects").select("id,name").eq("org_id", orgId).order("name")
      .then(({ data }) => setProjects((data ?? []) as Array<{ id: string; name: string }>));
  }, [open, orgId]);

  useEffect(() => {
    if (!open) return;
    setVendorId(""); setBillNumber(""); setBillDate(todayDateOnlyValue()); setDueDate(""); setProjectId("none");
    setTaxAmount("0"); setLines([{ ...EMPTY_LINE, accountId: categories[0]?.id ?? "" }]);
  }, [open, categories]);

  const setLine = (i: number, field: keyof LineItem, val: string) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, [field]: val } : l)));
  const addLine = () => setLines((prev) => [...prev, { ...EMPTY_LINE, accountId: categories[0]?.id ?? "" }]);
  const removeLine = (i: number) => setLines((prev) => prev.filter((_, idx) => idx !== i));

  const subtotal = lines.reduce((s, l) => s + (parseFloat(l.quantity) || 0) * (parseFloat(l.unitCost) || 0), 0);
  const tax = parseFloat(taxAmount) || 0;
  const total = subtotal + tax;

  const handleSubmit = async () => {
    if (saving) return;
    if (!vendorId) { toast.error("Vendor is required"); return; }
    if (!billDate) { toast.error("Bill date is required"); return; }
    if (lines.some((l) => !l.description.trim() || !l.accountId || !(parseFloat(l.unitCost) >= 0) || !(parseFloat(l.quantity) > 0))) {
      toast.error("Every line needs a description, category, quantity, and unit cost"); return;
    }
    if (total <= 0) { toast.error("Bill total must be greater than zero"); return; }
    setSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("You must be signed in to create a bill");
      const res = await fetch("/.netlify/functions/vendor-bill-create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          vendorId, billNumber: billNumber || undefined, billDate, dueDate: dueDate || undefined,
          projectId: projectId === "none" ? undefined : projectId, taxAmount: tax,
          lines: lines.map((l) => ({ description: l.description, quantity: parseFloat(l.quantity), unitCost: parseFloat(l.unitCost), accountId: l.accountId })),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not create this bill");
      toast.success("Bill saved as draft");
      onCreated();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create this bill");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle className="text-base font-semibold">New Vendor Bill</DialogTitle></DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Vendor</Label>
              <Select value={vendorId} onValueChange={setVendorId}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select a vendor" /></SelectTrigger>
                <SelectContent>{vendors.filter((v) => v.isActive).map((v) => <SelectItem key={v.id} value={v.id}>{vendorDisplayName(v)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Bill # (supplier's, optional)</Label>
              <Input className="h-9" value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Bill date</Label>
              <Input className="h-9" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Due date (optional)</Label>
              <Input className="h-9" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Project (optional)</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">No project</SelectItem>{projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-border p-3">
            <div className="grid grid-cols-[1fr_70px_90px_1fr_32px] gap-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              <div>Description</div><div>Qty</div><div>Unit cost</div><div>Category</div><div />
            </div>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_70px_90px_1fr_32px] items-center gap-2">
                <Input className="h-8 text-sm" value={l.description} onChange={(e) => setLine(i, "description", e.target.value)} placeholder="Materials" />
                <Input className="h-8 text-sm" type="number" min="0.0001" step="0.01" value={l.quantity} onChange={(e) => setLine(i, "quantity", e.target.value)} />
                <Input className="h-8 text-sm" type="number" min="0" step="0.01" value={l.unitCost} onChange={(e) => setLine(i, "unitCost", e.target.value)} />
                <Select value={l.accountId} onValueChange={(v) => setLine(i, "accountId", v)}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Category" /></SelectTrigger>
                  <SelectContent>{categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.code} · {c.name}</SelectItem>)}</SelectContent>
                </Select>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeLine(i)} disabled={lines.length === 1}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addLine}><Plus className="mr-1 h-3 w-3" />Add line</Button>
          </div>

          <div className="flex items-center justify-end gap-4 border-t border-border pt-3 text-sm">
            <div className="flex items-center gap-2"><span className="text-muted-foreground">Tax</span><Input className="h-8 w-24 text-right text-sm" type="number" min="0" step="0.01" value={taxAmount} onChange={(e) => setTaxAmount(e.target.value)} /></div>
            <div className="flex items-center gap-2"><span className="text-muted-foreground">Subtotal</span><span className="font-medium tabular-nums">{formatMoney(subtotal)}</span></div>
            <div className="flex items-center gap-2"><span className="font-semibold">Total</span><span className="font-semibold tabular-nums">{formatMoney(total)}</span></div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={handleSubmit} disabled={saving}>
            {saving ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Saving…</> : "Save as draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
