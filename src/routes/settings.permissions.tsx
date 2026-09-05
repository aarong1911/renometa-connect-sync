// src/routes/settings.permissions.tsx
//
// Platform State Sync Phase S5D — member_permissions overrides are now
// Query-backed (queryKeys.memberPermissions(orgId, memberId), see
// organization.ts) instead of this page's own local useState + useEffect
// fetch. Scoped per selected member, so switching members never mixes
// cached results (Part 19) — a different memberId is simply a different
// Query cache entry. orgId now comes from the shared useOrgId() instead
// of a duplicate ad hoc profiles.organization_id lookup.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useOrgId } from "@/lib/org-id";
import {
  useTeam, useMemberPermissions, setMemberPermissionOverride, clearMemberPermissionOverride, resetMemberPermissions,
  memberInitials, ROLE_LABELS, type Role, type TeamMember,
} from "@/lib/organization";
import {
  PERMISSION_ACTIONS as ACTIONS, PERMISSION_SECTIONS as SECTIONS, getRoleDefaultPermission as getRoleDefault,
  type PermissionAction as Action,
} from "@/lib/permission-features";

export const Route = createFileRoute("/settings/permissions")({ component: PermissionsPage });

// Feature/action catalog and role defaults now live in
// src/lib/permission-features.ts (security audit, post-13.3B) so
// server-side/Netlify permission checks can share the exact same table
// instead of re-implementing it — see src/lib/change-order-permissions.ts.

// ── Override lookup key ───────────────────────────────────────────────────────

type OverrideMap = Map<string, boolean>; // `${feature}:${action}` -> granted
function overrideKey(feature: string, action: Action) { return `${feature}:${action}`; }

// ── Toggle component ──────────────────────────────────────────────────────────

