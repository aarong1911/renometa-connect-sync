import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Settings as SettingsIcon, Inbox } from "lucide-react";
import { TemplatePicker } from "@/components/inbox/template-picker";
import { recordTemplateUse } from "@/lib/recent-templates";
import type { SharedMessageTemplate } from "@/lib/message-templates";
import { toast } from "sonner";

export const Route = createFileRoute("/inbox/templates")({
  component: TemplatesPickerPage,
});

function TemplatesPickerPage() {
  const navigate = useNavigate();

  function insert(t: SharedMessageTemplate) {
    recordTemplateUse(t.id);
    toast.success(`Inserting "${t.name}" into reply…`);
    navigate({ to: "/inbox", search: { templateId: t.id } });
  }

  return (
    <>
      <PageHeader
        title="Message templates"
        subtitle="Pick a template and insert it directly into your next Inbox reply"
        breadcrumb={["Workspace", "Inbox", "Templates"]}
        actions={
          <>
            <Button asChild variant="outline" size="sm" className="h-8">
              <Link to="/settings/templates">
                <SettingsIcon className="mr-1.5 h-3.5 w-3.5" /> Manage templates
              </Link>
            </Button>
            <Button asChild size="sm" className="h-8">
              <Link to="/inbox">
                <Inbox className="mr-1.5 h-3.5 w-3.5" /> Back to Inbox
              </Link>
            </Button>
          </>
        }
      />
      <TemplatePicker onInsert={insert} />
    </>
  );
}
