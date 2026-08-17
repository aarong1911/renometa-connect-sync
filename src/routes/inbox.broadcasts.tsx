// src/routes/inbox.broadcasts.tsx
//
// Phase 14.1: the old "Broadcasts" feature (this route was a near-byte-
// identical duplicate of the mock UI that used to live at /marketing) has
// been replaced by real, org-scoped Campaigns at /marketing. This route is
// kept only as a redirect so any stale bookmark/link still lands somewhere
// useful, rather than a 404.

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/inbox/broadcasts")({
  beforeLoad: () => {
    throw redirect({ to: "/marketing", search: { tab: "campaigns", createCampaign: false, campaignId: "", editCampaignId: "" } });
  },
});
