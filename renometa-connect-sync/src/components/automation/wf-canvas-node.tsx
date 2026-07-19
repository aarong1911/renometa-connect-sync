// src/components/automation/wf-canvas-node.tsx
import { memo } from "react";
import {
  Handle, Position, NodeToolbar, useReactFlow,
  type NodeProps, type Node,
} from "@xyflow/react";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { CATEGORY_STYLE, NODE_META_MAP, nodeHasTwoOutputs, type WfNodeData } from "@/lib/workflow-types";

export type WfCanvasNodeType = Node<WfNodeData, "wfNode">;

function WfCanvasNode({ id, data, selected }: NodeProps<WfCanvasNodeType>) {
  const { deleteElements } = useReactFlow();
  const meta = NODE_META_MAP[data.nodeType];
  const style = CATEGORY_STYLE[data.category];
  const Icon = meta?.icon;
  const isTrigger = data.category === "trigger";
  const hasTwoOut = nodeHasTwoOutputs(data.nodeType);

  return (
    <>
      {/* ── Delete toolbar — appears above the node when selected ── */}
      <NodeToolbar isVisible={selected} position={Position.Top} align="end" offset={6}>
        <button
          onClick={() => deleteElements({ nodes: [{ id }] })}
          title="Delete node (Del)"
          className="flex h-6 w-6 items-center justify-center rounded border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:border-destructive/60 hover:bg-destructive/5 hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </NodeToolbar>

      <div
        className={cn(
          "group relative w-55 rounded-xl border bg-card shadow-sm transition-all",
          selected
            ? "border-primary ring-2 ring-primary/30 shadow-md"
            : "border-border hover:border-border/80 hover:shadow-md",
        )}
      >
        {/* Target handle (top) — all except triggers */}
        {!isTrigger && (
          <Handle
            type="target"
            position={Position.Top}
            id="in"
            className={cn(
              "h-3! w-3! rounded-full! border-2! border-card! bg-slate-400!",
              selected && "bg-primary!",
            )}
          />
        )}

        <div className="p-3">
          <div className="flex items-start gap-2.5">
            {/* Category icon badge */}
            <div
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
                style.bg,
                style.border,
              )}
            >
              {Icon && <Icon className={cn("h-4 w-4", style.text)} />}
            </div>

            {/* Text */}
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="truncate text-[11px] font-semibold leading-tight">{data.label}</div>
              <div className="mt-0.5 truncate text-[10px] leading-snug text-muted-foreground">
                {data.subtitle || meta?.description}
              </div>
            </div>
          </div>

          {/* If/Else branch labels */}
          {hasTwoOut && (
            <div className="mt-2 flex items-center justify-around border-t border-border pt-2">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-emerald-600">Yes</span>
              <span className="text-[9px] font-semibold uppercase tracking-wider text-rose-500">No</span>
            </div>
          )}
        </div>

        {/* Source handle(s) — bottom */}
        {hasTwoOut ? (
          <>
            <Handle
              type="source"
              position={Position.Bottom}
              id="yes"
              style={{ left: "30%" }}
              className="h-3! w-3! rounded-full! border-2! border-card! bg-emerald-500!"
            />
            <Handle
              type="source"
              position={Position.Bottom}
              id="no"
              style={{ left: "70%" }}
              className="h-3! w-3! rounded-full! border-2! border-card! bg-rose-500!"
            />
          </>
        ) : (
          <Handle
            type="source"
            position={Position.Bottom}
            id="out"
            className={cn(
              "h-3! w-3! rounded-full! border-2! border-card! bg-slate-400!",
              selected && "bg-primary!",
            )}
          />
        )}
      </div>
    </>
  );
}

export const WfCanvasNodeMemo = memo(WfCanvasNode);
export const nodeTypes = { wfNode: WfCanvasNodeMemo };
