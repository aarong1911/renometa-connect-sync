import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { TeamMembersManager } from "@/components/organization/team-members-manager";
import {
  addMember,
  removeMember,
  updateMember,
  useTeam,
} from "@/lib/organization";

export const Route = createFileRoute("/settings/team")({
  component: TeamSettings,
});

// S5D.1 — addMember/updateMember/removeMember are now only ever called
// AFTER team-members-manager.tsx has confirmed the real persisted write
// (inviteMember/removeMemberFromOrg/update-user-by-id) succeeded, and that
// component already shows the one success/error toast for each action —
// this route no longer duplicates it.
function TeamSettings() {
  const team = useTeam();
  return (
    <Card className="overflow-hidden p-0">
      <TeamMembersManager
        members={team}
        onAdd={(m) => addMember(m)}
        onUpdate={(id, patch) => updateMember(id, patch)}
        onRemove={(id) => removeMember(id)}
      />
    </Card>
  );
}
