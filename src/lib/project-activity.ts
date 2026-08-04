// src/lib/project-activity.ts
//
// Phase 13.3A — Project Activity Feed foundation (Part 11/32). A pure,
// synchronous projection over data the Project detail drawer already
// loads — NOT a new activity/audit table. This generalizes the inline
// entry-merging IIFE that already lived in the Overview tab's "Recent
// Activity" card (src/routes/projects.index.tsx) into one reusable,
// testable function so Daily Logs/photos participate in the same feed
// without a second bespoke merge.
//
// What's derivable vs. what would need a real event log: "created" and
// "published" are derivable directly from stored timestamps
// (created_at/published_at) — no separate event row needed. "Archived"
// and "deleted" are NOT derivable after the fact (the status transition
// or the row itself is gone) and are deliberately NOT synthesized here;
// capturing those would require either a status-history table or
// delete-time logging, out of scope for this foundation pass (see the
// Phase 13.3A report).
import type { Task } from "@/lib/mock-data";
import type { ProjectDailyLog } from "@/lib/project-daily-logs";
import type { ProjectPhoto } from "@/lib/project-photos";

export type ProjectActivitySourceType =
  | "task_created" | "task_completed"
  | "note"
  | "daily_log_created" | "daily_log_published"
  | "photo_uploaded";

export type ProjectActivityEntry = {
  /** Stable derived id: `${sourceType}:${recordId}[:suffix]` — never random, so re-deriving on every render never reshuffles React keys. */
  id: string;
  projectId: string;
  sourceType: ProjectActivitySourceType;
  occurredAt: Date;
  actor: string | null;
  title: string;
  description?: string;
  relatedRecordId: string;
  isCustomerVisible: boolean;
  isFieldVisible: boolean;
};

type NoteLike = { id: string; body: string; created_at: string; author: string };

/**
 * Builds the normalized activity list from already-loaded Project data.
 * Callers sort/slice for their own presentation (e.g. Overview's compact
 * card takes the newest 6) — this function itself only normalizes and
 * leaves ordering to the caller's `.sort()` for flexibility, though
 * entries are returned newest-first by default for convenience.
 */
export function buildProjectActivity(params: {
  projectId: string;
  tasks: Task[];
  notes: NoteLike[];
  dailyLogs: ProjectDailyLog[];
  photos: ProjectPhoto[];
}): ProjectActivityEntry[] {
  const { projectId, tasks, notes, dailyLogs, photos } = params;
  const entries: ProjectActivityEntry[] = [];

  for (const t of tasks) {
    entries.push({
      id: `task_created:${t.id}`, projectId, sourceType: "task_created", occurredAt: new Date(t.due),
      actor: null, title: t.status === "completed" ? `Completed: ${t.title}` : `Task: ${t.title}`,
      description: t.priority !== "med" ? `${t.priority} priority` : undefined,
      relatedRecordId: t.id, isCustomerVisible: false, isFieldVisible: true,
    });
  }

  for (const n of notes) {
    entries.push({
      id: `note:${n.id}`, projectId, sourceType: "note", occurredAt: new Date(n.created_at),
      actor: n.author, title: `Note by ${n.author}`,
      description: n.body.length > 60 ? `${n.body.slice(0, 60)}…` : n.body,
      relatedRecordId: n.id, isCustomerVisible: false, isFieldVisible: false,
    });
  }

  for (const log of dailyLogs) {
    entries.push({
      id: `daily_log_created:${log.id}`, projectId, sourceType: "daily_log_created", occurredAt: new Date(log.createdAt),
      actor: log.createdBy, title: `Daily Log: ${log.title || log.summary.slice(0, 40)}`,
      description: log.logDate, relatedRecordId: log.id,
      isCustomerVisible: log.isCustomerVisible, isFieldVisible: log.isFieldVisible,
    });
    if (log.publishedAt) {
      entries.push({
        id: `daily_log_published:${log.id}`, projectId, sourceType: "daily_log_published", occurredAt: new Date(log.publishedAt),
        actor: log.createdBy, title: `Daily Log published — ${log.logDate}`,
        relatedRecordId: log.id, isCustomerVisible: log.isCustomerVisible, isFieldVisible: log.isFieldVisible,
      });
    }
  }

  for (const p of photos) {
    entries.push({
      id: `photo_uploaded:${p.id}`, projectId, sourceType: "photo_uploaded", occurredAt: new Date(p.createdAt),
      actor: p.uploadedBy, title: `Photo uploaded${p.caption ? `: ${p.caption}` : ""}`,
      description: p.category, relatedRecordId: p.id,
      isCustomerVisible: p.isCustomerVisible, isFieldVisible: p.isFieldVisible,
    });
  }

  return entries.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
}
