// src/components/projects/ChangeOrderFormDrawer.tsx
//
// Phase 13.3B — full Change Order editor/viewer drawer. Handles draft
// editing (overview/line items/pricing/schedule/message/notes), the
// customer-safe preview (via toPortalChangeOrder — the same projection the
// future Portal will render), send/resend, and every lifecycle status
// action from Part 27. Line item edits persist immediately per-row so the
// totals shown are always the server-recalculated authoritative values,
// never a locally-guessed number.

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Loader2, Plus, Trash2, Send, CheckCircle2, Undo2, Ban, Copy, FileText,
  ArrowUpCircle, ClipboardCheck, ExternalLink,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";

import { ChangeOrderStatusBadge } from "@/components/projects/ChangeOrderStatusBadge";
import {
  CHANGE_ORDER_ITEM_TYPE_LABELS, CHANGE_ORDER_ITEM_TYPE_ORDER,
  CHANGE_ORDER_DISCOUNT_TYPE_LABELS, CHANGE_ORDER_MARKUP_TYPE_LABELS,
  CHANGE_ORDER_APPROVAL_ACTION_LABELS,
  isChangeOrderDirectlyEditable,
  type ChangeOrderItemType,
} from "@/lib/change-order-status";
import {
  fetchChangeOrderItems, fetchChangeOrderApprovals, updateChangeOrder, deleteChangeOrderDraft,
  markChangeOrderReady, returnChangeOrderToDraft, cancelChangeOrder, createChangeOrderRevision,
  upsertChangeOrderItem, deleteChangeOrderItem, applyChangeOrderScheduleImpact,
  toPortalChangeOrder, fetchProjectChangeOrders, fetchEffectiveChangeOrderLineages, latestVersionByLineage,
  type ChangeOrder, type ChangeOrderLineItem, type ChangeOrderApproval, type EffectiveChangeOrderLineage,
} from "@/lib/project-change-orders";
import { sendChangeOrderForApproval } from "@/lib/change-order-approvals";
import { checkChangeOrderPermission } from "@/lib/change-order-permissions";
import { getOrgId } from "@/lib/contacts-store";
import { supabase } from "@/lib/supabase";

