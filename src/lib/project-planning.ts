// src/lib/project-planning.ts
//
// Phase 13.2 — Project Planning foundation: phases, milestones, and Task
// dependencies. Backed by supabase/migrations/20260812_project_planning_phases_milestones.sql
// (project_phases, project_milestones, task_dependencies, plus
// tasks.phase_id/milestone_id) — every function here degrades to a clear
// empty result or error message rather than crashing if that migration
// hasn't been applied yet in a given environment (see isMissingTableError).
//
// Not a reactive useSyncExternalStore module like projects-store.ts/
// tasks-store.ts — phases/milestones/dependencies are always scoped to
// exactly one open Project detail view, so a plain per-Project fetch (the
// same pattern EntityAppointmentsPanel and the Project detail Financials/
// Communications/Photos tabs already use) is simpler and sufficient; no
// cross-page reactivity is needed.
import { supabase } from "@/lib/supabase";
import { getOrgId } from "@/lib/contacts-store";
import type { Task } from "@/lib/mock-data";
import { addTask, deleteTask } from "@/lib/tasks-store";
import type { ProjectPlanTemplate } from "@/lib/project-plan-templates";

// ── Phases ──────────────────────────────────────────────────────────────

export type PhaseStatus = "not_started" | "in_progress" | "completed" | "on_hold" | "skipped";

export const PHASE_STATUS_ORDER: PhaseStatus[] = ["not_started", "in_progress", "completed", "on_hold", "skipped"];

export const PHASE_STATUS_LABELS: Record<PhaseStatus, string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  completed: "Completed",
  on_hold: "On Hold",
  skipped: "Skipped",
};

export type ProjectPhase = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  position: number;
  status: PhaseStatus;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  /** Manual override, null = derive from Tasks — see getPhaseDisplayProgress. */
  completionPercentage: number | null;
  color: string | null;
  isCustomerVisible: boolean;
  isFieldVisible: boolean;
  createdAt: string;
  /** source_template_key/source_template_name/generated_by_template when this phase was created by applyProjectPlanTemplate() — the duplicate-application check below reads source_template_key. Plain object, not a typed shape — mirrors how the rest of this codebase treats jsonb metadata columns (see estimate_proposal_templates, etc.). */
  metadata: Record<string, any>;
};

function isMissingTableError(message: string | undefined): boolean {
  return !!message && (message.includes("does not exist") || message.includes("schema cache"));
}

function mapPhaseRow(row: any): ProjectPhase {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description ?? null,
    position: row.position ?? 0,
    status: (row.status as PhaseStatus) ?? "not_started",
    plannedStartDate: row.planned_start_date ?? null,
    plannedEndDate: row.planned_end_date ?? null,
    actualStartDate: row.actual_start_date ?? null,
    actualEndDate: row.actual_end_date ?? null,
    completionPercentage: typeof row.completion_percentage === "number" ? row.completion_percentage : null,
    color: row.color ?? null,
    isCustomerVisible: !!row.is_customer_visible,
    isFieldVisible: row.is_field_visible !== false,
    createdAt: row.created_at,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  };
}

export async function fetchProjectPhases(projectId: string): Promise<{ phases: ProjectPhase[]; error: string | null }> {
  const { data, error } = await supabase
    .from("project_phases")
    .select("*")
    .eq("project_id", projectId)
    .order("position", { ascending: true });

  if (error) {
    if (isMissingTableError(error.message)) {
      return { phases: [], error: "Project planning isn't set up yet — deploy the Phase 13.2 migration (see supabase/migrations/20260812_project_planning_phases_milestones.sql)." };
    }
    console.error("[project-planning] fetchProjectPhases failed:", error);
    return { phases: [], error: error.message };
  }
  return { phases: (data ?? []).map(mapPhaseRow), error: null };
}

