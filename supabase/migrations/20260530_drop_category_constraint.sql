-- The existing constraint uses lowercase category values ('general', 'sales', etc.)
-- but the app sends title-case ('Sales', 'Operations', 'Client Care').
-- Drop it — category is validated at the application layer.
alter table workflows drop constraint if exists workflows_category_check;
