begin;

alter table public.invoices
  drop constraint if exists invoices_status_check;

alter table public.invoices
  add constraint invoices_status_check
  check (
    status = any (
      array[
        'draft'::text,
        'sent'::text,
        'viewed'::text,
        'partial'::text,
        'paid'::text,
        'overdue'::text,
        'cancelled'::text
      ]
    )
  );

commit;