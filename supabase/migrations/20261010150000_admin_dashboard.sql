-- Numbers for the private dashboard on /admin. One call returns everything the page shows.
-- Days are counted in Central time, the owner's time zone.
-- Only the service role (the admin-review function) can run it. The public key cannot.
create or replace function public.admin_dashboard(days int default 14)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with tz as (select 'America/Chicago'::text as z),
today as (select (now() at time zone (select z from tz))::date as d),
span as (
  select generate_series((select d from today) - (days - 1), (select d from today), interval '1 day')::date as d
),
news as (  -- claims from the daily news check (no "kind" set)
  select c.*, (c.created_at at time zone (select z from tz))::date as d
  from candidates c
  where c.claude_json->>'kind' is null
),
daily as (
  select s.d,
    (select count(*) from records r where r.status = 'published'
       and (r.created_at at time zone (select z from tz))::date = s.d) as added,
    (select count(*) from records r where r.status = 'superseded' and r.superseded_by is not null
       and (r.created_at at time zone (select z from tz))::date = s.d) as broken,
    (select count(*) from news n where n.d = s.d) as news_found,
    (select count(*) from news n where n.d = s.d and n.status in ('auto_published', 'approved')) as news_live,
    (select coalesce(sum((sr.stats->>'totalCost')::numeric), 0) from sync_runs sr
       where sr.source like 'news:%' and not sr.dry_run
         and (sr.started_at at time zone (select z from tz))::date = s.d) as cost
  from span s
),
today_news as (
  select n.created_at, n.status, n.record_id,
    coalesce(n.claude_json->>'title', '') as title,
    n.proposed_holder as holder,
    n.proposed_value_text as value_text,
    coalesce(
      (select r.slug from records r where r.id = n.record_id),
      (select r.slug from records r where r.slug = left(trim(both '-' from regexp_replace(
         lower(normalize(coalesce(n.claude_json->>'title', ''), NFKD)), '[^a-z0-9]+', '-', 'g')), 80))
    ) as slug,
    coalesce(
      (select r.status from records r where r.id = n.record_id),
      (select r.status from records r where r.slug = left(trim(both '-' from regexp_replace(
         lower(normalize(coalesce(n.claude_json->>'title', ''), NFKD)), '[^a-z0-9]+', '-', 'g')), 80))
    ) as record_status,
    coalesce(array_length(n.source_urls, 1), 0) as sources
  from news n
  where n.d = (select d from today)
),
runs as (
  select sr.source, sr.started_at, sr.finished_at,
    exists (select 1 from jsonb_array_elements(coalesce(sr.stats->'results', '[]'::jsonb)) e where e ? 'error') as failed
  from sync_runs sr
  where sr.source like 'news:%' and not sr.dry_run
    and (sr.started_at at time zone (select z from tz))::date = (select d from today)
)
select jsonb_build_object(
  'today', (select d from today),
  'totals', jsonb_build_object(
    'published', (select count(*) from records where status = 'published'),
    'history', (select count(*) from records where status = 'superseded'),
    'categories', (select count(distinct category_id) from records where status = 'published'),
    'no_poster', (select count(*) from records where status = 'published' and poster_url is null),
    'one_source', (select count(*) from records r where r.status = 'published'
                     and (select count(*) from record_sources s where s.record_id = r.id) < 2)
  ),
  'queues', jsonb_build_object(
    'corrections', (select count(*) from candidates where status = 'pending' and claude_json->>'kind' = 'submission'),
    'rechecks', (select count(*) from candidates where status = 'pending' and claude_json->>'kind' = 'recheck'),
    'drafts', (select count(*) from candidates where status = 'pending' and claude_json->>'kind' = 'draft'),
    'news', (select count(*) from candidates where status = 'pending' and claude_json->>'kind' is null)
  ),
  'daily', (select jsonb_agg(to_jsonb(daily) order by d) from daily),
  'today_news', coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at) from today_news t), '[]'::jsonb),
  'runs', jsonb_build_object(
    'count', (select count(*) from runs),
    'failed', (select count(*) from runs where failed),
    'last', (select max(finished_at) from runs)
  ),
  'search_misses', coalesce((select jsonb_agg(jsonb_build_object('query', query, 'count', count, 'last_seen', last_seen) order by count desc, last_seen desc)
                             from (select * from search_misses where query !~ '[${}<>]' order by count desc, last_seen desc limit 12) m), '[]'::jsonb)
);
$$;

revoke all on function public.admin_dashboard(int) from public, anon, authenticated;
grant execute on function public.admin_dashboard(int) to service_role;
