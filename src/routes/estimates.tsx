// src/routes/financials.estimates.tsx
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTopbarAction } from "@/lib/topbar-action";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { MetricCard } from "@/components/ui/metric-card";
import { StatusBadge, type BadgeTone } from "@/components/ui/status-badge";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Search, MoreHorizontal, FileText, CheckCircle2, Clock, Send, Plus, Trash2, Loader2, Download,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { computeEffectiveEstimateTotals } from "@/lib/estimate-totals";

// `template`/`clientName` are accepted (but not yet consumed) for the
// pre-existing "Create estimate from template" link on the Leads page —
// preserved here as passthrough so that link keeps type-checking.
type EstimatesSearch = { openNew?: boolean; template?: string; clientName?: string; leadId?: string };

export const Route = createFileRoute("/estimates")({
  validateSearch: (raw: Record<string, unknown>): EstimatesSearch => ({
    openNew: raw.openNew === true || raw.openNew === "1" ? true : undefined,
    template: typeof raw.template === "string" ? raw.template : undefined,
    clientName: typeof raw.clientName === "string" ? raw.clientName : undefined,
    leadId: typeof raw.leadId === "string" ? raw.leadId : undefined,
  }),
  component: EstimatesPage,
});

// ── Constants ─────────────────────────────────────────────────────────────────

const ITEM_CATEGORIES = ["Materials", "Labor", "Equipment", "Permits", "Subcontractor", "Other"] as const;
type ItemCategory = (typeof ITEM_CATEGORIES)[number];
const TAX_RATE = 0.08;
const UNIT_OPTIONS = ["ea", "sf", "lf", "hr", "day", "ls", "sqyd", "ton"] as const;

const STATUS_TONE: Record<string, BadgeTone> = {
  draft:    "muted",
  sent:     "info",
  viewed:   "violet",
  accepted: "success",
  declined: "danger",
};

// ── Types ─────────────────────────────────────────────────────────────────────

// Mirrors actual estimate_items columns from the DB
type EstimateItem = {
  id: string;
  estimate_id: string; // FK → estimates.id
  category: string;    // Materials, Labor, Equipment, Permits, Subcontractor, Other
  name: string;
  description: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
  position: number;
  total: number;       // stored: quantity * unit_price
};

type Estimate = {
  id: string;
  number: string | null;
  title: string;
  status: string;
  client_id: string | null;
  client_name: string;
  notes: string | null;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
  subtotal: number;
  tax_total: number;
  total: number;
  item_count: number;
  estimate_items: EstimateItem[];
};

type Contact = { id: string; name: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(s: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(s));
}

function formatMoney(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function genEstimateNumber(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `EST-${stamp}-${Math.floor(Math.random() * 900 + 100)}`;
}

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return m?.org_id ?? null;
}

function mapItems(raw: any[]): EstimateItem[] {
  return (raw ?? [])
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((row: any) => {
      const qty = Number(row.quantity ?? 0);
      const price = Number(row.unit_price ?? 0);
      return {
        id: row.id,
        estimate_id: row.estimate_id,
        category: row.category ?? "Other",
        name: row.name ?? "",
        description: row.description ?? null,
        quantity: qty,
        unit: row.unit ?? null,
        unit_price: price,
        position: row.position ?? 0,
        total: Number(row.total ?? qty * price),
      };
    });
}

// ── Estimate Form Sheet (create + edit) ──────────────────────────────────────

type FormItem = {
  category: ItemCategory;
  name: string;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
};

const EMPTY_ITEM: FormItem = { category: "Materials", name: "", description: "", quantity: "1", unit: "ea", unit_price: "" };

function itemToForm(i: EstimateItem): FormItem {
  return {
    category: (ITEM_CATEGORIES as readonly string[]).includes(i.category)
      ? (i.category as ItemCategory)
      : "Other",
    name: i.name,
    description: i.description ?? "",
    quantity: String(i.quantity),
    unit: i.unit ?? "",
    unit_price: String(i.unit_price),
  };
}

