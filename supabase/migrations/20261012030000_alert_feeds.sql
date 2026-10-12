-- Google Alerts RSS feeds, read every hour by the alerts-ingest function.
-- alert_items remembers every story seen, so nothing is checked twice.
create table if not exists public.alert_feeds (
  url text primary key,
  label text,
  active boolean not null default true,
  last_read_at timestamptz,
  last_error text
);
create table if not exists public.alert_items (
  id uuid primary key default gen_random_uuid(),
  link text not null unique,
  feed_url text,
  title text,
  snippet text,
  published_at timestamptz,
  decision text,           -- queued | not_record | duplicate | over_cap | prefilter
  reason text,
  story_key text,          -- the triage's short name for the record, used to drop repeats across articles
  candidate_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists alert_items_created on public.alert_items (created_at desc);
create index if not exists alert_items_key on public.alert_items (story_key);
alter table public.alert_feeds enable row level security;
alter table public.alert_items enable row level security;
-- No policies: only the service role (edge functions) reads or writes these tables.
