// src/routes/__root.tsx
import { Outlet, Link, createRootRouteWithContext, useRouterState, useNavigate } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/app-shell";
import { supabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";
import {
  useCurrentUserRole, canAccessRoute, ROLE_DEFAULT_ROUTE, ROLE_EXTERNAL_REDIRECT,
} from "@/lib/permissions";

interface RouterContext { queryClient: QueryClient }

const PUBLIC_ROUTES  = ["/signin", "/signup", "/forgot-password", "/auth/callback"];
const PORTAL_ROUTES  = ["/portal"];

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="max-w-md text-center">
        <h1 className="text-6xl font-semibold tracking-tight">404</h1>
        <h2 className="mt-3 text-lg font-medium">Page not found</h2>
        <p className="mt-1 text-sm text-muted-foreground">The page you're looking for doesn't exist.</p>
        <div className="mt-6">
          <Link to="/" className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const navigate  = useNavigate();
  const routerState = useRouterState();
  const pathname  = routerState.location.pathname;
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [checked, setChecked] = useState(false);

  const isPublicRoute = PUBLIC_ROUTES.some(r => pathname.startsWith(r));
  const isPortalRoute = PORTAL_ROUTES.some(r => pathname.startsWith(r));

  // Auth state
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => { setSession(s); setChecked(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); setChecked(true); });
    return () => subscription.unsubscribe();
  }, []);

  // Redirect unauthenticated users
  useEffect(() => {
    if (!checked) return;
    if (!session && !isPublicRoute && !isPortalRoute) navigate({ to: "/signin" });
    else if (session && pathname === "/signin") navigate({ to: "/" });
  }, [checked, session, pathname, isPublicRoute, isPortalRoute, navigate]);

  if (!checked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }
  if (!session && !isPublicRoute && !isPortalRoute) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={150}>
        {isPortalRoute ? (
          <Outlet />
        ) : (
          <AppShell>
            <RoleGuard pathname={pathname} isPublicRoute={isPublicRoute} session={session}>
              <Outlet />
            </RoleGuard>
          </AppShell>
        )}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

// ── Role guard — runs inside AppShell so role is available ───────────────────

function RoleGuard({ pathname, isPublicRoute, session, children }: {
  pathname: string; isPublicRoute: boolean;
  session: Session | null | undefined; children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const role     = useCurrentUserRole();

  useEffect(() => {
    if (!session || isPublicRoute || !role) return;

    // Redirect field workers and viewers to their external apps
    const external = ROLE_EXTERNAL_REDIRECT[role];
    if (external) { window.location.href = external; return; }

    // Redirect to default route if current page is not allowed
    if (!canAccessRoute(role, pathname)) {
      const defaultRoute = ROLE_DEFAULT_ROUTE[role] ?? "/";
      navigate({ to: defaultRoute });
    }
  }, [role, pathname, session, isPublicRoute, navigate]);

  // Show access denied briefly while redirecting
  if (role && !canAccessRoute(role, pathname) && !isPublicRoute) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">Redirecting…</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}