import "@xyflow/react/dist/style.css";
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls,
  addEdge, applyNodeChanges, applyEdgeChanges,
  MarkerType, ConnectionLineType,
  type Node, type Edge, type Connection, type NodeChange, type EdgeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Save, Loader2, History, CheckCircle2, XCircle, Play, LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { mapWorkflow, saveWorkflow, updateWorkflowStatus, type DbWorkflow } from "@/lib/workflows-store";
import { makeWfNode, NODE_META_MAP, CATEGORY_STYLE, type WfNodeType, type WfRfNode, type WfRfEdge } from "@/lib/workflow-types";
import { nodeTypes } from "@/components/automation/wf-canvas-node";
import { edgeTypes } from "@/components/automation/wf-edge";
import { WfNodePalette } from "@/components/automation/wf-node-palette";
import { WfConfigPanel } from "@/components/automation/wf-config-panel";
import { ROUTES } from "@/lib/routes";

// ── Route ────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/automation/workflows/$workflowId")({
  loader: async ({ params }) => {
    const { data, error } = await supabase
      .from("workflows").select("*").eq("id", params.workflowId).single();
    if (error || !data) throw notFound();
    return mapWorkflow(data);
  },
  notFoundComponent: () => (
    <div className="p-12 text-center text-sm text-muted-foreground">
      Workflow not found.{" "}
      <Link to={ROUTES.WORKFLOWS} className="text-primary hover:underline">Back to workflows</Link>
    </div>
  ),
  component: BuilderRoot,
});

// ── Edge helpers ─────────────────────────────────────────────────────────────

function markerFor(label?: string | null) {
  const color =
    label === "Yes" ? "#10b981" :
    label === "No"  ? "#f43f5e" :
    "#94a3b8";
  return { type: MarkerType.ArrowClosed, width: 14, height: 14, color };
}

