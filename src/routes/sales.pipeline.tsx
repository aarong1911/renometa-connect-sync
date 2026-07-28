// src/routes/sales.pipeline.tsx
//
// Legacy path — the canonical Pipeline route moved to /pipeline. This is a
// thin redirect only; the real page/component lives at src/routes/pipeline.tsx.
// Search params (dealId, addDeal, pName/pEmail/pPhone/pAddress, and any
// future filter/view state) are forwarded through unchanged.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/sales/pipeline")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/pipeline", search: search as any });
  },
});
