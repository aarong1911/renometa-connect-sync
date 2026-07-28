// src/components/layout/topbar.tsx
import {
  Search,
  Bell,
  HelpCircle,
  Calendar as CalendarIcon,
  Briefcase,
  Users,
  Target,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { ROUTES } from "@/lib/routes";
import { useOrganization } from "@/lib/organization";

type SearchResult = {
  id: string;
  label: string;
  sub: string;
  group: "contacts" | "deals" | "projects";
  href: string;
};

async function getOrgId(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) return null;

  const uid = session.user.id;

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", uid)
    .maybeSingle();

  if (profile?.organization_id) return profile.organization_id;

  const { data: membership } = await supabase
    .from("org_memberships")
    .select("org_id")
    .eq("member_id", uid)
    .maybeSingle();

  return membership?.org_id ?? null;
}

async function globalSearch(query: string): Promise<SearchResult[]> {
  const orgId = await getOrgId();
  if (!orgId || !query.trim()) return [];

  const q = query.trim();

  const [{ data: contacts }, { data: deals }, { data: projects }] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, full_name, email, phone")
      .eq("org_id", orgId)
      .or(`full_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`)
      .limit(5),

    supabase
      .from("deals")
      .select("id, title, value, status")
      .eq("org_id", orgId)
      .ilike("title", `%${q}%`)
      .limit(5),

    supabase
      .from("projects")
      .select("id, name, status, address")
      .eq("org_id", orgId)
      .ilike("name", `%${q}%`)
      .limit(5),
  ]);

  const out: SearchResult[] = [];

  for (const contact of contacts ?? []) {
    out.push({
      id: contact.id,
      label: contact.full_name,
      sub: contact.email ?? contact.phone ?? "",
      group: "contacts",
      href: `${ROUTES.CONTACTS}?contactId=${contact.id}`,
    });
  }

  for (const deal of deals ?? []) {
    out.push({
      id: deal.id,
      label: deal.title,
      sub: [
        deal.status,
        deal.value ? `$${Number(deal.value).toLocaleString("en-US")}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      group: "deals",
      href: ROUTES.PIPELINE,
    });
  }

  for (const project of projects ?? []) {
    out.push({
      id: project.id,
      label: project.name,
      sub: [project.status, project.address].filter(Boolean).join(" · "),
      group: "projects",
      href: ROUTES.PROJECTS,
    });
  }

  return out;
}

const GROUP_ICONS = {
  contacts: Users,
  deals: Target,
  projects: Briefcase,
};

const GROUP_LABELS = {
  contacts: "Contacts",
  deals: "Deals",
  projects: "Projects",
};

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function Topbar({ primaryAction }: { primaryAction?: ReactNode }) {
  const navigate = useNavigate();
  const organization = useOrganization();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const updateClock = () => setNow(new Date());
    updateClock();

    const intervalId = window.setInterval(updateClock, 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const companyClock = useMemo(() => {
    const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const timeZone = organization.timezone || browserTimeZone;

    try {
      const date = new Intl.DateTimeFormat("en-US", {
        timeZone,
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(now);

      const time = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
      }).format(now);

      const zone =
        new Intl.DateTimeFormat("en-US", {
          timeZone,
          timeZoneName: "short",
        })
          .formatToParts(now)
          .find((part) => part.type === "timeZoneName")?.value ?? timeZone;

      return { date, time, zone, timeZone };
    } catch {
      return {
        date: now.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
        time: now.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        }),
        zone: browserTimeZone,
        timeZone: browserTimeZone,
      };
    }
  }, [now, organization.timezone]);

  const handleSearch = useCallback((value: string) => {
    setQuery(value);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (!value.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);

    debounceRef.current = setTimeout(async () => {
      try {
        setResults(await globalSearch(value));
      } finally {
        setSearching(false);
      }
    }, 250);
  }, []);

  const handleSelect = (result: SearchResult) => {
    setOpen(false);
    setQuery("");
    setResults([]);
    navigate({ to: result.href });
  };

  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, result) => {
    (acc[result.group] ??= []).push(result);
    return acc;
  }, {});

  return (
    <header className="sticky top-0 z-30 grid h-16 grid-cols-[1fr_auto_1fr] items-center border-b border-border bg-background/80 px-6 backdrop-blur">
      <div className="justify-self-start">
        <div
          className="hidden h-10 w-auto items-center gap-3 whitespace-nowrap rounded-lg border border-slate-400/70 bg-secondary/30 px-3 xl:inline-flex"
          title={`Company timezone: ${companyClock.timeZone}`}
        >
          <span className="text-sm font-medium tabular-nums text-foreground/85">
            {companyClock.date}
          </span>
          <span className="h-4 w-px bg-slate-400/60" />
          <span className="text-sm font-medium tabular-nums text-foreground">
            {companyClock.time}
          </span>
          <span className="text-sm font-medium tabular-nums text-muted-foreground">
            {companyClock.zone}
          </span>
        </div>
      </div>

      <div className="w-[420px] max-w-[42vw]">
        <button
          onClick={() => setOpen(true)}
          className="flex h-10 w-full items-center gap-2 rounded-lg border border-slate-400/70 bg-secondary/45 px-3 text-sm text-muted-foreground transition-colors hover:bg-secondary/70"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">
            Search contacts, deals, projects, tasks...
          </span>
        </button>
      </div>

      <div className="relative flex min-w-0 items-center justify-end">
        <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 rounded-lg"
          onClick={() => navigate({ to: "/calendar" })}
          aria-label="Open calendar"
        >
          <CalendarIcon className="h-5 w-5 text-muted-foreground" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 rounded-lg"
          onClick={() => setShortcutsOpen(true)}
          aria-label="Keyboard shortcuts"
        >
          <HelpCircle className="h-5 w-5 text-muted-foreground" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="relative h-10 w-10 rounded-lg"
          aria-label="Notifications"
        >
          <Bell className="h-5 w-5 text-muted-foreground" />
        </Button>
      </div>

        {primaryAction && <div className="ml-2 flex shrink-0 items-center">{primaryAction}</div>}
      </div>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);

          if (!nextOpen) {
            setQuery("");
            setResults([]);
            setSearching(false);
          }
        }}
      >
        <DialogContent className="max-w-lg p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>Search</DialogTitle>
          </DialogHeader>

          <Command shouldFilter={false}>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => handleSearch(event.target.value)}
                placeholder="Search contacts, deals, projects…"
                className="flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
                autoFocus
              />
              {searching && (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              )}
            </div>

            <CommandList className="max-h-80 p-1">
              {!query && (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  Start typing to search…
                </div>
              )}

              {query && !searching && results.length === 0 && (
                <CommandEmpty>No results for "{query}"</CommandEmpty>
              )}

              {(["contacts", "deals", "projects"] as const).map((group) => {
                const items = grouped[group];
                if (!items?.length) return null;

                const Icon = GROUP_ICONS[group];

                return (
                  <CommandGroup key={group} heading={GROUP_LABELS[group]}>
                    {items.map((result) => (
                      <CommandItem
                        key={result.id}
                        onSelect={() => handleSelect(result)}
                        className="flex cursor-pointer items-center gap-2.5 py-2"
                      >
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                          <Icon className="h-3.5 w-3.5" />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{result.label}</div>
                          {result.sub && (
                            <div className="truncate text-[11px] text-muted-foreground">
                              {result.sub}
                            </div>
                          )}
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
          </DialogHeader>

          <div className="space-y-2 text-sm">
            {[
              [IS_MAC ? "⌘K" : "Ctrl K", "Global search"],
              [IS_MAC ? "⌘/" : "Ctrl /", "Focus sidebar"],
              ["Esc", "Close dialog"],
            ].map(([key, label]) => (
              <div
                key={key}
                className="flex items-center justify-between rounded-md bg-secondary/50 px-3 py-2"
              >
                <span className="text-muted-foreground">{label}</span>
                <kbd className="rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium">
                  {key}
                </kbd>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </header>
  );
}