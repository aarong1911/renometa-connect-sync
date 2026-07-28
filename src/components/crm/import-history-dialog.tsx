// src/components/crm/import-history-dialog.tsx
//
// Stage 9.5, Priority 9 — lightweight import history drawer shared by
// Leads/Contacts/Companies. Intentionally NOT a full admin screen: a single
// dialog listing this org's recent import jobs for the given entity type,
// with a rollback action gated by the job's own status (Priority 8).

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Loader2, RotateCcw, FileWarning } from "lucide-react";
import {
  useImportHistory, rollbackImportJob, type ImportEntityType, type ImportJob,
} from "@/lib/import-jobs-store";
import { formatDistanceToNow } from "date-fns";

function statusBadgeVariant(status: ImportJob["status"]): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "completed": return "default";
    case "failed": return "destructive";
    case "rolled_back": return "outline";
    case "partially_rolled_back": return "secondary";
    default: return "secondary";
  }
}

export function ImportHistoryDialog({
  open,
  onOpenChange,
  entityType,
  contactLinkedRecordCheck,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: ImportEntityType;
  /** Contacts-only: injected so rollback can re-run the same delete-safety guard as the Contacts page's own delete flow. */
  contactLinkedRecordCheck?: (contactId: string, orgId: string) => Promise<{ label: string; count: number }[]>;
}) {
  const { jobs, loading, refresh } = useImportHistory();
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);
  const entityJobs = jobs.filter((j) => j.entity_type === entityType);

  async function handleRollback(job: ImportJob) {
    setRollingBackId(job.id);
    try {
      const result = await rollbackImportJob(job, contactLinkedRecordCheck);
      const parts = [`${result.rolledBack} rolled back`];
      if (result.skippedLinked > 0) parts.push(`${result.skippedLinked} skipped (now linked to other records)`);
      if (result.failed > 0) parts.push(`${result.failed} failed`);
      toast.success("Rollback complete", { description: parts.join(" · ") });
    } catch (err) {
      console.error("[ImportHistoryDialog] rollback failed:", err);
      toast.error("Rollback failed. Please try again.");
    } finally {
      setRollingBackId(null);
    }
  }

  function downloadErrorRows(job: ImportJob) {
    const meta = job.metadata as { errors?: string[] } | null;
    const errors = meta?.errors ?? [];
    if (errors.length === 0) {
      toast.info("No error rows recorded for this import.");
      return;
    }
    const lines = ["Row,Error", ...errors.map((e) => {
      const match = e.match(/^Row (\d+): (.+)$/);
      return match ? `${match[1]},"${match[2].replace(/"/g, '""')}"` : `0,"${e.replace(/"/g, '""')}"`;
    })];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-${job.id.slice(0, 8)}-errors.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (o) void refresh(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import History</DialogTitle>
          <DialogDescription>Recent CSV imports for this workspace.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
          </div>
        ) : entityJobs.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <FileWarning className="h-6 w-6 mx-auto mb-2 opacity-50" />
            No imports yet.
          </div>
        ) : (
          <div className="space-y-2">
            {entityJobs.map((job) => {
              const canRollback = job.status === "completed" || job.status === "partially_rolled_back";
              return (
                <div key={job.id} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{job.original_filename || "Untitled import"}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(job.created_at), { addSuffix: true })}
                      </div>
                    </div>
                    <Badge variant={statusBadgeVariant(job.status)} className="shrink-0 capitalize">
                      {job.status.replace(/_/g, " ")}
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{job.total_rows} total</span>
                    <span>{job.created_rows} created</span>
                    <span>{job.skipped_rows} skipped</span>
                    {job.failed_rows > 0 && <span className="text-destructive">{job.failed_rows} failed</span>}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => downloadErrorRows(job)}>
                      Download error rows
                    </Button>
                    {canRollback && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={rollingBackId === job.id}
                        onClick={() => handleRollback(job)}
                      >
                        {rollingBackId === job.id
                          ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                          : <RotateCcw className="h-3 w-3 mr-1" />}
                        Rollback
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
