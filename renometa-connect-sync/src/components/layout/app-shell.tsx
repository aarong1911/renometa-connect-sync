import { useState, type ReactNode, type ComponentType } from "react";
import { useLocation } from "@tanstack/react-router";
import { Topbar } from "./topbar";
import { Sidebar } from "./sidebar";
import { cn } from "@/lib/utils";

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const { pathname } = useLocation();
  const isAuthRoute =
    pathname === "/signin" ||
    pathname === "/signup" ||
    pathname === "/forgot-password" ||
    pathname === "/onboarding" ||
    pathname.startsWith("/auth/");

  if (isAuthRoute) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen flex bg-canvas">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className={cn("flex-1 flex flex-col min-w-0 transition-[margin] duration-200", collapsed ? "ml-16" : "ml-60")}>
        <Topbar />
        <main className="flex-1 p-6 space-y-4">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  breadcrumb,
  actions,
  icon: Icon,
  iconBg = "bg-info-soft",
  iconColor = "text-info",
}: {
  title: string;
  subtitle?: string;
  breadcrumb?: string[];
  actions?: ReactNode;
  /** Opt-in icon tile — pages not yet ported simply omit this and keep the plain header. */
  icon?: ComponentType<{ className?: string }>;
  iconBg?: string;
  iconColor?: string;
}) {
  if (Icon) {
    return (
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl ring-1 ring-black/5", iconBg)}>
            <Icon className={cn("h-5 w-5", iconColor)} />
          </div>
          <div>
            {breadcrumb && breadcrumb.length > 0 && (
              <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                {breadcrumb.map((b, i) => (
                  <span key={i} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-border-strong">/</span>}
                    <span>{b}</span>
                  </span>
                ))}
              </div>
            )}
            <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-foreground">{title}</h1>
            {subtitle && <p className="mt-0.5 text-[13px] text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    );
  }

  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        {breadcrumb && breadcrumb.length > 0 && (
          <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            {breadcrumb.map((b, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-border-strong">/</span>}
                <span>{b}</span>
              </span>
            ))}
          </div>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
