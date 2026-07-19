import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CreditCard,
  Banknote,
  Building2,
  FileText,
  RotateCcw,
  Download,
  CheckCircle2,
  Mail,
  Hash,
  Calendar,
  BellRing,
} from "lucide-react";
import { formatDate, formatMoney, daysFromNow } from "@/lib/format";
import { mockInvoices, type Payment } from "@/lib/mock-data";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { logReminder, useReminders } from "@/lib/payment-reminders";

export function PaymentDetailDrawer({
  payment,
  onOpenChange,
}: {
  payment: Payment | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = payment !== null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full p-0 sm:max-w-xl">
        {payment && <Body payment={payment} onClose={() => onOpenChange(false)} />}
      </SheetContent>
    </Sheet>
  );
}

function Body({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const [refunded, setRefunded] = useState(false);
  const linkedInvoice = useMemo(
    () => mockInvoices.find((i) => i.number === payment.invoice),
    [payment.invoice],
  );
  const seed = parseInt(payment.id.replace(/\D/g, ""), 10) || 1;
  const txnId = `txn_${(seed * 9173).toString(36).toUpperCase()}${seed}A`;
  const methodMeta = getMethodMeta(payment, seed);
  const fee = Math.round(payment.amount * methodMeta.feeRate);
  const net = payment.amount - fee;

  const handleRefund = () => {
    setRefunded(true);
    toast.success(`Refund of ${formatMoney(payment.amount)} initiated to ${payment.client}`);
  };
  const handleReceipt = () => {
    toast.success(`Receipt emailed to ${payment.client}`);
  };
  const handleDownload = () => {
    toast.success(`Downloading receipt-${payment.id}.pdf`);
  };

  const isScheduled = payment.status === "Scheduled";
  const isPastDue =
    isScheduled && daysFromNow(payment.dueDate ?? payment.receivedAt) < 0;
  const allReminders = useReminders();
  const reminders = useMemo(
    () => allReminders.filter((r) => r.paymentId === payment.id),
    [allReminders, payment.id],
  );
  const handleSendReminder = () => {
    logReminder(payment.id);
    toast.success(`Reminder sent to ${payment.client}`, {
      description: `${payment.milestoneLabel ?? "Milestone"} · ${formatMoney(payment.amount)}`,
    });
  };
  return (
    <div className="flex h-full flex-col">
      <SheetHeader className="space-y-0 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="h-5 rounded px-1.5 text-[10px] font-medium uppercase tracking-wide"
          >
            {isScheduled ? "Scheduled" : "Payment"}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">{txnId}</span>
          <Badge
            variant="secondary"
            className={`ml-auto h-5 rounded px-1.5 text-[10px] ${
              refunded
                ? "bg-destructive/15 text-destructive"
                : isScheduled
                  ? "bg-primary-soft text-primary"
                  : "bg-success/15 text-success"
            }`}
          >
            {refunded ? "Refunded" : isScheduled ? "Scheduled" : "Received"}
          </Badge>
        </div>
        <SheetTitle className="mt-2 text-lg font-semibold">{payment.client}</SheetTitle>
        {isScheduled && payment.milestoneLabel && (
          <div className="mt-0.5 text-xs text-muted-foreground">{payment.milestoneLabel}</div>
        )}
        <div className="mt-0.5 flex items-baseline justify-between">
          <div
            className={`text-2xl font-semibold tabular-nums ${
              refunded
                ? "text-muted-foreground line-through"
                : isScheduled
                  ? "text-primary"
                  : "text-success"
            }`}
          >
            {isScheduled ? "" : "+"}
            {formatMoney(payment.amount)}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {isScheduled
              ? `Expected ${formatDate(payment.dueDate ?? payment.receivedAt)}`
              : `Received ${formatDate(payment.receivedAt)}`}
          </div>
        </div>
      </SheetHeader>

      <ScrollArea className="flex-1">
        <div className="space-y-5 px-5 py-4">
          {/* Linked invoice */}
          <Section title="Linked invoice">
            {linkedInvoice ? (
              <div className="rounded-md border border-border p-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-soft text-primary">
                    <FileText className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs text-muted-foreground">{linkedInvoice.number}</div>
                    <div className="truncate text-sm font-medium">{linkedInvoice.client}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold tabular-nums">
                      {formatMoney(linkedInvoice.amount)}
                    </div>
                    <Badge
                      variant="secondary"
                      className="mt-0.5 h-4 rounded px-1.5 text-[10px] bg-success/15 text-success"
                    >
                      {linkedInvoice.status}
                    </Badge>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Calendar className="h-3 w-3" /> Due {formatDate(linkedInvoice.due)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Hash className="h-3 w-3" /> {linkedInvoice.id}
                  </span>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                Invoice {payment.invoice} not found.
              </div>
            )}
          </Section>

          {/* Payment method details */}
          <Section title="Payment method">
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center gap-2">
                <div className={`flex h-8 w-8 items-center justify-center rounded-md ${methodMeta.tone}`}>
                  <methodMeta.icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{methodMeta.title}</div>
                  <div className="text-[11px] text-muted-foreground">{methodMeta.subtitle}</div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-3 text-xs">
                {methodMeta.fields.map((f) => (
                  <div key={f.label} className="flex justify-between">
                    <span className="text-muted-foreground">{f.label}</span>
                    <span className="font-mono text-[11px]">{f.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </Section>

          {/* Settlement breakdown */}
          <Section title="Settlement">
            <div className="space-y-1 rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs">
              <Row label="Gross amount" value={formatMoney(payment.amount)} />
              <Row label={`Processing fee (${(methodMeta.feeRate * 100).toFixed(2)}%)`} value={`-${formatMoney(fee)}`} />
              <Separator className="my-1" />
              <Row label="Net deposit" value={formatMoney(net)} bold />
              <div className="pt-1 text-[11px] text-muted-foreground">
                Expected to land {formatDate(addDays(payment.receivedAt, methodMeta.settleDays))} ·{" "}
                {methodMeta.settleDays}-day {payment.method} settlement
              </div>
            </div>
          </Section>

          {/* Activity */}
          <Section title="Activity">
            <ol className="relative space-y-3 border-l border-border pl-4">
              {isScheduled ? (
                <Activity
                  title={`Milestone scheduled · ${formatMoney(payment.amount)}`}
                  actor="System"
                  at={payment.receivedAt}
                  icon={Calendar}
                  tone="text-primary"
                />
              ) : (
                <>
                  <Activity
                    title={`Payment received · ${formatMoney(payment.amount)}`}
                    actor={payment.client}
                    at={payment.receivedAt}
                    icon={CheckCircle2}
                    tone="text-success"
                  />
                  <Activity
                    title="Receipt emailed"
                    actor="System"
                    at={payment.receivedAt}
                    icon={Mail}
                    tone="text-primary"
                  />
                </>
              )}
              {reminders.map((r, i) => (
                <Activity
                  key={i}
                  title="Payment reminder sent"
                  actor={r.actor}
                  at={r.sentAt}
                  icon={BellRing}
                  tone="text-warning"
                />
              ))}
              {refunded && (
                <Activity
                  title={`Refund issued · ${formatMoney(payment.amount)}`}
                  actor="Alex Romero"
                  at={new Date().toISOString()}
                  icon={RotateCcw}
                  tone="text-destructive"
                />
              )}
            </ol>
          </Section>
        </div>
      </ScrollArea>

      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-background px-5 py-3">
        {isScheduled ? (
          <Button
            size="sm"
            variant={isPastDue ? "default" : "outline"}
            className="h-8 gap-1.5"
            onClick={handleSendReminder}
          >
            <BellRing className="h-3.5 w-3.5" />
            Send reminder
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              onClick={handleRefund}
              disabled={refunded}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {refunded ? "Refunded" : "Refund"}
            </Button>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={handleReceipt}>
              <Mail className="h-3.5 w-3.5" />
              Email receipt
            </Button>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={handleDownload}>
              <Download className="h-3.5 w-3.5" />
              Receipt PDF
            </Button>
          </>
        )}
        <div className="ml-auto">
          <Button size="sm" variant="ghost" className="h-8" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
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

function Activity({
  title,
  actor,
  at,
  icon: Icon,
  tone,
}: {
  title: string;
  actor: string;
  at: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
}) {
  return (
    <li className="relative">
      <span
        className={`absolute -left-[21px] top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border bg-background ${tone}`}
      >
        <Icon className="h-2 w-2" />
      </span>
      <div className="text-xs font-medium">{title}</div>
      <div className="text-[11px] text-muted-foreground">
        {actor} · {formatDate(at)}
      </div>
    </li>
  );
}

function addDays(iso: string, days: number) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

type MethodMeta = {
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
  title: string;
  subtitle: string;
  fields: { label: string; value: string }[];
  feeRate: number;
  settleDays: number;
};

function getMethodMeta(p: Payment, seed: number): MethodMeta {
  switch (p.method) {
    case "Card": {
      const brands = ["Visa", "Mastercard", "Amex"];
      const brand = brands[seed % brands.length];
      const last4 = String(1000 + ((seed * 7919) % 9000)).slice(-4);
      return {
        icon: CreditCard,
        tone: "bg-primary-soft text-primary",
        title: `${brand} ending in ${last4}`,
        subtitle: "Credit card · Stripe",
        fields: [
          { label: "Brand", value: brand },
          { label: "Last 4", value: `•••• ${last4}` },
          { label: "Exp.", value: `0${1 + (seed % 9)}/2${7 + (seed % 3)}` },
          { label: "Auth code", value: `A${(seed * 13).toString(36).toUpperCase()}` },
        ],
        feeRate: 0.029,
        settleDays: 2,
      };
    }
    case "ACH": {
      const last4 = String(1000 + ((seed * 6151) % 9000)).slice(-4);
      return {
        icon: Building2,
        tone: "bg-chart-2/15 text-chart-2",
        title: `Bank transfer ····${last4}`,
        subtitle: "ACH · Plaid verified",
        fields: [
          { label: "Routing", value: "021000021" },
          { label: "Account", value: `•••• ${last4}` },
          { label: "Trace ID", value: `${seed}${(seed * 31).toString(36).toUpperCase()}` },
        ],
        feeRate: 0.008,
        settleDays: 3,
      };
    }
    case "Check": {
      return {
        icon: FileText,
        tone: "bg-secondary text-secondary-foreground",
        title: `Check #${4000 + seed}`,
        subtitle: "Mailed check · manual deposit",
        fields: [
          { label: "Check #", value: String(4000 + seed) },
          { label: "Bank", value: "Chase" },
          { label: "Memo", value: p.invoice },
        ],
        feeRate: 0,
        settleDays: 5,
      };
    }
    case "Wire":
    default: {
      return {
        icon: Banknote,
        tone: "bg-chart-5/15 text-chart-5",
        title: "Wire transfer",
        subtitle: "Domestic wire · same-day",
        fields: [
          { label: "Reference", value: `WIRE-${seed * 7}` },
          { label: "Originator", value: p.client },
          { label: "Bank", value: "Wells Fargo" },
        ],
        feeRate: 0.002,
        settleDays: 1,
      };
    }
  }
}
