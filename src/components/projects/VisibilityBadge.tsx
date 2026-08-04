// src/components/projects/VisibilityBadge.tsx
//
// Phase 13.3A — shared visibility indicator for Daily Logs and Project
// Photos. Text-first (Internal/Field/Customer/Field + Customer), never an
// icon-only eye glyph, with an accessible title — see Part 17/38.
import { Badge } from "@/components/ui/badge";

export function VisibilityBadge({ isCustomerVisible, isFieldVisible }: { isCustomerVisible: boolean; isFieldVisible: boolean }) {
  let label: string;
  let title: string;
  let tone: string;

  if (isCustomerVisible && isFieldVisible) {
    label = "Field + Customer"; title = "Visible to RenoMeta Field and RenoMeta Portal";
    tone = "border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-500/10 dark:text-cyan-400";
  } else if (isCustomerVisible) {
    label = "Customer"; title = "Visible to RenoMeta Portal";
    tone = "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-500/10 dark:text-blue-400";
  } else if (isFieldVisible) {
    label = "Field"; title = "Visible to RenoMeta Field";
    tone = "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-500/10 dark:text-slate-300";
  } else {
    label = "Internal"; title = "Internal only — not visible to Field or Portal";
    tone = "border-border bg-muted text-muted-foreground";
  }

  return (
    <Badge variant="outline" className={`h-5 rounded px-1.5 text-[10px] font-medium ${tone}`} title={title}>
      <span className="sr-only">{title}. </span>
      {label}
    </Badge>
  );
}
