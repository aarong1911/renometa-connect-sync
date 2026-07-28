import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Plus, Trash2, GripVertical, Star, StarOff, GitBranch, ArrowUp, ArrowDown,
  Archive, ArchiveRestore, Loader2, Check,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  createPipeline,
  createPipelineStage,
  deletePipeline,
  deletePipelineStage,
  reorderPipelineStages,
  setDefaultPipeline,
  setPipelineActive,
  updatePipeline,
  updatePipelineStage,
  usePipelines,
  usePipelineStages,
} from "@/lib/deals-store";
import type { SalesPipeline, SalesPipelineStage, StageOutcome } from "@/lib/sales/types";

export const Route = createFileRoute("/settings/pipelines")({
  component: PipelinesSettings,
});

// Curated palette matching the hex values already in use across the
// Pipeline board (pipeline.tsx's DEFAULT_STAGE_COLORS) and the live
// pipeline_stages data — not an arbitrary browser color input.
const STAGE_COLOR_PALETTE = [
  "#3B82F6", // blue
  "#0EA5E9", // sky
  "#06B6D4", // cyan
  "#8B5CF6", // violet
  "#F59E0B", // amber
  "#F97316", // orange
  "#22C55E", // green
  "#10B981", // emerald
  "#EF4444", // red
  "#64748B", // slate
];

const OUTCOME_LABELS: Record<StageOutcome, string> = {
  open: "Open",
  won: "Won",
  lost: "Lost",
};

