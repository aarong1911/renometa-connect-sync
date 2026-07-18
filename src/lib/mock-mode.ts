// src/lib/mock-mode.ts
//
// Toggle for viewing the UI fully populated with sample data and ZERO
// Supabase calls — for screenshots, demos, or local UI QA without a real
// org/session. Every store's initial fetch short-circuits into the existing
// sample data already defined in lib/mock-data.ts when this is on, instead
// of hitting Supabase.
//
// Enable by adding this line to your local .env (never commit it as true):
//   VITE_MOCK_MODE=true
//
// This must never be enabled in production — it's purely a local/dev
// convenience for visual work when a live backend isn't available or
// wanted yet.
export const MOCK_MODE = import.meta.env.VITE_MOCK_MODE === "true";
