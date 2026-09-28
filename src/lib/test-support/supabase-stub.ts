// Test-only stand-in for "@/lib/supabase" (aliased in by the esbuild bundles of
// src/lib/*.test.ts). There is no real client, URL or key here: `from()` is
// delegated to whatever in-memory fake the test installs on globalThis.
export const supabase: any = {
  auth: { getSession: async () => ({ data: { session: { access_token: "test-token" } } }) },
  from: (table: string) => (globalThis as any).__testSupabase.from(table),
};