function currency(n: number, code = "USD"): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}${new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(Math.abs(n))}`;
}

function newLocalItem(position: number): Partial<ChangeOrderLineItem> & { _localId: string } {
  return {
    _localId: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    position, itemType: "service", name: "", quantity: 1, unitPrice: 0, taxable: true,
  };
}

type Props = {
  changeOrderId: string | null;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
};

export function ChangeOrderFormDrawer({ changeOrderId, projectId, open, onOpenChange, onChanged }: Props) {
  const [co, setCo] = useState<ChangeOrder | null>(null);
  const [items, setItems] = useState<ChangeOrderLineItem[]>([]);
  const [approvals, setApprovals] = useState<ChangeOrderApproval[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("overview");
  const [canEdit, setCanEdit] = useState(false);
  // Live-typing text for the Unit price field, keyed by item id — kept
  // separate from ChangeOrderLineItem.unitPrice (a number) so intermediate
  // typing states ("-", "-2", "200.") never have to round-trip through
  // Number() and risk becoming NaN mid-keystroke.
  const [unitPriceDrafts, setUnitPriceDrafts] = useState<Record<string, string>>({});
  const unitPriceSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const orgId = await getOrgId();
      if (!user || !orgId) return;
      const allowed = await checkChangeOrderPermission(supabase, user.id, orgId, "send");
      if (!cancelled) setCanEdit(allowed);
    })();
    return () => { cancelled = true; };
  }, []);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [reason, setReason] = useState("");
  const [customerMessage, setCustomerMessage] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [scheduleImpactDays, setScheduleImpactDays] = useState(0);
  const [proposedStartDate, setProposedStartDate] = useState("");
  const [proposedCompletionDate, setProposedCompletionDate] = useState("");
  const [approvalDueAt, setApprovalDueAt] = useState("");
  const [isFieldVisible, setIsFieldVisible] = useState(false);
  const [discountType, setDiscountType] = useState<"percentage" | "fixed" | "none">("none");
  const [discountValue, setDiscountValue] = useState(0);
  const [markupType, setMarkupType] = useState<"percentage" | "fixed" | "none">("none");
  const [markupValue, setMarkupValue] = useState(0);
  const [taxRate, setTaxRate] = useState(0);

  const editable = co ? isChangeOrderDirectlyEditable(co.status) : false;

  // Document version vs. financial effectiveness (same read-only lookup as
  // ChangeOrdersTab — see fetchEffectiveChangeOrderLineages()'s doc comment
  // for why these can diverge). No ledger change; display only.
  const [effectiveLineage, setEffectiveLineage] = useState<EffectiveChangeOrderLineage | undefined>(undefined);
  const [latestVersionInLineage, setLatestVersionInLineage] = useState<number | undefined>(undefined);

  async function load() {
    if (!changeOrderId) return;
    setLoading(true);
    try {
      const [all, coItems, coApprovals, lineages] = await Promise.all([
        fetchProjectChangeOrders(projectId),
        fetchChangeOrderItems(changeOrderId),
        fetchChangeOrderApprovals(changeOrderId),
        fetchEffectiveChangeOrderLineages(projectId),
      ]);
      const found = all.find((c) => c.id === changeOrderId) ?? null;
      setCo(found);
      setItems(coItems);
      setApprovals(coApprovals);
      if (found) {
        setEffectiveLineage(lineages.get(found.changeOrderNumber));
        setLatestVersionInLineage(latestVersionByLineage(all).get(found.changeOrderNumber));
        setTitle(found.title);
        setDescription(found.description ?? "");
        setReason(found.reason ?? "");
        setCustomerMessage(found.customerMessage ?? "");
        setInternalNotes(found.internalNotes ?? "");
        setScheduleImpactDays(found.scheduleImpactDays);
        setProposedStartDate(found.proposedStartDate ?? "");
        setProposedCompletionDate(found.proposedCompletionDate ?? "");
        setApprovalDueAt(found.approvalDueAt ? found.approvalDueAt.slice(0, 10) : "");
        setIsFieldVisible(found.isFieldVisible);
        setDiscountType(found.discountType ?? "none");
        setDiscountValue(found.discountValue ?? 0);
        setMarkupType(found.markupType ?? "none");
        setMarkupValue(found.markupValue ?? 0);
        setTaxRate(found.taxRate);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load this Change Order");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && changeOrderId) { setTab("overview"); setUnitPriceDrafts({}); void load(); }
    if (!open) { setCo(null); setItems([]); setApprovals([]); setUnitPriceDrafts({}); setEffectiveLineage(undefined); setLatestVersionInLineage(undefined); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, changeOrderId]);

  async function refreshTotals() {
    if (!co) return;
    try {
      const updated = await updateChangeOrder(co.id, {});
      setCo(updated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not recalculate totals");
    }
  }

  async function saveOverview() {
    if (!co) return;
    setBusy(true);
    try {
      const updated = await updateChangeOrder(co.id, { title, description: description || null, reason: reason || null });
      setCo(updated);
      toast.success("Saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function saveMessages() {
    if (!co) return;
    setBusy(true);
    try {
      const updated = await updateChangeOrder(co.id, { customerMessage: customerMessage || null, internalNotes: internalNotes || null });
      setCo(updated);
      toast.success("Saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function savePricing() {
    if (!co) return;
    setBusy(true);
    try {
      const updated = await updateChangeOrder(co.id, {
        discountType: discountType === "none" ? null : discountType,
        discountValue: discountType === "none" ? null : discountValue,
        markupType: markupType === "none" ? null : markupType,
        markupValue: markupType === "none" ? null : markupValue,
        taxRate,
      });
      setCo(updated);
      toast.success("Pricing updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update pricing");
    } finally {
      setBusy(false);
    }
  }

  async function saveSchedule() {
    if (!co) return;
    setBusy(true);
    try {
      const updated = await updateChangeOrder(co.id, {
        scheduleImpactDays, proposedStartDate: proposedStartDate || null,
        proposedCompletionDate: proposedCompletionDate || null,
        approvalDueAt: approvalDueAt ? new Date(approvalDueAt).toISOString() : null,
        isFieldVisible,
      });
      setCo(updated);
      toast.success("Schedule impact saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save schedule impact");
    } finally {
      setBusy(false);
    }
  }

  async function addItem() {
    if (!co) return;
    const draft = newLocalItem(items.length);
    try {
      const saved = await upsertChangeOrderItem({
        changeOrderId: co.id, projectId, position: draft.position!, itemType: draft.itemType as ChangeOrderItemType,
        name: "New item", quantity: 1, unitPrice: 0, taxable: true,
      });
      setItems((prev) => [...prev, saved]);
      await refreshTotals();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add item");
    }
  }

  async function saveItem(item: ChangeOrderLineItem) {
    if (!co) return;
    try {
      const saved = await upsertChangeOrderItem({
        id: item.id, changeOrderId: co.id, projectId, position: item.position, itemType: item.itemType,
        name: item.name, description: item.description, quantity: item.quantity, unit: item.unit,
        unitPrice: item.unitPrice, taxable: item.taxable,
      });
      setItems((prev) => prev.map((i) => (i.id === item.id ? saved : i)));
      await refreshTotals();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save item");
    }
  }

  async function removeItem(id: string) {
    try {
      await deleteChangeOrderItem(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
      clearTimeout(unitPriceSaveTimers.current[id]);
      delete unitPriceSaveTimers.current[id];
      setUnitPriceDrafts((d) => { const next = { ...d }; delete next[id]; return next; });
      await refreshTotals();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove item");
    }
  }

  function updateLocalItem(id: string, patch: Partial<ChangeOrderLineItem>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }

  /**
   * Unit price uses DecimalInput (text + inputMode="decimal"), which
   * reports every keystroke including intermediate, not-yet-numeric
   * states ("-", "-2", "200."). Those only update the draft text and the
   * live line-total preview; a save is scheduled (debounced, not fired on
   * every keystroke) only once the text parses to a real, finite number
   * -- avoiding both a flood of network calls while typing "-200.57" one
   * character at a time, and the stale-closure risk of trying to detect
   * "blur" separately from DecimalInput's own built-in blur handling.
   */
  function handleUnitPriceChange(item: ChangeOrderLineItem, next: string) {
    setUnitPriceDrafts((d) => ({ ...d, [item.id]: next }));
    const parsed = Number(next);
    if (next === "" || next === "-" || !Number.isFinite(parsed)) return;

    updateLocalItem(item.id, { unitPrice: parsed });

    clearTimeout(unitPriceSaveTimers.current[item.id]);
    unitPriceSaveTimers.current[item.id] = setTimeout(() => {
      void saveItem({ ...item, unitPrice: parsed });
    }, 500);
  }

  async function handleMarkReady() {
    if (!co) return;
    if (items.length === 0) { toast.error("Add at least one line item, or explain a zero-value Change Order in Description, before marking ready."); return; }
    setBusy(true);
    try {
      const updated = await markChangeOrderReady(co.id);
      setCo(updated);
      onChanged();
      toast.success("Marked ready to send");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not mark ready");
    } finally {
      setBusy(false);
    }
  }

  async function handleReturnToDraft() {
    if (!co) return;
    setBusy(true);
    try {
      const updated = await returnChangeOrderToDraft(co.id);
      setCo(updated);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not return to draft");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!co) return;
    setBusy(true);
    try {
      await deleteChangeOrderDraft(co.id);
      onChanged();
      onOpenChange(false);
      toast.success("Draft deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete draft");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!co) return;
    setBusy(true);
    try {
      const updated = await cancelChangeOrder(co.id);
      setCo(updated);
      onChanged();
      toast.success("Change Order cancelled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not cancel");
    } finally {
      setBusy(false);
    }
  }

  async function handleSend(isResend: boolean) {
    if (!co) return;
    setBusy(true);
    try {
      const result = await sendChangeOrderForApproval(co.id);
      await navigator.clipboard.writeText(result.approvalUrl).catch(() => {});
      toast.success(
        isResend
          ? `Approval link copied${result.emailDelivered ? " and resent by email" : ""}`
          : `Sent${result.emailDelivered ? " by email" : ""} — approval link copied to clipboard`,
      );
      if (!result.emailDelivered && result.recipientEmail) {
        toast.warning("Email delivery failed — share the copied link with the customer directly.");
      }
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send this Change Order");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateRevision() {
    if (!co) return;
    setBusy(true);
    try {
      const revision = await createChangeOrderRevision(co.id);
      onChanged();
      toast.success(`Revision ${revision.changeOrderNumber} · v${revision.version} created`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create a revision");
    } finally {
      setBusy(false);
    }
  }

  async function handleApplyScheduleImpact() {
    if (!co || !co.proposedCompletionDate) return;
    setBusy(true);
    try {
      const updated = await applyChangeOrderScheduleImpact(co.id, co.proposedCompletionDate);
      setCo(updated);
      onChanged();
      toast.success("Project target completion date updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not apply schedule impact");
    } finally {
      setBusy(false);
    }
  }

  const portalPreview = useMemo(() => (co ? toPortalChangeOrder(co, items) : null), [co, items]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        {loading || !co ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <SheetHeader className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <SheetTitle className="text-lg">{co.changeOrderNumber} · {co.title || "Untitled"}</SheetTitle>
                <ChangeOrderStatusBadge status={co.status} />
                {co.version > 1 && <Badge variant="secondary">v{co.version}</Badge>}
              </div>
              <SheetDescription>{currency(co.totalAmount, co.currency)} total{co.scheduleImpactDays !== 0 ? ` · ${co.scheduleImpactDays > 0 ? "+" : ""}${co.scheduleImpactDays}d schedule impact` : ""}</SheetDescription>
            </SheetHeader>

            {/* Document version vs. financial effectiveness (Part 6/7) —
                ledger untouched, this only clarifies what the status badge
                alone can't: a "Superseded" document can still be the
                active contract amount, and a rejected latest revision
                doesn't mean the lineage lost its approved amount. */}
            {co.status === "superseded" && effectiveLineage?.changeOrderId === co.id && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-500/10 dark:text-emerald-300">
                This version was replaced for approval, but its approved amount ({currency(effectiveLineage.amount, co.currency)}) is still the currently effective contract amount for this Change Order — the replacement revision was not approved.
              </div>
            )}
            {co.version === latestVersionInLineage && effectiveLineage && effectiveLineage.changeOrderId !== co.id &&
              (co.status === "rejected" || co.status === "cancelled" || co.status === "expired") && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-500/10 dark:text-amber-300">
                This revision did not result in an approval. The current approved contract amount for this Change Order is still v{effectiveLineage.version} · {currency(effectiveLineage.amount, co.currency)}.
              </div>
            )}

            <Tabs value={tab} onValueChange={setTab} className="mt-4">
              {/* Same visual language as the Project-level tab bar
                  (projects.index.tsx SHEET_TABS: neutral bordered chip,
                  cream active state) rather than the shadcn Tabs default
                  (bg-muted pill container + floating white-active-chip) --
                  scaled down (h-8, smaller padding/text) since this bar
                  sits inside a drawer, not a full page header. The
                  bg-transparent/p-0/gap-1.5 on TabsList strips the default
                  pill-container chrome so only the per-trigger chip style
                  shows. */}
              <TabsList className="h-auto w-full flex-wrap justify-start gap-1.5 bg-transparent p-0">
                {[
                  { value: "overview", label: "Overview" },
                  { value: "items", label: "Line Items" },
                  { value: "pricing", label: "Pricing" },
                  { value: "schedule", label: "Schedule" },
                  { value: "message", label: "Message & Notes" },
                  { value: "preview", label: "Customer Preview" },
                  ...(co.status !== "draft" ? [{ value: "history", label: "History" }] : []),
                ].map((t) => (
                  <TabsTrigger
                    key={t.value}
                    value={t.value}
                    className="h-8 whitespace-nowrap rounded-md border border-border bg-white px-3 text-xs font-medium text-muted-foreground shadow-none transition-colors hover:bg-muted/50 hover:text-foreground
                      data-[state=active]:border-[#EADFC8] data-[state=active]:bg-[#FAF3E4] data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                  >
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="overview" className="space-y-3 pt-4">
                <div className="space-y-1.5">
                  <Label>Title</Label>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={!editable} />
                </div>
                <div className="space-y-1.5">
                  <Label>Customer-facing scope description</Label>
                  <Textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={!editable} rows={4} placeholder="What's changing in the Project scope, in customer-safe language" />
                </div>
                <div className="space-y-1.5">
                  <Label>Internal reason (not shown to customer)</Label>
                  <Textarea value={reason} onChange={(e) => setReason(e.target.value)} disabled={!editable} rows={2} />
                </div>
                {editable && <Button size="sm" onClick={saveOverview} disabled={busy}>Save</Button>}
              </TabsContent>

              <TabsContent value="items" className="space-y-3 pt-4">
                <div className="space-y-2">
                  {items.map((item) => (
                    <Card key={item.id} className="p-3">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-12 sm:items-end">
                        <div className="sm:col-span-3 space-y-1">
                          <Label className="text-xs">Name</Label>
                          <Input value={item.name} disabled={!editable} onChange={(e) => updateLocalItem(item.id, { name: e.target.value })} onBlur={() => saveItem(items.find((i) => i.id === item.id)!)} />
                        </div>
                        <div className="sm:col-span-2 space-y-1">
                          <Label className="text-xs">Type</Label>
                          <Select value={item.itemType} disabled={!editable} onValueChange={(v) => { updateLocalItem(item.id, { itemType: v as ChangeOrderItemType }); void saveItem({ ...item, itemType: v as ChangeOrderItemType }); }}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {CHANGE_ORDER_ITEM_TYPE_ORDER.map((t) => <SelectItem key={t} value={t}>{CHANGE_ORDER_ITEM_TYPE_LABELS[t]}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="sm:col-span-1 space-y-1">
                          <Label className="text-xs">Qty</Label>
                          <Input type="number" step="0.001" value={item.quantity} disabled={!editable} onChange={(e) => updateLocalItem(item.id, { quantity: Number(e.target.value) })} onBlur={() => saveItem(items.find((i) => i.id === item.id)!)} />
                        </div>
                        <div className="sm:col-span-2 space-y-1">
                          <Label className="text-xs">Unit price</Label>
                          <div className="relative">
                            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
                            <DecimalInput
                              value={unitPriceDrafts[item.id] ?? String(item.unitPrice)}
                              onChange={(next) => handleUnitPriceChange(item, next)}
                              disabled={!editable}
                              allowNegative
                              className="pl-5 text-right"
                              placeholder="Negative = credit"
                              aria-label="Unit price"
                            />
                          </div>
                        </div>
                        <div className="sm:col-span-2 space-y-1">
                          <Label className="text-xs">Line total</Label>
                          <div className={`flex h-9 items-center px-2 text-sm font-medium ${item.lineSubtotal < 0 ? "text-rose-600" : ""}`}>{currency(item.lineSubtotal, co.currency)}</div>
                        </div>
                        <div className="flex items-center gap-1 sm:col-span-1">
                          <Switch checked={item.taxable} disabled={!editable} onCheckedChange={(v) => { updateLocalItem(item.id, { taxable: v }); void saveItem({ ...item, taxable: v }); }} />
                          <span className="text-xs text-muted-foreground">Tax</span>
                        </div>
                        <div className="sm:col-span-1">
                          {editable && (
                            <Button variant="ghost" size="icon" onClick={() => removeItem(item.id)}>
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </Card>
                  ))}
                  {items.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No line items yet.</p>}
                </div>
                {editable && <Button size="sm" variant="outline" onClick={addItem}><Plus className="mr-1 h-4 w-4" />Add line item</Button>}
              </TabsContent>

              <TabsContent value="pricing" className="space-y-3 pt-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Discount type</Label>
                    <Select value={discountType} disabled={!editable} onValueChange={(v) => setDiscountType(v as any)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="percentage">{CHANGE_ORDER_DISCOUNT_TYPE_LABELS.percentage}</SelectItem>
                        <SelectItem value="fixed">{CHANGE_ORDER_DISCOUNT_TYPE_LABELS.fixed}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Discount value</Label>
                    <Input type="number" step="0.01" value={discountValue} disabled={!editable || discountType === "none"} onChange={(e) => setDiscountValue(Number(e.target.value))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Markup type</Label>
                    <Select value={markupType} disabled={!editable} onValueChange={(v) => setMarkupType(v as any)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="percentage">{CHANGE_ORDER_MARKUP_TYPE_LABELS.percentage}</SelectItem>
                        <SelectItem value="fixed">{CHANGE_ORDER_MARKUP_TYPE_LABELS.fixed}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Markup value</Label>
                    <Input type="number" step="0.01" value={markupValue} disabled={!editable || markupType === "none"} onChange={(e) => setMarkupValue(Number(e.target.value))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Tax rate (%)</Label>
                    <Input type="number" step="0.01" value={taxRate} disabled={!editable} onChange={(e) => setTaxRate(Number(e.target.value))} />
                  </div>
                </div>
                {editable && <Button size="sm" onClick={savePricing} disabled={busy}>Save pricing</Button>}

                <Card className="mt-4 space-y-1.5 p-4 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>{currency(co.subtotal, co.currency)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span>-{currency(co.discountAmount, co.currency)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Markup</span><span>{currency(co.markupAmount, co.currency)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span>{currency(co.taxAmount, co.currency)}</span></div>
                  <div className="flex justify-between border-t pt-1.5 text-base font-semibold"><span>Total</span><span className={co.totalAmount < 0 ? "text-rose-600" : ""}>{currency(co.totalAmount, co.currency)}</span></div>
                </Card>
              </TabsContent>

              <TabsContent value="schedule" className="space-y-3 pt-4">
                <div className="space-y-1.5">
                  <Label>Schedule impact (days, may be negative)</Label>
                  <Input type="number" value={scheduleImpactDays} disabled={!editable} onChange={(e) => setScheduleImpactDays(Number(e.target.value))} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Proposed start date</Label>
                    <Input type="date" value={proposedStartDate} disabled={!editable} onChange={(e) => setProposedStartDate(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Proposed completion date</Label>
                    <Input type="date" value={proposedCompletionDate} disabled={!editable} onChange={(e) => setProposedCompletionDate(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Approval deadline</Label>
                  <Input type="date" value={approvalDueAt} disabled={!editable} onChange={(e) => setApprovalDueAt(e.target.value)} />
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={isFieldVisible} disabled={!editable} onCheckedChange={setIsFieldVisible} />
                  <Label className="!mt-0">Visible to Field crews once approved</Label>
                </div>
                {editable && <Button size="sm" onClick={saveSchedule} disabled={busy}>Save</Button>}

                {co.status === "approved" && co.scheduleImpactDays !== 0 && !co.scheduleImpactAppliedAt && co.proposedCompletionDate && (
                  <Card className="mt-3 space-y-2 border-amber-200 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-500/10">
                    <p className="text-sm">This approved Change Order has an unapplied schedule impact. Applying it updates the Project's target completion date — it does not shift Tasks/phases automatically.</p>
                    <Button size="sm" onClick={handleApplyScheduleImpact} disabled={busy || !canEdit} title={!canEdit ? "You do not have permission to apply schedule impact" : undefined}><ArrowUpCircle className="mr-1 h-4 w-4" />Apply Schedule Impact</Button>
                  </Card>
                )}
                {co.scheduleImpactAppliedAt && (
                  <p className="text-xs text-muted-foreground">Schedule impact applied {new Date(co.scheduleImpactAppliedAt).toLocaleString()}.</p>
                )}
              </TabsContent>

              <TabsContent value="message" className="space-y-3 pt-4">
                <div className="space-y-1.5">
                  <Label>Customer message</Label>
                  <Textarea value={customerMessage} onChange={(e) => setCustomerMessage(e.target.value)} disabled={!editable} rows={4} />
                </div>
                <div className="space-y-1.5">
                  <Label>Internal notes (never shown to customer)</Label>
                  <Textarea value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} disabled={!editable} rows={4} />
                </div>
                {editable && <Button size="sm" onClick={saveMessages} disabled={busy}>Save</Button>}
              </TabsContent>

              <TabsContent value="preview" className="pt-4">
                {portalPreview && (
                  <Card className="space-y-4 p-5">
                    <div>
                      <p className="text-xs text-muted-foreground">Change Order {portalPreview.number} · v{portalPreview.version}</p>
                      <h3 className="text-lg font-semibold">{portalPreview.title}</h3>
                      {portalPreview.scope && <p className="mt-1 text-sm text-muted-foreground">{portalPreview.scope}</p>}
                    </div>
                    <div className="space-y-1.5">
                      {portalPreview.items.map((i) => (
                        <div key={i.id} className="flex justify-between text-sm">
                          <span>{i.name} {i.quantity !== 1 ? `× ${i.quantity}${i.unit ? ` ${i.unit}` : ""}` : ""}</span>
                          <span className={i.lineTotal < 0 ? "text-rose-600" : ""}>{currency(i.lineTotal, portalPreview.currency)}</span>
                        </div>
                      ))}
                    </div>
                    <div className="space-y-1 border-t pt-3 text-sm">
                      <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>{currency(portalPreview.subtotal, portalPreview.currency)}</span></div>
                      {portalPreview.discountAmount !== 0 && <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span>-{currency(portalPreview.discountAmount, portalPreview.currency)}</span></div>}
                      {portalPreview.taxAmount !== 0 && <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span>{currency(portalPreview.taxAmount, portalPreview.currency)}</span></div>}
                      <div className="flex justify-between text-base font-semibold"><span>Total</span><span className={portalPreview.totalAmount < 0 ? "text-rose-600" : ""}>{currency(portalPreview.totalAmount, portalPreview.currency)}</span></div>
                    </div>
                    {portalPreview.scheduleImpactDays !== 0 && (
                      <p className="text-sm text-muted-foreground">Schedule impact: {portalPreview.scheduleImpactDays > 0 ? "+" : ""}{portalPreview.scheduleImpactDays} days{portalPreview.proposedCompletionDate ? ` · new target completion ${portalPreview.proposedCompletionDate}` : ""}</p>
                    )}
                    {portalPreview.customerMessage && <p className="text-sm italic">"{portalPreview.customerMessage}"</p>}
                    {portalPreview.approvalDueAt && <p className="text-xs text-muted-foreground">Approval requested by {new Date(portalPreview.approvalDueAt).toLocaleDateString()}</p>}
                  </Card>
                )}
              </TabsContent>

              {co.status !== "draft" && (
                <TabsContent value="history" className="space-y-2 pt-4">
                  {approvals.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No activity yet.</p>}
                  {approvals.map((a) => (
                    <Card key={a.id} className="p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{CHANGE_ORDER_APPROVAL_ACTION_LABELS[a.action as keyof typeof CHANGE_ORDER_APPROVAL_ACTION_LABELS] ?? a.action}</span>
                        <span className="text-xs text-muted-foreground">{new Date(a.createdAt).toLocaleString()}</span>
                      </div>
                      {(a.actorName || a.actorEmail) && <p className="text-xs text-muted-foreground">{a.actorName ?? "Unknown"} {a.actorEmail ? `(${a.actorEmail})` : ""} · v{a.version}</p>}
                      {a.rejectionReason && <p className="mt-1 text-xs">Reason: {a.rejectionReason}</p>}
                    </Card>
                  ))}
                </TabsContent>
              )}
            </Tabs>

            <div className="mt-6 flex flex-wrap gap-2 border-t pt-4">
              {co.status === "draft" && (
                <>
                  <Button size="sm" onClick={handleMarkReady} disabled={busy}><CheckCircle2 className="mr-1 h-4 w-4" />Mark Ready</Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild><Button size="sm" variant="outline" disabled={busy}><Trash2 className="mr-1 h-4 w-4" />Delete Draft</Button></AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader><AlertDialogTitle>Delete this draft?</AlertDialogTitle><AlertDialogDescription>This cannot be undone.</AlertDialogDescription></AlertDialogHeader>
                      <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction></AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </>
              )}
              {co.status === "ready_to_send" && (
                <>
                  <Button size="sm" onClick={() => handleSend(false)} disabled={busy || !canEdit} title={!canEdit ? "You do not have permission to send Change Orders" : undefined}><Send className="mr-1 h-4 w-4" />Send for Approval</Button>
                  <Button size="sm" variant="outline" onClick={handleReturnToDraft} disabled={busy}><Undo2 className="mr-1 h-4 w-4" />Return to Draft</Button>
                </>
              )}
              {(co.status === "sent" || co.status === "viewed") && (
                <>
                  <Button size="sm" variant="outline" onClick={() => handleSend(true)} disabled={busy || !canEdit} title={!canEdit ? "You do not have permission to resend Change Orders" : undefined}><Copy className="mr-1 h-4 w-4" />Copy Approval Link / Resend</Button>
                  <Button size="sm" variant="outline" onClick={handleCancel} disabled={busy || !canEdit} title={!canEdit ? "You do not have permission to cancel Change Orders" : undefined}><Ban className="mr-1 h-4 w-4" />Cancel</Button>
                  <Button size="sm" variant="outline" onClick={handleCreateRevision} disabled={busy}><FileText className="mr-1 h-4 w-4" />Create Revision</Button>
                </>
              )}
              {co.status === "approved" && (
                <Button size="sm" variant="outline" onClick={handleCreateRevision} disabled={busy}><FileText className="mr-1 h-4 w-4" />Create Revision</Button>
              )}
              {(co.status === "rejected" || co.status === "cancelled" || co.status === "expired") && (
                <Button size="sm" variant="outline" onClick={handleCreateRevision} disabled={busy}><FileText className="mr-1 h-4 w-4" />Create Revision</Button>
              )}
              {co.status === "internal_review" && (
                <>
                  <Button size="sm" onClick={handleMarkReady} disabled={busy}><ClipboardCheck className="mr-1 h-4 w-4" />Mark Ready</Button>
                  <Button size="sm" variant="outline" onClick={handleReturnToDraft} disabled={busy}><Undo2 className="mr-1 h-4 w-4" />Return to Draft</Button>
                </>
              )}
              {co.isCustomerVisible && (co.status === "sent" || co.status === "viewed") && (
                <Button size="sm" variant="ghost" asChild>
                  <span className="flex items-center text-muted-foreground"><ExternalLink className="mr-1 h-3.5 w-3.5" />Customer-visible since {co.sentAt ? new Date(co.sentAt).toLocaleDateString() : "—"}</span>
                </Button>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
