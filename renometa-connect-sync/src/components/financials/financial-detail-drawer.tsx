import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Send,
  Eye,
  CheckCircle2,
  Download,
  FileText,
  CreditCard,
  Mail,
  XCircle,
  Clock,
  Receipt,
  type LucideIcon,
} from "lucide-react";
import { formatDate, formatMoney, daysFromNow } from "@/lib/format";
import { mockInvoices, type Estimate, type Invoice } from "@/lib/mock-data";
import {
  addDraftInvoice,
  nextDraftInvoiceNumber,
  defaultSchedule,
  useDraftInvoice,
  updateDraftInvoice,
  updateDraftSchedule,
  type DraftSchedule,
  type PaymentMilestone,
} from "@/lib/draft-invoices";
import { scheduleFromInvoice } from "@/lib/scheduled-payments";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, CalendarDays } from "lucide-react";

type Kind = "estimate" | "invoice";

export type FinancialRecord =
  | ({ kind: "estimate" } & Estimate)
  | ({ kind: "invoice" } & Invoice);

export function FinancialDetailDrawer({
  record,
  onOpenChange,
}: {
  record: FinancialRecord | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = record !== null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full p-0 sm:max-w-xl"
      >
        {record && <DrawerBody record={record} onClose={() => onOpenChange(false)} />}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({ record, onClose }: { record: FinancialRecord; onClose: () => void }) {
  const kind: Kind = record.kind;
  const isInvoice = kind === "invoice";
  const items = generateLineItems(record);
  const subtotal = items.reduce((s, it) => s + it.qty * it.price, 0);
  const tax = Math.round(subtotal * 0.0825);
  const total = subtotal + tax;
  const activity = generateActivity(record);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [localStatus, setLocalStatus] = useState<string>(record.status);
  const [convertedTo, setConvertedTo] = useState<string | null>(null);
  const navigate = useNavigate();

  // Draft invoice editing — only when this invoice came from the cross-route draft store.
  const draftId = isInvoice && record.id.startsWith("inv-draft-") ? record.id : undefined;
  const { invoice: draftInvoice, schedule: draftSchedule } = useDraftInvoice(draftId);
  const isDraft = isInvoice && localStatus === "Draft" && !!draftId;
  const currentDue = draftInvoice?.due ?? (isInvoice ? (record as Invoice).due : "");
  const currentSchedule: DraftSchedule =
    draftSchedule ?? { milestones: [{ id: "m1", label: "Full payment", percent: 100, dueDate: currentDue }] };

  const setDue = (date: string) => {
    if (!draftId) return;
    updateDraftInvoice(draftId, { due: date });
  };
  const setSchedule = (next: DraftSchedule) => {
    if (!draftId) return;
    updateDraftSchedule(draftId, next);
  };
  const updateMilestone = (id: string, patch: Partial<PaymentMilestone>) => {
    setSchedule({
      milestones: currentSchedule.milestones.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });
  };
  const addMilestone = () => {
    const last = currentSchedule.milestones[currentSchedule.milestones.length - 1];
    const baseDate = last?.dueDate ?? currentDue;
    const next = new Date(new Date(baseDate).getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    setSchedule({
      milestones: [
        ...currentSchedule.milestones,
        { id: `m${Date.now()}`, label: "Progress payment", percent: 0, dueDate: next },
      ],
    });
  };
  const removeMilestone = (id: string) => {
    setSchedule({ milestones: currentSchedule.milestones.filter((m) => m.id !== id) });
  };
  const percentSum = currentSchedule.milestones.reduce((s, m) => s + (Number(m.percent) || 0), 0);
  const scheduleBalanced = Math.round(percentSum) === 100;

  const label = isInvoice ? "Invoice" : "Estimate";
  const handleSend = () => {
    setLocalStatus("Sent");
    // For draft invoices with a payment schedule, push one Scheduled payment row per milestone
    // so /financials/payments reflects expected cashflow.
    if (isInvoice && draftId && currentSchedule.milestones.length > 0) {
      updateDraftInvoice(draftId, { status: "Sent" });
      scheduleFromInvoice({
        invoiceNumber: record.number,
        client: record.client,
        total,
        schedule: currentSchedule,
      });
      toast.success(`${label} ${record.number} sent to ${record.client}`, {
        description: `Scheduled ${currentSchedule.milestones.length} payment${currentSchedule.milestones.length === 1 ? "" : "s"} on cashflow`,
        action: {
          label: "View payments",
          onClick: () => navigate({ to: "/financials/payments" }),
        },
      });
      return;
    }
    toast.success(`${label} ${record.number} sent to ${record.client}`);
  };
  const handleReminder = () => {
    toast.success(`Reminder sent to ${record.client}`);
  };
  const handleMarkPaid = () => {
    setLocalStatus("Paid");
    toast.success(`${record.number} marked as paid · ${formatMoney(total)}`);
  };
  const handleAccept = () => {
    setLocalStatus("Accepted");
    toast.success(`${record.number} marked accepted`);
  };
  const handleDownload = () => {
    toast.success(`Downloading ${record.number}.pdf`);
  };
  const handleConvertToInvoice = () => {
    if (record.kind !== "estimate") return;
    const today = new Date();
    const due = new Date(today.getTime() + 30 * 86_400_000);
    const number = nextDraftInvoiceNumber(mockInvoices.length);
    const id = `inv-draft-${Date.now()}`;
    const draft: Invoice = {
      id,
      number,
      client: record.client,
      amount: total,
      status: "Draft",
      due: due.toISOString().slice(0, 10),
    };
    addDraftInvoice(draft, defaultSchedule(today.toISOString().slice(0, 10)));
    setConvertedTo(number);
    toast.success(`Created Draft ${number} from ${record.number}`, {
      description: `${items.length} line items · ${formatMoney(total)} · deposit + 2 milestones`,
      action: {
        label: "Open Invoices",
        onClick: () => navigate({ to: "/financials/invoices" }),
      },
    });
  };

  // Header status meta
  const statusTone = getStatusTone(record);
  const dateLabel = isInvoice
    ? buildDueLabel(record as Invoice)
    : `Issued ${formatDate((record as Estimate).issued)}`;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <SheetHeader className="space-y-0 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="h-5 rounded px-1.5 text-[10px] font-medium uppercase tracking-wide"
          >
            {kind}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">{record.number}</span>
          <Badge
            variant="secondary"
            className={`ml-auto h-5 rounded px-1.5 text-[10px] ${statusTone}`}
          >
            {localStatus}
          </Badge>
        </div>
        <SheetTitle className="mt-2 text-lg font-semibold">{record.client}</SheetTitle>
        <div className="mt-0.5 flex items-baseline justify-between">
          <div className="text-2xl font-semibold tabular-nums">{formatMoney(total)}</div>
          <div className="text-[11px] text-muted-foreground">{dateLabel}</div>
        </div>
      </SheetHeader>

      <ScrollArea className="flex-1">
        <div className="space-y-5 px-5 py-4">
          {/* Line items */}
          <Section title="Line items">
            <div className="overflow-hidden rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-secondary/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Description</th>
                    <th className="w-12 px-2 py-2 text-right font-medium">Qty</th>
                    <th className="w-20 px-2 py-2 text-right font-medium">Price</th>
                    <th className="w-24 px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, idx) => (
                    <tr key={idx} className="border-t border-border">
                      <td className="px-3 py-2">
                        <div className="font-medium text-foreground">{it.title}</div>
                        <div className="text-[11px] text-muted-foreground">{it.note}</div>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{it.qty}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatMoney(it.price)}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {formatMoney(it.qty * it.price)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="space-y-1 border-t border-border bg-secondary/20 px-3 py-2 text-xs">
                <Row label="Subtotal" value={formatMoney(subtotal)} />
                <Row label="Tax (8.25%)" value={formatMoney(tax)} />
                <Separator className="my-1" />
                <Row label="Total" value={formatMoney(total)} bold />
              </div>
            </div>
          </Section>

          {/* Editable due date + payment schedule for draft invoices */}
          {isDraft && (
            <Section title="Payment schedule">
              <div className="rounded-md border border-border">
                <div className="flex flex-wrap items-end gap-3 border-b border-border bg-secondary/20 px-3 py-2.5">
                  <div className="flex-1 min-w-[180px]">
                    <Label htmlFor="due-date" className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                      <CalendarDays className="h-3 w-3" /> Final due date
                    </Label>
                    <Input
                      id="due-date"
                      type="date"
                      value={currentDue}
                      onChange={(e) => setDue(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Net{" "}
                    <span className="font-medium text-foreground">
                      {Math.max(0, daysFromNow(currentDue))}
                    </span>{" "}
                    days from today
                  </div>
                </div>

                <div className="divide-y divide-border">
                  {currentSchedule.milestones.map((m, idx) => {
                    const amount = Math.round((total * (Number(m.percent) || 0)) / 100);
                    return (
                      <div key={m.id} className="grid grid-cols-12 items-center gap-2 px-3 py-2">
                        <div className="col-span-1 text-[10px] font-mono text-muted-foreground">
                          {String(idx + 1).padStart(2, "0")}
                        </div>
                        <Input
                          value={m.label}
                          onChange={(e) => updateMilestone(m.id, { label: e.target.value })}
                          className="col-span-4 h-7 text-xs"
                          placeholder="Label"
                        />
                        <div className="col-span-2 flex items-center gap-1">
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            value={m.percent}
                            onChange={(e) =>
                              updateMilestone(m.id, { percent: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })
                            }
                            className="h-7 text-xs tabular-nums"
                          />
                          <span className="text-[11px] text-muted-foreground">%</span>
                        </div>
                        <Input
                          type="date"
                          value={m.dueDate}
                          onChange={(e) => updateMilestone(m.id, { dueDate: e.target.value })}
                          className="col-span-3 h-7 text-xs"
                        />
                        <div className="col-span-1 text-right text-xs font-medium tabular-nums">
                          {formatMoney(amount)}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeMilestone(m.id)}
                          disabled={currentSchedule.milestones.length <= 1}
                          className="col-span-1 inline-flex h-7 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-destructive disabled:opacity-30"
                          aria-label="Remove milestone"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between border-t border-border bg-secondary/20 px-3 py-2 text-xs">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs"
                    onClick={addMilestone}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add milestone
                  </Button>
                  <div className="flex items-center gap-3">
                    <span
                      className={
                        scheduleBalanced
                          ? "text-success"
                          : "text-destructive"
                      }
                    >
                      {percentSum.toFixed(0)}% allocated
                    </span>
                    <span className="text-muted-foreground">
                      Total: <span className="font-medium tabular-nums text-foreground">{formatMoney(total)}</span>
                    </span>
                  </div>
                </div>
              </div>
            </Section>
          )}


          <Section title="Activity">
            <ol className="relative space-y-3 border-l border-border pl-4">
              {activity.map((a, i) => (
                <li key={i} className="relative">
                  <span
                    className={`absolute -left-[21px] top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border bg-background ${a.tone}`}
                  >
                    <a.icon className="h-2 w-2" />
                  </span>
                  <div className="text-xs font-medium">{a.title}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {a.actor} · {formatDate(a.at)}
                  </div>
                </li>
              ))}
            </ol>
          </Section>
        </div>
      </ScrollArea>

      {/* Footer actions */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-background px-5 py-3">
        {isInvoice ? (
          <>
            {isDraft ? (
              <Button
                size="sm"
                className="h-8 gap-1.5"
                onClick={handleSend}
                disabled={!scheduleBalanced}
                title={scheduleBalanced ? undefined : "Schedule must total 100% before sending"}
              >
                <Send className="h-3.5 w-3.5" />
                Send invoice
              </Button>
            ) : (
              <Button size="sm" className="h-8 gap-1.5" onClick={handleMarkPaid} disabled={localStatus === "Paid"}>
                <CheckCircle2 className="h-3.5 w-3.5" />
                {localStatus === "Paid" ? "Paid" : "Mark as paid"}
              </Button>
            )}
            {!isDraft && (
              <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={handleReminder}>
                <Send className="h-3.5 w-3.5" />
                Send reminder
              </Button>
            )}
          </>
        ) : (
          <>
            <Button size="sm" className="h-8 gap-1.5" onClick={handleSend}>
              <Send className="h-3.5 w-3.5" />
              Send to client
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              onClick={handleAccept}
              disabled={localStatus === "Accepted" || localStatus === "Declined"}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {localStatus === "Accepted" ? "Accepted" : "Mark accepted"}
            </Button>
            {localStatus === "Accepted" && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 border-success/40 bg-success/10 text-success hover:bg-success/15 hover:text-success"
                onClick={handleConvertToInvoice}
                disabled={convertedTo !== null}
              >
                <Receipt className="h-3.5 w-3.5" />
                {convertedTo ? `Converted · ${convertedTo}` : "Convert to invoice"}
              </Button>
            )}
          </>
        )}
        <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={handleDownload}>
          <Download className="h-3.5 w-3.5" />
          PDF
        </Button>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => setPreviewOpen(true)}>
          <Eye className="h-3.5 w-3.5" />
          Preview
        </Button>
        <div className="ml-auto">
          <Button size="sm" variant="ghost" className="h-8" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>

      <PdfPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        record={record}
        items={items}
        subtotal={subtotal}
        tax={tax}
        total={total}
      />
    </div>
  );
}

function PdfPreviewDialog({
  open,
  onOpenChange,
  record,
  items,
  subtotal,
  tax,
  total,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  record: FinancialRecord;
  items: { title: string; note: string; qty: number; price: number }[];
  subtotal: number;
  tax: number;
  total: number;
}) {
  const isInvoice = record.kind === "invoice";
  const dateLine = isInvoice
    ? `Due ${formatDate((record as Invoice).due)}`
    : `Issued ${formatDate((record as Estimate).issued)}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0">
        <DialogHeader className="border-b border-border px-6 py-3">
          <DialogTitle className="text-sm font-medium text-muted-foreground">
            PDF Preview · {record.number}
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[75vh]">
          <div className="bg-secondary/30 p-6">
            <div className="mx-auto max-w-[640px] rounded-md bg-white p-10 text-slate-900 shadow-lg">
              <div className="flex items-start justify-between border-b border-slate-200 pb-6">
                <div>
                  <div className="text-2xl font-semibold tracking-tight">Romero & Co.</div>
                  <div className="mt-1 text-xs text-slate-500">
                    412 Maple Ave · Austin, TX 78704<br />
                    hello@romero.co · (512) 555-0144
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                    {isInvoice ? "Invoice" : "Estimate"}
                  </div>
                  <div className="mt-1 font-mono text-sm">{record.number}</div>
                  <div className="mt-2 text-xs text-slate-500">{dateLine}</div>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-2 gap-4 text-xs">
                <div>
                  <div className="font-semibold uppercase tracking-wide text-slate-400">Bill to</div>
                  <div className="mt-1 font-medium text-slate-800">{record.client}</div>
                </div>
                <div className="text-right">
                  <div className="font-semibold uppercase tracking-wide text-slate-400">Amount due</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">{formatMoney(total)}</div>
                </div>
              </div>

              <table className="mt-6 w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-300 text-[10px] uppercase tracking-wide text-slate-500">
                    <th className="py-2 text-left font-semibold">Description</th>
                    <th className="w-12 py-2 text-right font-semibold">Qty</th>
                    <th className="w-20 py-2 text-right font-semibold">Price</th>
                    <th className="w-24 py-2 text-right font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, idx) => (
                    <tr key={idx} className="border-b border-slate-100">
                      <td className="py-2">
                        <div className="font-medium">{it.title}</div>
                        <div className="text-[10px] text-slate-500">{it.note}</div>
                      </td>
                      <td className="py-2 text-right tabular-nums">{it.qty}</td>
                      <td className="py-2 text-right tabular-nums">{formatMoney(it.price)}</td>
                      <td className="py-2 text-right tabular-nums">{formatMoney(it.qty * it.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mt-4 ml-auto w-56 space-y-1 text-xs">
                <div className="flex justify-between text-slate-500">
                  <span>Subtotal</span>
                  <span className="tabular-nums">{formatMoney(subtotal)}</span>
                </div>
                <div className="flex justify-between text-slate-500">
                  <span>Tax (8.25%)</span>
                  <span className="tabular-nums">{formatMoney(tax)}</span>
                </div>
                <div className="mt-1 flex justify-between border-t border-slate-300 pt-2 text-sm font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">{formatMoney(total)}</span>
                </div>
              </div>

              <div className="mt-10 border-t border-slate-200 pt-4 text-[10px] text-slate-400">
                Thank you for your business. Payment is due within 30 days of receipt.
              </div>
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={bold ? "font-semibold" : "text-muted-foreground"}>{label}</span>
      <span className={`tabular-nums ${bold ? "font-semibold" : ""}`}>{value}</span>
    </div>
  );
}

// ---------- helpers ----------

function getStatusTone(r: FinancialRecord): string {
  if (r.kind === "invoice") {
    return {
      Draft: "bg-secondary text-secondary-foreground",
      Sent: "bg-primary-soft text-primary",
      Viewed: "bg-chart-2/15 text-chart-2",
      Paid: "bg-success/15 text-success",
      Overdue: "bg-destructive/15 text-destructive",
    }[r.status];
  }
  return {
    Draft: "bg-secondary text-secondary-foreground",
    Sent: "bg-primary-soft text-primary",
    Viewed: "bg-chart-2/15 text-chart-2",
    Accepted: "bg-success/15 text-success",
    Declined: "bg-destructive/15 text-destructive",
  }[r.status];
}

function buildDueLabel(i: Invoice): string {
  if (i.status === "Paid") return `Paid · due ${formatDate(i.due)}`;
  const d = daysFromNow(i.due);
  if (d === 0) return `Due today · ${formatDate(i.due)}`;
  if (d > 0) return `Due in ${d}d · ${formatDate(i.due)}`;
  return `${Math.abs(d)}d overdue · ${formatDate(i.due)}`;
}

// Deterministic line items derived from the record's amount.
function generateLineItems(r: FinancialRecord) {
  const seedNum = parseInt(r.number.replace(/\D/g, ""), 10) || 1;
  const catalogs =
    r.kind === "invoice"
      ? [
          { title: "Demolition & site prep", note: "Labor + disposal" },
          { title: "Cabinetry installation", note: "Custom shaker, soft-close" },
          { title: "Quartz countertops", note: "Calacatta, eased edge" },
          { title: "Plumbing rough-in", note: "Includes fixtures" },
          { title: "Electrical & lighting", note: "Recessed + under-cabinet" },
          { title: "Tile & backsplash", note: "Material + install" },
        ]
      : [
          { title: "Design & planning", note: "Concepts + 3D renderings" },
          { title: "Materials allowance", note: "Estimated, refined at selections" },
          { title: "Labor — framing & rough-in", note: "Crew of 3, ~10 days" },
          { title: "Finishes & millwork", note: "Trim, paint, fixtures" },
          { title: "Project management", note: "Coordination & inspections" },
        ];

  const count = 3 + (seedNum % 3); // 3-5 items
  const baseTotal = r.amount;
  const weights = Array.from({ length: count }, (_, i) => 0.4 - i * 0.07 + ((seedNum + i) % 3) * 0.05);
  const wSum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w, i) => {
    const item = catalogs[(seedNum + i) % catalogs.length];
    const amount = Math.max(250, Math.round((baseTotal * w) / wSum / 50) * 50);
    const qty = 1 + ((seedNum + i) % 3);
    const price = Math.max(50, Math.round(amount / qty / 25) * 25);
    return { ...item, qty, price };
  });
}

type ActivityItem = { title: string; actor: string; at: string; icon: LucideIcon; tone: string };

function generateActivity(r: FinancialRecord): ActivityItem[] {
  const baseDate = r.kind === "invoice" ? (r as Invoice).due : (r as Estimate).issued;
  const base = new Date(baseDate).getTime();
  const day = 86_400_000;
  const owner = "Alex Romero";

  const created: ActivityItem = {
    title: r.kind === "invoice" ? "Invoice created" : "Estimate created",
    actor: owner,
    at: new Date(base - 7 * day).toISOString(),
    icon: FileText,
    tone: "text-muted-foreground",
  };
  const sent: ActivityItem = {
    title: r.kind === "invoice" ? "Sent to client" : "Sent to client for review",
    actor: owner,
    at: new Date(base - 5 * day).toISOString(),
    icon: Mail,
    tone: "text-primary",
  };
  const viewed: ActivityItem = {
    title: "Viewed by client",
    actor: r.client,
    at: new Date(base - 3 * day).toISOString(),
    icon: Eye,
    tone: "text-chart-2",
  };
  const reminder: ActivityItem = {
    title: "Reminder sent",
    actor: "Workflow · Auto-reminder",
    at: new Date(base - 1 * day).toISOString(),
    icon: Clock,
    tone: "text-warning",
  };

  if (r.kind === "invoice") {
    const inv = r as Invoice;
    if (inv.status === "Draft") return [created];
    if (inv.status === "Sent") return [created, sent];
    if (inv.status === "Viewed") return [created, sent, viewed];
    if (inv.status === "Overdue")
      return [
        created,
        sent,
        viewed,
        reminder,
        {
          title: "Marked overdue",
          actor: "System",
          at: new Date(base + 1 * day).toISOString(),
          icon: XCircle,
          tone: "text-destructive",
        },
      ];
    // Paid
    return [
      created,
      sent,
      viewed,
      {
        title: `Payment received · ${formatMoney(inv.amount)}`,
        actor: r.client,
        at: new Date(base + 2 * day).toISOString(),
        icon: CreditCard,
        tone: "text-success",
      },
    ];
  }

  const est = r as Estimate;
  if (est.status === "Draft") return [created];
  if (est.status === "Sent") return [created, sent];
  if (est.status === "Viewed") return [created, sent, viewed];
  if (est.status === "Declined")
    return [
      created,
      sent,
      viewed,
      {
        title: "Declined by client",
        actor: r.client,
        at: new Date(base + 2 * day).toISOString(),
        icon: XCircle,
        tone: "text-destructive",
      },
    ];
  // Accepted
  return [
    created,
    sent,
    viewed,
    {
      title: "Accepted — ready to invoice",
      actor: r.client,
      at: new Date(base + 2 * day).toISOString(),
      icon: CheckCircle2,
      tone: "text-success",
    },
  ];
}
