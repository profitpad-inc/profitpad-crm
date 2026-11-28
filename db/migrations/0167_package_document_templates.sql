-- Packages can ship document templates (manifest "document_templates"), such
-- as the defense package's quote layout. The install records each one in
-- meta.package_items as kind 'document_template' (object_type_id 'pc_0057',
-- item_key the template's id), so later installs know the package owns it.
alter table meta.package_items drop constraint package_items_kind_check;
alter table meta.package_items add constraint package_items_kind_check
  check (kind in ('object', 'property', 'option', 'option_scope', 'association_label', 'record', 'view', 'option_list', 'option_list_link', 'nav', 'integration', 'document_template'));
