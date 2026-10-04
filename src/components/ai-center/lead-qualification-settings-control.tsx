// src/components/ai-center/lead-qualification-settings-control.tsx
//
// Live Lead Qualification — Phase AI-3A. A small, deliberately minimal
// control for `ai_center_settings.agents.lead_qualification` — NOT a fake
// agent card. Lead Qualification is a system agent key the orchestrator
// already understands (ai/router.ts), but it has no seeded `agent_instances`
// row (see src/lib/agentic/policy-resolver.ts's own comment on why one was
// never created — it would make a fake card appear in the Agents tab).
// This component is the one place an owner/admin can actually turn on the
// real production trigger this phase adds, without redesigning the Agents
// tab or inventing a fake instance row.
//
// Same security shape as ai-emergency-pause-control.tsx: reads/writes go
// through netlify/functions/lead-qualification-settings.ts, which
// independently re-resolves owner/admin server-side — this component's
// owner/admin visibility check is a UI convenience only, not the real gate.

import { useEffect, useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useOrgId } from "@/lib/org-id";
import { useCurrentUserRole } from "@/lib/permissions";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchLeadQualificationSettings, saveLeadQualificationSettings, type LeadQualificationSettings } from "@/lib/lead-qualification-client";

export function LeadQualificationSettingsControl() {
  const orgId = useOrgId();
  const role = useCurrentUserRole();
  const isOwnerOrAdmin = role === "owner" || role === "admin";
  const [settings, setSettings] = useState<LeadQualificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!orgId || !isOwnerOrAdmin) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchLeadQualificationSettings().then((result) => {
      if (!cancelled) {
        setSettings(result ?? { enabled: false, defaultAutonomyLevel: 1 });
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, isOwnerOrAdmin]);

  if (!isOwnerOrAdmin || !orgId) return null;

  const applyChange = async (next: LeadQualificationSettings) => {
    const previous = settings;
    setSettings(next);
    setSaving(true);
    const result = await saveLeadQualificationSettings(next);
    setSaving(false);
    if (!result.ok) {
      setSettings(previous);
      toast.error(result.error ?? "Could not save Lead Qualification settings.");
    } else {
      toast.success(next.enabled ? "Lead Qualification live triggers enabled." : "Lead Qualification live triggers disabled.");
    }
  };

  if (loading || !settings) return null;

  return (
    <Card className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" />
        <div>
          <div className="text-sm font-medium">Lead Qualification — live triggers</div>
          <p className="max-w-md text-xs text-muted-foreground">
            When on, a new inbound message or "Run Lead Qualification" from the Leads page creates a real AI run for that lead. Level 1
            drafts a recommendation only; Level 2 proposes a reply for approval on supported channels (SMS, WhatsApp). Emergency Pause
            always overrides this.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Select
          value={String(settings.defaultAutonomyLevel)}
          disabled={saving || !settings.enabled}
          onValueChange={(v) => void applyChange({ ...settings, defaultAutonomyLevel: v === "2" ? 2 : 1 })}
        >
          <SelectTrigger className="h-8 w-[180px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1" className="text-xs">Level 1 — recommend only</SelectItem>
            <SelectItem value="2" className="text-xs">Level 2 — propose for approval</SelectItem>
          </SelectContent>
        </Select>
        <Switch
          checked={settings.enabled}
          disabled={saving}
          onCheckedChange={(checked) => void applyChange({ ...settings, enabled: checked })}
        />
      </div>
    </Card>
  );
}
