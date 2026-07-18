// src/components/automation/wf-node-palette.tsx
// Left sidebar node palette — drag onto canvas or click to add.

import { useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  CATEGORY_STYLE,
  NODES_BY_CATEGORY,
  type WfNodeCategory,
  type WfNodeMeta,
  type WfNodeType,
} from "@/lib/workflow-types";

const CATEGORY_ORDER: WfNodeCategory[] = ["trigger", "action", "condition", "utility"];

interface Props {
  onAdd: (type: WfNodeType) => void;
}

export function WfNodePalette({ onAdd }: Props) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Record<WfNodeCategory, boolean>>({
    trigger: false,
    action: false,
    condition: false,
    utility: false,
  });

  const q = search.trim().toLowerCase();

  const filteredByCategory = Object.fromEntries(
    CATEGORY_ORDER.map((cat) => [
      cat,
      NODES_BY_CATEGORY[cat].filter(
        (m) => !q || m.label.toLowerCase().includes(q) || m.description.toLowerCase().includes(q),
      ),
    ]),
  ) as Record<WfNodeCategory, WfNodeMeta[]>;

  const toggleCategory = (cat: WfNodeCategory) =>
    setCollapsed((prev) => ({ ...prev, [cat]: !prev[cat] }));

  return (
    <div className="flex h-full w-[220px] shrink-0 flex-col border-r border-border bg-sidebar">
      {/* Header */}
      <div className="border-b border-border px-3 py-2.5">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Nodes
        </div>
        <div className="relative mt-1.5">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search nodes…"
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      {/* Categories */}
      <div className="flex-1 overflow-y-auto py-1.5">
        {CATEGORY_ORDER.map((cat) => {
          const items = filteredByCategory[cat];
          if (items.length === 0) return null;
          const style = CATEGORY_STYLE[cat];
          const open = !collapsed[cat];

          return (
            <div key={cat} className="mb-1">
              {/* Category header */}
              <button
                onClick={() => toggleCategory(cat)}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-secondary/60"
              >
                <span className={cn("h-2 w-2 rounded-full", style.dot)} />
                <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {style.label}
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground">{items.length}</span>
                {open ? (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                )}
              </button>

              {/* Node items */}
              {open && (
                <div className="space-y-px px-2 pb-1">
                  {items.map((meta) => (
                    <PaletteItem key={meta.type} meta={meta} onAdd={onAdd} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer hint */}
      <div className="border-t border-border px-3 py-2">
        <p className="text-[10px] text-muted-foreground">
          Drag onto canvas or click to add below last node
        </p>
      </div>
    </div>
  );
}

function PaletteItem({ meta, onAdd }: { meta: WfNodeMeta; onAdd: (type: WfNodeType) => void }) {
  const style = CATEGORY_STYLE[meta.category];
  const Icon = meta.icon;

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/wf-node-type", meta.type);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onAdd(meta.type)}
      className="flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-secondary active:cursor-grabbing"
      title={meta.description}
    >
      <div
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded border",
          style.bg,
          style.border,
        )}
      >
        <Icon className={cn("h-3.5 w-3.5", style.text)} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium leading-tight">{meta.label}</div>
      </div>
    </div>
  );
}
