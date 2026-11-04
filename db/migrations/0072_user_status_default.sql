-- A user's Status is never empty: Active or Deactivated, new users start
-- Active. default_value (0029) makes the column default and the not-empty rule,
-- and the UI then offers no "None" choice.

update crm.pc_0000 set status = '{active}' where status is null and record_status <> 'deleted';

select meta.update_property('users', 'status', p_options => (select options || '{"default_value": "active"}' from meta.pc_0002 where object_type_id = 'pc_0000' and api_name = 'status'));
