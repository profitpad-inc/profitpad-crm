-- Closed stages have a fixed chance of winning: won is always 100%
-- (probability 1), lost is always 0. Settings shows a stage as Open, Closed
-- won or Closed lost; only open stages take a probability.
--
-- meta.set_option_details (from 0035) now fills the probability in when an
-- option becomes closed, refuses a different one for a closed option, and
-- clears it when an option is reopened without a new one. A check keeps
-- the rule for any other write.

update meta.pc_0003 set probability = case when is_won then 1 else 0 end
where is_closed and probability is distinct from case when is_won then 1 else 0 end;

alter table meta.pc_0003
  add constraint pc_0003_closed_probability check (not is_closed or probability = case when is_won then 1 else 0 end);

-- Same function as in 0035, with the closed-stage probability rule.
create or replace function meta.set_option_details(p_object text, p_api_name text, p_api_value text, p_details jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_prop meta.pc_0002 := meta._resolve_property(v_obj.object_type_id, p_api_name);
  v_opt meta.pc_0003;
  v_key text;
  v_parent meta.pc_0002;
  v_values text[];
  v_bad text;
  v_given numeric;
  v_was_closed boolean;
  v_fixed numeric;
begin
  if v_prop.type <> 'dropdown' then
    perform meta._fail(format('"%s" is not a dropdown', p_api_name));
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then
    perform meta._fail('details must be an object');
  end if;
  for v_key in select jsonb_object_keys(p_details) loop
    if v_key not in ('parent_values', 'is_closed', 'is_won', 'probability') then
      perform meta._fail(format('"%s" is not an option detail (allowed: parent_values, is_closed, is_won, probability)', v_key));
    end if;
  end loop;
  select * into v_opt from meta.pc_0003 where property_id = v_prop.pc_0002_id and api_value = p_api_value;
  if not found then
    perform meta._fail(format('unknown option "%s"', p_api_value), 'P0002');
  end if;
  v_was_closed := v_opt.is_closed;

  if p_details ? 'parent_values' then
    if jsonb_typeof(p_details -> 'parent_values') <> 'array' then
      perform meta._fail('parent_values must be an array of option values');
    end if;
    select coalesce(array_agg(distinct e), '{}') into v_values from jsonb_array_elements_text(p_details -> 'parent_values') e;
    if cardinality(v_values) > 0 then
      if not v_prop.options ? 'parent_property' then
        perform meta._fail(format('"%s" has no parent_property; set it with update_property first', p_api_name));
      end if;
      v_parent := meta._resolve_property(v_obj.object_type_id, v_prop.options ->> 'parent_property');
      select string_agg(v, ', ') into v_bad from unnest(v_values) v
      where not exists (select 1 from meta.pc_0003 o where o.property_id = v_parent.pc_0002_id and o.api_value = v);
      if v_bad is not null then
        perform meta._fail(format('%s has no option %s', v_parent.api_name, v_bad));
      end if;
    end if;
    v_opt.parent_values := v_values;
  end if;
  if p_details ? 'is_closed' then
    if jsonb_typeof(p_details -> 'is_closed') <> 'boolean' then perform meta._fail('is_closed must be true or false'); end if;
    v_opt.is_closed := (p_details ->> 'is_closed')::boolean;
  end if;
  if p_details ? 'is_won' then
    if jsonb_typeof(p_details -> 'is_won') <> 'boolean' then perform meta._fail('is_won must be true or false'); end if;
    v_opt.is_won := (p_details ->> 'is_won')::boolean;
    if v_opt.is_won then v_opt.is_closed := true; end if;
  end if;
  if v_opt.is_won and not v_opt.is_closed then
    perform meta._fail('a won option is always closed');
  end if;
  if p_details ? 'probability' then
    if jsonb_typeof(p_details -> 'probability') = 'null' then
      v_given := null;
    elsif jsonb_typeof(p_details -> 'probability') <> 'number' or (p_details ->> 'probability')::numeric not between 0 and 1 then
      perform meta._fail('probability must be a number from 0 to 1');
    else
      v_given := (p_details ->> 'probability')::numeric;
    end if;
  end if;
  if v_opt.is_closed then
    -- won is always 1, lost always 0; a closed option takes no other
    v_fixed := case when v_opt.is_won then 1 else 0 end;
    if p_details ? 'probability' and v_given is not null and v_given <> v_fixed then
      perform meta._fail(case when v_opt.is_won then 'a closed won option always has probability 1 (100%)'
        else 'a closed lost option always has probability 0' end);
    end if;
    v_opt.probability := v_fixed;
  elsif p_details ? 'probability' then
    v_opt.probability := v_given;
  elsif v_was_closed then
    -- reopened without a new probability: the old 100% or 0% no longer applies
    v_opt.probability := null;
  end if;

  update meta.pc_0003 set parent_values = v_opt.parent_values, is_closed = v_opt.is_closed, is_won = v_opt.is_won,
    probability = v_opt.probability, row_updated_at = now()
  where pc_0003_id = v_opt.pc_0003_id;
  perform meta._log_change('set_option_details', v_obj.object_type_id, v_prop.pc_0002_id,
    jsonb_build_object('api_name', v_prop.api_name, 'api_value', p_api_value, 'details', p_details));
end $$;
