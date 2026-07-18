// src/components/ui/status-badge.tsx
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shared status-pill styling, replacing ~5 separate per-page
// reimplementations (bordered rectangles, inline hex styles, differing
// sizes) with one ring-based chip matching the approved design.
export type BadgeTone = "primary" | "success" | "warning" | "danger" | "info" | "violet" | "muted";

const TONE_CLASSES: Record<BadgeTone, string> = {
  primary: "bg-primary-soft text-primary ring-primary/20",
  success: "bg-success-soft text-success ring-success/20",
  warning: "bg-warning-soft text-warning ring-warning/20",
  danger: "bg-destructive-soft text-destructive ring-destructive/20",
  info: "bg-info-soft text-info ring-info/20",
  violet: "bg-violet-soft text-violet ring-violet/20",
  muted: "bg-secondary text-muted-foreground ring-border",
};

/**
 * Domain-specific status vocab (payment status, lead status, invoice
 * status, ...) stays local to each page — pass a `tone` mapped from your
 * own status value. This component only owns the shared visual: size,
 * ring style, typography, optional leading icon.
 */
export function StatusBadge({
  tone = "muted",
  icon: Icon,
  children,
  className,
}: {
  tone?: BadgeTone;
  icon?: ComponentType<{ className?: string }>;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-semibold capitalize ring-1 ring-inset",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </span>
  );
}
