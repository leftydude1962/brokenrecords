-- Credit line for a real photo used as a record's poster (shown on the record page).
alter table public.records add column if not exists photo_credit text;
