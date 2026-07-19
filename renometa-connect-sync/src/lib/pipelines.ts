export type StageColor = "primary" | "success" | "warning" | "danger" | "muted" | "accent";

export type Stage = {
  id: string;
  name: string;
  color: StageColor;
};

export type Pipeline = {
  id: string;
  name: string;
  stages: Stage[];
};

const KEY = "renometa.pipelines.v1";
const ACTIVE_KEY = "renometa.pipelines.active.v1";

export const STAGE_COLORS: StageColor[] = ["primary", "success", "warning", "danger", "muted", "accent"];

export const PIPELINE_TEMPLATES: { id: string; name: string; stages: Omit<Stage, "id">[] }[] = [
  {
    id: "home-services",
    name: "Home Services",
    stages: [
      { name: "New Lead", color: "muted" },
      { name: "Contacted", color: "primary" },
      { name: "Estimate Sent", color: "accent" },
      { name: "Scheduled", color: "warning" },
      { name: "Completed", color: "success" },
      { name: "Invoiced", color: "success" },
    ],
  },
  {
    id: "remodel",
    name: "Remodel / Construction",
    stages: [
      { name: "Discovery", color: "muted" },
      { name: "Site Visit", color: "primary" },
      { name: "Design", color: "accent" },
      { name: "Proposal", color: "warning" },
      { name: "Contract Signed", color: "success" },
      { name: "Build", color: "warning" },
      { name: "Punch List & Close", color: "success" },
    ],
  },
];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function read(): Pipeline[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Pipeline[]) : [];
  } catch {
    return [];
  }
}

function write(pipelines: Pipeline[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(pipelines));
  window.dispatchEvent(new Event("pipelines:changed"));
}

import { useEffect, useState } from "react";

export function usePipelines() {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  useEffect(() => {
    setPipelines(read());
    const h = () => setPipelines(read());
    window.addEventListener("pipelines:changed", h);
    return () => window.removeEventListener("pipelines:changed", h);
  }, []);
  return pipelines;
}

export function useActivePipelineId() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    setId(localStorage.getItem(ACTIVE_KEY));
    const h = () => setId(localStorage.getItem(ACTIVE_KEY));
    window.addEventListener("pipelines:changed", h);
    return () => window.removeEventListener("pipelines:changed", h);
  }, []);
  return id;
}

export function setActivePipeline(id: string | null) {
  if (typeof window === "undefined") return;
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
  window.dispatchEvent(new Event("pipelines:changed"));
}

export function createPipelineFromTemplate(templateId: string, name?: string): Pipeline {
  const tpl = PIPELINE_TEMPLATES.find((t) => t.id === templateId);
  const pipeline: Pipeline = {
    id: uid(),
    name: name ?? tpl?.name ?? "New Pipeline",
    stages: (tpl?.stages ?? [{ name: "Stage 1", color: "primary" }]).map((s) => ({ ...s, id: uid() })),
  };
  const all = read();
  write([...all, pipeline]);
  return pipeline;
}

export function createBlankPipeline(name = "Untitled Pipeline"): Pipeline {
  const pipeline: Pipeline = {
    id: uid(),
    name,
    stages: [
      { id: uid(), name: "To Do", color: "muted" },
      { id: uid(), name: "In Progress", color: "primary" },
      { id: uid(), name: "Done", color: "success" },
    ],
  };
  const all = read();
  write([...all, pipeline]);
  return pipeline;
}

export function duplicatePipeline(id: string): Pipeline | null {
  const all = read();
  const src = all.find((p) => p.id === id);
  if (!src) return null;
  const copy: Pipeline = {
    id: uid(),
    name: `${src.name} (copy)`,
    stages: src.stages.map((s) => ({ ...s, id: uid() })),
  };
  write([...all, copy]);
  return copy;
}

export function deletePipeline(id: string) {
  write(read().filter((p) => p.id !== id));
  if (typeof window !== "undefined" && localStorage.getItem(ACTIVE_KEY) === id) {
    setActivePipeline(null);
  }
}

export function renamePipeline(id: string, name: string) {
  write(read().map((p) => (p.id === id ? { ...p, name } : p)));
}

export function updateStage(pipelineId: string, stageId: string, patch: Partial<Omit<Stage, "id">>) {
  write(
    read().map((p) =>
      p.id === pipelineId
        ? { ...p, stages: p.stages.map((s) => (s.id === stageId ? { ...s, ...patch } : s)) }
        : p,
    ),
  );
}

export function addStage(pipelineId: string) {
  write(
    read().map((p) =>
      p.id === pipelineId
        ? { ...p, stages: [...p.stages, { id: uid(), name: "New Stage", color: "muted" as StageColor }] }
        : p,
    ),
  );
}

export function removeStage(pipelineId: string, stageId: string) {
  write(
    read().map((p) =>
      p.id === pipelineId ? { ...p, stages: p.stages.filter((s) => s.id !== stageId) } : p,
    ),
  );
}

export function reorderStages(pipelineId: string, from: number, to: number) {
  write(
    read().map((p) => {
      if (p.id !== pipelineId) return p;
      const next = [...p.stages];
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      return { ...p, stages: next };
    }),
  );
}

export const STAGE_COLOR_CLASS: Record<StageColor, string> = {
  primary: "bg-primary/15 text-primary border-primary/30",
  success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  danger: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  muted: "bg-muted text-muted-foreground border-border",
  accent: "bg-accent text-accent-foreground border-border",
};