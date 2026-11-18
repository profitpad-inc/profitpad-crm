-- Packages can set the default sidebar menu (manifest "nav"). The install
-- records it in meta.package_items as kind 'nav' (object_type_id 'ui',
-- item_key 'default'), so later installs know the package set it once and
-- keep the tenant's menu as it is.
alter table meta.package_items drop constraint package_items_kind_check;
alter table meta.package_items add constraint package_items_kind_check
  check (kind in ('object', 'property', 'option', 'option_scope', 'association_label', 'record', 'view', 'option_list', 'option_list_link', 'nav'));
