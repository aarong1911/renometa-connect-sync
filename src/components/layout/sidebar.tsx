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
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { signOut } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

const LOGO_KEY = "rm_org_logo";

type NavItem = { to: string; label: string; icon: React.ComponentType<{ className?: string }>; badgeKey?: "inbox" };

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
  { to: ROUTES.AI_CENTER,         label: "AI Center",       icon: Bot },
  { to: ROUTES.WORKFLOWS,         label: "Workflows",       icon: Workflow },
  { to: "/marketing",             label: "Marketing",       icon: Megaphone },
  { to: "/insights/reputation",   label: "Reviews",         icon: Star },
  { to: "/financials",            label: "Financials",      icon: DollarSign },
  { to: "/insights/analytics",    label: "Reports",         icon: BarChart3 },
  { to: "/files",                 label: "Files",           icon: FolderOpen },
  { to: "/settings/integrations", label: "Integrations",    icon: Plug },
];

async function getOrgId(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return null;
  const uid = session.user.id;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", uid).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", uid).maybeSingle();
  return m?.org_id ?? null;
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const location  = useLocation();
  const pathname  = location.pathname;
  const navigate  = useNavigate();
  const role      = useCurrentUserRole();
  const org       = useOrganization();
  const { conversations } = useSmsMetaConversations();

  const [logoUrl, setLogoUrl] = useState<string | null>(() => {
    try { return localStorage.getItem(LOGO_KEY) || null; } catch { return null; }
  });
  const [user, setUser] = useState<{ email: string; firstName: string; lastName: string } | null>(null);

  // Real org logo — same fetch/realtime pattern the topbar used to own.
  useEffect(() => {
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
      const orgId = await getOrgId();
      if (!orgId) return;
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
  }, []);

  // Real session user — same as the topbar used to own.
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) return;
      const meta = session.user.user_metadata ?? {};
      setUser({
        email: session.user.email ?? "",
        firstName: meta.first_name ?? meta.firstName ?? "",
        lastName: meta.last_name ?? meta.lastName ?? "",
      });
    });
  }, []);

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

  const unreadCount = conversations.filter(c => c.unread).length;
  const displayLogo = logoUrl || org.logoUrl;
  const companyName = org.companyName || "RenoMeta";
  const displayName = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.email?.split("@")[0] || "Account";

  return (
    <TooltipProvider delayDuration={0}>
      <aside className={cn(
        "fixed left-0 top-0 bottom-0 z-40 flex flex-col border-r border-border bg-card transition-[width] duration-200",
        collapsed ? "w-16" : "w-60",
      )}>
        {/* Brand — real logo, falls back to a letter tile */}
        <div className={cn("flex items-center h-16 border-b border-border shrink-0", collapsed ? "justify-center px-2" : "px-4 gap-2.5")}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg">
            {displayLogo ? (
              <img key={displayLogo} src={displayLogo} alt="logo" className="h-full w-full object-contain" onError={() => setLogoUrl(null)} />
            ) : (
              <div className="grid h-full w-full place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/70 text-sm font-bold text-primary-foreground">
                {companyName[0]?.toUpperCase() ?? "R"}
              </div>
            )}
          </div>
          {!collapsed && (
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-semibold text-foreground">{companyName}</div>
              <div className="text-[10px] font-medium tracking-widest text-muted-foreground">CONNECT</div>
            </div>
          )}
        </div>

        {/* Collapse control */}
        <div className={cn("shrink-0 pt-2", collapsed ? "px-2" : "px-3")}>
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
            {items.map(item => (
              <NavLinkRow key={item.to} item={item} active={isNavActive(item.to)} collapsed={collapsed} badgeCount={item.badgeKey === "inbox" ? unreadCount : undefined} />
            ))}
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
                      <div className="truncate text-xs text-muted-foreground">{companyName}</div>
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
}

function NavLinkRow({ item, active, collapsed, badgeCount }: { item: NavItem; active: boolean; collapsed: boolean; badgeCount?: number }) {
  const Icon = item.icon;
  const content = (
    <Link to={item.to} className={cn(
      "group relative flex items-center rounded-lg text-sm font-medium transition-colors",
      collapsed ? "justify-center h-9 w-full" : "justify-between gap-3 px-3 py-2",
      active ? "bg-gold-soft text-gold-hover ring-1 ring-gold-soft" : "text-foreground/70 hover:bg-secondary hover:text-foreground",
    )}>
      <span className={cn("flex items-center", collapsed ? "" : "gap-3")}>
        <Icon className={cn("h-4 w-4", active && "text-gold-hover")} />
        {!collapsed && <span>{item.label}</span>}
      </span>
      {!!badgeCount && (
        collapsed ? (
          <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground">{badgeCount}</span>
        ) : (
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">{badgeCount}</span>
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
