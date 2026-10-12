-- "Lead with it": a record with lead_until in the future goes first in the weekly email
-- and is the next social post. Set it by hand for big stories, like the 3,156 lb pumpkin.
alter table public.records add column if not exists lead_until timestamptz;

CREATE OR REPLACE FUNCTION public.digest_items(days integer DEFAULT 7)
 RETURNS TABLE(kind text, slug text, title text, holder text, display_value text, old_holder text, old_value text, poster_url text, category_name text, changed_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  order by coalesce(r.lead_until > now(), false) desc, (i.kind = 'broken') desc, i.changed_at desc
  limit 12;
$function$;
