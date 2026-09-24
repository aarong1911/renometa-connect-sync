import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Menu } from "lucide-react";
// src/components/layout/sidebar.tsx
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  LayoutDashboard, Users, Building2, Target, Briefcase, ListTodo, Calendar, FolderOpen,
  Inbox, Megaphone, Workflow, Bot, FileText, BarChart3, TrendingUp, Star, Settings,
  DollarSign, Plug, ChevronsLeft, ChevronsRight, ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/lib/routes";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCurrentUserRole, filterNavGroups, canAccessSettings } from "@/lib/permissions";
import { useOrganization } from "@/lib/organization";
import { useSmsMetaConversations } from "@/lib/sms-meta-conversations";
import { useConversationArchiveStates, conversationMapKey } from "@/lib/conversation-states";
import { useAiApprovalPendingCount, formatBadgeCount, pendingApprovalAriaLabel } from "@/lib/ai-approvals-count";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { signOut } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { useOrgId } from "@/lib/org-id";
import { useAuthSession } from "@/lib/auth-session";

const LOGO_KEY = "rm_org_logo";

type NavItem = { to: string; label: string; icon: React.ComponentType<{ className?: string }>; badgeKey?: "inbox" | "aiApprovals" };

// Flat single-list nav (Lovable design), in Lovable's exact order — mapped
// to this app's real routes. Role-based visibility preserved via
// the same ROLE_ALLOWED_ROUTES prefix-matching used before — Settings and
// Integrations stay owner-only automatically since "/settings/..." only
// passes the filter when "/settings" is in that role's allowed list.
const NAV: NavItem[] = [
  { to: "/",                      label: "Command Center", icon: LayoutDashboard },
  { to: "/leads",                 label: "Leads",           icon: Target },
  { to: "/inbox",                 label: "Conversations",   icon: Inbox, badgeKey: "inbox" },
  { to: "/calendar",              label: "Calendar",        icon: Calendar },
  { to: ROUTES.PIPELINE,          label: "Pipeline",        icon: TrendingUp },
  { to: "/estimates",             label: "Estimates",       icon: FileText },
  { to: "/projects",              label: "Projects",        icon: Briefcase },
  { to: "/tasks",                 label: "Tasks",           icon: ListTodo },
  { to: "/contacts",              label: "Contacts",        icon: Users },
  { to: "/companies",             label: "Accounts",        icon: Building2 },
  { to: ROUTES.AI_CENTER,         label: "AI Center",       icon: Bot, badgeKey: "aiApprovals" },
  { to: ROUTES.WORKFLOWS,         label: "Workflows",       icon: Workflow },
  { to: "/marketing",             label: "Marketing",       icon: Megaphone },
  { to: "/insights/reputation",   label: "Reviews",         icon: Star },
  { to: "/financials",            label: "Financials",      icon: DollarSign },
  { to: "/insights/analytics",    label: "Reports",         icon: BarChart3 },
  { to: "/files",                 label: "Files",           icon: FolderOpen },
  { to: "/settings/integrations", label: "Integrations",    icon: Plug },
];

