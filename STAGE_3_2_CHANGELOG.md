# Stage 3.2 — Financials invoice workflow

- Added a Create Invoice action to the Financials page.
- Expanded the invoice modal so invoices can be created directly from Financials with optional customer and project selection.
- Added customer avatars to invoice rows using the existing branded avatar system and stored avatar_key.
- Rebuilt the invoice search toolbar to match the Lovable composition with status, customer, due date, and sort controls.
- Made invoice rows interactive.
- Added a right-side invoice details drawer with invoice totals, customer details, project details, dates, line items, payment balance, and notes.
- Kept invoice data and creation connected to Supabase.