/**
 * Phase 13.2B — Calendar integration (Part 35): one org-wide fetch each for
 * phases/milestones, instead of one query per visible Project. Calendar
 * already loads every accessible Project via useProjects(); this mirrors
 * that same "fetch once, filter/group in memory" shape rather than
 * fetching per-Project like the Project detail drawer does (that fetch is
 * fine there — it's scoped to exactly one open Project).
 */
export async function fetchOrgPhases(): Promise<{ phases: ProjectPhase[]; error: string | null }> {
  const orgId = await getOrgId();
  if (!orgId) return { phases: [], error: null };

  const { data, error } = await supabase.from("project_phases").select("*").eq("org_id", orgId);
  if (error) {
    if (isMissingTableError(error.message)) return { phases: [], error: null };
    console.error("[project-planning] fetchOrgPhases failed:", error);
    return { phases: [], error: error.message };
  }
  return { phases: (data ?? []).map(mapPhaseRow), error: null };
}

export type CreatePhaseInput = {
  projectId: string;
  name: string;
  description?: string | null;
  position: number;
  plannedStartDate?: string | null;
  plannedEndDate?: string | null;
  metadata?: Record<string, any>;
};

export async function createProjectPhase(input: CreatePhaseInput): Promise<{ phase?: ProjectPhase; error: string | null }> {
  const orgId = await getOrgId();
  if (!orgId) return { error: "Not authenticated" };

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from("project_phases")
    .insert({
      org_id: orgId,
      project_id: input.projectId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      position: input.position,
      planned_start_date: input.plannedStartDate || null,
      planned_end_date: input.plannedEndDate || null,
      created_by: user?.id ?? null,
      metadata: input.metadata ?? {},
    })
    .select("*")
    .single();

  if (error || !data) {
    console.error("[project-planning] createProjectPhase failed:", error);
    return { error: error?.message ?? "Could not create phase" };
  }
  return { phase: mapPhaseRow(data), error: null };
}

export type UpdatePhaseInput = Partial<{
  name: string;
  description: string | null;
  position: number;
  status: PhaseStatus;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  completionPercentage: number | null;
}>;

export async function updateProjectPhase(id: string, patch: UpdatePhaseInput): Promise<{ phase?: ProjectPhase; error: string | null }> {
  const payload: Record<string, any> = {};
  if (patch.name !== undefined) payload.name = patch.name.trim();
  if (patch.description !== undefined) payload.description = patch.description?.trim() || null;
  if (patch.position !== undefined) payload.position = patch.position;
  if (patch.status !== undefined) payload.status = patch.status;
  if (patch.plannedStartDate !== undefined) payload.planned_start_date = patch.plannedStartDate || null;
  if (patch.plannedEndDate !== undefined) payload.planned_end_date = patch.plannedEndDate || null;
  if (patch.actualStartDate !== undefined) payload.actual_start_date = patch.actualStartDate || null;
  if (patch.actualEndDate !== undefined) payload.actual_end_date = patch.actualEndDate || null;
  if (patch.completionPercentage !== undefined) {
    payload.completion_percentage = patch.completionPercentage === null
      ? null
      : Math.min(100, Math.max(0, Math.round(patch.completionPercentage)));
  }

  const { data, error } = await supabase.from("project_phases").update(payload).eq("id", id).select("*").single();
  if (error || !data) {
    console.error("[project-planning] updateProjectPhase failed:", error);
    return { error: error?.message ?? "Could not update phase" };
  }
  return { phase: mapPhaseRow(data), error: null };
}

/** Tasks/milestones referencing this phase are NOT deleted — tasks.phase_id and project_milestones.phase_id are ON DELETE SET NULL, so they fall back to "unassigned" rather than disappearing. Caller is responsible for the confirmation UX; this function does not ask again. */
export async function deleteProjectPhase(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from("project_phases").delete().eq("id", id);
  if (error) {
    console.error("[project-planning] deleteProjectPhase failed:", error);
    return { error: error.message };
  }
  return { error: null };
}

