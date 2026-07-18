// src/routes/settings.tsx
import { createFileRoute, Outlet, Link, useLocation } from "@tanstack/react-router";
import { PageHeader } from "@/components/layout/app-shell";
import {
  Building2, Users, Plug, CreditCard, Wand2, Palette, Key, Bell,
  FileText, Pin, GitBranch, ShieldCheck, Settings as SettingsIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { OrganizationSettings } from "@/components/organization/organization-settings";

export const Route = createFileRoute("/settings")({ component: SettingsLayout });

const sections = [
  { to: "/settings",              label: "Organization",  icon: Building2,   exact: true },
  { to: "/settings/team",         label: "Team & Roles",  icon: Users },
  { to: "/settings/permissions",  label: "Permissions",   icon: ShieldCheck },
  { to: "/settings/favorites",    label: "Favorites",     icon: Pin },
  { to: "/settings/pipelines",    label: "Pipelines",     icon: GitBranch },
  { to: "/settings/integrations", label: "Integrations",  icon: Plug },
  { to: "/settings/billing",      label: "Plans & Billing", icon: CreditCard },
  { to: "/settings/templates",    label: "Templates",     icon: FileText },
  { to: "/settings/custom-fields",label: "Custom Fields", icon: Wand2 },
  { to: "/settings/branding",     label: "Branding",      icon: Palette },
  { to: "/settings/api-keys",     label: "API Keys",      icon: Key },
  { to: "/settings/notifications",label: "Notifications", icon: Bell },
];

function SettingsLayout() {
  const { pathname } = useLocation();
  const isRoot = pathname === "/settings" || pathname === "/settings/";
  return (
    <>
      <PageHeader icon={SettingsIcon} iconBg="bg-secondary" iconColor="text-foreground" title="Settings" subtitle="Manage your workspace, team, integrations, and billing" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
        <nav className="space-y-0.5">
          {sections.map(s => {
            const active = s.exact ? isRoot : pathname.startsWith(s.to);
            const Icon = s.icon;
            return (
              <Link key={s.to} to={s.to}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                  active ? "bg-primary-soft text-primary" : "text-foreground hover:bg-secondary",
                )}>
                <Icon className="h-3.5 w-3.5" />{s.label}
              </Link>
            );
          })}
        </nav>
        <div>{isRoot ? <OrganizationSettings /> : <Outlet />}</div>
      </div>
    </>
  );
}