function makeEdge(partial: Partial<Edge> & Pick<Edge, "source" | "target">): Edge {
  const lbl = partial.label as string | undefined;
  return {
    id: `e_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
    type: "wfEdge",
    animated: false,
    markerEnd: markerFor(lbl),
    ...partial,
  };
}

// Ensure every loaded edge has the right type + marker (handles old/template edges).
function normaliseEdges(edges: Edge[]): Edge[] {
  return edges.map((e) => ({
    ...makeEdge(e),
    id: e.id, // preserve original id
  }));
}

// ── Stable React Flow props (must be module-level — new object refs each render
// cause React Flow to re-initialise internal edge state, creating ghost edges) ─

const DEFAULT_EDGE_OPTIONS: Partial<Edge> = {
  type: "wfEdge",
  animated: false,
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#94a3b8" },
};

const CONNECTION_LINE_STYLE: React.CSSProperties = {
  stroke: "hsl(var(--primary))",
  strokeWidth: 2,
  strokeDasharray: "6 3",
};

const FIT_VIEW_OPTIONS = { padding: 0.3 } as const;
const PRO_OPTIONS = { hideAttribution: true } as const;

// ── Auto-arrange: BFS topological layout ──────────────────────────────────────

function autoArrangeNodes(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes;

  const outMap: Record<string, string[]> = {};
  const inCount: Record<string, number> = {};
  for (const n of nodes) { outMap[n.id] = []; inCount[n.id] = 0; }
  for (const e of edges) {
    outMap[e.source]?.push(e.target);
    inCount[e.target] = (inCount[e.target] ?? 0) + 1;
  }

  // BFS from roots — assign max-depth level to each node
  const depth: Record<string, number> = {};
  const queue: Array<{ id: string; d: number }> = [];
  for (const n of nodes) {
    if ((inCount[n.id] ?? 0) === 0) { depth[n.id] = 0; queue.push({ id: n.id, d: 0 }); }
  }
  while (queue.length > 0) {
    const { id, d } = queue.shift()!;
    for (const child of outMap[id] ?? []) {
      const next = d + 1;
      if ((depth[child] ?? -1) < next) { depth[child] = next; queue.push({ id: child, d: next }); }
    }
  }
  // Disconnected nodes go after the deepest connected node
  const maxConnected = Object.values(depth).reduce((m, v) => Math.max(m, v), 0);
  nodes.filter(n => depth[n.id] === undefined).forEach((n, i) => { depth[n.id] = maxConnected + 1 + i; });

  // Group by depth and assign positions
  const byDepth: Record<number, string[]> = {};
  for (const [id, d] of Object.entries(depth)) (byDepth[d] = byDepth[d] ?? []).push(id);

  const V_GAP = 160;
  const H_GAP = 280;
  const CENTER_X = 300;
  const newPos: Record<string, { x: number; y: number }> = {};
  const maxDepth = Math.max(...Object.keys(byDepth).map(Number));

  for (let d = 0; d <= maxDepth; d++) {
    const ids = byDepth[d] ?? [];
    const totalW = (ids.length - 1) * H_GAP;
    ids.forEach((id, i) => {
      newPos[id] = { x: CENTER_X - totalW / 2 + i * H_GAP, y: 80 + d * V_GAP };
    });
  }

  return nodes.map(n => ({ ...n, position: newPos[n.id] ?? n.position }));
}

function BuilderRoot() {
  return (
    <ReactFlowProvider>
      <BuilderPage />
    </ReactFlowProvider>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

type RunRow = { id: string; contact_name: string; started_at: string; duration_ms: number | null; status: "success" | "failed" | "running" };

// ── Page ──────────────────────────────────────────────────────────────────────

function BuilderPage() {
  const wf = Route.useLoaderData() as DbWorkflow;
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);

  // React Flow state
  const [rfNodes, setRfNodes] = useState<Node[]>(() =>
    wf.nodes.length > 0 ? (wf.nodes as Node[]) : [makeWfNode("manual", { x: 300, y: 80 }) as Node],
  );
  const [rfEdges, setRfEdges] = useState<Edge[]>(() =>
    normaliseEdges(wf.edges as Edge[]),
  );

  // UI state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState(wf.status);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  const selectedNode = rfNodes.find((n) => n.id === selectedId) as WfRfNode | undefined;

  // ── React Flow handlers ───────────────────────────────────────────────────

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes((prev) => applyNodeChanges(changes, prev));
    if (changes.some((c) => c.type !== "select" && c.type !== "dimensions")) setDirty(true);
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setRfEdges((prev) => applyEdgeChanges(changes, prev));
    if (changes.some((c) => c.type !== "select")) setDirty(true);
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    const isYes = connection.sourceHandle === "yes";
    const isNo  = connection.sourceHandle === "no";
    const edge: Edge = makeEdge({
      ...connection,
      label: isYes ? "Yes" : isNo ? "No" : undefined,
    });
    setRfEdges((prev) => addEdge(edge, prev));
    setDirty(true);
  }, []);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedId(node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedId(null);
  }, []);

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setRfEdges((prev) => prev.filter((e) => e.id !== edge.id));
    setDirty(true);
  }, []);

  // ── Drag-and-drop from palette ────────────────────────────────────────────

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const nodeType = e.dataTransfer.getData("application/wf-node-type") as WfNodeType;
    if (!nodeType || !rfInstance || !reactFlowWrapper.current) return;

    const bounds = reactFlowWrapper.current.getBoundingClientRect();
    const position = rfInstance.screenToFlowPosition({
      x: e.clientX - bounds.left,
      y: e.clientY - bounds.top,
    });

    const newNode = makeWfNode(nodeType, position) as Node;
    setRfNodes((prev) => [...prev, newNode]);
    setSelectedId(newNode.id);
    setDirty(true);
  }, [rfInstance]);

  // ── Add node from palette click (below last node) ─────────────────────────

  const handleAddNode = useCallback((type: WfNodeType) => {
    const lastNode = rfNodes.reduce<Node | null>((best, n) => {
      if (!best) return n;
      return (n.position.y > best.position.y) ? n : best;
    }, null);

    const position = lastNode
      ? { x: lastNode.position.x, y: lastNode.position.y + 160 }
      : { x: 300, y: 80 };

    const newNode = makeWfNode(type, position) as Node;
    setRfNodes((prev) => [...prev, newNode]);

    // Auto-connect from last node's "out" to new node's "in"
    if (lastNode) {
      const lastNodeType = (lastNode as WfRfNode).data?.nodeType;
      const sourceHandle = lastNodeType === "if_else" ? null : "out";
      if (sourceHandle) {
        setRfEdges((prev) => [...prev, makeEdge({
          source: lastNode.id,
          target: newNode.id,
          sourceHandle,
          targetHandle: "in",
        })]);
      }
    }

    setSelectedId(newNode.id);
    setDirty(true);

    // Fit view after adding
    setTimeout(() => rfInstance?.fitView({ padding: 0.2, duration: 300 }), 50);
  }, [rfNodes, rfInstance]);

  // ── Node updates from config panel ───────────────────────────────────────

  const handleNodeUpdate = useCallback((patch: Partial<WfRfNode["data"]>) => {
    setRfNodes((prev) =>
      prev.map((n) =>
        n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n,
      ),
    );
    setDirty(true);
  }, [selectedId]);

  const handleNodeDelete = useCallback(() => {
    if (!selectedId) return;
    setRfNodes((prev) => prev.filter((n) => n.id !== selectedId));
    setRfEdges((prev) => prev.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
    setDirty(true);
  }, [selectedId]);

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    const { error } = await saveWorkflow(wf.id, rfNodes as WfRfNode[], rfEdges as WfRfEdge[], { status });
    setSaving(false);
    if (error) { toast.error("Failed to save workflow"); }
    else { setDirty(false); toast.success("Workflow saved"); }
  };

  // ── Status toggle ─────────────────────────────────────────────────────────

  const handleStatusToggle = async (checked: boolean) => {
    if (status === "draft" && checked) {
      toast.info("Finish configuring the workflow before going live.");
      return;
    }
    const next = checked ? "active" : "paused";
    setStatus(next);
    const { error } = await updateWorkflowStatus(wf.id, next);
    if (error) { setStatus(status); toast.error("Failed to update status"); }
  };

  // ── Run history ───────────────────────────────────────────────────────────

  const loadRuns = async () => {
    setShowHistory(true);
    if (runs.length > 0) return;
    setRunsLoading(true);
    const { data } = await supabase
      .from("workflow_runs")
      .select("id, contact_name, started_at, duration_ms, status")
      .eq("workflow_id", wf.id)
      .order("started_at", { ascending: false })
      .limit(20);
    setRuns((data ?? []) as RunRow[]);
    setRunsLoading(false);
  };

  // ── Trigger node label in header ──────────────────────────────────────────
  const triggerNode = rfNodes.find((n) => {
    const nd = n as WfRfNode;
    return nd.data?.category === "trigger";
  }) as WfRfNode | undefined;
  const triggerMeta = triggerNode ? NODE_META_MAP[triggerNode.data.nodeType] : null;
  const triggerStyle = triggerMeta ? CATEGORY_STYLE.trigger : null;

  return (
    <div className="-mx-6 -my-6 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden">
      {/* Workflow builder topbar */}
      <div className="flex shrink-0 items-center justify-between gap-4 px-6 py-3">
        <div>
          <div className="mb-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Automation</span>
            <span className="text-muted-foreground/40">/</span>
            <span>Workflows</span>
            <span className="text-muted-foreground/40">/</span>
            <span>{wf.name}</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{wf.name}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">{wf.folder} · {rfNodes.length} steps</p>
        </div>
        <div className="flex items-center gap-2 pr-1">
          {triggerMeta && triggerStyle && (
            <Badge variant="outline" className={`h-6 text-[11px] ${triggerStyle.badge}`}>
              {triggerMeta.label}
            </Badge>
          )}
          <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1">
            <Switch checked={status === "active"} onCheckedChange={handleStatusToggle} disabled={status === "draft"} />
            <span className="text-xs font-medium capitalize">{status}</span>
          </div>
          <Button variant="outline" size="sm" className="h-8" title="Auto-arrange nodes"
            onClick={() => {
              const arranged = autoArrangeNodes(rfNodes, rfEdges);
              setRfNodes(arranged);
              setDirty(true);
              setTimeout(() => rfInstance?.fitView({ padding: 0.25, duration: 400 }), 50);
            }}>
            <LayoutGrid className="mr-1.5 h-3.5 w-3.5" /> Arrange
          </Button>
          <Button variant="outline" size="sm" className="h-8" onClick={showHistory ? () => setShowHistory(false) : loadRuns}>
            <History className="mr-1.5 h-3.5 w-3.5" /> History
          </Button>
          <Button variant="outline" size="sm" className="h-8">
            <Play className="mr-1.5 h-3.5 w-3.5" /> Test
          </Button>
          <Button size="sm" className="h-8" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
            {saving ? "Saving…" : dirty ? "Save *" : "Saved"}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden border-t border-border">
        {/* Left: Node palette */}
        <WfNodePalette onAdd={handleAddNode} />

        {/* Center: React Flow canvas */}
        <div ref={reactFlowWrapper} className="relative min-h-0 flex-1" onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            onInit={setRfInstance}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            deleteKeyCode="Delete"
            proOptions={PRO_OPTIONS}
            edgeTypes={edgeTypes}
            connectionLineType={ConnectionLineType.SmoothStep}
            defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
            connectionLineStyle={CONNECTION_LINE_STYLE}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="hsl(var(--border))" />
            <Controls position="bottom-right" showInteractive={false} className="border-border! bg-card! shadow-sm!" />

            {/* Empty state */}
            {rfNodes.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="text-center">
                  <p className="text-sm font-medium text-muted-foreground">Drag a trigger node to start</p>
                  <p className="mt-1 text-xs text-muted-foreground">or click a node in the left panel</p>
                </div>
              </div>
            )}
          </ReactFlow>

          {/* Run history slide-over */}
          {showHistory && (
            <div className="absolute inset-y-0 right-0 z-10 w-72 border-l border-border bg-card shadow-xl">
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <div className="text-sm font-semibold">Recent runs</div>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setShowHistory(false)}>Close</Button>
              </div>
              <div className="overflow-y-auto">
                {runsLoading && <div className="flex items-center justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>}
                {!runsLoading && runs.length === 0 && <div className="p-6 text-center text-xs text-muted-foreground">No runs yet.</div>}
                {runs.map((r) => (
                  <div key={r.id} className="flex items-start gap-2 border-b border-border px-4 py-2.5 hover:bg-secondary/30">
                    {r.status === "success" && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-success" />}
                    {r.status === "failed" && <XCircle className="mt-0.5 h-3.5 w-3.5 text-destructive" />}
                    {r.status === "running" && <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-primary" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{r.contact_name || "Unknown"}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(r.started_at))}
                        {r.duration_ms != null && ` · ${(r.duration_ms / 1000).toFixed(1)}s`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Config panel */}
        {selectedNode && (
          <WfConfigPanel
            node={selectedNode}
            onUpdate={handleNodeUpdate}
            onDelete={handleNodeDelete}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}