/** Swaps `position` with the adjacent phase in the given direction — the simplest correct reorder primitive; the caller re-sorts its local list by the returned positions. */
export async function movePhase(phases: ProjectPhase[], phaseId: string, direction: "up" | "down"): Promise<{ error: string | null }> {
  const sorted = [...phases].sort((a, b) => a.position - b.position);
  const idx = sorted.findIndex((p) => p.id === phaseId);
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return { error: null };

  const a = sorted[idx];
  const b = sorted[swapIdx];
  const [err1, err2] = await Promise.all([
    supabase.from("project_phases").update({ position: b.position }).eq("id", a.id),
    supabase.from("project_phases").update({ position: a.position }).eq("id", b.id),
  ]);
  const error = err1.error?.message ?? err2.error?.message ?? null;
  if (error) console.error("[project-planning] movePhase failed:", error);
  return { error };
}

/** Workflow-based fallback when a phase has no Tasks — not a claim of real completion, mirrors the same "manual value vs derived default" split used for Project progress (Phase 13.4). */
const PHASE_STATUS_FALLBACK_PROGRESS: Record<PhaseStatus, number> = {
  not_started: 0,
  in_progress: 50,
  completed: 100,
  on_hold: 0,
  skipped: 0,
};

/** Preferred progress source: completed/total ACTIVE Tasks in the phase (excludes cancelled) when the phase has any Tasks at all; otherwise the phase's manual completion_percentage if set, else a status-based fallback. */
export function getPhaseDisplayProgress(phase: ProjectPhase, phaseTasks: Task[]): number {
  const active = phaseTasks.filter((t) => t.status !== "cancelled");
  if (active.length > 0) {
    const done = active.filter((t) => t.status === "completed").length;
    return Math.round((done / active.length) * 100);
  }
  if (phase.completionPercentage !== null) return phase.completionPercentage;
  return PHASE_STATUS_FALLBACK_PROGRESS[phase.status];
}

// ── Milestones ──────────────────────────────────────────────────────────

export type MilestoneStatus = "pending" | "achieved" | "missed" | "cancelled";

export const MILESTONE_STATUS_LABELS: Record<MilestoneStatus, string> = {
  pending: "Pending",
  achieved: "Achieved",
  missed: "Missed",
  cancelled: "Cancelled",
};

export type ProjectMilestone = {
  id: string;
  projectId: string;
  phaseId: string | null;
  name: string;
  description: string | null;
  status: MilestoneStatus;
  plannedDate: string | null;
  completedAt: string | null;
  position: number;
  isCustomerVisible: boolean;
  isFieldVisible: boolean;
  metadata: Record<string, any>;
};

function mapMilestoneRow(row: any): ProjectMilestone {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id ?? null,
    name: row.name,
    description: row.description ?? null,
    status: (row.status as MilestoneStatus) ?? "pending",
    plannedDate: row.planned_date ?? null,
    completedAt: row.completed_at ?? null,
    position: row.position ?? 0,
    isCustomerVisible: !!row.is_customer_visible,
    isFieldVisible: row.is_field_visible !== false,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  };
}

export async function fetchProjectMilestones(projectId: string): Promise<{ milestones: ProjectMilestone[]; error: string | null }> {
  const { data, error } = await supabase
    .from("project_milestones")
    .select("*")
    .eq("project_id", projectId)
    .order("position", { ascending: true });

  if (error) {
    if (isMissingTableError(error.message)) return { milestones: [], error: null };
    console.error("[project-planning] fetchProjectMilestones failed:", error);
    return { milestones: [], error: error.message };
  }
  return { milestones: (data ?? []).map(mapMilestoneRow), error: null };
}

/** Org-wide milestone fetch — see fetchOrgPhases() above for why this exists alongside the per-Project fetchProjectMilestones(). */
export async function fetchOrgMilestones(): Promise<{ milestones: ProjectMilestone[]; error: string | null }> {
  const orgId = await getOrgId();
  if (!orgId) return { milestones: [], error: null };

  const { data, error } = await supabase.from("project_milestones").select("*").eq("org_id", orgId);
  if (error) {
    if (isMissingTableError(error.message)) return { milestones: [], error: null };
    console.error("[project-planning] fetchOrgMilestones failed:", error);
    return { milestones: [], error: error.message };
  }
  return { milestones: (data ?? []).map(mapMilestoneRow), error: null };
}

