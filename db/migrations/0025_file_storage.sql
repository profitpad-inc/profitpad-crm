-- File storage on the API server's disk (api/src/files.ts). A file record
-- (pc_0050) holds the metadata; the bytes live under FILES_DIR at
-- storage_key. Uploads arrive in chunks, so a file is "uploading" until the
-- last chunk lands and "ready" after. A file with a public_token can be
-- opened by anyone at /files/<public_token>/<name>; without one it is only
-- reachable through short-lived signed links.

select meta.create_property(
  p_object => 'files', p_api_name => 'status', p_label => 'Upload status', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => '[{"api_value": "uploading", "label": "Uploading"}, {"api_value": "ready", "label": "Ready"}]',
  p_description => 'Uploading until every byte has arrived; only ready files can be opened.',
  p_is_native => true);

select meta.create_property(
  p_object => 'files', p_api_name => 'public_token', p_label => 'Public link key', p_type => 'text',
  p_options => '{"single_line": true, "unique": true}',
  p_description => 'Set while the file has a public link (/files/<key>/<name>). Cleared when the link is turned off.',
  p_is_native => true);

-- Only the API's file endpoints may set these: a storage_key written through
-- a plain record update could point at another file's bytes.
update meta.pc_0002 set read_only = true
where object_type_id = 'pc_0050' and api_name in ('mime_type', 'size_bytes', 'storage_key', 'checksum', 'status', 'public_token');
select meta._log_change('update_property', 'pc_0050', null,
  '{"read_only": ["mime_type", "size_bytes", "storage_key", "checksum", "status", "public_token"]}');
