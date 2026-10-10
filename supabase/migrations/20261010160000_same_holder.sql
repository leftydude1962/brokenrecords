-- True when two holder names describe the same holder, allowing for word order, extra detail
-- and punctuation: "Mount Vinson (Vinson Massif)" = "Vinson Massif (Mount Vinson)".
-- record-recheck uses the same rule (sameHolder) to sort its results.
create or replace function public.same_holder(a text, b text)
returns boolean
language sql
immutable
as $$
  with w as (
    select
      array(select distinct x from unnest(regexp_split_to_array(lower(normalize(coalesce(a, ''), NFKD)), '[^a-z0-9]+')) x
            where length(x) > 2 and x not in ('the','and','for','from','with','its','inc','ltd','team','national')) as wa,
      array(select distinct x from unnest(regexp_split_to_array(lower(normalize(coalesce(b, ''), NFKD)), '[^a-z0-9]+')) x
            where length(x) > 2 and x not in ('the','and','for','from','with','its','inc','ltd','team','national')) as wb
  )
  select case
    when cardinality(wa) = 0 or cardinality(wb) = 0 then null
    else (select count(*) from unnest(wa) x where x = any(wb))::numeric / least(cardinality(wa), cardinality(wb)) >= 0.5
  end
  from w;
$$;
