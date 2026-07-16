# Redesign against your REAL app — batch 12 (sidebar active-state fix)

## File → destination
sidebar.tsx → src/components/layout/sidebar.tsx (replaces batch 7's version)

## The bug
On `/financials/estimates`, both "Estimates" AND "Financials" lit up gold
in the sidebar. The active-check used simple prefix matching
(`pathname.startsWith(to + "/")`), so the parent hub route
("/financials") and the more specific child route
("/financials/estimates") both matched simultaneously — since Estimates
has its own dedicated top-level nav item separate from the Financials hub.

## The fix
The active-check now finds the single **most specific** (longest)
matching nav path across the whole nav list, and only highlights that
one. So:
- On `/financials/estimates` → only "Estimates" lights up
- On `/financials/invoices` → only "Invoices"... 

  wait — actually "Invoices" isn't a top-level nav item (only Estimates
  and Financials are, per Lovable's structure) — so `/financials/invoices`
  will correctly show only "Financials" highlighted, since there's no
  more specific nav entry to compete with it. Only Estimates (which does
  have its own entry) was the actual conflict case.
- Everywhere else (Leads, Contacts, Pipeline, etc.) — unchanged behavior,
  no regression.

## How to apply
Just replace `src/components/layout/sidebar.tsx` with this version — no
other files affected, no restart-order dependency on other batches.
