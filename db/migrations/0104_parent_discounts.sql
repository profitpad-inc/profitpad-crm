-- A discount on a whole deal, quote or invoice (the defense package's quote
-- builder, like Matt's app): discount_type (none, percent, amount) and
-- discount_value. Line items keep their own per-line discount; this one comes
-- off the lines' total, and the record's amount is that total less it (the
-- web app's line items editor and "update the amount" offers do the sum, as
-- they already did for the plain total). A deal's discount is copied to a
-- quote or invoice made from it, with its lines.
--
-- Installs that already have the properties (the defense CRM got them by hand
-- on 2026-11-22) are left alone.
--
-- The Standard quote template (0080) shows Subtotal and Discount above the
-- total when a discount applies. Only a template that still has the original
-- total block is changed, so an edited template is never touched.

select set_config('crm.actor', 'system:migration', true);

do $$
declare
  v_object text;
begin
  foreach v_object in array array['deals', 'quotes', 'invoices'] loop
    if not exists (
      select 1 from meta.pc_0001 o join meta.pc_0002 p on p.object_type_id = o.object_type_id
      where o.api_name = v_object and p.api_name = 'discount_type'
    ) then
      perform meta.create_property(
        p_object => v_object, p_api_name => 'discount_type', p_label => 'Discount type',
        p_type => 'dropdown', p_options => '{"single_value": true}',
        p_description => 'A discount on the whole record, taken off the line items'' total: a percent or a fixed amount (Discount value).',
        p_dropdown_options => '[{"api_value": "none", "label": "None"}, {"api_value": "percent", "label": "Percent"}, {"api_value": "amount", "label": "Fixed amount"}]',
        p_is_native => true);
    end if;
    if not exists (
      select 1 from meta.pc_0001 o join meta.pc_0002 p on p.object_type_id = o.object_type_id
      where o.api_name = v_object and p.api_name = 'discount_value'
    ) then
      perform meta.create_property(
        p_object => v_object, p_api_name => 'discount_value', p_label => 'Discount value',
        p_type => 'number', p_options => '{"min": 0}',
        p_description => 'Percent (0 to 100) or amount, depending on Discount type.',
        p_is_native => true);
    end if;
  end loop;
end $$;

-- The Standard quote template: Subtotal and Discount rows above the total.
do $$
declare
  v_old_block text := E'  <div class="total">\n    <div class="total-box">\n      <span class="total-label">Total</span>';
  v_new_block text := E'  {%- assign sub = 0 -%}\n'
    || E'  {%- for l in lines -%}{%- assign sub = sub | plus: l.amount -%}{%- endfor -%}\n'
    || E'  {%- assign disc = 0 -%}\n'
    || E'  {%- if quote.discount_value and quote.discount_value != 0 -%}\n'
    || E'    {%- if quote.discount_type == "percent" -%}{%- assign disc = sub | times: quote.discount_value | divided_by: 100.0 | round: 2 -%}\n'
    || E'    {%- elsif quote.discount_type == "amount" -%}{%- assign disc = quote.discount_value -%}{%- endif -%}\n'
    || E'  {%- endif %}\n'
    || E'  {%- if disc != 0 and lines.size > 0 %}\n'
    || E'  <div class="subtotals">\n'
    || E'    <div><span class="total-label">Subtotal</span><span>{{ sub | money: cur }}</span></div>\n'
    || E'    <div><span class="total-label">Discount{% if quote.discount_type == "percent" %} ({{ quote.discount_value | number }}%){% endif %}</span><span>-{{ disc | money: cur }}</span></div>\n'
    || E'  </div>\n'
    || E'  {%- endif %}\n\n'
    || E'  <div class="total">\n    <div class="total-box">\n      <span class="total-label">Total</span>';
  v_old_css text := E'  .total { display: flex; justify-content: flex-end; margin-top: 14px; break-inside: avoid; }';
  v_new_css text := E'  .subtotals { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; margin-top: 14px; break-inside: avoid; }\n'
    || E'  .subtotals div { display: flex; justify-content: space-between; gap: 32px; min-width: 240px; }\n'
    || E'  .total { display: flex; justify-content: flex-end; margin-top: 14px; break-inside: avoid; }';
begin
  update crm.pc_0057
  set source = replace(replace(source, v_old_block, v_new_block), v_old_css, v_new_css)
  where is_builtin @> '{true}' and object @> '{quotes}'
    and strpos(source, v_old_block) > 0 and strpos(source, v_old_css) > 0
    and strpos(source, 'class="subtotals"') = 0;
  update crm.pc_0057
  set draft_source = replace(replace(draft_source, v_old_block, v_new_block), v_old_css, v_new_css)
  where is_builtin @> '{true}' and object @> '{quotes}'
    and strpos(draft_source, v_old_block) > 0 and strpos(draft_source, v_old_css) > 0
    and strpos(draft_source, 'class="subtotals"') = 0;
end $$;