export type CreateMilestoneInput = {
  projectId: string;
  phaseId?: string | null;
  name: string;
  plannedDate?: string | null;
  position: number;
  metadata?: Record<string, any>;
};

export async function createProjectMilestone(input: CreateMilestoneInput): Promise<{ milestone?: ProjectMilestone; error: string | null }> {
  const orgId = await getOrgId();
  if (!orgId) return { error: "Not authenticated" };

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from("project_milestones")
    .insert({
      org_id: orgId,
      project_id: input.projectId,
      phase_id: input.phaseId ?? null,
      name: input.name.trim(),
      planned_date: input.plannedDate || null,
      position: input.position,
      created_by: user?.id ?? null,
      metadata: input.metadata ?? {},
    })
    .select("*")
    .single();

  if (error || !data) {
    console.error("[project-planning] createProjectMilestone failed:", error);
    return { error: error?.message ?? "Could not create milestone" };
  }
  return { milestone: mapMilestoneRow(data), error: null };
}

/** Idempotent: re-achieving an already-achieved milestone is a no-op success rather than overwriting completed_at with a later timestamp. */
export async function achieveMilestone(milestone: ProjectMilestone): Promise<{ milestone?: ProjectMilestone; error: string | null }> {
  if (milestone.status === "achieved") return { milestone, error: null };

  const { data, error } = await supabase
    .from("project_milestones")
    .update({ status: "achieved", completed_at: new Date().toISOString() })
    .eq("id", milestone.id)
    .select("*")
    .single();

  if (error || !data) {
    console.error("[project-planning] achieveMilestone failed:", error);
    return { error: error?.message ?? "Could not update milestone" };
  }
  return { milestone: mapMilestoneRow(data), error: null };
}

export async function deleteProjectMilestone(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from("project_milestones").delete().eq("id", id);
  if (error) console.error("[project-planning] deleteProjectMilestone failed:", error);
  return { error: error?.message ?? null };
}

// ── Task dependencies ──────────────────────────────────────────────────

export type TaskDependency = {
  id: string;
  projectId: string;
  predecessorTaskId: string;
  successorTaskId: string;
  dependencyType: "finish_to_start";
  lagDays: number;
};

function mapDependencyRow(row: any): TaskDependency {
  return {
    id: row.id,
    projectId: row.project_id,
    predecessorTaskId: row.predecessor_task_id,
    successorTaskId: row.successor_task_id,
    dependencyType: row.dependency_type ?? "finish_to_start",
    lagDays: row.lag_days ?? 0,
  };
}

export async function fetchTaskDependencies(projectId: string): Promise<{ dependencies: TaskDependency[]; error: string | null }> {
  const { data, error } = await supabase
    .from("task_dependencies")
    .select("*")
    .eq("project_id", projectId);

  if (error) {
    if (isMissingTableError(error.message)) return { dependencies: [], error: null };
    console.error("[project-planning] fetchTaskDependencies failed:", error);
    return { dependencies: [], error: error.message };
  }
  return { dependencies: (data ?? []).map(mapDependencyRow), error: null };
}

/** The DB trigger (validate_task_dependency) is the real cycle guard — this just surfaces its error message (and the unique-pair constraint's) in a UI-friendly form instead of a raw Postgres error string. */
export async function createTaskDependency(input: {
  projectId: string; predecessorTaskId: string; successorTaskId: string; lagDays?: number;
}): Promise<{ dependency?: TaskDependency; error: string | null }> {
  if (input.predecessorTaskId === input.successorTaskId) {
    return { error: "A task cannot depend on itself." };
  }

  const orgId = await getOrgId();
  if (!orgId) return { error: "Not authenticated" };

  const { data, error } = await supabase
    .from("task_dependencies")
    .insert({
      org_id: orgId,
      project_id: input.projectId,
      predecessor_task_id: input.predecessorTaskId,
      successor_task_id: input.successorTaskId,
      lag_days: input.lagDays ?? 0,
    })
    .select("*")
    .single();

  if (error || !data) {
    if (error?.message?.includes("circular")) return { error: "This dependency would create a circular task sequence." };
    if (error?.code === "23505") return { error: "This dependency already exists." };
    console.error("[project-planning] createTaskDependency failed:", error);
    return { error: error?.message ?? "Could not add dependency" };
  }
  return { dependency: mapDependencyRow(data), error: null };
}