function ColorSwatch({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn("inline-block h-4 w-4 shrink-0 rounded-full ring-1 ring-black/10", className)}
      style={{ backgroundColor: color }}
    />
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5">
          <ColorSwatch color={value} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-2">
        <div className="grid grid-cols-5 gap-1.5">
          {STAGE_COLOR_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
              className="flex h-7 w-7 items-center justify-center rounded-full ring-1 ring-black/10 transition-transform hover:scale-110"
              style={{ backgroundColor: c }}
              title={c}
            >
              {value.toLowerCase() === c.toLowerCase() && <Check className="h-3.5 w-3.5 text-white drop-shadow" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PipelinesSettings() {
  const pipelines = usePipelines();
  const allStages = usePipelineStages();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState("");
  const [creating, setCreating] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<SalesPipeline | null>(null);
  const [archiveWarnTarget, setArchiveWarnTarget] = useState<SalesPipeline | null>(null);
  const [deleteStageTarget, setDeleteStageTarget] = useState<SalesPipelineStage | null>(null);
  const [busy, setBusy] = useState(false);

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

  const stages = useMemo(
    () =>
      allStages
        .filter((s) => s.pipelineId === selectedId && s.id.length > 20)
        .sort((a, b) => a.position - b.position),
    [allStages, selectedId],
  );

  async function handleCreate() {
    if (!newPipelineName.trim()) {
      toast.error("Pipeline name is required.");
      return;
    }
    setCreating(true);
    try {
      const created = await createPipeline({ name: newPipelineName.trim() });
      setSelectedId(created.id);
      setCreateOpen(false);
      setNewPipelineName("");
      toast.success(`"${created.name}" created`);
    } catch (error) {
      console.error("[settings.pipelines] create failed:", error);
      toast.error(error instanceof Error ? error.message : "Failed to create pipeline.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(name: string) {
    if (!selected) return;
    try {
      await updatePipeline(selected.id, { name });
    } catch (error) {
      console.error("[settings.pipelines] rename failed:", error);
      toast.error(error instanceof Error ? error.message : "Failed to rename pipeline.");
    }
  }

  async function handleDescriptionChange(description: string) {
    if (!selected) return;
    try {
      await updatePipeline(selected.id, { description });
    } catch (error) {
      console.error("[settings.pipelines] description update failed:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update description.");
    }
  }

  async function handleSetDefault() {
    if (!selected) return;
    setBusy(true);
    try {
      await setDefaultPipeline(selected.id);
      toast.success(`"${selected.name}" set as default`);
    } catch (error) {
      console.error("[settings.pipelines] set default failed:", error);
      toast.error(error instanceof Error ? error.message : "Failed to set default pipeline.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleActive(pipeline: SalesPipeline) {
    if (pipeline.isActive && pipeline.isDefault) {
      setArchiveWarnTarget(pipeline);
      return;
    }
    await performToggleActive(pipeline);
  }

  async function performToggleActive(pipeline: SalesPipeline) {
    setBusy(true);
    try {
      await setPipelineActive(pipeline.id, !pipeline.isActive);
      toast.success(pipeline.isActive ? `"${pipeline.name}" archived` : `"${pipeline.name}" activated`);
    } catch (error) {
      console.error("[settings.pipelines] toggle active failed:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update pipeline status.");
    } finally {
      setBusy(false);
      setArchiveWarnTarget(null);
    }
  }

  async function handleDeletePipeline() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await deletePipeline(deleteTarget.id);
      toast.success(`"${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
    } catch (error) {
      console.error("[settings.pipelines] delete failed:", error);
      toast.error(error instanceof Error ? error.message : "Failed to delete pipeline.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddStage() {
    if (!selected) return;
    try {
      await createPipelineStage(selected.id, { name: "New Stage" });
    } catch (error) {
      console.error("[settings.pipelines] add stage failed:", error);
      toast.error(error instanceof Error ? error.message : "Failed to add stage.");
    }
  }

  async function handleMoveStage(index: number, direction: -1 | 1) {
    if (!selected) return;
    const target = index + direction;
    if (target < 0 || target >= stages.length) return;
    const next = [...stages];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    try {
      await reorderPipelineStages(selected.id, next.map((s) => s.id));
    } catch (error) {
      console.error("[settings.pipelines] reorder failed:", error);
      toast.error(error instanceof Error ? error.message : "Failed to reorder stages.");
    }
  }

  async function handleStagePatch(
    stageId: string,
    patch: Parameters<typeof updatePipelineStage>[1],
    errorLabel: string,
  ) {
    try {
      await updatePipelineStage(stageId, patch);
    } catch (error) {
      console.error(`[settings.pipelines] ${errorLabel} failed:`, error);
      toast.error(error instanceof Error ? error.message : `Failed to update ${errorLabel}.`);
    }
  }

  async function handleDeleteStage() {
    if (!deleteStageTarget) return;
    setBusy(true);
    try {
      await deletePipelineStage(deleteStageTarget.id);
      toast.success(`"${deleteStageTarget.name}" deleted`);
      setDeleteStageTarget(null);
    } catch (error) {
      console.error("[settings.pipelines] delete stage failed:", error);
      toast.error(error instanceof Error ? error.message : "Failed to delete stage.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={GitBranch}
        iconBg="bg-violet-soft"
        iconColor="text-violet"
        title="Pipeline Settings"
        subtitle="Configure your sales pipelines and their stages. Changes apply immediately across the board, New Deal dialog, and Deal drawer."
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New pipeline
          </Button>
        }
      />

      {pipelines.length === 0 ? (
        <Card className="p-10 text-center">
          <GitBranch className="mx-auto h-8 w-8 text-muted-foreground" />
          <h3 className="mt-3 font-semibold">No pipelines yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a pipeline to start organizing your sales stages.
          </p>
          <Button size="sm" className="mt-4" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New pipeline
          </Button>
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
                    {p.isDefault ? " · default" : ""}
                    {!p.isActive ? " · archived" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {selected && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || selected.isDefault}
                  onClick={handleSetDefault}
                >
                  {selected.isDefault ? (
                    <>
                      <Star className="mr-1.5 h-3.5 w-3.5 fill-current text-gold" />
                      Default
                    </>
                  ) : (
                    <>
                      <StarOff className="mr-1.5 h-3.5 w-3.5" />
                      Set as default
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => handleToggleActive(selected)}
                >
                  {selected.isActive ? (
                    <>
                      <Archive className="mr-1.5 h-3.5 w-3.5" />
                      Archive
                    </>
                  ) : (
                    <>
                      <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" />
                      Activate
                    </>
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => setDeleteTarget(selected)}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Delete
                </Button>
              </>
            )}
          </div>

          {selected && (
            <Card className="space-y-4 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Pipeline name
                  </Label>
                  <Input
                    value={selected.name}
                    onChange={(e) => handleRename(e.target.value)}
                    className="font-medium"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Description
                  </Label>
                  <Textarea
                    value={selected.description ?? ""}
                    onChange={(e) => handleDescriptionChange(e.target.value)}
                    placeholder="Optional description"
                    className="min-h-9 resize-none py-2 text-sm"
                    rows={1}
                  />
                </div>
              </div>

              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Preview
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {stages.map((stage, i) => (
                    <span key={stage.id} className="flex items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className="gap-1.5 font-medium"
                        style={{
                          borderColor: `${stage.color}55`,
                          backgroundColor: `${stage.color}14`,
                          color: stage.color,
                        }}
                      >
                        <ColorSwatch color={stage.color} className="h-2.5 w-2.5" />
                        {stage.name || "Untitled"}
                      </Badge>
                      {i < stages.length - 1 && <span className="text-muted-foreground">›</span>}
                    </span>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Stages
                  </div>
                  <Button variant="outline" size="sm" onClick={handleAddStage}>
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Add stage
                  </Button>
                </div>

                <div className="space-y-1.5">
                  {stages.map((stage, idx) => (
                    <div
                      key={stage.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-2.5 sm:flex-nowrap"
                    >
                      <div className="flex shrink-0 flex-col">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => handleMoveStage(idx, -1)}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === stages.length - 1}
                          onClick={() => handleMoveStage(idx, 1)}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />

                      <Input
                        defaultValue={stage.name}
                        onBlur={(e) => {
                          if (e.target.value.trim() && e.target.value !== stage.name) {
                            handleStagePatch(stage.id, { name: e.target.value }, "stage name");
                          }
                        }}
                        className="h-8 min-w-32 flex-1"
                        placeholder="Stage name"
                      />

                      <ColorPicker
                        value={stage.color}
                        onChange={(color) => handleStagePatch(stage.id, { color }, "stage color")}
                      />

                      <div className="flex shrink-0 items-center gap-1">
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          defaultValue={stage.probability}
                          onBlur={(e) => {
                            const value = Number(e.target.value);
                            if (Number.isFinite(value) && value !== stage.probability) {
                              handleStagePatch(stage.id, { probability: value }, "probability");
                            }
                          }}
                          className="h-8 w-16 text-xs"
                        />
                        <span className="text-xs text-muted-foreground">%</span>
                      </div>

                      <Select
                        value={stage.outcome}
                        onValueChange={(value) =>
                          handleStagePatch(stage.id, { outcome: value as StageOutcome }, "outcome")
                        }
                      >
                        <SelectTrigger className="h-8 w-28 shrink-0 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(Object.keys(OUTCOME_LABELS) as StageOutcome[]).map((o) => (
                            <SelectItem key={o} value={o}>
                              {OUTCOME_LABELS[o]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => setDeleteStageTarget(stage)}
                        disabled={stages.length <= 1}
                        title={stages.length <= 1 ? "A pipeline must have at least one stage" : "Delete stage"}
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

      {/* Create pipeline */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New pipeline</DialogTitle>
            <DialogDescription>
              Start with a single default stage — add more once it's created.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label>Pipeline name</Label>
            <Input
              value={newPipelineName}
              onChange={(e) => setNewPipelineName(e.target.value)}
              placeholder="e.g. Commercial Projects"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating || !newPipelineName.trim()}>
              {creating ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1.5 h-3.5 w-3.5" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive default pipeline warning */}
      <AlertDialog open={!!archiveWarnTarget} onOpenChange={(o) => !o && setArchiveWarnTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive the default pipeline?</AlertDialogTitle>
            <AlertDialogDescription>
              "{archiveWarnTarget?.name}" is currently your organization's default pipeline. Archiving
              it means new Deals will no longer default to it until another pipeline is set as default.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => archiveWarnTarget && performToggleActive(archiveWarnTarget)}
            >
              Archive anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete pipeline */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the pipeline and its stages. Blocked automatically if any Deal
              still references it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeletePipeline}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete stage */}
      <AlertDialog open={!!deleteStageTarget} onOpenChange={(o) => !o && setDeleteStageTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteStageTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Blocked automatically if any Deal is currently in this stage.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteStage}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
