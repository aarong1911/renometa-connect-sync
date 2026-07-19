import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GripVertical, Pin, Star, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  FAVORITE_CATALOG,
  MAX_FAVORITES,
  setFavorites,
  toggleFavorite,
  useFavorites,
} from "@/lib/favorites";
import { toast } from "sonner";

export const Route = createFileRoute("/settings/favorites")({
  component: FavoritesSettings,
});

function FavoritesSettings() {
  const favs = useFavorites();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const grouped = useMemo(() => {
    const g = new Map<string, typeof FAVORITE_CATALOG>();
    for (const opt of FAVORITE_CATALOG) {
      if (!g.has(opt.group)) g.set(opt.group, []);
      g.get(opt.group)!.push(opt);
    }
    return Array.from(g.entries());
  }, []);

  const selected = favs
    .map((to) => FAVORITE_CATALOG.find((o) => o.to === to))
    .filter((x): x is (typeof FAVORITE_CATALOG)[number] => !!x);

  function reorder(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= favs.length || to >= favs.length) return;
    const next = [...favs];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setFavorites(next);
  }

  return (
    <Card className="p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Pin className="h-4 w-4" /> Sidebar Favorites
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Pin up to {MAX_FAVORITES} shortcuts to the top of your sidebar for quick access.
          </p>
        </div>
        {favs.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFavorites([]);
              toast.success("Favorites cleared");
            }}
          >
            Clear all
          </Button>
        )}
      </div>

      <div className="mb-6 rounded-md border border-dashed p-3">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Current favorites ({favs.length}/{MAX_FAVORITES})
        </div>
        {selected.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No favorites pinned yet. Select up to {MAX_FAVORITES} below.
          </p>
        ) : (
          <>
            <p className="mb-2 text-[11px] text-muted-foreground">
              Drag to reorder — the top item appears first in the sidebar.
            </p>
            <ul className="space-y-1.5">
              {selected.map((opt, index) => {
                const Icon = opt.icon;
                const isDragging = dragIndex === index;
                const isOver = overIndex === index && dragIndex !== null && dragIndex !== index;
                return (
                  <li
                    key={opt.to}
                    draggable
                    onDragStart={(e) => {
                      setDragIndex(index);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", String(index));
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (overIndex !== index) setOverIndex(index);
                    }}
                    onDragLeave={() => {
                      if (overIndex === index) setOverIndex(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragIndex !== null) {
                        reorder(dragIndex, index);
                        toast.success("Favorites reordered");
                      }
                      setDragIndex(null);
                      setOverIndex(null);
                    }}
                    onDragEnd={() => {
                      setDragIndex(null);
                      setOverIndex(null);
                    }}
                    className={cn(
                      "flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-sm transition-colors",
                      isDragging && "opacity-40",
                      isOver && "border-primary ring-1 ring-primary",
                    )}
                  >
                    <GripVertical className="h-4 w-4 cursor-grab text-muted-foreground active:cursor-grabbing" />
                    <span className="text-[10px] font-semibold tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    <Icon className="h-4 w-4" />
                    <span className="flex-1 font-medium">{opt.label}</span>
                    <button
                      type="button"
                      onClick={() => toggleFavorite(opt.to)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={`Remove ${opt.label}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      <div className="space-y-5">
        {grouped.map(([group, items]) => (
          <div key={group}>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group}
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {items.map((opt) => {
                const Icon = opt.icon;
                const isFav = favs.includes(opt.to);
                const disabled = !isFav && favs.length >= MAX_FAVORITES;
                return (
                  <button
                    key={opt.to}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      toggleFavorite(opt.to);
                      if (!isFav) toast.success(`Pinned ${opt.label}`);
                    }}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                      isFav
                        ? "border-primary/40 bg-primary-soft text-primary"
                        : "border-border hover:bg-secondary",
                      disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Icon className="h-4 w-4" />
                      <span className="font-medium">{opt.label}</span>
                    </span>
                    {isFav && <Star className="h-3.5 w-3.5 fill-primary text-primary" />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}