import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, GripVertical, Copy, Star, StarOff, GitBranch } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  PIPELINE_TEMPLATES,
  STAGE_COLORS,
  STAGE_COLOR_CLASS,
  type StageColor,
  addStage,
  createBlankPipeline,
  createPipelineFromTemplate,
  deletePipeline,
  duplicatePipeline,
  removeStage,
  renamePipeline,
  reorderStages,
  setActivePipeline,
  updateStage,
  useActivePipelineId,
  usePipelines,
} from "@/lib/pipelines";

export const Route = createFileRoute("/settings/pipelines")({
  component: PipelinesSettings,
});

function PipelinesSettings() {
  const pipelines = usePipelines();
  const activeId = useActivePipelineId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!selectedId && pipelines[0]) setSelectedId(pipelines[0].id);
    if (selectedId && !pipelines.find((p) => p.id === selectedId)) {
      setSelectedId(pipelines[0]?.id ?? null);
    }
  }, [pipelines, selectedId]);

  const selected = useMemo(
    () => pipelines.find((p) => p.id === selectedId) ?? null,
    [pipelines, selectedId],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Pipelines</h2>
          <p className="text-sm text-muted-foreground">
            Build and manage workflow pipelines. Pick a template or start from scratch.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Dialog open={tplOpen} onOpenChange={setTplOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <GitBranch className="mr-1.5 h-3.5 w-3.5" />
                From template
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Choose a template</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                {PIPELINE_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    onClick={() => {
                      const p = createPipelineFromTemplate(tpl.id);
                      setSelectedId(p.id);
                      setTplOpen(false);
                      toast.success(`Created "${p.name}"`);
                    }}
                    className="rounded-lg border p-3 text-left hover:bg-secondary transition-colors"
                  >
                    <div className="font-medium text-sm">{tpl.name}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {tpl.stages.length} stages
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {tpl.stages.map((s, i) => (
                        <span
                          key={i}
                          className={cn(
                            "rounded border px-1.5 py-0.5 text-[10px]",
                            STAGE_COLOR_CLASS[s.color],
                          )}
                        >
                          {s.name}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
              <DialogFooter />
            </DialogContent>
          </Dialog>
          <Button
            size="sm"
            onClick={() => {
              const p = createBlankPipeline();
              setSelectedId(p.id);
              toast.success("Pipeline created");
            }}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New pipeline
          </Button>
        </div>
      </div>

      {pipelines.length === 0 ? (
        <Card className="p-10 text-center">
          <GitBranch className="mx-auto h-8 w-8 text-muted-foreground" />
          <h3 className="mt-3 font-semibold">No pipelines yet</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Start from a template or create a blank pipeline.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setTplOpen(true)}>
              Use a template
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const p = createBlankPipeline();
                setSelectedId(p.id);
              }}
            >
              Create blank
            </Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={selectedId ?? ""} onValueChange={setSelectedId}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Select pipeline" />
              </SelectTrigger>
              <SelectContent>
                {pipelines.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {activeId === p.id ? " · active" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (activeId === selected.id) {
                      setActivePipeline(null);
                      toast.success("Unset active pipeline");
                    } else {
                      setActivePipeline(selected.id);
                      toast.success(`"${selected.name}" set as active`);
                    }
                  }}
                >
                  {activeId === selected.id ? (
                    <>
                      <StarOff className="mr-1.5 h-3.5 w-3.5" />
                      Unset active
                    </>
                  ) : (
                    <>
                      <Star className="mr-1.5 h-3.5 w-3.5" />
                      Set as active
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const p = duplicatePipeline(selected.id);
                    if (p) {
                      setSelectedId(p.id);
                      toast.success("Pipeline duplicated");
                    }
                  }}
                >
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  Duplicate
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    if (confirm(`Delete "${selected.name}"?`)) {
                      deletePipeline(selected.id);
                      toast.success("Pipeline deleted");
                    }
                  }}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Delete
                </Button>
              </>
            )}
          </div>

          {selected && (
            <Card className="p-4 space-y-4">
              <div className="flex items-center gap-2">
                <Input
                  value={selected.name}
                  onChange={(e) => renamePipeline(selected.id, e.target.value)}
                  className="max-w-md font-medium"
                />
              </div>

              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Preview
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {selected.stages.map((s, i) => (
                    <span key={s.id} className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "rounded border px-2 py-1 text-xs",
                          STAGE_COLOR_CLASS[s.color],
                        )}
                      >
                        {s.name || "Untitled"}
                      </span>
                      {i < selected.stages.length - 1 && (
                        <span className="text-muted-foreground">›</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Stages · drag to reorder
                  </div>
                  <Button variant="outline" size="sm" onClick={() => addStage(selected.id)}>
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Add stage
                  </Button>
                </div>
                <div className="space-y-1.5">
                  {selected.stages.map((stage, idx) => (
                    <div
                      key={stage.id}
                      draggable
                      onDragStart={() => setDragIndex(idx)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setOverIndex(idx);
                      }}
                      onDragLeave={() => setOverIndex((i) => (i === idx ? null : i))}
                      onDrop={() => {
                        if (dragIndex !== null && dragIndex !== idx) {
                          reorderStages(selected.id, dragIndex, idx);
                        }
                        setDragIndex(null);
                        setOverIndex(null);
                      }}
                      onDragEnd={() => {
                        setDragIndex(null);
                        setOverIndex(null);
                      }}
                      className={cn(
                        "flex items-center gap-2 rounded-md border bg-card p-2 transition-all",
                        dragIndex === idx && "opacity-50",
                        overIndex === idx && dragIndex !== idx && "ring-2 ring-primary",
                      )}
                    >
                      <GripVertical className="h-4 w-4 cursor-grab text-muted-foreground" />
                      <Input
                        value={stage.name}
                        onChange={(e) =>
                          updateStage(selected.id, stage.id, { name: e.target.value })
                        }
                        className="h-8 flex-1"
                        placeholder="Stage name"
                      />
                      <Select
                        value={stage.color}
                        onValueChange={(v) =>
                          updateStage(selected.id, stage.id, { color: v as StageColor })
                        }
                      >
                        <SelectTrigger className="h-8 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STAGE_COLORS.map((c) => (
                            <SelectItem key={c} value={c}>
                              <span className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    "h-3 w-3 rounded border",
                                    STAGE_COLOR_CLASS[c],
                                  )}
                                />
                                <span className="capitalize">{c}</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => removeStage(selected.id, stage.id)}
                        disabled={selected.stages.length <= 1}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}