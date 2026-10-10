-- Email list for record alerts. One row per address.
-- status: pending (signed up, not confirmed), confirmed (gets the weekly email), unsubscribed.
-- token: random secret in the confirm and unsubscribe links. Never shown anywhere else.
-- RLS on with no policies: only the service role (edge functions) can read or write it.
create table if not exists public.subscribers (
  id               uuid primary key default gen_random_uuid(),
  email            text not null unique check (email = lower(email) and length(email) <= 200),
  status           text not null default 'pending' check (status in ('pending', 'confirmed', 'unsubscribed')),
  token            uuid not null default gen_random_uuid() unique,
  source           text check (length(source) <= 40),   -- where they signed up: home, record, category, tip, alerts...
  source_detail    text check (length(source_detail) <= 120), -- the record or category slug, if any
  ip_hash          text,
  created_at       timestamptz not null default now(),
  confirm_sent_at  timestamptz,
  confirm_count    integer not null default 0,
  confirmed_at     timestamptz,
  unsubscribed_at  timestamptz,
  last_digest_at   timestamptz
);
create index if not exists subscribers_status_idx on public.subscribers (status);
alter table public.subscribers enable row level security;

-- One row per email the site sends in bulk (the weekly digest), for the dashboard and to avoid double sends.
create table if not exists public.email_sends (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,                 -- digest
  week_of     date,                          -- Monday of the week the digest covers
  subject     text,
  recipients  integer not null default 0,
  items       integer not null default 0,
  error       text,
  sent_at     timestamptz not null default now(),
  unique (kind, week_of)
);
alter table public.email_sends enable row level security;

-- Records broken or newly added in the last N days, for the weekly email. Same rules as the
-- "Just broken" section: a break needs a newer, better value than the old holder; a new record
-- needs at least two sources and a recent date.
create or replace function public.digest_items(days int default 7)
returns table (kind text, slug text, title text, holder text, display_value text, old_holder text, old_value text,
               poster_url text, category_name text, changed_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with broken as (
    select distinct on (p.id) 'broken'::text as kind, p.id, s.created_at as changed_at, s.holder as old_holder,
      coalesce(s.value_text, s.value_numeric::text || ' ' || coalesce(s.unit, '')) as old_value
    from records p join records s on s.superseded_by = p.id and s.status = 'superseded'
    where p.status = 'published' and s.created_at > now() - make_interval(days => days)
      and s.achieved_on is not null and p.achieved_on > s.achieved_on
      and case p.better_direction when 'lower' then p.value_numeric < s.value_numeric else p.value_numeric > s.value_numeric end
    order by p.id, s.created_at desc
  ), fresh as (
    select 'new'::text, p.id, p.created_at, null::text, null::text
    from records p
    where p.status = 'published' and p.created_at > now() - make_interval(days => days)
      and p.id not in (select id from broken)
      and p.achieved_on >= p.created_at::date - 45
      and (select count(distinct coalesce(publisher, url)) from record_sources rs where rs.record_id = p.id) >= 2
  ), items as (select * from broken union all select * from fresh)
  select i.kind, r.slug, r.title, r.holder,
    coalesce(r.value_text, r.value_numeric::text || ' ' || coalesce(r.unit, '')),
    i.old_holder, i.old_value, r.poster_url, c.name, i.changed_at
  from items i join records r on r.id = i.id left join categories c on c.id = r.category_id
  order by (i.kind = 'broken') desc, i.changed_at desc
  limit 12;
$$;
revoke all on function public.digest_items(int) from public, anon, authenticated;
grant execute on function public.digest_items(int) to service_role;
