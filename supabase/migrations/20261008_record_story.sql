-- Original write-ups for record pages (made by the record-story edge function) and richer source cards.
alter table records add column if not exists story jsonb, add column if not exists story_at timestamptz, add column if not exists story_error text;
alter table record_sources add column if not exists title text, add column if not exists published_on date, add column if not exists quote text;
