-- Home page "Just broken" feed.
-- security_invoker = true so the existing RLS on records / record_sources /
-- categories applies to whoever reads the view (anon can already read
-- published + superseded records, sources and categories).

create or replace view public.latest_feed
with (security_invoker = true) as
with src as (
  select record_id, count(distinct coalesce(publisher, url)) as n
  from public.record_sources
  group by record_id
),
broken as (                -- a real break: better value AND a later achieved_on
  select p.id,
         'broken'::text      as kind,
         s.created_at        as changed_at,
         s.holder            as old_holder,
         coalesce(s.value_text, s.value_numeric::text || ' ' || coalesce(s.unit, '')) as old_value,
         s.achieved_on       as old_achieved_on
  from public.records p
  join public.records s
    on s.title = p.title            -- TODO: switch to s.superseded_by = p.id once that column exists
   and s.status = 'superseded'
  where p.status = 'published'
    and s.achieved_on is not null
    and p.achieved_on > s.achieved_on
    and case p.better_direction
          when 'higher' then p.value_numeric > s.value_numeric
          when 'lower'  then p.value_numeric < s.value_numeric
          else p.holder is distinct from s.holder
        end
),
fresh as (                 -- newly set records from the news, not bulk loads
  select p.id,
         'new'::text         as kind,
         p.created_at        as changed_at,
         null::text          as old_holder,
         null::text          as old_value,
         null::date          as old_achieved_on
  from public.records p
  where p.status = 'published'
    and p.id not in (select id from broken)
    and p.achieved_on >= p.created_at::date - 45     -- set recently, not a historical bulk load
    and coalesce(p.value_text, '') !~* 'as of'       -- skip rolling "as of" counts
    and coalesce((select n from src where src.record_id = p.id), 0) >= 2
),
feed as (
  select * from broken
  union all
  select * from fresh
),
windowed as (              -- last 7 days; on a slow week fall back to 30
  select * from feed
  where changed_at > now() - case
          when (select count(*) from feed where changed_at > now() - interval '7 days') >= 4
          then interval '7 days' else interval '30 days' end
)
select w.kind,
       (w.kind = 'broken')   as is_broken,
       w.changed_at,
       r.id, r.slug, r.title, r.holder,
       coalesce(r.value_text, r.value_numeric::text || ' ' || coalesce(r.unit, '')) as display_value,
       r.achieved_on,
       w.old_holder, w.old_value, w.old_achieved_on,
       r.poster_url, r.video_url,
       c.slug as category_slug,
       c.name as category_name
from windowed w
join public.records r on r.id = w.id
left join public.categories c on c.id = r.category_id;

grant select on public.latest_feed to anon, authenticated;
