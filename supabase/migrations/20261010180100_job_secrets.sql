-- Shared secret between cron and the jobs that must not be callable by the public key.
-- Cron reads it at run time (x-job-secret header); the function compares it with this table.
-- RLS on with no policies: only the service role and the database itself can read it.
create table if not exists public.job_secrets (key text primary key, value text not null);
alter table public.job_secrets enable row level security;
insert into public.job_secrets (key, value)
values ('jobs', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;