function EstimateFormSheet({
  open, onClose, orgId, onSaved, estimate, initialLead,
}: {
  open: boolean;
  onClose: () => void;
  orgId: string;
  onSaved: () => void;
  estimate?: Estimate; // undefined = create mode
  initialLead?: { contactId: string; name: string; projectType: string; budget: number; notes: string } | null;
}) {
  const isEdit = !!estimate;

  const [title, setTitle] = useState("");
  const [clientId, setClientId] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<FormItem[]>([{ ...EMPTY_ITEM }]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [saving, setSaving] = useState(false);

  // Populate fields when opening in edit mode or resetting for create
  useEffect(() => {
    if (!open) return;
    if (isEdit && estimate) {
      setTitle(estimate.title);
      setClientId(estimate.client_id ?? "");
      setValidUntil(estimate.valid_until ?? "");
      setNotes(estimate.notes ?? "");
      setItems(estimate.estimate_items.length ? estimate.estimate_items.map(itemToForm) : [{ ...EMPTY_ITEM }]);
    } else {
      setTitle(initialLead?.projectType ? `${initialLead.projectType} Estimate` : "");
      setClientId(initialLead?.contactId ?? "");
      setValidUntil("");
      setNotes(initialLead?.notes ?? "");
      setItems(initialLead?.budget ? [{
        ...EMPTY_ITEM,
        category: "Labor",
        name: initialLead.projectType || "Project estimate",
        description: `Estimate prepared for ${initialLead.name}`,
        unit: "ls",
        unit_price: String(initialLead.budget),
      }] : [{ ...EMPTY_ITEM }]);
    }
  }, [open, initialLead]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    supabase
      .from("contacts")
      .select("id, full_name")
      .eq("org_id", orgId)
      .order("full_name")
      .then(({ data }) =>
        setContacts((data ?? []).map((c: any) => ({ id: c.id, name: c.full_name ?? "—" })))
      );
  }, [open, orgId]);

  const setItem = (i: number, field: keyof FormItem, val: string) =>
    setItems(prev => prev.map((item, idx) => (idx === i ? { ...item, [field]: val } : item)));
  const addItem = () => setItems(prev => [...prev, { ...EMPTY_ITEM }]);
  const removeItem = (i: number) => setItems(prev => prev.filter((_, idx) => idx !== i));

  const subtotal = items.reduce(
    (s, it) => s + (parseFloat(it.quantity) || 0) * (parseFloat(it.unit_price) || 0),
    0
  );
  const taxTotal = subtotal * TAX_RATE;
  const total = subtotal + taxTotal;

  const handleClose = () => onClose();

  function buildItemRows(estimateId: string) {
    return items
      .filter(it => it.name.trim())
      .map((it, idx) => {
        const qty = parseFloat(it.quantity) || 1;
        const price = parseFloat(it.unit_price) || 0;
        return {
          estimate_id: estimateId,
          category: it.category,
          name: it.name.trim(),
          description: it.description.trim() || null,
          quantity: qty,
          unit: it.unit.trim() || "ea",
          unit_price: price,
          total: qty * price,
          position: idx,
        };
      });
  }

  const save = async (newStatus?: "sent") => {
    if (!title.trim()) { toast.error("Title is required"); return; }
    setSaving(true);
    try {
      if (isEdit && estimate) {
        // Update header
        const { error: updErr } = await supabase
          .from("estimates")
          .update({
            title: title.trim(),
            client_id: clientId || null,
            valid_until: validUntil || null,
            notes: notes.trim() || null,
            subtotal,
            tax_total: taxTotal,
            total,
            ...(newStatus ? { status: newStatus } : {}),
            updated_at: new Date().toISOString(),
          })
          .eq("id", estimate.id);
        if (updErr) throw updErr;

        // Replace all items
        await supabase.from("estimate_items").delete().eq("estimate_id", estimate.id);
        const rows = buildItemRows(estimate.id);
        if (rows.length) {
          const { error: itemErr } = await supabase.from("estimate_items").insert(rows);
          if (itemErr) throw itemErr;
        }
        toast.success("Estimate updated");
      } else {
        // Create
        const status = newStatus ?? "draft";
        const { data: est, error: estErr } = await supabase
          .from("estimates")
          .insert({
            org_id: orgId,
            number: genEstimateNumber(),
            title: title.trim(),
            client_id: clientId || null,
            valid_until: validUntil || null,
            notes: notes.trim() || null,
            subtotal,
            tax_total: taxTotal,
            total,
            status,
          })
          .select("id")
          .single();
        if (estErr) throw estErr;

        const rows = buildItemRows(est.id);
        if (rows.length) {
          const { error: itemErr } = await supabase.from("estimate_items").insert(rows);
          if (itemErr) throw itemErr;
        }
        toast.success(status === "sent" ? "Estimate created and marked as sent" : "Draft saved");
      }

      onSaved();
      handleClose();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to save estimate");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={o => !o && handleClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl" side="right">
        <SheetHeader className="border-b border-border pb-4">
          <SheetTitle>{isEdit ? "Edit Estimate" : "New Estimate"}</SheetTitle>
          <SheetDescription>
            {isEdit ? "Update the estimate details and line items." : "Create a proposal for a client."}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-5 pb-24 text-sm">
          {/* Basic fields */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="est-title">Title</Label>
              <Input
                id="est-title"
                placeholder="e.g. Kitchen Renovation Estimate"
                value={title}
                onChange={e => setTitle(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Client</Label>
              <Select value={clientId} onValueChange={setClientId}>
                <SelectTrigger><SelectValue placeholder="Select client…" /></SelectTrigger>
                <SelectContent>
                  {contacts.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="est-valid">Valid Until</Label>
              <Input
                id="est-valid"
                type="date"
                value={validUntil}
                onChange={e => setValidUntil(e.target.value)}
              />
            </div>
          </div>

          {/* Scope of Work */}
          <div className="space-y-1">
            <Label htmlFor="est-notes">Scope of Work <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Textarea
              id="est-notes"
              rows={4}
              placeholder="Describe the project scope, work to be performed, materials included, exclusions, and special conditions..."
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="resize-none text-sm"
            />
          </div>

          {/* Line items */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium">Line Items</span>
              <Button type="button" variant="outline" size="sm" onClick={addItem}>
                <Plus className="mr-1 h-3.5 w-3.5" />Add Item
              </Button>
            </div>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-secondary/60 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-2 pl-3 pr-2 text-left">Description</th>
                    <th className="py-2 pr-2 text-left">Category</th>
                    <th className="py-2 pr-2 text-right">Qty</th>
                    <th className="py-2 pr-2 text-left">Unit</th>
                    <th className="py-2 pr-2 text-right">Unit Price</th>
                    <th className="py-2 pr-3 text-right">Total</th>
                    <th className="w-8 py-2 pr-2" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, i) => {
                    const lineTotal = (parseFloat(it.quantity) || 0) * (parseFloat(it.unit_price) || 0);
                    return (
                      <tr key={i} className="border-b border-border last:border-0">
                        <td className="py-1.5 pl-3 pr-2">
                          <Input
                            placeholder="Item name"
                            value={it.name}
                            onChange={e => setItem(i, "name", e.target.value)}
                            className="h-7 text-xs"
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <Select value={it.category} onValueChange={v => setItem(i, "category", v as ItemCategory)}>
                            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {ITEM_CATEGORIES.map(c => (
                                <SelectItem key={c} value={c}>{c}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input
                            type="number"
                            min="0"
                            value={it.quantity}
                            onChange={e => setItem(i, "quantity", e.target.value)}
                            className="h-7 text-right text-xs"
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <Select value={it.unit || "ea"} onValueChange={v => setItem(i, "unit", v)}>
                            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {UNIT_OPTIONS.map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="0.00"
                            value={it.unit_price}
                            onChange={e => setItem(i, "unit_price", e.target.value)}
                            className="h-7 text-right text-xs"
                          />
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{formatMoney(lineTotal)}</td>
                        <td className="py-1.5 pr-2">
                          {items.length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => removeItem(i)}
                            >
                              <Trash2 className="h-3 w-3 text-destructive" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Totals summary */}
          <div className="ml-auto w-full max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="tabular-nums">{formatMoney(subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tax (8%)</span>
              <span className="tabular-nums">{formatMoney(taxTotal)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-1.5 font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatMoney(total)}</span>
            </div>
          </div>
        </div>

        {/* Sticky footer */}
        <div className="absolute bottom-0 left-0 right-0 flex gap-2 border-t border-border bg-background p-4">
          <Button type="button" variant="outline" className="flex-1" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          {isEdit ? (
            <>
              <Button type="button" className="flex-1" onClick={() => save()} disabled={saving}>
                {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Save Changes
              </Button>
              {estimate?.status === "draft" && (
                <Button type="button" variant="secondary" className="flex-1" onClick={() => save("sent")} disabled={saving}>
                  <Send className="mr-1.5 h-3.5 w-3.5" />Save & Send
                </Button>
              )}
            </>
          ) : (
            <>
              <Button type="button" variant="secondary" className="flex-1" onClick={() => save()} disabled={saving}>
                {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Save Draft
              </Button>
              <Button type="button" className="flex-1" onClick={() => save("sent")} disabled={saving}>
                <Send className="mr-1.5 h-3.5 w-3.5" />Send to Client
              </Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── PDF Print ─────────────────────────────────────────────────────────────────

type OrgInfo = {
  name: string;
  logo_url: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
};

type ContactInfo = {
  full_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
};

function fmtLong(s: string) {
  return new Date(s).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function fmtPhone(p: string | null | undefined): string {
  if (!p) return "";
  const d = p.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === "1") return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return p;
}

function moneyRaw(n: number) {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

async function openPrintWindow(
  estimate: Estimate,
  org: OrgInfo | null,
  contact: ContactInfo | null,
) {
  // Open window immediately (must be in synchronous user-gesture context)
  const w = window.open("", "_blank");
  if (!w) { toast.error("Allow popups to download PDF"); return; }

  const coName = org?.name ?? "Your Company";
  const coPhone = fmtPhone(org?.phone);
  const coAddress = org?.address ?? "";

  // ── Company identity block ──
  const logoHtml = org?.logo_url
    ? `<img src="${org.logo_url}" alt="${coName}" style="height:52px;max-width:180px;object-fit:contain;margin-right:12px;vertical-align:middle">`
    : ``;

  const coMetaLine = [coAddress, coPhone].filter(Boolean).join("<br>");

  // ── Client block ──
  const clientName = estimate.client_name !== "—" ? estimate.client_name : (contact?.full_name ?? "—");
  const clientLines = [
    clientName,
    contact?.address,
    [fmtPhone(contact?.phone), contact?.email].filter(Boolean).join(" · "),
  ].filter(Boolean).join("\n");

  // ── Line items grouped by category ──
  const grouped = ITEM_CATEGORIES.map(cat => ({
    cat,
    items: estimate.estimate_items.filter(i => i.category === cat),
  })).filter(g => g.items.length > 0);
  // Catch items with unrecognised categories
  const knownCats = new Set<string>(ITEM_CATEGORIES);
  const otherItems = estimate.estimate_items.filter(i => !knownCats.has(i.category));
  if (otherItems.length) grouped.push({ cat: "Other", items: otherItems });

  const itemRowsHtml = grouped.map(g => `
    <tr class="cat-row"><td colspan="4">${g.cat}</td></tr>
    ${g.items.map(item => `
      <tr>
        <td>${item.name}${item.description ? `<br><span class="sub">${item.description}</span>` : ""}</td>
        <td class="r">${item.quantity}${item.unit ? ` ${item.unit}` : ""}</td>
        <td class="r">$${moneyRaw(item.unit_price)}</td>
        <td class="r">$${moneyRaw(item.total)}</td>
      </tr>`).join("")}
  `).join("");

  // ── Scope of Work ──
  const scopeHtml = estimate.notes
    ? `<div class="section">
        <div class="section-title">Scope of Work</div>
        <div class="scope-text">${estimate.notes.replace(/\n/g, "<br>")}</div>
       </div><hr>`
    : "";

  // ── Closing message ──
  const closingMsg = `Thank you for the opportunity to work on your project. We are committed to delivering exceptional quality and craftsmanship. Please don't hesitate to reach out with any questions.`;

  // ── Footer line ──
  const footerLeft = [coName, coPhone].filter(Boolean).join(" · ");

  w.document.write(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Estimate ${estimate.number ?? estimate.id.slice(0, 8)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#111;padding:48px;max-width:820px;margin:0 auto}
hr{border:none;border-top:1px solid #e5e7eb;margin:20px 0}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}
.co-name{font-size:22px;font-weight:800;color:#111}
.co-meta{font-size:11px;color:#6b7280;margin-top:6px;line-height:1.8}
.est-right{text-align:right}
.est-label{font-size:32px;font-weight:800;letter-spacing:-1px;color:#111}
.est-meta{font-size:12px;color:#6b7280;margin-top:4px;line-height:1.8}
.prepared{margin:20px 0}
.prepared-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;margin-bottom:6px}
.prepared-name{font-size:15px;font-weight:700;color:#111}
.prepared-detail{font-size:12px;color:#6b7280;margin-top:3px;line-height:1.7}
.section{margin:20px 0}
.section-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;margin-bottom:6px}
.scope-text{font-size:13px;color:#374151;line-height:1.7;white-space:pre-wrap}
table{width:100%;border-collapse:collapse;margin:4px 0 12px}
thead th{background:#f3f4f6;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;padding:9px 12px;text-align:left;border-bottom:2px solid #e5e7eb}
thead th.r{text-align:right}
tbody td{padding:9px 12px;border-bottom:1px solid #f3f4f6;vertical-align:top;font-size:13px}
tbody td.r{text-align:right;white-space:nowrap}
.cat-row td{background:#f9fafb;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;padding:6px 12px;border-bottom:1px solid #e5e7eb}
.sub{font-size:11px;color:#9ca3af;display:block;margin-top:2px}
.totals-wrap{display:flex;justify-content:flex-end;margin-top:4px}
.totals{width:260px}
.trow{display:flex;justify-content:space-between;padding:5px 0;font-size:13px}
.trow.grand{font-size:16px;font-weight:800;border-top:2px solid #111;padding-top:10px;margin-top:4px}
.muted{color:#6b7280}
.closing{margin-top:28px;padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;color:#374151;line-height:1.7}
.closing-sig{margin-top:16px;font-size:13px;font-weight:600;color:#111}
.closing-sig-meta{font-size:12px;color:#6b7280}
.footer{margin-top:32px;padding-top:12px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;font-size:11px;color:#9ca3af}
@media print{body{padding:24px}.footer{position:running(footer)}@page{margin:16mm;@bottom-left{content:element(footer)}}}
</style></head><body>

<div class="hdr">
  <div>
    <div style="display:flex;align-items:center;gap:12px">
      ${logoHtml}
      <div class="co-name">${coName}</div>
    </div>
    ${coMetaLine ? `<div class="co-meta">${coMetaLine}</div>` : ""}
  </div>
  <div class="est-right">
    <div class="est-label">ESTIMATE</div>
    <div class="est-meta">
      ${estimate.number ? `${estimate.number}<br>` : ""}
      Date: ${fmtLong(estimate.created_at)}<br>
      ${estimate.valid_until ? `Valid Until: ${fmtLong(estimate.valid_until)}` : ""}
    </div>
  </div>
</div>

<hr>

<div class="prepared">
  <div class="prepared-label">Prepared For</div>
  <div class="prepared-name">${clientLines.split("\n")[0]}</div>
  ${clientLines.split("\n").slice(1).map(l => `<div class="prepared-detail">${l}</div>`).join("")}
</div>

<hr>

${scopeHtml}

<table>
  <thead><tr>
    <th>Description</th>
    <th class="r">Qty</th>
    <th class="r">Unit Price</th>
    <th class="r">Total</th>
  </tr></thead>
  <tbody>
    ${itemRowsHtml || '<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:20px">No line items</td></tr>'}
  </tbody>
</table>

<hr>

<div class="totals-wrap"><div class="totals">
  <div class="trow"><span class="muted">Subtotal</span><span>$${moneyRaw(estimate.subtotal)}</span></div>
  <div class="trow"><span class="muted">Tax (8%)</span><span>$${moneyRaw(estimate.tax_total)}</span></div>
  <div class="trow grand"><span>Total</span><span>$${moneyRaw(estimate.total)}</span></div>
</div></div>

<hr>

<div class="closing">
  ${closingMsg}
  <div class="closing-sig">${coName}</div>
  <div class="closing-sig-meta">${coPhone}</div>
</div>

<div class="footer">
  <span>${footerLeft}</span>
  <span>Page 1 of 1</span>
</div>

<script>window.onload=function(){window.print();}</script>
</body></html>`);
  w.document.close();
}

// ── Estimate View Dialog ───────────────────────────────────────────────────────

function EstimateViewDialog({
  estimate, org, onClose,
}: {
  estimate: Estimate | null;
  org: OrgInfo | null;
  onClose: () => void;
}) {
  const [contact, setContact] = useState<ContactInfo | null>(null);

  useEffect(() => {
    if (!estimate?.client_id) { setContact(null); return; }
    supabase
      .from("contacts")
      .select("full_name, email, phone, address")
      .eq("id", estimate.client_id)
      .maybeSingle()
      .then(({ data }) => setContact(data as ContactInfo | null));
  }, [estimate?.client_id]);

  if (!estimate) return null;

  // Line items grouped by category for the in-app view
  const grouped = ITEM_CATEGORIES
    .map(cat => ({ cat, items: estimate.estimate_items.filter(i => i.category === cat) }))
    .filter(g => g.items.length > 0);
  const knownCats = new Set<string>(ITEM_CATEGORIES);
  const otherItems = estimate.estimate_items.filter(i => !knownCats.has(i.category));
  if (otherItems.length) grouped.push({ cat: "Other", items: otherItems });

  return (
    <Dialog open={!!estimate} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="border-b border-border pb-4">
          <div className="flex items-start justify-between gap-3">
            <DialogTitle className="sr-only">Estimate {estimate.number}</DialogTitle>
            <div className="flex items-center gap-3">
              {org?.logo_url && (
                <img src={org.logo_url} alt={org.name} className="h-12 max-w-40 object-contain shrink-0" />
              )}
              <div>
                <div className="text-lg font-bold leading-tight">{org?.name ?? "Your Company"}</div>
                {(org?.phone || org?.address) && (
                  <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    {[org?.address, fmtPhone(org?.phone)].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-2xl font-extrabold tracking-tight">ESTIMATE</div>
              {estimate.number && <div className="text-xs text-muted-foreground">{estimate.number}</div>}
              <div className="mt-0.5 text-xs text-muted-foreground">
                {fmtLong(estimate.created_at)}
                {estimate.valid_until && <><br />Valid until {fmtLong(estimate.valid_until)}</>}
              </div>
              <StatusBadge tone={STATUS_TONE[estimate.status] ?? STATUS_TONE.draft} className="mt-1">
                {estimate.status}
              </StatusBadge>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 py-2 text-sm">
          {/* Prepared For */}
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Prepared For</div>
            <div className="text-base font-semibold">{estimate.client_name !== "—" ? estimate.client_name : (contact?.full_name ?? "—")}</div>
            {contact?.address && <div className="text-xs text-muted-foreground mt-0.5">{contact.address}</div>}
            {(contact?.phone || contact?.email) && (
              <div className="text-xs text-muted-foreground">
                {[fmtPhone(contact.phone), contact.email].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>

          {/* Scope of Work */}
          {estimate.notes && (
            <div className="rounded-md border border-border bg-secondary/30 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Scope of Work</div>
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{estimate.notes}</p>
            </div>
          )}

          {/* Line items grouped by category */}
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-secondary/60 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pl-3 pr-2 text-left">Description</th>
                  <th className="py-2 pr-2 text-right">Qty</th>
                  <th className="py-2 pr-2 text-right">Unit Price</th>
                  <th className="py-2 pr-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {estimate.estimate_items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-muted-foreground">No line items</td>
                  </tr>
                ) : grouped.map(g => (
                  <>
                    <tr key={`cat-${g.cat}`} className="border-b border-border bg-secondary/40">
                      <td colSpan={4} className="py-1.5 pl-3 pr-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {g.cat}
                      </td>
                    </tr>
                    {g.items.map(item => (
                      <tr key={item.id} className="border-b border-border last:border-0">
                        <td className="py-2 pl-3 pr-2">
                          <div className="font-medium">{item.name}</div>
                          {item.description && <div className="text-[11px] text-muted-foreground">{item.description}</div>}
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums">
                          {item.quantity}{item.unit ? ` ${item.unit}` : ""}
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(item.unit_price)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums font-medium">{formatMoney(item.total)}</td>
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="ml-auto w-60 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="tabular-nums">{formatMoney(estimate.subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tax (8%)</span>
              <span className="tabular-nums">{formatMoney(estimate.tax_total)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-2 text-base font-bold">
              <span>Total</span>
              <span className="tabular-nums">{formatMoney(estimate.total)}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button variant="outline" onClick={onClose}>Close</Button>
            <Button onClick={() => openPrintWindow(estimate, org, contact)}>
              <Download className="mr-1.5 h-3.5 w-3.5" />Download PDF
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Estimate Detail Sheet ─────────────────────────────────────────────────────

function EstimateDetailSheet({
  estimate, onClose, onStatusChange, onEdit,
}: {
  estimate: Estimate | null;
  onClose: () => void;
  onStatusChange: (id: string, status: string) => void;
  onEdit: (e: Estimate) => void;
}) {
  if (!estimate) return null;

  const knownKinds = new Set<string>(ITEM_CATEGORIES);
  const grouped = ITEM_CATEGORIES
    .map(cat => ({ category: cat, items: estimate.estimate_items.filter(i => i.category === cat) }))
    .filter(g => g.items.length > 0);
  // Catch items with unknown categories
  const ungrouped = estimate.estimate_items.filter(i => !knownKinds.has(i.category));
  if (ungrouped.length) grouped.push({ category: "Other" as ItemCategory, items: ungrouped });

  return (
    <Sheet open={!!estimate} onOpenChange={o => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader className="border-b border-border pb-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <SheetTitle className="text-base">{estimate.title}</SheetTitle>
              <SheetDescription className="text-xs">
                {estimate.client_name}
                {estimate.number ? ` · ${estimate.number}` : ""}
              </SheetDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <StatusBadge tone={STATUS_TONE[estimate.status] ?? STATUS_TONE.draft}>
                {estimate.status}
              </StatusBadge>
              <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => onEdit(estimate)}>
                Edit
              </Button>
            </div>
          </div>
        </SheetHeader>

        <div className="mt-4 space-y-5 pb-20 text-sm">
          {/* Meta row */}
          <div className="grid grid-cols-2 gap-3">
            {estimate.valid_until && <FactBox label="Valid Until" value={fmtDate(estimate.valid_until)} />}
            <FactBox label="Line Items" value={String(estimate.item_count)} />
          </div>

          {/* Line items grouped by category */}
          {grouped.length > 0 ? (
            <div className="space-y-4">
              {grouped.map(g => (
                <div key={g.category}>
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {g.category}
                  </div>
                  <div className="overflow-hidden rounded-md border border-border">
                    <table className="w-full text-xs">
                      <thead className="bg-secondary/40">
                        <tr className="border-b border-border">
                          <th className="py-1.5 pl-3 pr-2 text-left font-medium">Item</th>
                          <th className="py-1.5 pr-2 text-right font-medium">Qty</th>
                          <th className="py-1.5 pr-2 text-right font-medium">Unit Price</th>
                          <th className="py-1.5 pr-3 text-right font-medium">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.items.map(item => (
                          <tr key={item.id} className="border-b border-border last:border-0">
                            <td className="py-1.5 pl-3 pr-2">
                              <div className="font-medium">{item.name}</div>
                              {item.description && (
                                <div className="text-muted-foreground">{item.description}</div>
                              )}
                            </td>
                            <td className="py-1.5 pr-2 text-right tabular-nums">
                              {item.quantity}{item.unit ? ` ${item.unit}` : ""}
                            </td>
                            <td className="py-1.5 pr-2 text-right tabular-nums">
                              {formatMoney(item.unit_price)}
                            </td>
                            <td className="py-1.5 pr-3 text-right tabular-nums font-medium">
                              {formatMoney(item.total)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No line items on this estimate.</p>
          )}

          {/* Totals breakdown */}
          <div className="space-y-1.5 border-t border-border pt-3">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="tabular-nums">{formatMoney(estimate.subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tax (8%)</span>
              <span className="tabular-nums">{formatMoney(estimate.tax_total)}</span>
            </div>
            <div className="flex justify-between text-base font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatMoney(estimate.total)}</span>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            {estimate.status === "draft" && (
              <Button className="flex-1" onClick={() => onStatusChange(estimate.id, "sent")}>
                <Send className="mr-1.5 h-3.5 w-3.5" />Mark Sent
              </Button>
            )}
            {["sent", "viewed"].includes(estimate.status) && (
              <>
                <Button
                  className="flex-1 bg-success hover:bg-success/90 text-success-foreground"
                  onClick={() => onStatusChange(estimate.id, "accepted")}
                >
                  <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />Accept
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 text-destructive hover:text-destructive"
                  onClick={() => onStatusChange(estimate.id, "declined")}
                >
                  Decline
                </Button>
              </>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

function EstimatesPage() {
  const { openNew, leadId } = useSearch({ from: "/estimates" });
  const navigate = useNavigate({ from: "/estimates" });
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selected, setSelected] = useState<Estimate | null>(null);
  const [viewTarget, setViewTarget] = useState<Estimate | null>(null);
  const [editTarget, setEditTarget] = useState<Estimate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Estimate | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [orgInfo, setOrgInfo] = useState<OrgInfo | null>(null);
  const [initialLead, setInitialLead] = useState<{ contactId: string; name: string; projectType: string; budget: number; notes: string } | null>(null);

  useEffect(() => { getOrgId().then(setOrgId); }, []);

  // Deep-link support: Command Center Quick Actions navigates here with
  // ?openNew=1 instead of duplicating this form, so it opens the same sheet.
  useEffect(() => {
    if (!openNew || !orgId) return;

    const openForLead = async () => {
      if (leadId) {
        const { data: leadRow } = await supabase
          .from("leads")
          .select("contact_id, estimated_value, notes, custom_fields")
          .eq("id", leadId)
          .maybeSingle();

        if (leadRow) {
          let name = "Lead";
          if (leadRow.contact_id) {
            const { data: contact } = await supabase
              .from("contacts")
              .select("full_name")
              .eq("id", leadRow.contact_id)
              .maybeSingle();
            name = contact?.full_name ?? leadRow.custom_fields?.name ?? "Lead";
          }
          setInitialLead({
            contactId: leadRow.contact_id ?? "",
            name,
            projectType: leadRow.custom_fields?.service ?? "",
            budget: Number(leadRow.estimated_value ?? 0),
            notes: leadRow.notes ?? "",
          });
        }
      } else {
        setInitialLead(null);
      }

      setNewOpen(true);
      navigate({ search: (s) => ({ ...s, openNew: undefined, leadId: undefined }), replace: true });
    };

    void openForLead();
  }, [openNew, leadId, orgId, navigate]);

  useTopbarAction(
    <Button
      size="sm"
      onClick={() => {
        if (!orgId) { toast.error("Still loading…"); return; }
        setNewOpen(true);
      }}
    >
      <FileText className="mr-1.5 h-3.5 w-3.5" />New Estimate
    </Button>,
  );

  useEffect(() => {
    if (!orgId) return;
    supabase
      .from("organizations")
      .select("name, logo_url, email, phone, address")
      .eq("id", orgId)
      .maybeSingle()
      .then(({ data }) => { if (data) setOrgInfo(data as OrgInfo); });
  }, [orgId]);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);

    // 1. Load estimates (plain select — no joins to avoid FK resolution failures)
    const { data: estData, error: estErr } = await supabase
      .from("estimates")
      .select("*")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });
    if (estErr) { console.error("[estimates]", estErr); setLoading(false); return; }
    if (!estData?.length) { setEstimates([]); setLoading(false); return; }

    const estimateIds = estData.map((e: any) => e.id);

    // 2. Load all items for these estimates (FK: estimate_id → estimates.id)
    const { data: itemsData } = await supabase
      .from("estimate_items")
      .select("*")
      .in("estimate_id", estimateIds);

    // 3. Load contact names for the client_ids present
    const clientIds = [...new Set(estData.map((e: any) => e.client_id).filter(Boolean))] as string[];
    const { data: contactsData } = clientIds.length
      ? await supabase.from("contacts").select("id, full_name").in("id", clientIds)
      : { data: [] };

    const contactMap = new Map((contactsData ?? []).map((c: any) => [c.id, c.full_name as string]));
    const itemsByEstimate = new Map<string, any[]>();
    (itemsData ?? []).forEach((item: any) => {
      const list = itemsByEstimate.get(item.estimate_id) ?? [];
      list.push(item);
      itemsByEstimate.set(item.estimate_id, list);
    });

    setEstimates(
      estData.map((r: any) => {
        const items = mapItems(itemsByEstimate.get(r.id) ?? []);
        // Shared with the Command Center's Estimates card (see
        // src/lib/estimate-totals.ts) so both pages can never silently
        // diverge on which total is "correct" for the same estimate.
        const { subtotal, tax_total, total } = computeEffectiveEstimateTotals(
          { subtotal: Number(r.subtotal ?? 0), tax_total: Number(r.tax_total ?? 0), total: Number(r.total ?? 0) },
          items,
        );
        return {
          id: r.id,
          number: r.number ?? null,
          title: r.title ?? "Untitled",
          status: r.status ?? "draft",
          client_id: r.client_id ?? null,
          client_name: r.client_name ?? contactMap.get(r.client_id) ?? "—",
          notes: r.notes ?? null,
          valid_until: r.valid_until ?? null,
          created_at: r.created_at,
          updated_at: r.updated_at,
          subtotal,
          tax_total,
          total,
          item_count: items.length,
          estimate_items: items,
        };
      })
    );
    setLoading(false);
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return estimates.filter(e => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (!q) return true;
      return (
        e.title.toLowerCase().includes(q) ||
        e.client_name.toLowerCase().includes(q) ||
        (e.number ?? "").toLowerCase().includes(q)
      );
    });
  }, [estimates, search, statusFilter]);

  const stats = useMemo(
    () => ({
      draft: estimates.filter(e => e.status === "draft").length,
      sent: estimates.filter(e => e.status === "sent").length,
      pending: estimates.filter(e => ["sent", "viewed"].includes(e.status)).length,
      acceptedValue: estimates.filter(e => e.status === "accepted").reduce((sum, e) => sum + e.total, 0),
    }),
    [estimates]
  );

  const updateStatus = async (id: string, status: string) => {
    const { error } = await supabase
      .from("estimates")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) { toast.error("Failed to update status"); return; }
    toast.success(`Estimate marked as ${status}`);
    load();
    setSelected(s => (s?.id === id ? { ...s, status } : s));
  };

  const deleteEstimate = async (e: Estimate) => {
    await supabase.from("estimate_items").delete().eq("estimate_id", e.id);
    const { error } = await supabase.from("estimates").delete().eq("id", e.id);
    if (error) { toast.error("Failed to delete estimate"); return; }
    toast.success("Estimate deleted");
    setDeleteTarget(null);
    if (selected?.id === e.id) setSelected(null);
    load();
  };

  return (
    <>
      <PageHeader
        icon={FileText}
        iconBg="bg-gold-soft"
        iconColor="text-gold-hover"
        title="Estimates"
        subtitle="Create, send, track, and follow up on customer estimates."
        breadcrumb={["Estimates"]}
      />

      {/* KPIs */}
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Draft" value={stats.draft} icon={FileText} tone="muted" />
        <MetricCard label="Sent" value={stats.sent} icon={Send} tone="info" />
        <MetricCard label="Awaiting response" value={stats.pending} icon={Clock} tone="warning" />
        <MetricCard label="Accepted value" value={formatMoney(stats.acceptedValue)} icon={CheckCircle2} tone="success" />
      </div>

      {/* Filters */}
      <Card className="mb-3 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-50 flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search estimates…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-8 pl-8 text-sm"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {Object.keys(STATUS_TONE).map(s => (
                <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Card>

      {/* List table */}
      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-secondary/60 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <tr className="border-b border-border">
              <th className="py-2.5 pl-4 pr-3 text-left">Estimate</th>
              <th className="py-2.5 pr-4 text-left">Customer</th>
              <th className="py-2.5 pr-4 text-left">Project</th>
              <th className="py-2.5 pr-4 text-left">Status</th>
              <th className="py-2.5 pr-4 text-right">Items</th>
              <th className="py-2.5 pr-4 text-right">Amount</th>
              <th className="py-2.5 pr-4 text-left">Valid until</th>
              <th className="w-10 py-2.5 pr-3" />
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-border">
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} className="py-3 pr-4"><Skeleton className="h-4 w-24" /></td>
                  ))}
                  <td />
                </tr>
              ))}

            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="py-12 text-center text-sm text-muted-foreground">
                  No estimates found.
                </td>
              </tr>
            )}

            {!loading &&
              filtered.map(e => (
                <tr
                  key={e.id}
                  onClick={() => setSelected(e)}
                  className="cursor-pointer border-b border-border hover:bg-secondary/30"
                >
                  <td className="py-2.5 pl-4 pr-3">
                    <div className="font-semibold tabular-nums">{e.number ?? "—"}</div>
                  </td>
                  <td className="py-2.5 pr-4">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <ContactAvatar id={e.client_id} name={e.client_name} size="xs" />
                      <span className="truncate font-medium">{e.client_name}</span>
                    </div>
                  </td>
                  <td className="py-2.5 pr-4">
                    <div className="truncate font-medium">{e.title}</div>
                  </td>
                  <td className="py-2.5 pr-4">
                    <StatusBadge tone={STATUS_TONE[e.status] ?? STATUS_TONE.draft}>
                      {e.status}
                    </StatusBadge>
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-muted-foreground">
                    {e.item_count}
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums font-medium">
                    {formatMoney(e.total)}
                  </td>
                  <td className="py-2.5 pr-4 text-[11px] text-muted-foreground">
                    {e.valid_until ? fmtDate(e.valid_until) : "—"}
                  </td>
                  <td className="py-2.5 pr-3" onClick={ev => ev.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setViewTarget(e)}>View</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setSelected(null); setEditTarget(e); }}>Edit</DropdownMenuItem>
                        {e.status === "draft" && (
                          <DropdownMenuItem onClick={() => updateStatus(e.id, "sent")}>
                            Mark as Sent
                          </DropdownMenuItem>
                        )}
                        {["sent", "viewed"].includes(e.status) && (
                          <DropdownMenuItem onClick={() => updateStatus(e.id, "accepted")}>
                            Mark as Accepted
                          </DropdownMenuItem>
                        )}
                        {["sent", "viewed"].includes(e.status) && (
                          <DropdownMenuItem
                            onClick={() => updateStatus(e.id, "declined")}
                            className="text-destructive"
                          >
                            Mark as Declined
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeleteTarget(e)}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Card>

      {/* Create Sheet */}
      {orgId && (
        <EstimateFormSheet
          open={newOpen}
          onClose={() => setNewOpen(false)}
          orgId={orgId}
          onSaved={load}
        />
      )}

      {/* Edit Sheet */}
      {orgId && editTarget && (
        <EstimateFormSheet
          open={!!editTarget}
          onClose={() => setEditTarget(null)}
          orgId={orgId}
          onSaved={() => { load(); setEditTarget(null); }}
          estimate={editTarget}
        />
      )}

      {/* Detail Sheet */}
      <EstimateDetailSheet
        estimate={selected}
        onClose={() => setSelected(null)}
        onStatusChange={updateStatus}
        onEdit={e => { setSelected(null); setEditTarget(e); }}
      />

      {/* View Dialog */}
      <EstimateViewDialog
        estimate={viewTarget}
        org={orgInfo}
        onClose={() => setViewTarget(null)}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={o => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete estimate?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.title}" and all its line items will be permanently removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
              onClick={() => deleteTarget && deleteEstimate(deleteTarget)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Shared ────────────────────────────────────────────────────────────────────

function FactBox({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-secondary/40 p-2.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-sm font-semibold tabular-nums", highlight && "text-base text-primary")}>
        {value}
      </div>
    </div>
  );
}