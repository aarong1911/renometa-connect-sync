// Small localStorage-backed history of recently-inserted message templates.
// Used by /inbox (to record) and /inbox/templates (to display).
import { useEffect, useState } from "react";

const KEY = "inbox.recentTemplateIds";
const MAX = 6;
const EVENT = "recent-templates-change";

function read(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(ids: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // ignore quota / serialization errors
  }
}

export function recordTemplateUse(id: string) {
  const current = read().filter((x) => x !== id);
  current.unshift(id);
  write(current.slice(0, MAX));
}

export function clearRecentTemplates() {
  write([]);
}

export function useRecentTemplateIds(): string[] {
  const [ids, setIds] = useState<string[]>(() => read());
  useEffect(() => {
    const sync = () => setIds(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return ids;
}