-- Poster image and looping clip for each record, made by the media-gen function.
alter table public.records
  add column if not exists visual_prompt text,
  add column if not exists poster_url text,
  add column if not exists video_url text,
  add column if not exists media_status text,
  add column if not exists media_task_id text,
  add column if not exists media_error text,
  add column if not exists media_attempts int not null default 0,
  add column if not exists media_started_at timestamptz,
  add column if not exists media_priority int;

create index if not exists records_media_status_idx on public.records (media_status);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 52428800, array['image/jpeg','image/png','image/webp','video/mp4'])
on conflict (id) do nothing;
