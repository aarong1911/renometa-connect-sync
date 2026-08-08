// src/components/projects/ChangeOrderStatusBadge.tsx
import { Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  CHANGE_ORDER_STATUS_ICONS, CHANGE_ORDER_STATUS_LABELS, CHANGE_ORDER_STATUS_TINT,
  type ChangeOrderStatus,
} from "@/lib/change-order-status";

/**
 * `overdue` is a purely display-side derivation (see isChangeOrderOverdue
 * in project-change-orders.ts) -- it never mutates the stored status. A
 * sent/viewed Change Order past its approval_due_at renders with the same
 * visual language as "expired" without requiring a database write; the
 * approve/reject RPCs independently re-check the deadline server-side.
 */
export function ChangeOrderStatusBadge({ status, overdue, className }: { status: ChangeOrderStatus; overdue?: boolean; className?: string }) {
  if (overdue) {
    const tint = CHANGE_ORDER_STATUS_TINT.expired;
    return (
      <Badge variant="outline" className={cn("gap-1 font-medium", tint.badge, className)}>
        <Clock3 className={cn("h-3 w-3", tint.icon)} />
        Overdue
      </Badge>
    );
  }
  const Icon = CHANGE_ORDER_STATUS_ICONS[status];
  const tint = CHANGE_ORDER_STATUS_TINT[status];
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", tint.badge, className)}>
      <Icon className={cn("h-3 w-3", tint.icon)} />
      {CHANGE_ORDER_STATUS_LABELS[status]}
    </Badge>
  );
}
