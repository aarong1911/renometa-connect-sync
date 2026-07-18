// src/routes/projects.$clientSlug.tsx
//
// This used to be a full, separately-maintained project detail page built
// entirely on lib/mock-data.ts (fake tasks, invoices, selections, team,
// etc.) shown to real users when linked from Inbox. The real project
// detail experience lives in projects.index.tsx (ProjectDetailSheet),
// backed by real Supabase queries — this route now just redirects old
// /projects/$clientSlug links there instead of duplicating it.
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$clientSlug")({
  component: RedirectToProjectsList,
});

function RedirectToProjectsList() {
  const { clientSlug } = Route.useParams();
  return <Navigate to="/projects" search={{ slug: clientSlug }} replace />;
}
