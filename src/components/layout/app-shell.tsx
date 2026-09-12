import { useEffect, useMemo, useState, type ReactNode, type ComponentType } from "react";
import { useLocation } from "@tanstack/react-router";
import { Topbar } from "./topbar";
import { Sidebar } from "./sidebar";
import { cn } from "@/lib/utils";
import { TopbarActionContext } from "@/lib/topbar-action";

const SIDEBAR_COLLAPSED_KEY = "rm_sidebar_collapsed";

function readCollapsedPref(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(readCollapsedPref);
  const [primaryAction, setPrimaryAction] = useState<ReactNode>(null);
  const { pathname } = useLocation();
  const isAuthRoute =
    pathname === "/signin" ||
    pathname === "/signup" ||
    pathname === "/forgot-password" ||
    pathname === "/onboarding" ||
    pathname.startsWith("/auth/");

  // The app shell is a single fixed-viewport flex box (`h-dvh overflow-
  // hidden` below) with exactly one scroll container (`main`,
  // overflow-y-auto). At fractional browser zoom (e.g. 90%) the computed
  // 100dvh box can round a hair taller than the actual viewport, which —
  // with no overflow constraint on <html>/<body> — leaked out as a second,
  // page-level scrollbar alongside `main`'s own. Locking the root element's
  // overflow while this shell is mounted removes that stray sliver without
  // touching any real scroll behavior, since `main` already owns all
  // legitimate content scrolling. Scoped to the shell's own lifecycle (not
  // a blanket CSS rule) so portal/proposal/change-order and auth pages —
  // which never mount AppShell and rely on natural document scrolling —
  // are unaffected.
  useEffect(() => {
    if (isAuthRoute) return;
    document.documentElement.classList.add("app-shell-scroll-lock");
    return () => document.documentElement.classList.remove("app-shell-scroll-lock");
  }, [isAuthRoute]);

  useEffect(() => {
    if (isAuthRoute) return;
    const viewport = window.visualViewport;
    const root = document.documentElement;
    const updateViewport = () => {
      // Pinch zoom must keep its native behavior; only follow the keyboard viewport.
      if (viewport && viewport.scale !== 1) return;
      const height = viewport?.height ?? window.innerHeight;
      root.style.setProperty("--mobile-viewport-height", `${height}px`);
      const editing = document.activeElement?.matches("input, textarea, [contenteditable=true]");
      root.classList.toggle("mobile-keyboard-open", !!editing && window.innerHeight - height > 120);
    };
    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    window.addEventListener("resize", updateViewport);
    document.addEventListener("focusout", updateViewport);
    return () => {
      viewport?.removeEventListener("resize", updateViewport);
      window.removeEventListener("resize", updateViewport);
      document.removeEventListener("focusout", updateViewport);
      root.style.removeProperty("--mobile-viewport-height");
      root.classList.remove("mobile-keyboard-open");
    };
  }, [isAuthRoute]);

  // Must be a stable object — a new literal here every render would
  // re-render every useTopbarAction() consumer on every AppShell render
  // (context value identity, not just props, drives context re-renders),
  // which recreates their action node, which re-fires their effect, which
  // calls setAction again, which re-renders AppShell: an infinite loop.
  const topbarActionCtx = useMemo(() => ({ setAction: setPrimaryAction }), []);

  if (isAuthRoute) {
    return <>{children}</>;
  }

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  return (
    <TopbarActionContext.Provider value={topbarActionCtx}>
      <div className="mobile-app-shell flex h-dvh overflow-hidden bg-canvas">
        <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} />
        <div className={cn("flex min-w-0 flex-1 flex-col transition-[margin] duration-200", collapsed ? "md:ml-16" : "md:ml-60")}>
          <Topbar primaryAction={primaryAction} />
          <main className="app-main min-h-0 min-w-0 flex-1 overflow-y-auto p-3 md:p-6 space-y-4">{children}</main>
        </div>
      </div>
    </TopbarActionContext.Provider>
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
      <div className="mobile-page-header mb-4 md:mb-6 flex flex-wrap md:flex-nowrap items-start justify-between gap-3 md:gap-4">
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
            {subtitle && <p className="hidden md:block mt-0.5 text-[13px] text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    );
  }

  return (
    <div className="mobile-page-header mb-4 md:mb-6 flex flex-wrap md:flex-nowrap items-start justify-between gap-3 md:gap-4">
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
        {subtitle && <p className="hidden md:block mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
