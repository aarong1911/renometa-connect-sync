# Stage 3 — Financials and Estimates

- Added a standalone `/estimates` route using the existing production Supabase logic, dialogs, status updates, PDF view, and CRUD flows.
- Converted `/financials/estimates` into a backward-compatible redirect to `/estimates`.
- Updated sidebar, favorites, permissions, Command Center actions, and Leads links to use `/estimates`.
- Removed the Financials tab bar from the Financials overview.
- Financials now renders as a standalone dashboard with its own page header and invoice actions.
- Legacy nested invoice/payment/report routes remain functional through the parent outlet.
