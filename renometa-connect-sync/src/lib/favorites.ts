// Sidebar favorites — user-picked shortcuts (max 2), persisted to localStorage.
import { useSyncExternalStore } from "react";
import {
  LayoutDashboard, Users, Building2, Target, TrendingUp, Briefcase, ListTodo,
  Calendar, FolderOpen, Inbox, MessageSquare, Megaphone, Workflow, Bot, Bell,
  FileText, Receipt, CreditCard, BarChart3, Trophy,
} from "lucide-react";
import { ROUTES } from "@/lib/routes";

export type FavoriteOption = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  group: string;
};

export const FAVORITE_CATALOG: FavoriteOption[] = [
  { to: "/", label: "Command Center", icon: LayoutDashboard, group: "Overview" },
  { to: "/contacts", label: "Contacts", icon: Users, group: "CRM" },
  { to: "/companies", label: "Companies", icon: Building2, group: "CRM" },
  { to: "/leads", label: "Leads", icon: Target, group: "CRM" },
  { to: "/sales/pipeline", label: "Pipeline", icon: TrendingUp, group: "CRM" },
  { to: "/projects", label: "Projects", icon: Briefcase, group: "Projects" },
  { to: "/tasks", label: "Tasks", icon: ListTodo, group: "Projects" },
  { to: "/calendar", label: "Calendar", icon: Calendar, group: "Projects" },
  { to: "/files", label: "Files", icon: FolderOpen, group: "Projects" },
  { to: "/inbox", label: "Conversations", icon: Inbox, group: "Inbox" },
  { to: "/inbox/templates", label: "Templates", icon: MessageSquare, group: "Inbox" },
  { to: "/marketing", label: "Marketing", icon: Megaphone, group: "Inbox" },
  { to: ROUTES.WORKFLOWS, label: "Workflows", icon: Workflow, group: "Automation" },
  { to: ROUTES.AI_CENTER, label: "AI Center", icon: Bot, group: "Automation" },
  { to: ROUTES.TRIGGERS, label: "Triggers", icon: Bell, group: "Automation" },
  { to: "/financials/estimates", label: "Estimates", icon: FileText, group: "Financials" },
  { to: "/financials/invoices", label: "Invoices", icon: Receipt, group: "Financials" },
  { to: "/financials/payments", label: "Payments", icon: CreditCard, group: "Financials" },
  { to: "/insights/analytics", label: "Analytics", icon: BarChart3, group: "Insights" },
  { to: "/insights/reputation", label: "Reputation", icon: Trophy, group: "Insights" },
];

export const MAX_FAVORITES = 2;
const KEY = "renometa.favorites.v1";
const DEFAULT_FAVS: string[] = ["/sales/pipeline", "/projects"];

function load(): string[] {
  if (typeof window === "undefined") return [...DEFAULT_FAVS];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [...DEFAULT_FAVS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_FAVS];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, MAX_FAVORITES);
  } catch {
    return [...DEFAULT_FAVS];
  }
}
function persist() {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(KEY, JSON.stringify(favs)); } catch { /* ignore */ }
}

let favs: string[] = load();
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function getFavorites(): string[] { return favs; }
export function setFavorites(next: string[]) {
  favs = next.slice(0, MAX_FAVORITES);
  persist();
  emit();
}
export function toggleFavorite(to: string) {
  if (favs.includes(to)) {
    setFavorites(favs.filter((x) => x !== to));
  } else if (favs.length < MAX_FAVORITES) {
    setFavorites([...favs, to]);
  }
}
export function useFavorites(): string[] {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => favs,
    () => DEFAULT_FAVS,
  );
}
export function useFavoriteOptions(): FavoriteOption[] {
  const ids = useFavorites();
  return ids
    .map((id) => FAVORITE_CATALOG.find((o) => o.to === id))
    .filter((x): x is FavoriteOption => !!x);
}