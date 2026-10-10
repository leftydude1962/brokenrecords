-- Name of the visitor who tipped us off to this record, shown as "Tipped off by ..." on the page.
-- Only set when the visitor gave a name and the owner approved the tip on /admin.
alter table public.records add column if not exists tipped_by text check (tipped_by is null or length(tipped_by) <= 60);
