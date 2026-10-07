-- Featured records get a video clip, one per category; every other record gets a still image only.
alter table public.records add column if not exists featured boolean not null default false;
update public.records set featured = true where slug in (
  'mens-100m','highest-tornado-wind-speed','largest-animal-ever',
  'highest-mountain','land-speed-record','tallest-building','nfl-career-passing-yards',
  'f1-fastest-lap','mlb-career-home-runs','most-time-in-space');