export async function deleteTaskDependency(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from("task_dependencies").delete().eq("id", id);
  if (error) console.error("[project-planning] deleteTaskDependency failed:", error);
  return { error: error?.message ?? null };
}

/** A task is blocked when it has an incomplete predecessor via a finish_to_start dependency. */
export function getBlockingTask(taskId: string, dependencies: TaskDependency[], tasksById: Map<string, Task>): Task | null {
  for (const dep of dependencies) {
    if (dep.successorTaskId !== taskId) continue;
    const predecessor = tasksById.get(dep.predecessorTaskId);
    if (predecessor && predecessor.status !== "completed" && predecessor.status !== "cancelled") return predecessor;
  }
  return null;
}

// ── Apply Project Plan Template ────────────────────────────────────────
//
// A single template-key-per-phase stamp (metadata.source_template_key) is
// enough to detect "was this template already applied" and to know which
// phases/milestones are safe to remove under Replace Unstarted Plan —
// deliberately not building a separate applied_templates table for this
// pass (see the Phase 13.2 continuation report for the reasoning).

/** True when any existing phase carries this template's key — the duplicate-application signal surfaced to the user before Apply proceeds. */
export function hasTemplateBeenApplied(phases: ProjectPhase[], templateKey: string): boolean {
  return phases.some((p) => p.metadata?.source_template_key === templateKey);
}

export type ApplyTemplateMode = "empty" | "merge" | "replace_unstarted";

export type ApplyTemplateSummary = {
  phaseCount: number;
  milestoneCount: number;
  taskCount: number;
  dependencyCount: number;
};

/**
 * Sequential client-side application with compensating cleanup — no
 * Supabase RPC/transaction exists for this yet (see the report's
 * deferred-items list), so every record created during this call is
 * tracked and deleted again, in reverse dependency order, the moment any
 * step fails. Never leaves a half-created plan without an error.
 */
