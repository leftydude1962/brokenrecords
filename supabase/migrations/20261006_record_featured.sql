-- Featured records get a video clip; every other record gets a still image only.
alter table public.records add column if not exists featured boolean not null default false;
update public.records set featured = true where slug in (
  'mens-100m','highest-tornado-wind-speed','largest-animal-ever',
  'highest-mountain','land-speed-record','tallest-building','fastest-land-animal',
  'f1-fastest-lap','longest-lightning-flash-distance','most-time-in-space');
