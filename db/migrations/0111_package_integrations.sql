-- Packages can create view integrations (manifest "integrations"), such as
-- the defense package's n8n workflows. The install records each one in
-- meta.package_items as kind 'integration' (object_type_id 'auth', item_key
-- the integration's key), so later installs know the package owns it.
alter table meta.package_items drop constraint package_items_kind_check;
alter table meta.package_items add constraint package_items_kind_check
  check (kind in ('object', 'property', 'option', 'option_scope', 'association_label', 'record', 'view', 'option_list', 'option_list_link', 'nav', 'integration'));
