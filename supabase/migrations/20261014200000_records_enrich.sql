-- record-enrich: marks each record once it has been researched for extra sources and its date.
alter table public.records add column if not exists enriched_at timestamptz;
alter table public.records add column if not exists enrich_note jsonb;
