-- Date a record was last confirmed against its sources by a real check.
-- Null until a check runs. Not the same as last_verified_at, which the sync jobs set without re-searching every record.
alter table public.records add column if not exists last_checked_at timestamptz;
