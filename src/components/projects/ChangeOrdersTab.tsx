// src/components/projects/ChangeOrdersTab.tsx
//
// Phase 13.3B — Project → Change Orders. Self-contained: fetches its own
// data keyed on projectId, same "fetch once per open tab" shape as
// ProjectDailyLogsTab/ProjectPhotoGallery, so projects.index.tsx only needs
// to render <ChangeOrdersTab projectId={project.id} />.

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FileText, Loader2, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { ChangeOrderStatusBadge } from "@/components/projects/ChangeOrderStatusBadge";
import { ChangeOrderFormDrawer } from "@/components/projects/ChangeOrderFormDrawer";
import { CHANGE_ORDER_STATUS_LABELS, CHANGE_ORDER_STATUS_ORDER, type ChangeOrderStatus } from "@/lib/change-order-status";
import {
  fetchProjectChangeOrders, createChangeOrderDraft, isChangeOrderOverdue,
  fetchProjectChangeOrderFinancialSummary, fetchEffectiveChangeOrderLineages, latestVersionByLineage,
  type ChangeOrder, type EffectiveChangeOrderLineage,
} from "@/lib/project-change-orders";
import { checkChangeOrderPermission } from "@/lib/change-order-permissions";
import { getOrgId } from "@/lib/contacts-store";
import { supabase } from "@/lib/supabase";

