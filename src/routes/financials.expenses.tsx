// src/routes/financials.expenses.tsx — Phase 13.5, Part 27.
//
// No `expenses` table and no vendor model exist anywhere in this codebase
// (confirmed by audit — see the Phase 13.5 report). Part 27 explicitly says
// not to invent a vendor_id reference without deciding vendor architecture
// first, and to prefer a structured empty state over wiring "Add Expense"
// against schema that doesn't exist yet. This is that empty state — no
// backend call, nothing to wire.
import { createFileRoute } from "@tanstack/react-router";
import { Wallet } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/financials/expenses")({ component: ExpensesPage });

function ExpensesPage() {
  return (
    <Card className="flex flex-col items-center justify-center gap-3 p-16 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-secondary"><Wallet className="h-5 w-5 text-muted-foreground" /></span>
      <div>
        <p className="text-sm font-semibold">No expenses yet</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          Expense tracking (materials, subcontractors, vendor bills) is foundation-level in this
          release — the schema and vendor model haven't been designed yet, so this tab is a
          placeholder rather than a partial feature.
        </p>
      </div>
      <Button disabled title="Expense tracking isn't implemented yet">Add Expense</Button>
    </Card>
  );
}