function Toggle({ on, inherited, onChange }: {
  on: boolean; inherited: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={cn(
        "relative inline-block h-5 w-9 shrink-0 rounded-full border-none transition-colors duration-200 cursor-pointer",
        on
          ? inherited ? "bg-[#97C459] opacity-70" : "bg-[#378ADD]"
          : inherited ? "bg-[#888780] opacity-50" : "bg-[#B4B2A9]"
      )}
      title={inherited ? "Role default (click to override)" : "Custom override (click to change)"}
    >
      <span className={cn(
        "absolute top-0.75 h-3.5 w-3.5 rounded-full transition-[left] duration-200",
        on ? "left-4.75" : "left-0.75",
        on ? "bg-white" : inherited ? "bg-[#d3d1c7]" : "bg-[#f0efeb]",
      )} />
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function PermissionsPage() {
  const team = useTeam();
  const orgId = useOrgId();
  const [selected, setSelected]         = useState<TeamMember | null>(null);
  const [saving, setSaving]             = useState<string | null>(null);

  // Select first non-owner member by default
  useEffect(() => {
    if (team.length > 0 && !selected) {
      const first = team.find(m => m.role !== "owner") ?? team[0];
      setSelected(first);
    }
  }, [team]);

  // Query-backed (S5D) — scoped per (orgId, selected member), so switching
  // members never mixes cached results; a different memberId is simply a
  // different cache entry.
  const overridesQuery = useMemberPermissions(orgId, selected?.id);
  const loading = overridesQuery.isLoading;
  const overrides: OverrideMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const row of overridesQuery.data ?? []) map.set(overrideKey(row.feature, row.action as Action), row.granted);
    return map;
  }, [overridesQuery.data]);

  const handleToggle = async (featureId: string, action: Action, newValue: boolean) => {
    if (!selected || !orgId) return;
    const key        = overrideKey(featureId, action);
    const roleDefault = getRoleDefault(selected.role, featureId, action);
    setSaving(key);

    // If toggling back to role default → delete the override
    const result = newValue === roleDefault
      ? await clearMemberPermissionOverride(orgId, selected.id, featureId, action)
      : await setMemberPermissionOverride(orgId, selected.id, featureId, action, newValue);

    if (!result.ok) toast.error("Could not update the permission.");
    setSaving(null);
  };

  const handleReset = async () => {
    if (!selected || !orgId) return;
    const result = await resetMemberPermissions(orgId, selected.id);
    if (result.ok) toast.success("Reset to role defaults");
    else toast.error("Could not reset permissions.");
  };

  const overrideCount = overrides.size;

  const getToggleState = (featureId: string, action: Action): { on: boolean; inherited: boolean } => {
    const key         = overrideKey(featureId, action);
    const roleDefault = getRoleDefault(selected?.role ?? "viewer", featureId, action);
    if (overrides.has(key)) return { on: overrides.get(key)!, inherited: false };
    return { on: roleDefault, inherited: true };
  };

  const isOverridden = (featureId: string, action: Action) =>
    overrides.has(overrideKey(featureId, action));

  return (
    <div>
      <div className="mb-5">
        <h3 className="text-sm font-semibold">Permissions</h3>
        <p className="text-xs text-muted-foreground mt-0.5">Override role defaults for individual team members. Owner-only feature.</p>
      </div>

      <div className="grid grid-cols-[200px_1fr] gap-4">
        {/* Member list */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">Team members</p>
          <div className="space-y-0.5">
            {team.map(m => (
              <button key={m.id} onClick={() => setSelected(m)}
                className={cn(
                  "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors",
                  selected?.id === m.id ? "bg-primary/10" : "hover:bg-secondary"
                )}>
                <Avatar className="h-7 w-7 shrink-0">
                  <AvatarFallback className="text-[10px] font-medium bg-primary/10 text-primary">
                    {memberInitials(m.name && m.name !== m.email ? m.name : m.email)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{m.name && m.name !== m.email ? m.name : m.email}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{ROLE_LABELS[m.role]}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Matrix */}
        <div>
          {!selected ? (
            <div className="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
              Select a team member to manage permissions
            </div>
          ) : (
            <div className="rounded-xl border border-border overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card">
                <div className="flex items-center gap-2.5">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="text-[10px] font-medium bg-primary/10 text-primary">
                      {memberInitials(selected.name && selected.name !== selected.email ? selected.name : selected.email)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-sm font-semibold">{selected.name && selected.name !== selected.email ? selected.name : selected.email}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {ROLE_LABELS[selected.role]}
                      {overrideCount > 0 && ` · ${overrideCount} override${overrideCount > 1 ? "s" : ""} active`}
                    </p>
                  </div>
                </div>
                {overrideCount > 0 && (
                  <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={handleReset}>
                    <RotateCcw className="h-3 w-3" />Reset to defaults
                  </Button>
                )}
              </div>

              {loading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <table className="w-full text-sm border-collapse">
                  <thead className="bg-secondary/60">
                    <tr>
                      <th className="py-2 pl-4 pr-3 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Feature</th>
                      {ACTIONS.map(a => (
                        <th key={a} className="py-2 px-3 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground w-20">{a}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {SECTIONS.map(section => (
                      <>
                        <tr key={`section-${section.label}`} className="bg-secondary/30">
                          <td colSpan={5} className="py-1.5 pl-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-t border-border">
                            {section.label}
                          </td>
                        </tr>
                        {section.features.map(feature => (
                          <tr key={feature.id} className="border-b border-border last:border-0 hover:bg-secondary/20">
                            <td className="py-2.5 pl-4 pr-3">
                              <div className="flex items-center gap-2">
                                <div>
                                  <p className="text-xs font-medium">{feature.label}</p>
                                  <p className="text-[10px] text-muted-foreground">{feature.description}</p>
                                </div>
                                {ACTIONS.some(a => isOverridden(feature.id, a)) && (
                                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-blue-200 bg-blue-50 text-blue-700 ml-1">Override</Badge>
                                )}
                              </div>
                            </td>
                            {ACTIONS.map(action => {
                              const { on, inherited } = getToggleState(feature.id, action);
                              const key = overrideKey(feature.id, action);
                              return (
                                <td key={action} className="py-2.5 px-3 text-center">
                                  {saving === key
                                    ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mx-auto" />
                                    : <Toggle on={on} inherited={inherited} onChange={v => handleToggle(feature.id, action, v)} />
                                  }
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </>
                    ))}
                  </tbody>
                </table>
              )}

              {/* Legend */}
              <div className="flex gap-4 px-4 py-2.5 border-t border-border bg-secondary/30">
                {[
                  { color: "bg-[#378ADD]", label: "Override (manually set)" },
                  { color: "bg-[#97C459] opacity-70", label: "Role default (on)" },
                  { color: "bg-[#888780] opacity-50", label: "Role default (off)" },
                ].map(item => (
                  <div key={item.label} className="flex items-center gap-1.5">
                    <div className={cn("h-2.5 w-2.5 rounded-full", item.color)} />
                    <span className="text-[10px] text-muted-foreground">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}