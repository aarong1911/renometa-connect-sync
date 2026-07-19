// src/components/automation/wf-edge.tsx
// Custom React Flow edge — smoothstep path, arrowhead, optional colored label badge.

import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
  type Edge,
} from "@xyflow/react";
import { cn } from "@/lib/utils";

export type WfEdgeData = Record<string, unknown>; // satisfies RF's constraint

export type WfEdgeType = Edge<WfEdgeData, "wfEdge">;

export function WfEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  style,
  markerEnd,
  selected,
}: EdgeProps<WfEdgeType>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });

  const isYes = label === "Yes";
  const isNo  = label === "No";

  const strokeColor =
    isYes ? "#10b981"
    : isNo  ? "#f43f5e"
    : selected ? "hsl(var(--primary))"
    : "#94a3b8"; // slate-400 — visible on both light and dark

  const strokeWidth = selected ? 2.5 : 2;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: strokeColor,
          strokeWidth,
          cursor: "pointer",
          ...style,
        }}
      />

      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: "all",
              zIndex: 10,
            }}
            className="nodrag nopan"
          >
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none shadow-sm",
                isYes
                  ? "border-emerald-300 bg-white text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/80 dark:text-emerald-300"
                  : isNo
                  ? "border-rose-300 bg-white text-rose-600 dark:border-rose-700 dark:bg-rose-950/80 dark:text-rose-300"
                  : "border-border bg-card text-muted-foreground",
              )}
            >
              {label as string}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { wfEdge: WfEdge };
