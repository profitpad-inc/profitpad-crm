-- Parent discounts (0104): discount_type and discount_value on deals, quotes
-- and invoices, and the Standard quote template shows Subtotal and Discount.
-- Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_count integer;
begin
  select count(*) into v_count
  from meta.pc_0001 o join meta.pc_0002 p on p.object_type_id = o.object_type_id
  where o.api_name in ('deals', 'quotes', 'invoices') and p.api_name in ('discount_type', 'discount_value') and p.record_status = 'active';
  if v_count <> 6 then
    raise exception 'expected 6 discount properties, found %', v_count;
  end if;

  select count(*) into v_count from crm.pc_0057
  where is_builtin @> '{true}' and object @> '{quotes}' and strpos(source, 'class="subtotals"') > 0 and strpos(source, '.subtotals {') > 0;
  if v_count <> 1 then
    raise exception 'the Standard quote template does not show the discount (% templates changed)', v_count;
  end if;
end $t$;

-- a quote takes a percent discount through the record functions' columns
select set_config('crm.actor', 'system:test', true);
insert into crm.pc_0022 (name, discount_type, discount_value) values ('Discount test', '{percent}', 10);
do $t$
begin
  if not exists (select 1 from crm.pc_0022 where name = 'Discount test' and discount_type = '{percent}' and discount_value = 10) then
    raise exception 'quote discount not stored';
  end if;
end $t$;

rollback;
