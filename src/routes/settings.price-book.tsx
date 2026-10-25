// src/routes/settings.price-book.tsx
//
// Pricing Intelligence P4 — Settings → Price Book. Staff-managed, organization-owned reference prices used to SUGGEST pricing on
// estimates (Price Book first, then past-estimate history). Suggestions are never applied automatically.
//
// All reads and writes go through the trusted /price-book function (owner/admin only): the organization and reviewer are resolved
// server-side, and normalization happens there. Internal cost and markup are staff-only configuration — they are shown here to the
// owner/admin who manages the book and are never used to derive a sell price or shown to customers or the AI.
import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { BookOpen, Loader2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { createPriceBookItem, listPriceBookItems, updatePriceBookItem, type PriceBookRow } from "@/lib/price-book-api";
import { PRICE_BOOK_ITEM_TYPES } from "@/lib/pricing/price-book";
import { PROJECT_TYPES } from "@/lib/pricing/project-type";

export const Route = createFileRoute("/settings/price-book")({ component: PriceBookSettings });

const money = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" }));
const label = (s: string) => s.replace(/_/g, " ");
const NO_TYPE = "__none__";

type Draft = {
  name: string; aliases: string; projectTypes: string[]; itemType: string; unit: string;
  sell: string; low: string; high: string; cost: string; markup: string;
  taxable: boolean; active: boolean; reviewed: boolean; notes: string;
};
const EMPTY: Draft = { name: "", aliases: "", projectTypes: [], itemType: NO_TYPE, unit: "each", sell: "", low: "", high: "", cost: "", markup: "", taxable: true, active: true, reviewed: false, notes: "" };

function toDraft(r: PriceBookRow): Draft {
  const s = (n: number | null) => (n === null ? "" : String(n));
  return {
    name: r.name, aliases: r.aliases.join(", "), projectTypes: r.projectTypes, itemType: r.itemType ?? NO_TYPE, unit: r.unit,
    sell: s(r.sellUnitPrice), low: s(r.lowUnitPrice), high: s(r.highUnitPrice), cost: s(r.internalUnitCost), markup: s(r.defaultMarkupPercent),
    taxable: r.taxable, active: r.active, reviewed: !!r.reviewedAt, notes: r.notes ?? "",
  };
}

const optNum = (v: string): number | null => (v.trim() === "" ? null : Number(v));

function draftToInput(d: Draft) {
  return {
    name: d.name.trim(),
    aliases: d.aliases.split(",").map((a) => a.trim()).filter(Boolean),
    projectTypes: d.projectTypes as (typeof PROJECT_TYPES)[number][],
    itemType: d.itemType === NO_TYPE ? null : (d.itemType as (typeof PRICE_BOOK_ITEM_TYPES)[number]),
    unit: d.unit.trim(),
    sellUnitPrice: Number(d.sell),
    lowUnitPrice: optNum(d.low),
    highUnitPrice: optNum(d.high),
    internalUnitCost: optNum(d.cost),
    defaultMarkupPercent: optNum(d.markup),
    taxable: d.taxable,
    active: d.active,
    notes: d.notes.trim() === "" ? null : d.notes.trim(),
    reviewed: d.reviewed,
  };
}

function PriceBookSettings() {
  const [items, setItems] = useState<PriceBookRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "inactive">("active");
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setItems(await listPriceBookItems({ q, active: activeFilter })); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load the Price Book."); }
    finally { setLoading(false); }
  }, [q, activeFilter]);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 200);
    return () => clearTimeout(t);
  }, [load]);

  const draftError = useMemo(() => {
    if (!editing) return null;
    const d = editing.draft;
    if (!d.name.trim()) return "Name is required.";
    if (!d.unit.trim()) return "Unit is required.";
    if (d.sell.trim() === "" || !Number.isFinite(Number(d.sell)) || Number(d.sell) < 0) return "Enter a valid sell price (0 or more).";
    const low = optNum(d.low), high = optNum(d.high), sell = Number(d.sell);
    if (low !== null && (!Number.isFinite(low) || low < 0 || low > sell)) return "Low price must be between 0 and the sell price.";
    if (high !== null && (!Number.isFinite(high) || high < sell)) return "High price must be at least the sell price.";
    return null;
  }, [editing]);

  async function save() {
    if (!editing || draftError) return;
    setSaving(true);
    try {
      const input = draftToInput(editing.draft);
      if (editing.id) await updatePriceBookItem(editing.id, input);
      else await createPriceBookItem(input);
      toast.success("Price book saved");
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the price book entry.");
    } finally { setSaving(false); }
  }

  async function toggleActive(row: PriceBookRow) {
    try { await updatePriceBookItem(row.id, { active: !row.active }); await load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not update the entry."); }
  }

  const set = (patch: Partial<Draft>) => setEditing((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...patch } } : cur));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><BookOpen className="h-4 w-4" />Price Book</h2>
          <p className="text-xs text-muted-foreground">Reference prices used to suggest pricing on estimates. Suggestions are for staff review only and are never applied automatically.</p>
        </div>
        <Button size="sm" className="gap-1" onClick={() => setEditing({ id: null, draft: EMPTY })}><Plus className="h-3.5 w-3.5" />Add item</Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 max-w-xs text-sm" placeholder="Search name, alias, type…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={activeFilter} onValueChange={(v) => setActiveFilter(v as typeof activeFilter)}>
          <SelectTrigger className="h-8 w-36 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="overflow-x-auto">
        {loading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
        ) : error ? (
          <p className="p-4 text-sm text-destructive">{error}</p>
        ) : items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No price book items yet. Add the items you price most often.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2">Item</th><th className="px-3 py-2">Unit</th><th className="px-3 py-2 text-right">Sell</th>
                <th className="px-3 py-2">Project types</th><th className="px-3 py-2">Status</th><th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.name}</div>
                    {r.aliases.length > 0 && <div className="text-[11px] text-muted-foreground">Also: {r.aliases.join(", ")}</div>}
                  </td>
                  <td className="px-3 py-2">{r.unit}</td>
                  <td className="px-3 py-2 text-right">{money(r.sellUnitPrice)}</td>
                  <td className="px-3 py-2 text-xs">{r.projectTypes.length ? r.projectTypes.map(label).join(", ") : "Any"}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <Badge variant={r.active ? "secondary" : "outline"} className="h-5 text-[10px]">{r.active ? "Active" : "Inactive"}</Badge>
                      <Badge variant="outline" className="h-5 text-[10px]">{r.reviewedAt ? `Reviewed ${new Date(r.reviewedAt).toLocaleDateString()}` : "Not reviewed"}</Badge>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Edit ${r.name}`} onClick={() => setEditing({ id: r.id, draft: toDraft(r) })}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => toggleActive(r)}>{r.active ? "Deactivate" : "Activate"}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Dialog open={!!editing} onOpenChange={(o) => !o && !saving && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Edit price book item" : "Add price book item"}</DialogTitle>
            <DialogDescription>Staff-only. The sell price is what gets suggested; internal cost and markup are never shown to customers or the AI.</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1"><Label className="text-xs">Name</Label><Input value={editing.draft.name} onChange={(e) => set({ name: e.target.value })} /></div>
              <div className="col-span-2 space-y-1"><Label className="text-xs">Aliases (comma separated)</Label><Input value={editing.draft.aliases} onChange={(e) => set({ aliases: e.target.value })} /></div>
              <div className="space-y-1">
                <Label className="text-xs">Item type</Label>
                <Select value={editing.draft.itemType} onValueChange={(v) => set({ itemType: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TYPE}>Any</SelectItem>
                    {PRICE_BOOK_ITEM_TYPES.map((t) => <SelectItem key={t} value={t}>{label(t)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1"><Label className="text-xs">Unit</Label><Input value={editing.draft.unit} onChange={(e) => set({ unit: e.target.value })} placeholder="sqft, hour, each…" /></div>
              <div className="space-y-1"><Label className="text-xs">Sell price</Label><Input inputMode="decimal" value={editing.draft.sell} onChange={(e) => set({ sell: e.target.value })} /></div>
              <div className="space-y-1"><Label className="text-xs">Taxable</Label><div className="pt-1.5"><Switch checked={editing.draft.taxable} onCheckedChange={(v) => set({ taxable: v })} /></div></div>
              <div className="space-y-1"><Label className="text-xs">Low (optional)</Label><Input inputMode="decimal" value={editing.draft.low} onChange={(e) => set({ low: e.target.value })} /></div>
              <div className="space-y-1"><Label className="text-xs">High (optional)</Label><Input inputMode="decimal" value={editing.draft.high} onChange={(e) => set({ high: e.target.value })} /></div>
              <div className="space-y-1"><Label className="text-xs">Internal cost (staff only)</Label><Input inputMode="decimal" value={editing.draft.cost} onChange={(e) => set({ cost: e.target.value })} /></div>
              <div className="space-y-1"><Label className="text-xs">Markup % (staff only)</Label><Input inputMode="decimal" value={editing.draft.markup} onChange={(e) => set({ markup: e.target.value })} /></div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Project types (none selected = applies to any)</Label>
                <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                  {PROJECT_TYPES.map((t) => (
                    <label key={t} className="flex items-center gap-1.5 text-xs capitalize">
                      <Checkbox
                        checked={editing.draft.projectTypes.includes(t)}
                        onCheckedChange={(c) => set({ projectTypes: c ? [...editing.draft.projectTypes, t] : editing.draft.projectTypes.filter((x) => x !== t) })}
                      />
                      {label(t)}
                    </label>
                  ))}
                </div>
              </div>
              <div className="col-span-2 space-y-1"><Label className="text-xs">Notes (staff only)</Label><Textarea rows={2} value={editing.draft.notes} onChange={(e) => set({ notes: e.target.value })} /></div>
              <label className="flex items-center gap-2 text-xs"><Switch checked={editing.draft.active} onCheckedChange={(v) => set({ active: v })} />Active</label>
              <label className="flex items-center gap-2 text-xs"><Switch checked={editing.draft.reviewed} onCheckedChange={(v) => set({ reviewed: v })} />Reviewed</label>
            </div>
          )}
          {draftError && <p className="text-xs text-destructive">{draftError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving || !!draftError}>{saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
