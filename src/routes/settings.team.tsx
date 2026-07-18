import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { TeamMembersManager } from "@/components/organization/team-members-manager";
import {
  addMember,
  removeMember,
  updateMember,
  useTeam,
} from "@/lib/organization";
import { toast } from "sonner";

export const Route = createFileRoute("/settings/team")({
  component: TeamSettings,
});

function TeamSettings() {
  const team = useTeam();
  return (
    <Card className="overflow-hidden p-0">
      <TeamMembersManager
        members={team}
        onAdd={(m) => {
          addMember(m);
          toast.success(
            m.status === "invited"
              ? `Invitation sent to ${m.email}`
              : `${m.name || m.email} added`,
          );
        }}
        onUpdate={(id, patch) => {
          updateMember(id, patch);
          toast.success("Member updated");
        }}
        onRemove={(id) => {
          removeMember(id);
          toast.success("Member removed");
        }}
      />
    </Card>
  );
}
