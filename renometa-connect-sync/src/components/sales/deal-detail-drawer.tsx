import { useMemo, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Mail, Phone, MessageSquare, FileText, CheckCircle2, XCircle, StickyNote,
  TrendingUp, Calendar, User, Building2, AlertCircle, MapPin, Pencil,
  CalendarClock, UserPlus, Loader2, Trash2,
} from "lucide-react";
import { type Deal, type LostReason } from "@/lib/mock-data";
import { useContacts, updateContact } from "@/lib/contacts-store";
import { useContactActivity, type ActivityKind } from "@/lib/contact-activity";
import { formatMoney, formatDateShort, formatPhone } from "@/lib/format";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const LOST_REASONS: LostReason[] = ["Budget", "Timing", "Scope", "Competitor", "No response"];

function stageName(id: string, stages?: { id: string; name: string }[]) {
  if (stages) return stages.find((s) => s.id === id)?.name ?? id;
  return id;
}

function activityIcon(kind: ActivityKind | string) {
  switch (kind) {
    case "email-out":
    case "email-in":
      return { Icon: Mail, tone: "bg-sky-500/10 text-sky-600 dark:text-sky-400" };
    case "sms":
    case "sms-out":
    case "sms-in":
      return { Icon: MessageSquare, tone: "bg-violet-500/10 text-violet-600 dark:text-violet-400" };
    case "call":
      return { Icon: Phone, tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
    case "note":
      return { Icon: StickyNote, tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400" };
    case "proposal":
    case "invoice":
      return { Icon: FileText, tone: "bg-primary-soft text-primary" };
    case "stage":
    case "deal":
      return { Icon: TrendingUp, tone: "bg-secondary text-foreground" };
    case "appointment":
      return { Icon: CalendarClock, tone: "bg-success/10 text-success" };
    case "lead":
      return { Icon: UserPlus, tone: "bg-primary-soft text-primary" };
    default:
      return { Icon: CheckCircle2, tone: "bg-secondary text-foreground" };
  }
}

export function DealDetailDrawer({
  deal,
  onOpenChange,
  onStageChange,
  onMarkLost,
  onDealUpdate,
  onDelete,
  stages,
  teamMembers,
}: {
  deal: Deal | null;
  onOpenChange: (open: boolean) => void;
  onStageChange?: (dealId: string, newStage: string) => void;
  onMarkLost?: (dealId: string, reason: LostReason, notes: string) => void;
  onDealUpdate?: (dealId: string, patch: Partial<Deal>) => void;
  onDelete?: (dealId: string) => void;
  stages?: { id: string; name: string }[];
  teamMembers?: { id: string; name: string }[];
}) {
  const allContacts = useContacts();
  const contact = useMemo(
    () => (deal ? allContacts.find((c) => c.id === deal.contactId) : null),
    [deal, allContacts],
  );

  // Real activity from Supabase
  const { items: activity, loading: activityLoading } = useContactActivity(deal?.contactId ?? null);

  const [lostOpen, setLostOpen] = useState(false);
  const [lostReason, setLostReason] = useState<LostReason | null>(null);
  const [lostNotes, setLostNotes] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ email: "", phone: "", address: "", stage: "", owner: "" });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [contactEditMode, setContactEditMode] = useState(false);
  const [contactForm, setContactForm] = useState({ email: "", phone: "", address: "" });

  const openEdit = () => {
    if (!deal) return;
    setEditForm({
      email: deal.email ?? "",
      phone: deal.phone ?? "",
      address: deal.address ?? "",
      stage: deal.stage,
      owner: deal.owner,
    });
    setEditOpen(true);
  };

  const saveEdit = () => {
    if (!deal) return;
    const patch: Partial<Deal> = {
      email: editForm.email || undefined,
      phone: editForm.phone || undefined,
      address: editForm.address || undefined,
      stage: editForm.stage,
      owner: editForm.owner,
    };
    onDealUpdate?.(deal.id, patch);
    toast.success("Deal updated");
    setEditOpen(false);
  };

  const handleWon = () => {
    if (!deal) return;
    onStageChange?.(deal.id, "won");
    toast.success(`${deal.name} marked as Won`, {
      description: `${formatMoney(deal.value)} added to closed revenue.`,
    });
    onOpenChange(false);
  };

  const openLost = () => {
    setLostReason(null);
    setLostNotes("");
    setLostOpen(true);
  };

  const confirmLost = () => {
    if (!deal || !lostReason) return;
    onMarkLost?.(deal.id, lostReason, lostNotes);
    toast(`${deal.name} marked as Lost`, {
      description: `Reason: ${lostReason}${lostNotes ? ` · ${lostNotes.slice(0, 60)}` : ""}`,
    });
    setLostOpen(false);
    onOpenChange(false);
  };

  return (
    <>
    <Sheet open={!!deal} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {deal && (
          <>
            <SheetHeader className="space-y-3 border-b border-border pb-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 text-left">
                  <Badge variant="outline" className="mb-1.5 h-5 rounded px-1.5 text-[10px]">
                    {stageName(deal.stage, stages)}
                  </Badge>
                  <SheetTitle className="text-base leading-snug">{deal.name}</SheetTitle>
                  <SheetDescription className="mt-0.5 text-xs">
                    {deal.contactName} · Owned by {deal.owner}
                  </SheetDescription>
                </div>
                <div className="text-right">
                  <div className="text-xl font-semibold tabular-nums">{formatMoney(deal.value)}</div>
                  <div className="text-[11px] text-muted-foreground">Expected {formatDateShort(deal.expectedClose)}</div>
                </div>
              </div>
              {deal.lostReason && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                  <div className="min-w-0">
                    <div className="font-medium text-destructive">Lost · {deal.lostReason}</div>
                    {deal.lostAt && (
                      <div className="text-[11px] text-muted-foreground">
                        {formatDistanceToNow(new Date(deal.lostAt), { addSuffix: true })}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-8 w-8 shrink-0 p-0" onClick={openEdit} aria-label="Edit deal">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" variant="outline" className="h-8 w-8 shrink-0 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDeleteOpen(true)} aria-label="Delete deal">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" className="flex-1 bg-emerald-600 text-white hover:bg-emerald-700" onClick={handleWon}>
                  <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Mark as Won
                </Button>
                <Button size="sm" variant="outline" className="flex-1" onClick={openLost}>
                  <XCircle className="mr-1.5 h-3.5 w-3.5" /> Mark as Lost
                </Button>
              </div>
            </SheetHeader>

            <div className="mt-4 space-y-5">
              {/* Linked contact */}
              <section>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Linked contact</div>
                {contact ? (
                  <div className="flex items-center gap-3 rounded-md border border-border bg-card p-3">
                    <Avatar className="h-10 w-10">
                      <AvatarFallback className="bg-primary-soft text-xs font-medium text-primary">
                        {contact.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{contact.name}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{contact.company}</div>
                    </div>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Email"><Mail className="h-3.5 w-3.5" /></Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Call"><Phone className="h-3.5 w-3.5" /></Button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">No linked contact.</div>
                )}
              </section>

              {/* Contact info */}
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Contact Info</div>
                  {!contactEditMode && (
                    <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px] text-muted-foreground" onClick={() => {
                      setContactForm({ email: deal.email || contact?.email || "", phone: deal.phone || contact?.phone || "", address: deal.address || "" });
                      setContactEditMode(true);
                    }}>
                      <Pencil className="mr-1 h-3 w-3" /> Edit
                    </Button>
                  )}
                </div>
                {contactEditMode ? (
                  <div className="space-y-2.5 rounded-md border border-border bg-card p-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Email</Label>
                      <Input value={contactForm.email} onChange={(e) => setContactForm((p) => ({ ...p, email: e.target.value }))} placeholder="client@example.com" className="h-8 text-sm" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Phone</Label>
                      <Input value={contactForm.phone} onChange={(e) => setContactForm((p) => ({ ...p, phone: formatPhone(e.target.value) }))} placeholder="(555) 123-4567" inputMode="tel" className="h-8 text-sm" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Address</Label>
                      <Input value={contactForm.address} onChange={(e) => setContactForm((p) => ({ ...p, address: e.target.value }))} placeholder="123 Main St" className="h-8 text-sm" />
                    </div>
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" className="h-7 flex-1 text-xs" onClick={async () => {
                        onDealUpdate?.(deal.id, { email: contactForm.email || undefined, phone: contactForm.phone || undefined, address: contactForm.address || undefined });
                        if (contact) {
                          try {
                            await updateContact(contact.id, {
                              email: contactForm.email || contact.email,
                              phone: contactForm.phone || contact.phone,
                              address: contactForm.address || contact.address || "",
                            });
                          } catch { toast.error("Failed to save contact"); return; }
                        }
                        toast.success("Contact info updated");
                        setContactEditMode(false);
                      }}>Save</Button>
                      <Button size="sm" variant="outline" className="h-7 flex-1 text-xs" onClick={() => setContactEditMode(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(deal.email || contact?.email) && (
                      <div className="flex items-center gap-2 text-sm"><Mail className="h-3.5 w-3.5 text-muted-foreground" /><span>{deal.email || contact?.email}</span></div>
                    )}
                    {(deal.phone || contact?.phone) && (
                      <div className="flex items-center gap-2 text-sm"><Phone className="h-3.5 w-3.5 text-muted-foreground" /><a href={`tel:${deal.phone || contact?.phone}`} className="hover:underline">{deal.phone || contact?.phone}</a></div>
                    )}
                    {deal.address && (
                      <div className="flex items-center gap-2 text-sm"><MapPin className="h-3.5 w-3.5 text-muted-foreground" /><a href={`https://maps.google.com/?q=${encodeURIComponent(deal.address)}`} target="_blank" rel="noopener noreferrer" className="hover:underline">{deal.address}</a></div>
                    )}
                    {!deal.email && !contact?.email && !deal.phone && !contact?.phone && !deal.address && (
                      <div className="text-xs text-muted-foreground">No contact info available.</div>
                    )}
                  </div>
                )}
              </section>

              {/* Deal facts */}
              <section className="grid grid-cols-2 gap-3">
                <Fact icon={User} label="Owner" value={deal.owner} />
                <Fact icon={Building2} label="Company" value={contact?.company ?? "—"} />
                <Fact icon={Calendar} label="Age in stage" value={`${deal.ageDays}d`} />
                <Fact icon={TrendingUp} label="Stage" value={stageName(deal.stage, stages)} />
              </section>

              <Separator />

              {/* Activity timeline — real data from Supabase */}
              <section>
                <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Activity</div>
                <div>
                  {activityLoading && (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )}
                  {!activityLoading && activity.length === 0 && (
                    <div className="py-6 text-center text-xs text-muted-foreground">No activity yet.</div>
                  )}
                  {!activityLoading && activity.map((item, i) => {
                    const { Icon, tone } = activityIcon(item.kind);
                    const isLast = i === activity.length - 1;
                    return (
                      <div key={item.id} className="relative flex gap-3 pb-4">
                        {!isLast && <div className="absolute left-[15px] top-8 h-full w-px bg-border" />}
                        <div className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-background ${tone}`}>
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1 pt-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <div className="truncate text-sm font-medium">{item.title}</div>
                            <div className="shrink-0 text-[11px] text-muted-foreground">
                              {formatDistanceToNow(new Date(item.at), { addSuffix: true })}
                            </div>
                          </div>
                          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.body}</div>
                          <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">By {item.by}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>

    <Dialog open={lostOpen} onOpenChange={setLostOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark deal as Lost</DialogTitle>
          <DialogDescription>Capture why this deal didn't close. This helps surface patterns in your pipeline.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Reason</div>
            <div className="grid grid-cols-2 gap-1.5">
              {LOST_REASONS.map((r) => (
                <button key={r} onClick={() => setLostReason(r)} className={`h-9 rounded-md border px-3 text-left text-sm font-medium transition-colors ${lostReason === r ? "border-primary/40 bg-primary-soft text-primary" : "border-border bg-background text-foreground hover:bg-secondary/60"}`}>{r}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Notes (optional)</div>
            <Textarea value={lostNotes} onChange={(e) => setLostNotes(e.target.value)} placeholder="Add context — competitor name, timing details, etc." rows={3} className="resize-none text-sm" />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => setLostOpen(false)}>Cancel</Button>
          <Button variant="destructive" disabled={!lostReason} onClick={confirmLost}>Mark as Lost</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete deal?</DialogTitle>
          <DialogDescription>
            <strong>{deal?.name}</strong> will be permanently removed. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button variant="destructive" onClick={() => {
            if (!deal) return;
            onDelete?.(deal.id);
            setDeleteOpen(false);
            onOpenChange(false);
          }}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={editOpen} onOpenChange={setEditOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Deal</DialogTitle>
          <DialogDescription>Update deal details below.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {stages && stages.length > 0 && (
            <div className="space-y-1.5">
              <Label>Stage</Label>
              <Select value={editForm.stage} onValueChange={(v) => setEditForm((p) => ({ ...p, stage: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{stages.map((s) => (<SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>))}</SelectContent>
              </Select>
            </div>
          )}
          {teamMembers && teamMembers.length > 0 && (
            <div className="space-y-1.5">
              <Label>Owner</Label>
              <Select value={editForm.owner} onValueChange={(v) => setEditForm((p) => ({ ...p, owner: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{teamMembers.map((m) => (<SelectItem key={m.id} value={m.name}>{m.name}</SelectItem>))}</SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input value={editForm.email} onChange={(e) => setEditForm((p) => ({ ...p, email: e.target.value }))} placeholder="client@example.com" />
          </div>
          <div className="space-y-1.5">
            <Label>Phone</Label>
            <Input value={editForm.phone} onChange={(e) => setEditForm((p) => ({ ...p, phone: formatPhone(e.target.value) }))} placeholder="(555) 123-4567" inputMode="tel" />
          </div>
          <div className="space-y-1.5">
            <Label>Address</Label>
            <Input value={editForm.address} onChange={(e) => setEditForm((p) => ({ ...p, address: e.target.value }))} placeholder="123 Main St" />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
          <Button onClick={saveEdit}>Save Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function Fact({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"><Icon className="h-3 w-3" /> {label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  );
}