export function Sidebar({ collapsed: desktopCollapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const isMobile = useIsMobile();
  const collapsed = !isMobile && desktopCollapsed;
  const [moreOpen, setMoreOpen] = useState(false);

  const location  = useLocation();
  const pathname  = location.pathname;
  useEffect(() => { setMoreOpen(false); }, [pathname]);
  const navigate  = useNavigate();
  const role      = useCurrentUserRole();
  const orgId     = useOrgId();
  const org       = useOrganization();
  const { conversations } = useSmsMetaConversations();
  const { archivedMap } = useConversationArchiveStates();
  const aiApprovalsPendingCount = useAiApprovalPendingCount();

  const [logoUrl, setLogoUrl] = useState<string | null>(() => {
    try { return localStorage.getItem(LOGO_KEY) || null; } catch { return null; }
  });
  const [user, setUser] = useState<{ email: string; firstName: string; lastName: string } | null>(null);

  // Real org logo — same fetch/realtime pattern the topbar used to own.
  // Keyed on the reactive useOrgId() above (not a one-shot getOrgId()
  // call) so this re-runs the moment orgId actually resolves after
  // sign-in, instead of possibly capturing a stale pre-login null and
  // never retrying — same boot-race class as the useOrgId() fix itself.
  useEffect(() => {
    if (!orgId) return;
    let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;
    function applyLogo(raw: string | null | undefined, fromDB = false) {
      const url = raw && !raw.startsWith("blob:") ? raw : null;
      if (url) {
        setLogoUrl(url);
        try { localStorage.setItem(LOGO_KEY, url); } catch {}
      } else if (fromDB) {
        const cached = (() => { try { return localStorage.getItem(LOGO_KEY) || null; } catch { return null; } })();
        setLogoUrl(cached);
      } else {
        setLogoUrl(null);
        try { localStorage.removeItem(LOGO_KEY); } catch {}
      }
    }
    async function load() {
      const { data, error } = await supabase.from("organizations").select("logo_url").eq("id", orgId).maybeSingle();
      if (!error && data !== undefined) applyLogo(data?.logo_url, true);
      if (realtimeChannel) return;
      realtimeChannel = supabase
        .channel(`sidebar_${orgId}`)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "organizations", filter: `id=eq.${orgId}` },
          (payload) => applyLogo((payload.new as any)?.logo_url))
        .subscribe();
    }
    load();
    const onOrgUpdated = () => load();
    window.addEventListener("org-updated", onOrgUpdated);
    return () => {
      window.removeEventListener("org-updated", onOrgUpdated);
      if (realtimeChannel) supabase.removeChannel(realtimeChannel);
    };
  }, [orgId]);

  // Real session user — reads the shared session cache (auth-session.ts)
  // instead of independently calling getSession(); see that file's header
  // for why (prod lock-contention incident, worst on /inbox).
  const { session } = useAuthSession();
  useEffect(() => {
    if (!session?.user) return;
    const meta = session.user.user_metadata ?? {};
    setUser({
      email: session.user.email ?? "",
      firstName: meta.first_name ?? meta.firstName ?? "",
      lastName: meta.last_name ?? meta.lastName ?? "",
    });
  }, [session]);

  const items = role === null ? [] : filterNavGroups([{ label: "", items: NAV }], role)[0]?.items ?? [];
  const showSettings = role === null ? false : canAccessSettings(role);

  const isActive = (to: string) =>
    to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(to + "/");

  // All real nav "to" paths (main list + settings), used below to find the
  // single most specific match — prevents a parent hub route (e.g.
  // "/financials") from lighting up alongside a more specific child entry
  // that also has its own top-level nav item (e.g. "/estimates").
  const allNavPaths = [...NAV.map(n => n.to), "/settings"];

  const isNavActive = (to: string) => {
    if (to === "/inbox") return pathname === "/inbox" || pathname === "/inbox/";
    if (!isActive(to)) return false;
    const moreSpecificMatchExists = allNavPaths.some(
      other => other !== to && other.length > to.length && isActive(other),
    );
    return !moreSpecificMatchExists;
  };

  // Same single source of truth + same units as the Inbox page's "Unread"
  // folder badge and each conversation row's numeric badge (a real
  // unread INBOUND message total, not a count of conversations that have
  // any unread message) — previously this counted CONVERSATIONS
  // (`.filter(c => c.unread).length`), which could disagree with the other
  // two badges even when all three were reading correct underlying data,
  // simply because they were counting different things. Archived
  // conversations are excluded here too, matching the Inbox folder counts'
  // own archived-exclusion (an archived conversation's unread messages
  // don't surface anywhere in the main Inbox view, so they shouldn't
  // inflate the nav badge either).
  const unreadCount = conversations
    .filter((c) => {
      const key = conversationMapKey(c);
      return !(key && archivedMap[key]);
    })
    .reduce((sum, c) => sum + (c.unreadCount ?? (c.unread ? 1 : 0)), 0);
  const displayLogo = logoUrl || org.logoUrl;
  // Tenant-derived only — no hardcoded product/company name fallback.
  // org.companyName itself already resolves from this org's own
  // organizations.name/public_name (src/lib/organization.ts); an empty
  // string here just means that hasn't loaded/been set yet.
  const companyName = org.companyName;
  const displayName = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.email?.split("@")[0] || "Account";

  const sidebar = (
    <TooltipProvider delayDuration={0}>
      <aside className={cn(
        "flex flex-col border-r border-border bg-card transition-[width] duration-200",
        isMobile ? "relative h-full !w-full" : "fixed left-0 top-0 bottom-0 z-40",
        collapsed ? "w-16" : "w-60",
      )}>
        {/* Brand — tenant-only. Expanded state shows the org's own full
            logo/wordmark (or its name as text) and nothing else; no
            separate hardcoded product name/tagline is rendered beside it.
            Collapsed state keeps the existing compact square-tile
            treatment (real logo, object-contain, never stretched/cropped
            into a shape it wasn't designed for) with a tenant-derived
            initial as the only fallback — never a fixed letter. */}
        <div className={cn("flex items-center h-16 border-b border-border shrink-0", collapsed ? "justify-center px-2" : "px-3")}>
          {collapsed ? (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg">
              {displayLogo ? (
                <img key={displayLogo} src={displayLogo} alt={`${companyName || "Organization"} logo`} className="h-full w-full object-contain" onError={() => setLogoUrl(null)} />
              ) : companyName ? (
                <div className="grid h-full w-full place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/70 text-sm font-bold text-primary-foreground">
                  {companyName[0].toUpperCase()}
                </div>
              ) : (
                <div className="grid h-full w-full place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/70 text-primary-foreground">
                  <Building2 className="h-4 w-4" />
                </div>
              )}
            </div>
          ) : displayLogo ? (
            <img
              key={displayLogo}
              src={displayLogo}
              alt={`${companyName || "Organization"} logo`}
              className="h-auto w-auto object-contain"
              style={{ maxWidth: 180, maxHeight: 48 }}
              onError={() => setLogoUrl(null)}
            />
          ) : (
            <span className="truncate text-base font-semibold text-foreground">{companyName || "Organization"}</span>
          )}
        </div>

        {/* Collapse control */}
        <div className={cn("hidden md:block shrink-0 pt-2", collapsed ? "px-2" : "px-3")}>
          <button
            onClick={onToggle}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "flex h-8 w-full items-center gap-2 rounded-md text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
              collapsed ? "justify-center px-0" : "justify-between px-2",
            )}
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : (<><span>Collapse</span><ChevronsLeft className="h-4 w-4" /></>)}
          </button>
        </div>

        {/* Nav */}
        <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin py-2", collapsed ? "px-2" : "px-3")}>
          <div className="space-y-0.5">
            {items.map(item => {
              // badgeCount: explicit per-key mapping, one branch per
              // badgeKey, falling through to `undefined` (no badge) for
              // every nav item that isn't inbox or aiApprovals — never a
              // bare boolean/truthy shortcut that could silently coerce a
              // real 0 vs. "not applicable" into the same falsy value.
              let badgeCount: number | undefined;
              if (item.badgeKey === "inbox") {
                badgeCount = unreadCount;
              } else if (item.badgeKey === "aiApprovals") {
                badgeCount = aiApprovalsPendingCount;
              } else {
                badgeCount = undefined;
              }
              const badgeAriaLabel = item.badgeKey === "aiApprovals" ? pendingApprovalAriaLabel(aiApprovalsPendingCount) : undefined;
              return (
                <NavLinkRow
                  key={item.to}
                  item={item}
                  active={isNavActive(item.to)}
                  collapsed={collapsed}
                  badgeCount={badgeCount}
                  badgeAriaLabel={badgeAriaLabel}
                />
              );
            })}
          </div>
        </div>

        {showSettings && (
          <div className={cn("shrink-0 border-t border-border", collapsed ? "px-2 py-2" : "px-3 py-2")}>
            <NavLinkRow item={{ to: "/settings", label: "Settings", icon: Settings }} active={isActive("/settings")} collapsed={collapsed} />
          </div>
        )}

        {/* User — anchored at bottom, matches Lovable's shell */}
        <div className={cn("shrink-0 border-t border-border", collapsed ? "p-2" : "p-3")}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className={cn("flex w-full items-center rounded-lg p-2 hover:bg-secondary", collapsed ? "justify-center" : "gap-3")}>
                <ContactAvatar id={user?.email} name={displayName} size="sm" className="h-9 w-9" />
                {!collapsed && (
                  <>
                    <div className="min-w-0 flex-1 text-left">
                      <div className="truncate text-sm font-semibold">{displayName}</div>
                      <div className="truncate text-xs text-muted-foreground">{companyName || "Organization"}</div>
                    </div>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-56">
              <DropdownMenuLabel>
                <div className="font-medium">{displayName}</div>
                <div className="text-xs font-normal text-muted-foreground">{user?.email}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate({ to: "/settings" })}>Settings</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={signOut}>Sign out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </TooltipProvider>
  );
  if (!isMobile) return <div className="hidden md:block">{sidebar}</div>;
  const primaryPaths = ["/", "/leads", "/inbox", "/calendar"];
  const primary = items.filter(item => primaryPaths.includes(item.to));
  return <>
    <nav aria-label="Main navigation" className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-card/95 px-2 backdrop-blur">
      {primary.map(item => {
        const Icon = item.icon;
        const active = isNavActive(item.to);
        const label = item.to === "/" ? "Home" : item.to === "/inbox" ? "Inbox" : item.label;
        return <Link key={item.to} to={item.to} aria-current={active ? "page" : undefined} className={cn("relative flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium", active ? "text-gold-hover" : "text-muted-foreground")}>
          <span className={cn("relative rounded-xl px-4 py-1", active && "bg-gold-soft")}><Icon className="h-5 w-5" />
          {item.badgeKey && unreadCount > 0 && <span aria-label={`${unreadCount} unread messages`} className="absolute -right-1 -top-1 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">{unreadCount > 99 ? "99+" : unreadCount}</span>}</span>
          {label}
        </Link>;
      })}
      <button type="button" onClick={() => setMoreOpen(true)} aria-expanded={moreOpen} aria-label="More navigation and account" className={cn("flex min-h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium", !primary.some(item => isNavActive(item.to)) ? "text-gold-hover" : "text-muted-foreground")}><Menu className="h-5 w-5" />More</button>
    </nav>
    <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
      <SheetContent side="bottom" className="h-[85dvh] overflow-hidden rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)]" aria-describedby={undefined}>
        <SheetTitle className="sr-only">Navigation and account</SheetTitle>
        <div className="h-full" onClick={event => { if ((event.target as HTMLElement).closest("a")) setMoreOpen(false); }}>{sidebar}</div>
      </SheetContent>
    </Sheet>
  </>;

}

