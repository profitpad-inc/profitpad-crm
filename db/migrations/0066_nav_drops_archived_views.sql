-- A custom view (crm.pc_0055) that stops being active (archived, merged or
-- permanently deleted) is taken out of every sidebar menu: the default menu,
-- each user's menu, sections inside them and the mobile bottom bars. Before
-- this, the item stayed as a dead link and saving the menu in Settings failed
-- ("custom view ... does not exist"). Restoring the view does not put it back.

-- items without any custom_view item for p_slug, sections included
create function ui._nav_without_view(p_items jsonb, p_slug text) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(
    case when i ->> 'type' = 'section'
      then jsonb_set(i, '{items}', ui._nav_without_view(coalesce(i -> 'items', '[]'), p_slug))
      else i end
    order by n), '[]')
  from jsonb_array_elements(coalesce(p_items, '[]')) with ordinality as e(i, n)
  where not (i ->> 'type' = 'custom_view' and lower(i ->> 'slug') = lower(p_slug))
$$;

create function ui._nav_drop_view() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  -- old.slug: a permanent delete has already blanked the new row
  if old.slug is not null then
    update ui.nav_menus
    set items = ui._nav_without_view(items, old.slug),
        bottom_items = ui._nav_without_view(bottom_items, old.slug),
        updated_at = now()
    where items is distinct from ui._nav_without_view(items, old.slug)
       or bottom_items is distinct from ui._nav_without_view(bottom_items, old.slug);
  end if;
  return null;
end $$;

create trigger nav_drop_view
after update of record_status on crm.pc_0055
for each row when (old.record_status = 'active' and new.record_status <> 'active')
execute function ui._nav_drop_view();

-- views already archived or deleted: clean the menus once
do $$
declare
  v_slug text;
begin
  for v_slug in
    select distinct lower(i ->> 'slug')
    from ui.nav_menus m,
         lateral jsonb_path_query(m.items || m.bottom_items, 'strict $.** ? (@.type == "custom_view")') as i
    where not exists (select 1 from crm.pc_0055 v where lower(v.slug) = lower(i ->> 'slug') and v.record_status = 'active')
  loop
    update ui.nav_menus
    set items = ui._nav_without_view(items, v_slug), bottom_items = ui._nav_without_view(bottom_items, v_slug), updated_at = now();
  end loop;
end $$;
