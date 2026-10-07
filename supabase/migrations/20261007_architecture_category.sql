-- Buildings, bridges and structures become one Architecture category.
-- The empty bridges and structures rows stay in the table; the site hides them and redirects their pages.
update public.categories set slug = 'architecture', name = 'Architecture' where slug = 'buildings';
update public.records set category_id = (select id from public.categories where slug = 'architecture')
  where category_id in (select id from public.categories where slug in ('bridges', 'structures'));
update public.candidates set category_guess = 'architecture' where category_guess in ('buildings', 'bridges', 'structures');
