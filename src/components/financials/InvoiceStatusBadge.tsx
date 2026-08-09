// src/components/financials/InvoiceStatusBadge.tsx
import type { ComponentType } from "react";
import { CheckCircle2, AlertCircle, Receipt, FileText, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { getInvoiceDisplayStatus, getInvoiceStatusStyle, type InvoiceStatus } from "@/lib/invoice-status";

const STATUS_ICON: Record<InvoiceStatus, ComponentType<{ className?: string }>> = {
  draft: FileText, sent: Receipt, viewed: Receipt, partial: Receipt,
  paid: CheckCircle2, overdue: AlertCircle, void: Ban, cancelled: Ban,
};

export function InvoiceStatusBadge({ status, dueDate, className, showIcon = true }: {
  status: string | null | undefined;
  dueDate?: string | null;
  className?: string;
  showIcon?: boolean;
}) {
  const display = getInvoiceDisplayStatus(status, dueDate ?? null);
  const style = getInvoiceStatusStyle(status, dueDate ?? null);
  const Icon = STATUS_ICON[display];
  return (
    <span className={cn("inline-flex w-fit items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-semibold ring-1", style.badge, className)}>
      {showIcon && <Icon className="h-3 w-3" />}
      {style.label}
    </span>
  );
}
