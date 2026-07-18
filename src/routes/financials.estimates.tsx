import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/financials/estimates")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/estimates", search: search as any });
  },
});
