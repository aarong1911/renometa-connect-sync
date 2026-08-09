// src/components/projects/InvoiceModal.tsx
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";

type LineItem = { description: string; quantity: string; unit_price: string };

type Props = {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  clientId?: string;
  orgId?: string;
  onCreated: () => void;
};

function genInvoiceNumber(): string {
  const now = new Date();
  return `INV-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${Math.floor(Math.random() * 900 + 100)}`;
}

const EMPTY_ITEM: LineItem = { description: "", quantity: "1", unit_price: "" };

export function InvoiceModal({ open, onClose, projectId, clientId, orgId, onCreated }: Props) {
  const [invoiceNumber, setInvoiceNumber] = useState(genInvoiceNumber);
  const [issueDate,     setIssueDate]     = useState(new Date().toISOString().split("T")[0]);
  const [dueDate,       setDueDate]       = useState("");
  const [notes,         setNotes]         = useState("");
  const [items,         setItems]         = useState<LineItem[]>([{ ...EMPTY_ITEM }]);
  const [saving,        setSaving]        = useState(false);
  const [sending,       setSending]       = useState(false);
  const [resolvedOrgId, setResolvedOrgId] = useState<string | null>(orgId ?? null);
  const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? "none");
  const [selectedClientId, setSelectedClientId] = useState(clientId ?? "none");
  const [projects, setProjects] = useState<Array<{ id: string; name: string; client_id?: string | null }>>([]);
  const [contacts, setContacts] = useState<Array<{ id: string; full_name: string }>>([]);

  // Resolve orgId from user profile if not passed as prop
  useEffect(() => {
    if (orgId) { setResolvedOrgId(orgId); return; }
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle()
        .then(({ data }) => { if (data?.organization_id) setResolvedOrgId(data.organization_id); });
    });
  }, [orgId, open]);

  useEffect(() => {
    if (!open || !resolvedOrgId) return;
    Promise.all([
      supabase.from("projects").select("id,name,client_id").eq("org_id", resolvedOrgId).order("name"),
      supabase.from("contacts").select("id,full_name").eq("org_id", resolvedOrgId).order("full_name"),
    ]).then(([projectResult, contactResult]) => {
      setProjects((projectResult.data ?? []) as Array<{ id: string; name: string; client_id?: string | null }>);
      setContacts((contactResult.data ?? []) as Array<{ id: string; full_name: string }>);
    });
  }, [open, resolvedOrgId]);

  useEffect(() => {
    if (projectId) setSelectedProjectId(projectId);
    if (clientId) setSelectedClientId(clientId);
  }, [projectId, clientId, open]);

  const setItem = (i: number, field: keyof LineItem, val: string) =>
    setItems(prev => prev.map((item, idx) => idx === i ? { ...item, [field]: val } : item));
  const addItem    = () => setItems(prev => [...prev, { ...EMPTY_ITEM }]);
  const removeItem = (i: number) => setItems(prev => prev.filter((_, idx) => idx !== i));

  const subtotal = items.reduce((s, item) => {
    return s + (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0);
  }, 0);

  const handleClose = () => {
    setInvoiceNumber(genInvoiceNumber());
    setIssueDate(new Date().toISOString().split("T")[0]);
    setDueDate(""); setNotes("");
    setItems([{ ...EMPTY_ITEM }]);
    setSelectedProjectId(projectId ?? "none");
    setSelectedClientId(clientId ?? "none");
    onClose();
  };

  const handleSave = async (sendAfterCreate: boolean) => {
    if (!issueDate)         { toast.error("Issue date is required"); return; }
    if (subtotal <= 0)      { toast.error("Add at least one line item with a price"); return; }
    if (!resolvedOrgId)     { toast.error("Organization not found"); return; }
    if (sendAfterCreate && selectedClientId === "none") { toast.error("Select a customer before sending — the invoice needs an email to send to."); return; }

    if (sendAfterCreate) setSending(true); else setSaving(true);

    const payload: Record<string, any> = {
      org_id:         resolvedOrgId,
      invoice_number: invoiceNumber,
      issue_date:     issueDate,
      due_date:       dueDate || null,
      status:         "draft",
      subtotal,
      tax_amount:     0,
      total_amount:   subtotal,
      amount_paid:    0,
      notes:          notes || null,
    };
    if (selectedProjectId !== "none") payload.project_id = selectedProjectId;
    if (selectedClientId !== "none") payload.client_id = selectedClientId;

    const { data: inv, error: invErr } = await supabase
      .from("invoices").insert(payload).select("id").single();

    if (invErr) {
      console.error("[InvoiceModal] insert error:", invErr);
      toast.error(`Failed to create invoice: ${invErr.message}`);
      setSaving(false); setSending(false); return;
    }

    // Insert line items
    const lineItems = items
      .filter(i => i.description.trim() && parseFloat(i.unit_price) > 0)
      .map(i => ({
        invoice_id:  inv.id,
        description: i.description.trim(),
        quantity:    parseFloat(i.quantity) || 1,
        unit_price:  parseFloat(i.unit_price) || 0,
        amount:      (parseFloat(i.quantity) || 1) * (parseFloat(i.unit_price) || 0),
      }));

    if (lineItems.length > 0) {
      await supabase.from("invoice_items").insert(lineItems);
    }

    import("@/lib/trigger-workflow").then(({ triggerWorkflow }) => {
      triggerWorkflow("invoice_created", { invoice: { id: inv.id, number: invoiceNumber, amount: subtotal }, projectId: selectedProjectId === "none" ? null : selectedProjectId });
    });

    // "Create & Send" reuses the exact same trusted send path as sending an
    // existing draft (InvoiceDetailModal.tsx's handleSend) — the invoice is
    // created as a draft first (so it always exists even if sending fails),
    // then invoice-send.ts does the email, draft->sent transition, secure
    // public token mint, and invoice-issued accounting entry in one call.
    if (sendAfterCreate) {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) throw new Error("You must be signed in to send an invoice");
        const res = await fetch("/.netlify/functions/invoice-send", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ invoiceId: inv.id }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || "Could not send this invoice");
        toast.success(`Invoice ${invoiceNumber} sent to ${body.recipientEmail ?? "the customer"}`);
      } catch (err) {
        // The invoice itself was created successfully (as a draft) even if
        // sending failed — say so plainly rather than implying total failure.
        toast.error(`Invoice ${invoiceNumber} was created as a draft, but sending failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    } else {
      toast.success(`Invoice ${invoiceNumber} saved as draft`);
    }

    setSaving(false);
    setSending(false);
    onCreated();
    handleClose();
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && handleClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Invoice</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Customer</Label>
              <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select customer" /></SelectTrigger>
                <SelectContent><SelectItem value="none">No customer</SelectItem>{contacts.map(contact => <SelectItem key={contact.id} value={contact.id}>{contact.full_name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Project</Label>
              <Select value={selectedProjectId} onValueChange={(value) => { setSelectedProjectId(value); const project = projects.find(p => p.id === value); if (project?.client_id) setSelectedClientId(project.client_id); }}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select project" /></SelectTrigger>
                <SelectContent><SelectItem value="none">No project</SelectItem>{projects.map(project => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Invoice #</Label>
              <Input className="h-9" value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Issue date <span className="text-destructive">*</span></Label>
              <Input className="h-9" type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">Due date</Label>
              <Input className="h-9" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
            </div>
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs">Line items</Label>
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={addItem}>
                <Plus className="h-3 w-3" />Add item
              </Button>
            </div>
            <div className="space-y-2">
              <div className="grid grid-cols-12 gap-2 text-[10px] text-muted-foreground font-medium px-1">
                <div className="col-span-6">Description</div>
                <div className="col-span-2 text-center">Qty</div>
                <div className="col-span-3">Unit price</div>
                <div className="col-span-1" />
              </div>
              {items.map((item, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  <Input className="h-8 text-xs col-span-6" value={item.description}
                    onChange={e => setItem(i, "description", e.target.value)} placeholder="Description" />
                  <Input className="h-8 text-xs col-span-2 text-center" value={item.quantity}
                    onChange={e => setItem(i, "quantity", e.target.value)} type="number" min="0" step="0.01" />
                  <Input className="h-8 text-xs col-span-3" value={item.unit_price}
                    onChange={e => setItem(i, "unit_price", e.target.value)} type="number" min="0" step="0.01" placeholder="0.00" />
                  <button type="button" onClick={() => removeItem(i)} disabled={items.length === 1}
                    className="col-span-1 text-muted-foreground hover:text-destructive disabled:opacity-30 flex justify-center">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex justify-between items-center border-t border-border mt-3 pt-3">
              <span className="text-xs font-medium text-muted-foreground">Total</span>
              <span className="text-base font-bold tabular-nums">
                {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(subtotal)}
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Notes</Label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Payment terms, instructions…" rows={3}
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={handleClose} disabled={saving || sending}>Cancel</Button>
          <Button variant="outline" size="sm" onClick={() => handleSave(false)} disabled={saving || sending || !resolvedOrgId}>
            {saving ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Saving…</> : "Save as Draft"}
          </Button>
          <Button size="sm" onClick={() => handleSave(true)} disabled={saving || sending || !resolvedOrgId}>
            {sending ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Sending…</> : "Create & Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
