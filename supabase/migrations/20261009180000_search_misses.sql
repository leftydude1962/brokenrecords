-- Searches on the site that found no record. One row per distinct search text, with a count.
-- Only the words typed are stored: no IP, no visitor id.
create table if not exists public.search_misses (
  query      text primary key,
  count      integer not null default 1,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

-- RLS on with no policies: the public key cannot read or change this table directly.
alter table public.search_misses enable row level security;

-- The only way in for the site: add or count one search. Short, trimmed, lower case.
create or replace function public.log_search_miss(q text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t text := lower(left(btrim(coalesce(q, '')), 100));
begin
  if length(t) < 2 then
    return;
  end if;
  insert into public.search_misses (query) values (t)
  on conflict (query) do update
    set count = public.search_misses.count + 1,
        last_seen = now();
end;
$$;

revoke all on function public.log_search_miss(text) from public;
grant execute on function public.log_search_miss(text) to anon, authenticated;
