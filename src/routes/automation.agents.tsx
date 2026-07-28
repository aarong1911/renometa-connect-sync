// Legacy route — AI Center moved to /ai-center (cleaner public-facing path).
// This is a thin redirect only; the real implementation lives at
// src/routes/ai-center.tsx and must not be duplicated here. Preserves
// deep links (agentId, tab) so old bookmarks and internal links keep working.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/automation/agents")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/ai-center", search: search as any });
  },
});
