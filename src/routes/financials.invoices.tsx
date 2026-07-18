import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/financials/invoices")({
  beforeLoad: () => {
    throw redirect({ to: "/financials" });
  },
});