function currency(n: number, code = "USD"): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}${new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(Math.abs(n))}`;
}

// Pending Approval means actually awaiting a customer decision -- only
// sent/viewed. ready_to_send is still internal (never delivered to the
// customer yet), so it must not count here even though it's "pending" in
// a colloquial internal-workflow sense.
const PENDING_STATUSES = new Set<ChangeOrderStatus>(["sent", "viewed"]);
const DRAFT_STATUSES = new Set<ChangeOrderStatus>(["draft", "internal_review"]);

export function ChangeOrdersTab({ projectId, onOpenChangeOrder, initialOpenId }: { projectId: string; onOpenChangeOrder?: (id: string) => void; initialOpenId?: string }) {
  const [orders, setOrders] = useState<ChangeOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ChangeOrderStatus | "all">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newReason, setNewReason] = useState("");
  const [creating, setCreating] = useState(false);
  const [openDrawerId, setOpenDrawerId] = useState<string | null>(null);
  const [canCreate, setCanCreate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const orgId = await getOrgId();
      if (!user || !orgId) return;
      const allowed = await checkChangeOrderPermission(supabase, user.id, orgId, "create");
      if (!cancelled) setCanCreate(allowed);
    })();
    return () => { cancelled = true; };
  }, []);

  async function load() {
    setLoading(true);
    try {
      const rows = await fetchProjectChangeOrders(projectId);
      setOrders(rows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load Change Orders");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [projectId]);

  // Approved Value (round 6, KPI fix): sourced from the same
  // project_financial_adjustments ledger fetchProjectChangeOrderFinancialSummary()
  // uses (status='applied', reversed_at is null) -- not a sum of
  // co.totalAmount for every row whose own status happens to be
  // 'approved', which would double-count a lineage once an earlier
  // version's adjustment has been reversed by a later approved revision.
  // Re-derives whenever `orders` changes (e.g. after `load()` following a
  // send/cancel/etc.), so it reflects an approval recorded elsewhere
  // (the customer's public link) as soon as this tab's data is reloaded,
  // without requiring a full page refresh.
  const [approvedValue, setApprovedValue] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchProjectChangeOrderFinancialSummary(projectId, 0)
      .then((summary) => { if (!cancelled) setApprovedValue(summary.approvedChangeOrdersTotal); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, orders]);

  // Document version vs. financial effectiveness (Part 7) — a lineage's
  // latest revision (highest version) and the version whose approved
  // amount is actually still counted in Revised Contract Value can
  // diverge: sending a revision supersedes the prior document
  // immediately, but that prior version's adjustment is only reversed
  // once the replacement is itself approved (never merely sent/rejected).
  // Read-only lookups over the existing ledger -- no ledger change.
  const [effectiveLineages, setEffectiveLineages] = useState<Map<string, EffectiveChangeOrderLineage>>(new Map());
  useEffect(() => {
    let cancelled = false;
    fetchEffectiveChangeOrderLineages(projectId).then((m) => { if (!cancelled) setEffectiveLineages(m); }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, orders]);
  const latestVersions = useMemo(() => latestVersionByLineage(orders), [orders]);

  // Deep link (Part 39) — opens the referenced Change Order once its row is
  // confirmed to exist; an unknown/invalid id simply never opens anything
  // rather than crashing or showing an empty drawer.
  useEffect(() => {
    if (!initialOpenId || loading) return;
    if (orders.some((o) => o.id === initialOpenId)) setOpenDrawerId(initialOpenId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOpenId, loading, orders]);

  const kpis = useMemo(() => {
    const pending = orders.filter((o) => PENDING_STATUSES.has(o.status));
    const drafts = orders.filter((o) => DRAFT_STATUSES.has(o.status));
    const scheduleImpactDays = orders
      .filter((o) => o.status === "approved")
      .reduce((sum, o) => sum + o.scheduleImpactDays, 0);
    return {
      pendingCount: pending.length,
      pendingValue: pending.reduce((sum, o) => sum + o.totalAmount, 0),
      draftCount: drafts.length,
      scheduleImpactDays,
    };
  }, [orders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (statusFilter !== "all" && o.status !== statusFilter) return false;
      if (!q) return true;
      return o.title.toLowerCase().includes(q) || o.changeOrderNumber.toLowerCase().includes(q);
    });
  }, [orders, search, statusFilter]);

  async function handleCreate() {
    if (!newTitle.trim()) { toast.error("Title is required"); return; }
    setCreating(true);
    try {
      const created = await createChangeOrderDraft({ projectId, title: newTitle.trim(), reason: newReason.trim() || null });
      setCreateOpen(false);
      setNewTitle("");
      setNewReason("");
      await load();
      setOpenDrawerId(created.id);
      onOpenChangeOrder?.(created.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create Change Order");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Change Orders</h3>
          <p className="text-sm text-muted-foreground">Track scope, pricing, schedule changes, and customer approvals.</p>
        </div>
        {canCreate && <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="mr-1 h-4 w-4" />New Change Order</Button>}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">Pending Approval</p>
          <p className="text-lg font-semibold">{kpis.pendingCount}</p>
          <p className="text-xs text-muted-foreground">{currency(kpis.pendingValue)}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">Approved Value</p>
          <p className={`text-lg font-semibold ${approvedValue < 0 ? "text-rose-600" : ""}`}>{currency(approvedValue)}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">Drafts</p>
          <p className="text-lg font-semibold">{kpis.draftCount}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">Schedule Impact</p>
          <p className="text-lg font-semibold">{kpis.scheduleImpactDays > 0 ? "+" : ""}{kpis.scheduleImpactDays}d</p>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search Change Orders..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as ChangeOrderStatus | "all")}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {CHANGE_ORDER_STATUS_ORDER.map((s) => <SelectItem key={s} value={s}>{CHANGE_ORDER_STATUS_LABELS[s]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : filtered.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-2 p-10 text-center">
          <FileText className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">No Change Orders yet</p>
          <p className="text-xs text-muted-foreground">Create one to track a scope, price, or schedule change for this Project.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((co) => {
            const effective = effectiveLineages.get(co.changeOrderNumber);
            const isLatestInLineage = co.version === latestVersions.get(co.changeOrderNumber);
            // This exact version is superseded as a document but its
            // approved amount is still the one counted in Revised
            // Contract Value (the replacement that superseded it was
            // never itself approved).
            const isSupersededButEffective = co.status === "superseded" && effective?.changeOrderId === co.id;
            // This is the newest document in the lineage, but it didn't
            // end in approval — an earlier version remains the active
            // contract amount.
            const showsStaleActiveNote =
              isLatestInLineage && effective && effective.changeOrderId !== co.id &&
              (co.status === "rejected" || co.status === "cancelled" || co.status === "expired");
            return (
              <Card key={co.id} className="cursor-pointer p-3 transition hover:border-primary/40" onClick={() => { setOpenDrawerId(co.id); onOpenChangeOrder?.(co.id); }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{co.changeOrderNumber}</span>
                      <span className="truncate text-sm text-muted-foreground">{co.title}</span>
                      {co.version > 1 && <span className="text-xs text-muted-foreground">v{co.version}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {co.sentAt && <span>Sent {new Date(co.sentAt).toLocaleDateString()}</span>}
                      {co.approvalDueAt && <span>Due {new Date(co.approvalDueAt).toLocaleDateString()}</span>}
                      {co.approvedAt && <span>Approved {new Date(co.approvedAt).toLocaleDateString()}</span>}
                      {co.rejectedAt && <span>Rejected {new Date(co.rejectedAt).toLocaleDateString()}</span>}
                      {co.scheduleImpactDays !== 0 && <span>{co.scheduleImpactDays > 0 ? "+" : ""}{co.scheduleImpactDays}d schedule</span>}
                      <span>Updated {new Date(co.updatedAt).toLocaleDateString()}</span>
                    </div>
                    {showsStaleActiveNote && (
                      <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                        Current approved version: v{effective!.version} · {currency(effective!.amount, co.currency)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`font-semibold ${co.totalAmount < 0 ? "text-rose-600" : ""}`}>{currency(co.totalAmount, co.currency)}</span>
                    <div className="flex flex-col items-end gap-1">
                      <ChangeOrderStatusBadge status={co.status} overdue={isChangeOrderOverdue(co)} />
                      {isSupersededButEffective && (
                        <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-500/10 dark:text-emerald-400">
                          Currently Effective
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Change Order</DialogTitle>
            <DialogDescription>Start a draft — you can add line items, pricing, and schedule impact next.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="e.g. Upgraded kitchen countertops" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label>Internal reason (optional)</Label>
              <Textarea value={newReason} onChange={(e) => setNewReason(e.target.value)} rows={2} placeholder="Why this change is needed" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Create Draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ChangeOrderFormDrawer
        changeOrderId={openDrawerId}
        projectId={projectId}
        open={!!openDrawerId}
        onOpenChange={(open) => { if (!open) setOpenDrawerId(null); }}
        onChanged={() => void load()}
      />
    </div>
  );
}
