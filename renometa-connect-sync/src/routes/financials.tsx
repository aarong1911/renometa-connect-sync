import { createFileRoute, Outlet, Link, useLocation, Navigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/layout/app-shell";
import { Plus, Download, Filter, FileText, Receipt, CreditCard, BarChart3, DollarSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/financials")({
  component: FinancialsLayout,
});

const tabs = [
  { to: "/financials/estimates", label: "Estimates", icon: FileText },
  { to: "/financials/invoices", label: "Invoices", icon: Receipt },
  { to: "/financials/payments", label: "Payments", icon: CreditCard },
  { to: "/financials/reports", label: "Reports", icon: BarChart3 },
];

function FinancialsLayout() {
  const { pathname } = useLocation();
  const isRoot = pathname === "/financials" || pathname === "/financials/";

  if (isRoot) return <Navigate to="/financials/estimates" replace />;

  return (
    <>
      <PageHeader
        icon={DollarSign}
        iconBg="bg-success-soft"
        iconColor="text-success"
        title="Financials"
        subtitle="Estimates, invoices, payments, and reports"
        breadcrumb={["Financials"]}
        actions={
          <>
            <Button variant="outline" size="sm" className="h-8">
              <Filter className="mr-1.5 h-3.5 w-3.5" /> Filter
            </Button>
            <Button variant="outline" size="sm" className="h-8">
              <Download className="mr-1.5 h-3.5 w-3.5" /> Export
            </Button>
            <Button size="sm" className="h-8">
              <Plus className="mr-1.5 h-3.5 w-3.5" /> New
            </Button>
          </>
        }
      />

      <div className="mb-5 flex gap-1 border-b border-border">
        {tabs.map((t) => {
          const active = pathname.startsWith(t.to);
          const Icon = t.icon;
          return (
            <Link
              key={t.to}
              to={t.to}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </Link>
          );
        })}
      </div>

      <Outlet />
    </>
  );
}
