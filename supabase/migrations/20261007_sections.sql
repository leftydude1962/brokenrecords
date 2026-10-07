-- Ten top-level sections. Existing categories become sub-categories under them (categories.parent_id).
alter table public.categories add column if not exists sort_order int;
insert into public.categories (slug, name, sort_order) values
 ('sports','Sports',1),('nature-and-earth','Nature and Earth',2),('architecture-and-engineering','Architecture and Engineering',3),
 ('animals-and-plants','Animals and Plants',4),('people-and-feats','People and Feats',5),('science-and-technology','Science and Technology',6),
 ('space-and-astronomy','Space and Astronomy',7),('arts-and-entertainment','Arts, Entertainment and Music',8),
 ('food-and-drink','Food and Drink',9),('business-and-money','Business and Money',10)
on conflict do nothing;
insert into public.categories (slug, name) values ('plants','Plants'),('food','Food and Drink') on conflict do nothing;
-- Parent mapping, renames and the featured picks were applied the same day; see the session notes.