function NavLinkRow({ item, active, collapsed, badgeCount, badgeAriaLabel }: { item: NavItem; active: boolean; collapsed: boolean; badgeCount?: number; badgeAriaLabel?: string }) {
  const Icon = item.icon;
  // formatBadgeCount(): null (hidden) for 0, exact number for 1-99, "99+"
  // above that — same display rule for every badge on this nav, so the AI
  // Center pending-approval badge (the reason this cap exists) uses the
  // exact same visual language as the pre-existing Inbox unread badge
  // rather than a second, slightly-different notification style.
  const badgeText = badgeCount == null ? null : formatBadgeCount(badgeCount);
  const content = (
    <Link to={item.to} className={cn(
      "group relative flex items-center rounded-lg text-sm font-medium transition-colors",
      collapsed ? "justify-center h-9 w-full" : "justify-between gap-3 px-3 py-3 md:py-2",
      active ? "bg-gold-soft text-gold-hover ring-1 ring-gold-soft" : "text-foreground/70 hover:bg-secondary hover:text-foreground",
    )}>
      <span className={cn("flex items-center", collapsed ? "" : "gap-3")}>
        <Icon className={cn("h-4 w-4", active && "text-gold-hover")} />
        {!collapsed && <span>{item.label}</span>}
      </span>
      {badgeText != null && (
        collapsed ? (
          <span
            className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground"
            title={badgeAriaLabel}
            aria-label={badgeAriaLabel}
          >
            {badgeText}
          </span>
        ) : (
          <span
            className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground"
            title={badgeAriaLabel}
            aria-label={badgeAriaLabel}
          >
            {badgeText}
          </span>
        )
      )}
    </Link>
  );
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right" className="text-xs">{item.label}</TooltipContent>
      </Tooltip>
    );
  }
  return content;
}