export async function applyProjectPlanTemplate(params: {
  projectId: string;
  template: ProjectPlanTemplate;
  /** yyyy-mm-dd */
  planningStartDate: string;
  mode: ApplyTemplateMode;
  existingPhases: ProjectPhase[];
  existingMilestones: ProjectMilestone[];
}): Promise<{ error: string | null; summary?: ApplyTemplateSummary }> {
  const { projectId, template, planningStartDate, mode, existingPhases, existingMilestones } = params;

  const startBase = new Date(`${planningStartDate}T00:00:00`);
  if (Number.isNaN(startBase.getTime())) return { error: "Invalid planning start date" };

  const orgId = await getOrgId();
  if (!orgId) return { error: "Not authenticated" };

  // Replace Unstarted Plan — only ever removes phases/milestones this same
  // template mechanism generated (metadata.generated_by_template) and that
  // are still not_started/pending; manually created or in-progress/
  // completed/achieved records are never touched. Their Tasks are NOT
  // deleted (tasks.phase_id is ON DELETE SET NULL) — they fall back to
  // Unassigned Tasks rather than being destroyed, a deliberately
  // conservative reading of "replace" given a Task may have been renamed
  // or reassigned by the user since it was generated.
  if (mode === "replace_unstarted") {
    const phasesToRemove = existingPhases.filter((p) => p.status === "not_started" && p.metadata?.generated_by_template);
    const milestonesToRemove = existingMilestones.filter((m) => m.status === "pending" && m.metadata?.generated_by_template);
    for (const p of phasesToRemove) await deleteProjectPhase(p.id);
    for (const m of milestonesToRemove) await deleteProjectMilestone(m.id);
  }

  function addDays(days: number): string {
    const d = new Date(startBase);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  let cursor = 0;
  const phaseOffsets = new Map<string, { start: number; end: number }>();
  for (const p of template.phases) {
    phaseOffsets.set(p.key, { start: cursor, end: cursor + Math.max(0, p.durationDays) });
    cursor += Math.max(0, p.durationDays);
  }

  const createdPhaseIds: string[] = [];
  const createdMilestoneIds: string[] = [];
  const createdTaskIds: string[] = [];
  const createdDependencyIds: string[] = [];
  const phaseKeyToId = new Map<string, string>();
  const taskKeyToId = new Map<string, string>();

  async function rollback() {
    for (const id of createdDependencyIds) await deleteTaskDependency(id);
    for (const id of createdTaskIds) await deleteTask(id);
    for (const id of createdMilestoneIds) await deleteProjectMilestone(id);
    for (const id of createdPhaseIds) await deleteProjectPhase(id);
  }

  const sourceMeta = { source_template_key: template.key, source_template_name: template.name, generated_by_template: true };
  const phasePositionBase = mode === "merge" ? existingPhases.length : 0;
  const milestonePositionBase = mode === "merge" ? existingMilestones.length : 0;

  for (let i = 0; i < template.phases.length; i++) {
    const tp = template.phases[i];
    const offsets = phaseOffsets.get(tp.key)!;
    const { phase, error } = await createProjectPhase({
      projectId,
      name: tp.name,
      position: phasePositionBase + i,
      plannedStartDate: addDays(offsets.start),
      plannedEndDate: addDays(offsets.end),
      metadata: sourceMeta,
    });
    if (error || !phase) { await rollback(); return { error: error ?? `Could not create phase "${tp.name}"` }; }
    createdPhaseIds.push(phase.id);
    phaseKeyToId.set(tp.key, phase.id);
  }

  for (let i = 0; i < template.milestones.length; i++) {
    const tm = template.milestones[i];
    const phaseId = tm.phaseKey ? phaseKeyToId.get(tm.phaseKey) ?? null : null;
    const { milestone, error } = await createProjectMilestone({
      projectId,
      phaseId,
      name: tm.name,
      plannedDate: addDays(tm.offsetDays),
      position: milestonePositionBase + i,
      metadata: sourceMeta,
    });
    if (error || !milestone) { await rollback(); return { error: error ?? `Could not create milestone "${tm.name}"` }; }
    createdMilestoneIds.push(milestone.id);
  }

  for (const tt of template.tasks) {
    const phaseId = phaseKeyToId.get(tt.phaseKey);
    if (!phaseId) continue; // authored templates always reference a real phaseKey — defensive skip only
    const created = await addTask({
      projectId, phaseId, title: tt.title, due: new Date().toISOString(),
      status: "not_started", priority: "med", recurrence: "none",
    });
    if (!created) { await rollback(); return { error: `Could not create task "${tt.title}"` }; }
    createdTaskIds.push(created.id);
    taskKeyToId.set(tt.key, created.id);
  }

  for (const dep of template.dependencies) {
    const predecessorId = taskKeyToId.get(dep.fromTaskKey);
    const successorId = taskKeyToId.get(dep.toTaskKey);
    if (!predecessorId || !successorId) continue;
    const { dependency, error } = await createTaskDependency({ projectId, predecessorTaskId: predecessorId, successorTaskId: successorId });
    if (error || !dependency) { await rollback(); return { error: error ?? "Could not create task dependency" }; }
    createdDependencyIds.push(dependency.id);
  }

  return {
    error: null,
    summary: {
      phaseCount: createdPhaseIds.length,
      milestoneCount: createdMilestoneIds.length,
      taskCount: createdTaskIds.length,
      dependencyCount: createdDependencyIds.length,
    },
  };
}
