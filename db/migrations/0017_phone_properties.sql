-- Phone number properties: text properties with display "phone". The API
-- checks every write to them with Google's libphonenumber (default region CA)
-- and stores valid numbers as E.164 plus extension: +16132220328ext4. The UI
-- shows them as +1 613-222-0328 ext4. See api/src/phone.ts.
--
-- Same function as in 0003, with 'phone' added to the display values.
create or replace function meta._validate_options(p_type text, p_options jsonb) returns void
language plpgsql as $$
declare
  v_spec jsonb;
  v_key text;
  v_value jsonb;
  v_kind text;
  v_ok boolean;
begin
  v_spec := case p_type
    when 'text' then '{"single_line":"boolean","display":"display","regex":"regex","regex_scope":"regex_scope","json_only":"boolean","unique":"boolean","case_insensitive":"boolean"}'
    when 'number' then '{"format":"number_format","prefix":"string","suffix":"string","decimals":"decimals","min":"number","max":"number","currency_code":"currency","currency_property":"string"}'
    when 'dropdown' then '{"single_value":"boolean","allow_form_add":"boolean","allow_user_add":"boolean","auto_append_users":"boolean"}'
    when 'date' then '{}'
    when 'datetime' then '{"timezone":"timezone"}'
    when 'file' then '{"max_files":"positive_int"}'
    when 'calculation' then '{"display":"display","format":"number_format","prefix":"string","suffix":"string","decimals":"decimals","timezone":"timezone"}'
    else '{}'
  end::jsonb;
  for v_key, v_value in select * from jsonb_each(p_options) loop
    v_kind := v_spec ->> v_key;
    if v_kind is null then
      perform meta._fail(format('option "%s" is not allowed for %s properties (allowed: %s)', v_key, p_type,
        coalesce((select string_agg(k, ', ') from jsonb_object_keys(v_spec) k), 'none')));
    end if;
    v_ok := case v_kind
      when 'boolean' then jsonb_typeof(v_value) = 'boolean'
      when 'string' then jsonb_typeof(v_value) = 'string' and char_length(v_value #>> '{}') <= 63
      when 'number' then jsonb_typeof(v_value) = 'number'
      when 'regex' then jsonb_typeof(v_value) = 'string'
      when 'display' then v_value #>> '{}' in ('plain', 'url', 'markdown', 'json', 'html', 'phone')
      when 'regex_scope' then v_value #>> '{}' in ('all', 'ui')
      when 'number_format' then v_value #>> '{}' in ('formatted', 'unformatted', 'currency', 'percentage')
      when 'currency' then exists (select 1 from meta.pc_0007 where code = v_value #>> '{}')
      when 'timezone' then exists (select 1 from pg_timezone_names where name = v_value #>> '{}')
      when 'decimals' then jsonb_typeof(v_value) = 'number' and (v_value #>> '{}') ~ '^([0-9]|10)$'
      when 'positive_int' then jsonb_typeof(v_value) = 'number' and (v_value #>> '{}') ~ '^[1-9][0-9]{0,5}$'
      else false
    end;
    if not coalesce(v_ok, false) then
      perform meta._fail(format('option "%s" has an invalid value: %s', v_key, v_value));
    end if;
    if v_kind = 'regex' then
      begin
        perform '' ~ (v_value #>> '{}');
      exception when others then
        perform meta._fail(format('regex is invalid: %s', sqlerrm));
      end;
    end if;
  end loop;
  if p_options ? 'min' and p_options ? 'max' and (p_options ->> 'min')::numeric > (p_options ->> 'max')::numeric then
    perform meta._fail('min cannot be greater than max');
  end if;
  if p_options ? 'regex_scope' and not p_options ? 'regex' then
    perform meta._fail('regex_scope requires regex');
  end if;
end $$;

-- the native phone properties
select meta.update_property('contacts', 'phone', p_options => '{"single_line": true, "display": "phone"}');
select meta.update_property('companies', 'phone', p_options => '{"single_line": true, "display": "phone"}');
select meta.update_property('users', 'phone', p_options => '{"single_line": true, "display": "phone"}');
