import { createFileRoute, useLocation } from "@tanstack/react-router";
import { PageHeader } from "@/components/layout/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";

export const Route = createFileRoute("/$")({
  component: PlaceholderPage,
});

function PlaceholderPage() {
  const { pathname } = useLocation();
  const title = pathname.replace(/^\//, "").split("/").pop()?.replace(/-/g, " ") ?? "Page";
  const pretty = title.charAt(0).toUpperCase() + title.slice(1);

  return (
    <>
      <PageHeader title={pretty} subtitle="This module is part of the next build phase." />
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="text-sm font-medium">{pretty} is coming next</div>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            We're focusing on Dashboard, Contacts, and Pipeline first. Approve those and we'll roll out Projects, Inbox,
            Workflows, Financials, and Settings with the same polish.
          </p>
          <Button size="sm" className="mt-5" asChild>
            <a href="/">Back to Dashboard</a>
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
