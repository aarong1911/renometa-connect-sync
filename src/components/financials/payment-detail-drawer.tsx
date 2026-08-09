import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CreditCard,
  Banknote,
  Building2,
  FileText,
  CheckCircle2,
  Hash,
  Calendar,
  BellRing,
} from "lucide-react";
import { formatDate, formatMoney, daysFromNow } from "@/lib/format";
import { type Payment } from "@/lib/mock-data";
import { formatPaymentMethod, formatPaymentProvider } from "@/lib/payment-method";
import { useEffect, useMemo, useState } from "react";
import { logReminder, useReminders } from "@/lib/payment-reminders";
import { supabase } from "@/lib/supabase";

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

type LinkedInvoice = { id: string; invoice_number: string; client_name: string; total_amount: number; status: string; due_date: string };

function Body({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const [linkedInvoice, setLinkedInvoice] = useState<LinkedInvoice | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLinkedInvoice(undefined);
    supabase
      .from("invoices")
      .select(`id, invoice_number, total_amount, status, due_date, contacts!client_id(full_name)`)
      .eq("invoice_number", payment.invoice)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setLinkedInvoice(
          data
            ? {
                id: data.id,
                invoice_number: data.invoice_number,
                client_name: (data as any).contacts?.full_name ?? "—",
                total_amount: Number(data.total_amount ?? 0),
                status: data.status ?? "—",
                due_date: data.due_date,
              }
            : null,
        );
      });
    return () => { cancelled = true; };
  }, [payment.invoice]);

  const methodMeta = getMethodMeta(payment.method);

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
  };
  // Part 4 — a customer-friendly hierarchy (amount, name, date) leads; the
  // raw UUID is demoted to a small muted technical reference, preferring
  // the provider's own transaction id (e.g. a Stripe PaymentIntent) over
  // our internal invoice_payments.id when one exists.
  const reference = isScheduled ? null : paymentReference(payment);

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
          <Badge
            variant="secondary"
            className={`ml-auto h-5 rounded px-1.5 text-[10px] ${
              isScheduled ? "bg-primary-soft text-primary" : "bg-success/15 text-success"
            }`}
          >
            {isScheduled ? "Scheduled" : "Received"}
          </Badge>
        </div>
        <div className={`mt-2 text-2xl font-semibold tabular-nums ${isScheduled ? "text-primary" : "text-success"}`}>
          {isScheduled ? "" : "+"}
          {formatMoney(payment.amount)}
        </div>
        <SheetTitle className="mt-0.5 text-base font-semibold">{payment.client}</SheetTitle>
        {isScheduled && payment.milestoneLabel && (
          <div className="mt-0.5 text-xs text-muted-foreground">{payment.milestoneLabel}</div>
        )}
        <div className="mt-1 flex items-center justify-between">
          <div className="text-[11px] text-muted-foreground">
            {isScheduled
              ? `Expected ${formatDate(payment.dueDate ?? payment.receivedAt)}`
              : `Received ${formatDate(payment.receivedAt)}`}
          </div>
          {reference && <div className="font-mono text-[10px] text-muted-foreground">{reference}</div>}
        </div>
      </SheetHeader>

      <ScrollArea className="flex-1">
        <div className="space-y-5 px-5 py-4">
          {/* Linked invoice */}
          <Section title="Linked invoice">
            {linkedInvoice === undefined ? (
              <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">Loading…</div>
            ) : linkedInvoice ? (
              <div className="rounded-md border border-border p-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-soft text-primary">
                    <FileText className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs text-muted-foreground">{linkedInvoice.invoice_number}</div>
                    <div className="truncate text-sm font-medium">{linkedInvoice.client_name}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold tabular-nums">
                      {formatMoney(linkedInvoice.total_amount)}
                    </div>
                    <Badge
                      variant="secondary"
                      className="mt-0.5 h-4 rounded px-1.5 text-[10px] bg-success/15 text-success capitalize"
                    >
                      {linkedInvoice.status}
                    </Badge>
                  </div>
                </div>
                {/* Part 14 — the invoice UUID is internal metadata with no
                    customer value; due date and project name are the useful
                    footer facts here. */}
                <div className="mt-3 flex items-center gap-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
                  {linkedInvoice.due_date && (
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="h-3 w-3" /> Due {formatDate(linkedInvoice.due_date)}
                    </span>
                  )}
                  {payment.projectName && (
                    <span className="inline-flex items-center gap-1">
                      <Hash className="h-3 w-3" /> {payment.projectName}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                Invoice {payment.invoice} not found.
              </div>
            )}
          </Section>

          {/* Payment method — Part 6: method (how) and provider (who
              processed it) are distinct concepts, shown as two separate
              lines rather than conflated into one label. */}
          {!isScheduled && (
            <Section title="Payment method">
              <div className="rounded-md border border-border p-3">
                <div className="flex items-center gap-2">
                  <div className={`flex h-8 w-8 items-center justify-center rounded-md ${methodMeta.tone}`}>
                    <methodMeta.icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{methodMeta.title}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {payment.provider === "stripe"
                        ? "Processed securely by Stripe"
                        : `Processed by ${formatPaymentProvider(payment.provider)}`}
                    </div>
                  </div>
                </div>
                {payment.providerPaymentId && (
                  <div className="mt-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
                    {formatPaymentProvider(payment.provider)} transaction
                    <div className="mt-0.5 font-mono text-[10.5px]">{payment.providerPaymentId}</div>
                  </div>
                )}
              </div>
            </Section>
          )}

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
                <Activity
                  title={`Payment received · ${formatMoney(payment.amount)}`}
                  // Part 15 — a "<Method> via <Provider>" qualifier only
                  // for real received transactions with a non-manual
                  // provider on record; never fabricated for a manual cash
                  // payment, which just shows the client's name as before.
                  actor={
                    payment.provider && payment.provider !== "manual"
                      ? `${formatPaymentMethod(payment.method)} via ${formatPaymentProvider(payment.provider)}`
                      : payment.client
                  }
                  at={payment.receivedAt}
                  icon={CheckCircle2}
                  tone="text-success"
                />
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
            </ol>
          </Section>
        </div>
      </ScrollArea>

      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-background px-5 py-3">
        {isScheduled && (
          <Button
            size="sm"
            variant={isPastDue ? "default" : "outline"}
            className="h-8 gap-1.5"
            onClick={handleSendReminder}
          >
            <BellRing className="h-3.5 w-3.5" />
            Send reminder
          </Button>
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

type MethodMeta = {
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
  title: string;
};

/** Truncated technical reference for the header — prefers the provider's own transaction id (e.g. a Stripe PaymentIntent) over our internal invoice_payments.id, since that's the more useful id for support/reconciliation. */
function paymentReference(payment: Payment): string {
  if (payment.providerPaymentId) {
    const id = payment.providerPaymentId;
    const truncated = id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
    return `${formatPaymentProvider(payment.provider)} · ${truncated}`;
  }
  const shortId = payment.id.length > 12 ? `${payment.id.slice(0, 8)}…` : payment.id;
  return `Payment ID · ${shortId}`;
}

// No payment processor is integrated for per-transaction detail (card
// brand/last4, ACH routing/trace IDs, etc.) — this previously fabricated
// realistic-looking values seeded from the payment ID. Only the real
// canonical payment_method value is shown now, humanized via
// formatPaymentMethod() (Phase 13.7B) — never a hardcoded "Card"/"Other"
// switch that silently dropped values it didn't recognize.
function getMethodMeta(method: string): MethodMeta {
  const key = (method ?? "").toLowerCase();
  const title = formatPaymentMethod(method);
  switch (key) {
    case "card":
      return { icon: CreditCard, tone: "bg-primary-soft text-primary", title };
    case "cash":
      return { icon: Banknote, tone: "bg-success/15 text-success", title };
    case "ach":
    case "bank_transfer":
    case "us_bank_account":
      return { icon: Building2, tone: "bg-chart-2/15 text-chart-2", title };
    case "check":
      return { icon: FileText, tone: "bg-secondary text-secondary-foreground", title };
    case "wire":
      return { icon: Banknote, tone: "bg-chart-5/15 text-chart-5", title };
    default:
      return { icon: Banknote, tone: "bg-muted text-muted-foreground", title };
  }
}
