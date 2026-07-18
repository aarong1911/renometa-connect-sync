// src/components/ui/metric-card.tsx
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

// Canonical icon-tile tone → token pairing, replacing the ~12 slightly
// different ad hoc tone maps that were previously copy-pasted per page
// (some used bg-primary-soft/text-primary, others raw bg-emerald-500/10,
// etc, for the same visual intent).
export type MetricTone = "primary" | "success" | "warning" | "danger" | "info" | "violet" | "gold" | "orange" | "cyan" | "emerald" | "muted";

const TONE_CLASSES: Record<MetricTone, { bg: string; icon: string }> = {
  primary: { bg: "bg-primary-soft", icon: "text-primary" },
  success: { bg: "bg-success-soft", icon: "text-success" },
  warning: { bg: "bg-warning-soft", icon: "text-warning" },
  danger: { bg: "bg-destructive-soft", icon: "text-destructive" },
  info: { bg: "bg-info-soft", icon: "text-info" },
  violet: { bg: "bg-violet-soft", icon: "text-violet" },
  gold: { bg: "bg-gold-soft", icon: "text-gold" },
  orange: { bg: "bg-orange-soft", icon: "text-orange" },
  cyan: { bg: "bg-cyan-soft", icon: "text-cyan" },
  emerald: { bg: "bg-emerald-soft", icon: "text-emerald" },
  muted: { bg: "bg-secondary", icon: "text-muted-foreground" },
};

export type MetricTrend = { delta: string; up: boolean };

/**
 * Shared KPI/stat tile — icon in a colored tile, uppercase label, large
 * value, optional trend delta or plain sub-text below. Matches the
 * approved design's MetricCard. Pass either `tone` (preset token pair) or
 * explicit `iconBg`/`iconColor` for a one-off color; `tone` wins if both
 * are given.
 */
export function MetricCard({
  icon: Icon,
  tone,
  iconBg,
  iconColor,
  label,
  value,
  trend,
  sub,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  tone?: MetricTone;
  iconBg?: string;
  iconColor?: string;
  label: string;
  value: ReactNode;
  /** Colored up/down delta chip — omit rather than fabricate when there's no real comparison. */
  trend?: MetricTrend;
  /** Plain trailing text, shown only when `trend` isn't set. */
  sub?: string;
  className?: string;
}) {
  const resolvedBg = tone ? TONE_CLASSES[tone].bg : (iconBg ?? TONE_CLASSES.primary.bg);
  const resolvedIcon = tone ? TONE_CLASSES[tone].icon : (iconColor ?? TONE_CLASSES.primary.icon);

  return (
    <div
      className={cn(
        "rounded-xl border border-border/70 bg-card p-4 flex flex-col gap-2.5",
        "shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:shadow-[0_4px_16px_-4px_rgba(15,23,42,0.08)] hover:border-border transition-all duration-200",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <div className={cn("h-8 w-8 rounded-lg grid place-items-center shrink-0", resolvedBg)}>
          <Icon className={cn("h-4 w-4", resolvedIcon)} />
        </div>
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground truncate">{label}</span>
      </div>
      <div className="text-[22px] leading-none font-semibold tracking-tight text-foreground tabular-nums">{value}</div>
      {trend ? (
        <div className="flex items-center gap-1 text-[11px]">
          <span className={cn("font-semibold", trend.up ? "text-success" : "text-destructive")}>
            {trend.up ? "↑" : "↓"} {trend.delta}
          </span>
          {sub && <span className="text-muted-foreground">{sub}</span>}
        </div>
      ) : sub ? (
        <div className="text-[11px] text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  );
}
