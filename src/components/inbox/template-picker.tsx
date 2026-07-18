import { useMemo, useState } from "react";
import {
  MessageSquare, Mail, Search, Star, Sparkles, ArrowRight, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  messageTemplates,
  type SharedMessageTemplate,
  type MessageChannel,
} from "@/lib/message-templates";
import { useRecentTemplateIds, clearRecentTemplates } from "@/lib/recent-templates";

type ChannelFilter = "all" | MessageChannel;

export type TemplatePickerProps = {
  /** Initial channel filter. Defaults to "all". */
  initialChannel?: ChannelFilter;
  /** Called when the user inserts a template. */
  onInsert: (t: SharedMessageTemplate) => void;
  /** Compact layout for narrow sheets (single column cards). */
  compact?: boolean;
};

/**
 * Shared template picker used both by the /inbox/templates route and the
 * "Pick template" side sheet in the Inbox composer.
 */
export function TemplatePicker({
  initialChannel = "all",
  onInsert,
  compact = false,
}: TemplatePickerProps) {
  const [channel, setChannel] = useState<ChannelFilter>(initialChannel);
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const recentIds = useRecentTemplateIds();

  const recent = useMemo(() => {
    return recentIds
      .map((id) => messageTemplates.find((t) => t.id === id))
      .filter((t): t is SharedMessageTemplate => Boolean(t));
  }, [recentIds]);

  const categories = useMemo(() => {
    const set = new Set(messageTemplates.map((t) => t.category));
    return ["all", ...Array.from(set).sort()];
  }, []);

  const counts = useMemo(() => ({
    all: messageTemplates.length,
    email: messageTemplates.filter((t) => t.channel === "email").length,
    sms: messageTemplates.filter((t) => t.channel === "sms").length,
  }), []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return messageTemplates
      .filter((t) => channel === "all" || t.channel === channel)
      .filter((t) => category === "all" || t.category === category)
      .filter((t) => {
        if (!q) return true;
        return (
          t.name.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.body.toLowerCase().includes(q) ||
          (t.subject ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => Number(b.starred) - Number(a.starred) || b.uses - a.uses);
  }, [channel, category, query]);

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className={cn("flex gap-3", compact ? "flex-col" : "flex-col lg:flex-row lg:items-center lg:justify-between")}>
        <div className="flex items-center gap-1 rounded-md border bg-card p-1">
          <ChannelChip active={channel === "all"} onClick={() => setChannel("all")} icon={Sparkles} label="All" count={counts.all} />
          <ChannelChip active={channel === "email"} onClick={() => setChannel("email")} icon={Mail} label="Email" count={counts.email} />
          <ChannelChip active={channel === "sms"} onClick={() => setChannel("sms")} icon={MessageSquare} label="SMS" count={counts.sms} />
        </div>
        <div className={cn("relative w-full", compact ? "" : "lg:max-w-sm")}>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates…"
            className="h-9 pl-8"
          />
        </div>
      </div>

      {/* Category pills */}
      <div className="flex flex-wrap gap-1.5">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              category === c
                ? "border-primary bg-primary-soft text-primary"
                : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {c === "all" ? "All categories" : c}
          </button>
        ))}
      </div>

      {/* Recently used */}
      {recent.length > 0 && (
        <div className="rounded-lg border bg-card p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recently used</h2>
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-medium">{recent.length}</Badge>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => clearRecentTemplates()}
            >
              Clear
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {recent.map((t) => {
              const Icon = t.channel === "email" ? Mail : MessageSquare;
              return (
                <button
                  key={t.id}
                  onClick={() => onInsert(t)}
                  className="group inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:border-primary hover:bg-primary-soft hover:text-primary"
                  title={t.description}
                >
                  <Icon className="h-3 w-3" />
                  <span className="max-w-[180px] truncate">{t.name}</span>
                  <ArrowRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Grid */}
      {visible.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Sparkles className="h-10 w-10 text-muted-foreground" />
            <div>
              <h3 className="text-sm font-semibold">No templates match those filters</h3>
              <p className="text-xs text-muted-foreground">Try a different channel, category, or search term.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className={cn("grid gap-3", compact ? "grid-cols-1" : "sm:grid-cols-2 xl:grid-cols-3")}>
          {visible.map((t) => (
            <TemplateCard key={t.id} t={t} onInsert={() => onInsert(t)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChannelChip({
  active, onClick, icon: Icon, label, count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition-colors",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
      <span className={cn("ml-0.5 rounded px-1 text-[10px] tabular-nums", active ? "bg-primary-foreground/20" : "bg-muted text-muted-foreground")}>
        {count}
      </span>
    </button>
  );
}

function TemplateCard({ t, onInsert }: { t: SharedMessageTemplate; onInsert: () => void }) {
  const Icon = t.channel === "email" ? Mail : MessageSquare;
  return (
    <Card className="group flex flex-col overflow-hidden transition-shadow hover:shadow-md">
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 min-w-0">
            <span className={cn(
              "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
              t.channel === "email" ? "bg-primary-soft text-primary" : "bg-success-soft text-success",
            )}>
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h3 className="text-sm font-semibold truncate">{t.name}</h3>
                {t.starred && <Star className="h-3 w-3 fill-warning text-warning shrink-0" />}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-medium">{t.category}</Badge>
                <span>·</span>
                <span>{t.uses.toLocaleString()} uses</span>
              </div>
            </div>
          </div>
        </div>

        <p className="text-xs text-muted-foreground line-clamp-2">{t.description}</p>

        {t.subject && (
          <div className="rounded-md border bg-muted/40 px-2.5 py-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Subject</div>
            <div className="text-xs font-medium truncate">{t.subject}</div>
          </div>
        )}

        <div className="rounded-md border bg-card px-2.5 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Body</div>
          <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-foreground line-clamp-4">
            {t.body}
          </pre>
        </div>

        <div className="mt-auto flex items-center justify-end pt-1">
          <Button size="sm" className="h-8" onClick={onInsert}>
            Insert into reply <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}