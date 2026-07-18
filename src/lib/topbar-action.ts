// src/lib/topbar-action.ts
import { createContext, useContext, useEffect, type ReactNode } from "react";

type TopbarActionContextValue = {
  setAction: (node: ReactNode) => void;
};

export const TopbarActionContext = createContext<TopbarActionContextValue | null>(null);

/**
 * Lets a route register its primary action into the topbar instead of
 * rendering its own duplicate button. The action node stays owned by the
 * page (dialogs/state live there) — this just relocates where it renders.
 * Pass `null` (or omit) to clear a previously-registered action.
 */
export function useTopbarAction(node: ReactNode) {
  const ctx = useContext(TopbarActionContext);
  useEffect(() => {
    if (!ctx) return;
    ctx.setAction(node);
    return () => ctx.setAction(null);
  }, [ctx, node]);
}
