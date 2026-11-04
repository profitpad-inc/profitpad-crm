-- The CRM's own quote layout becomes a document template, and quotes always
-- have a default (the user's rules, 2026-11-04):
--   - "Standard quote" (scripts/document-templates/standard-quote.liquid) is
--     installed, published, and made the default when no template is. It is
--     marked is_builtin: it can be edited and archived, never deleted or merged
--     away. The old built-in drawing (api/src/pdf/quote.ts) and Settings ->
--     Quote document (ui.settings 'quote_document') are gone.
--   - There is always an active, published default template per object type
--     that has templates: the default can't be archived, deleted, merged away
--     or stop being the default until another template is the default (the
--     API sets the new default before clearing the old one).
-- Refusals use 55006 (409).

-- A dropdown with a default is never empty, so existing templates get "No"
-- before the default (and its not-empty rule) is set. No history rows: this
-- is a backfill, not a change anyone made.
select meta.create_property(
  p_object => 'document_templates', p_api_name => 'is_builtin', p_label => 'Came with the CRM', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => '[{"api_value": "true", "label": "Yes"}, {"api_value": "false", "label": "No"}]',
  p_description => 'Installed with the CRM. It can be edited and archived, but not deleted.', p_is_native => true);
select set_config('crm.skip_history', 'on', true);
update crm.pc_0057 set is_builtin = '{false}' where record_status <> 'deleted' and is_builtin is null;
select set_config('crm.skip_history', '', true);
select meta.update_property('document_templates', 'is_builtin', p_options => '{"single_value": true, "default_value": "false"}');
update meta.pc_0002 set read_only = true where object_type_id = 'pc_0057' and api_name = 'is_builtin';
select meta._log_change('update_property', 'pc_0057', null, '{"read_only": ["is_builtin"]}');

insert into crm.pc_0057 (name, description, object, status, is_default, is_builtin, page_size, orientation, page_margin,
                         draft_source, draft_queries, source, queries, published_at)
values ('Standard quote',
        'The CRM''s own quote layout: parties, line items, the total, and in the PDF the status, signatures and signed fields.',
        '{quotes}', '{published}',
        case when exists (select 1 from crm.pc_0057 where record_status = 'active' and object[1] = 'quotes'
                            and status[1] = 'published' and is_default[1] = 'true') then '{false}' else '{true}' end::text[],
        '{true}', '{letter}', '{portrait}', '0.75in',
        $tpl${%- comment -%}
  Standard quote: the CRM's own quote layout (title and status, parties, the
  line items, the total on a double rule, and in the PDF only the status, a
  status note, signatures and signed fields: the customer's page shows those
  under the document). Installed by migration 0080 as the default quote template; it can
  be edited, archived (once another template is the default) but not deleted.
{%- endcomment -%}
{%- assign t = org.theme -%}
{%- assign c_text = t.text | default: "#0b1220" -%}
{%- assign c_muted = t.muted_text | default: "#475467" -%}
{%- assign c_border = t.border | default: "#cfd6df" -%}
{%- assign c_surface = t.surface | default: "#eef1f5" -%}
{%- assign cur = quote.currency -%}

{%- assign status = quote.status -%}
{%- if status == "sent" and quote.expiration_date and quote.expiration_date < today -%}{%- assign status = "expired" -%}{%- endif -%}
{%- case status -%}
  {%- when "draft" -%}{%- assign status_label = "Draft" -%}
  {%- when "sent" -%}{%- assign status_label = "Open" -%}
  {%- when "pending_countersign" -%}{%- assign status_label = "Awaiting countersignature" -%}
  {%- when "accepted" -%}{%- assign status_label = "Accepted" -%}
  {%- when "rejected" -%}{%- assign status_label = "Declined" -%}
  {%- when "expired" -%}{%- assign status_label = "Expired" -%}
  {%- else -%}{%- assign status_label = quote._text.status -%}
{%- endcase -%}

{%- assign total = quote.amount -%}
{%- if total == nil and lines.size > 0 -%}
  {%- assign total = 0 -%}
  {%- for l in lines -%}{%- assign total = total | plus: l.amount -%}{%- endfor -%}
{%- endif -%}
{%- assign has_discount = false -%}
{%- for l in lines -%}{%- if l.discount and l.discount != 0 -%}{%- assign has_discount = true -%}{%- endif -%}{%- endfor -%}
{%- assign signing = quote.signing_fields | parse_json -%}
{%- assign signed = quote.signed_fields | parse_json -%}
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{{ quote.name | default: "Quote" }}</title>
<style>
  @font-face { font-family: "Inter"; font-weight: 400; src: url("https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/inter-latin-400-normal.woff2") format("woff2"); }
  @font-face { font-family: "Inter"; font-weight: 500; src: url("https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/inter-latin-500-normal.woff2") format("woff2"); }
  @font-face { font-family: "Inter"; font-weight: 600; src: url("https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/inter-latin-600-normal.woff2") format("woff2"); }
  @font-face { font-family: "Montserrat"; font-weight: 700; src: url("https://cdn.jsdelivr.net/npm/@fontsource/montserrat@5.3.0/files/montserrat-latin-700-normal.woff2") format("woff2"); }
  :root { --text: {{ c_text }}; --muted: {{ c_muted }}; --border: {{ c_border }}; --surface: {{ c_surface }}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; }
  body { font-family: "Inter", Helvetica, Arial, sans-serif; font-size: 10pt; line-height: 1.4; color: var(--text); padding: 0.35in 0.4in; }
  @media print { body { padding: 0; } }
  /* the customer's page shows status, signatures and answers under the document */
  @media screen { .print-only { display: none !important; } }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  h1 { font-family: "Montserrat", Helvetica, Arial, sans-serif; font-weight: 700; font-size: 21pt; line-height: 1.15; margin: 0; overflow-wrap: anywhere; }
  .pill { flex: none; margin-top: 3px; padding: 2px 9px; border-radius: 999px; border: 0.75pt solid var(--border); background: var(--surface); font-size: 8.5pt; font-weight: 600; white-space: nowrap; }
  .pill.accepted { background: #ecfdf3; border-color: #abefc6; color: #05603a; }
  .pill.rejected, .pill.expired { background: #fef3f2; border-color: #fecdca; color: #912018; }
  .pill.pending_countersign { background: #fffaeb; border-color: #fedf89; color: #93370d; }
  .parties { display: flex; flex-wrap: wrap; gap: 10px 32px; margin-top: 18px; padding-top: 13px; border-top: 0.75pt solid var(--border); }
  .label { font-size: 8.5pt; color: var(--muted); }
  .value { font-weight: 500; }
  .sub { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; margin-top: 26px; }
  thead { display: table-header-group; }
  th { font-size: 8.5pt; font-weight: 500; color: var(--muted); text-align: left; vertical-align: bottom; padding: 0 7px 3px; border-bottom: 0.75pt solid var(--text); }
  td { vertical-align: top; padding: 10px 7px; border-bottom: 0.75pt solid var(--border); }
  th:first-child, td:first-child { padding-left: 0; }
  th:last-child, td:last-child { padding-right: 0; }
  tr { break-inside: avoid; }
  .num { text-align: right; white-space: nowrap; }
  .item-name { font-weight: 500; }
  .sku { font-size: 8.5pt; color: var(--muted); margin-top: 2px; }
  .amount { font-weight: 600; }
  .total { display: flex; justify-content: flex-end; margin-top: 14px; break-inside: avoid; }
  .total-box { display: flex; align-items: baseline; gap: 32px; padding: 0 0 4px 16px; border-bottom: 3.3pt double var(--text); }
  .total-label { font-weight: 500; color: var(--muted); }
  .total-amount { font-family: "Montserrat", Helvetica, Arial, sans-serif; font-weight: 700; font-size: 20pt; line-height: 1.1; }
  .note { margin-top: 20px; padding: 10px 14px; border-radius: 5px; border-left: 2.25pt solid var(--border); background: var(--surface); break-inside: avoid; }
  .note.good { background: #ecfdf3; border-left-color: #17b26a; color: #05603a; }
  .note.wait { background: #fffaeb; border-left-color: #f79009; color: #93370d; }
  .note.bad { background: #fef3f2; border-left-color: #f04438; color: #912018; }
  .note .why { color: var(--muted); margin-top: 3px; }
  .signatures { display: flex; flex-wrap: wrap; gap: 32px; margin-top: 26px; break-inside: avoid; }
  .signature { width: 214px; }
  .sig-line { position: relative; height: 62px; border-bottom: 0.75pt solid var(--text); margin-top: 4px; }
  .sig-line::before { content: "\00d7"; position: absolute; left: 0; bottom: 1px; font-size: 12pt; color: var(--muted); }
  .sig-line img { position: absolute; left: 15px; bottom: 0; max-width: 174px; max-height: 58px; }
  .sig-who { font-weight: 600; margin-top: 6px; }
  .signed-fields { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin-top: 14px; }
  .signed-fields dt { color: var(--muted); }
  .signed-fields dd { margin: 0; }
</style>
</head>
<body>
  <div class="head">
    <h1>{{ quote.name | default: "Quote" }}</h1>
    <span class="pill print-only {{ status }}">{{ status_label }}</span>
  </div>

  {%- capture parties -%}
    {%- if company and company.name -%}
      <div><div class="label">Prepared for</div><div class="value">{{ company.name }}</div></div>
    {%- endif -%}
    {%- if contact -%}
      {%- if contact.name -%}
        <div><div class="label">Attention</div><div class="value">{{ contact.name }}</div>{% if contact.email %}<div class="sub">{{ contact.email }}</div>{% endif %}</div>
      {%- elsif contact.email -%}
        <div><div class="label">Attention</div><div class="value">{{ contact.email }}</div></div>
      {%- endif -%}
    {%- endif -%}
    {%- if quote.expiration_date -%}
      <div><div class="label">Valid until</div><div class="value">{{ quote.expiration_date | date: "%B %-d, %Y" }}</div></div>
    {%- endif -%}
  {%- endcapture -%}
  {%- if parties != "" %}
  <div class="parties">{{ parties | raw }}</div>
  {%- endif %}

  {%- if lines.size > 0 %}
  <table>
    <thead>
      <tr>
        <th style="width: {% if has_discount %}40{% else %}55{% endif %}%">Item</th>
        <th class="num" style="width: 10%">Qty</th>
        <th class="num" style="width: 17%">Unit price</th>
        {%- if has_discount %}<th class="num" style="width: 15%">Discount</th>{% endif %}
        <th class="num" style="width: 18%">Amount</th>
      </tr>
    </thead>
    <tbody>
      {%- for l in lines %}
      <tr>
        <td><div class="item-name">{{ l.name }}</div>{% if l.sku %}<div class="sku">SKU {{ l.sku }}</div>{% endif %}</td>
        <td class="num">{{ l.quantity | number }}</td>
        <td class="num">{{ l.unit_price | money: cur }}</td>
        {%- if has_discount %}<td class="num">{% if l.discount and l.discount != 0 %}{{ l.discount | money: cur }}{% endif %}</td>{% endif %}
        <td class="num amount">{{ l.amount | money: cur }}</td>
      </tr>
      {%- endfor %}
    </tbody>
  </table>
  {%- endif %}

  <div class="total">
    <div class="total-box">
      <span class="total-label">Total</span>
      <span class="total-amount">{% if total == nil %}n/a{% else %}{{ total | money: cur }}{% endif %}</span>
    </div>
  </div>

  {%- if status == "accepted" or status == "rejected" %}
  <div class="note print-only {% if status == "accepted" %}good{% else %}bad{% endif %}">
    {% if status == "accepted" %}Accepted{% else %}Declined{% endif %} by {{ quote.responder_name | default: "the customer" }}{% if quote.responded_at %} on {{ quote.responded_at | date: "%B %-d, %Y" }}{% endif %}.
    {%- if status == "rejected" and quote.decline_reason %}<div class="why">Reason: {{ quote.decline_reason }}</div>{% endif %}
  </div>
  {%- elsif status == "pending_countersign" %}
  <div class="note print-only wait">Signed by {{ quote.responder_name | default: "the customer" }}{% if quote.customer_signed_at %} on {{ quote.customer_signed_at | date: "%Y-%m-%d %H:%M:%S UTC" }}{% endif %}. We will countersign and confirm shortly.</div>
  {%- elsif status == "expired" %}
  <div class="note print-only">This quote has expired. Contact us if you would like an updated one.</div>
  {%- endif %}

  {%- if quote.customer_signature or quote.countersigner_signature %}
  <div class="signatures print-only">
    {%- if quote.customer_signature %}
    <div class="signature">
      <div class="label">Customer signature</div>
      <div class="sig-line"><img src="{{ quote.customer_signature }}" alt="Customer signature"></div>
      {% if quote.responder_name %}<div class="sig-who">{{ quote.responder_name }}</div>{% endif %}
      {% if quote.customer_signed_at %}<div class="label">Signed {{ quote.customer_signed_at | date: "%Y-%m-%d %H:%M:%S UTC" }}</div>{% endif %}
    </div>
    {%- endif %}
    {%- if quote.countersigner_signature %}
    <div class="signature">
      <div class="label">Countersignature</div>
      <div class="sig-line"><img src="{{ quote.countersigner_signature }}" alt="Countersignature"></div>
      {% if quote.countersigner_name %}<div class="sig-who">{{ quote.countersigner_name }}</div>{% endif %}
      {% if quote.countersigned_at %}<div class="label">Signed {{ quote.countersigned_at | date: "%Y-%m-%d %H:%M:%S UTC" }}</div>{% endif %}
    </div>
    {%- endif %}
  </div>
  {%- endif %}

  {%- if quote.customer_signature and signing and signed %}
  {%- capture answered -%}
    {%- for f in signing -%}{%- assign v = signed[f.key] -%}{%- if v and v != "" -%}<dt>{{ f.label }}</dt><dd>{{ v }}</dd>{%- endif -%}{%- endfor -%}
  {%- endcapture -%}
  {%- if answered != "" %}
  <dl class="signed-fields print-only">{{ answered | raw }}</dl>
  {%- endif %}
  {%- endif %}
</body>
</html>
$tpl$, null, $tpl${%- comment -%}
  Standard quote: the CRM's own quote layout (title and status, parties, the
  line items, the total on a double rule, and in the PDF only the status, a
  status note, signatures and signed fields: the customer's page shows those
  under the document). Installed by migration 0080 as the default quote template; it can
  be edited, archived (once another template is the default) but not deleted.
{%- endcomment -%}
{%- assign t = org.theme -%}
{%- assign c_text = t.text | default: "#0b1220" -%}
{%- assign c_muted = t.muted_text | default: "#475467" -%}
{%- assign c_border = t.border | default: "#cfd6df" -%}
{%- assign c_surface = t.surface | default: "#eef1f5" -%}
{%- assign cur = quote.currency -%}

{%- assign status = quote.status -%}
{%- if status == "sent" and quote.expiration_date and quote.expiration_date < today -%}{%- assign status = "expired" -%}{%- endif -%}
{%- case status -%}
  {%- when "draft" -%}{%- assign status_label = "Draft" -%}
  {%- when "sent" -%}{%- assign status_label = "Open" -%}
  {%- when "pending_countersign" -%}{%- assign status_label = "Awaiting countersignature" -%}
  {%- when "accepted" -%}{%- assign status_label = "Accepted" -%}
  {%- when "rejected" -%}{%- assign status_label = "Declined" -%}
  {%- when "expired" -%}{%- assign status_label = "Expired" -%}
  {%- else -%}{%- assign status_label = quote._text.status -%}
{%- endcase -%}

{%- assign total = quote.amount -%}
{%- if total == nil and lines.size > 0 -%}
  {%- assign total = 0 -%}
  {%- for l in lines -%}{%- assign total = total | plus: l.amount -%}{%- endfor -%}
{%- endif -%}
{%- assign has_discount = false -%}
{%- for l in lines -%}{%- if l.discount and l.discount != 0 -%}{%- assign has_discount = true -%}{%- endif -%}{%- endfor -%}
{%- assign signing = quote.signing_fields | parse_json -%}
{%- assign signed = quote.signed_fields | parse_json -%}
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{{ quote.name | default: "Quote" }}</title>
<style>
  @font-face { font-family: "Inter"; font-weight: 400; src: url("https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/inter-latin-400-normal.woff2") format("woff2"); }
  @font-face { font-family: "Inter"; font-weight: 500; src: url("https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/inter-latin-500-normal.woff2") format("woff2"); }
  @font-face { font-family: "Inter"; font-weight: 600; src: url("https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/inter-latin-600-normal.woff2") format("woff2"); }
  @font-face { font-family: "Montserrat"; font-weight: 700; src: url("https://cdn.jsdelivr.net/npm/@fontsource/montserrat@5.3.0/files/montserrat-latin-700-normal.woff2") format("woff2"); }
  :root { --text: {{ c_text }}; --muted: {{ c_muted }}; --border: {{ c_border }}; --surface: {{ c_surface }}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; }
  body { font-family: "Inter", Helvetica, Arial, sans-serif; font-size: 10pt; line-height: 1.4; color: var(--text); padding: 0.35in 0.4in; }
  @media print { body { padding: 0; } }
  /* the customer's page shows status, signatures and answers under the document */
  @media screen { .print-only { display: none !important; } }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  h1 { font-family: "Montserrat", Helvetica, Arial, sans-serif; font-weight: 700; font-size: 21pt; line-height: 1.15; margin: 0; overflow-wrap: anywhere; }
  .pill { flex: none; margin-top: 3px; padding: 2px 9px; border-radius: 999px; border: 0.75pt solid var(--border); background: var(--surface); font-size: 8.5pt; font-weight: 600; white-space: nowrap; }
  .pill.accepted { background: #ecfdf3; border-color: #abefc6; color: #05603a; }
  .pill.rejected, .pill.expired { background: #fef3f2; border-color: #fecdca; color: #912018; }
  .pill.pending_countersign { background: #fffaeb; border-color: #fedf89; color: #93370d; }
  .parties { display: flex; flex-wrap: wrap; gap: 10px 32px; margin-top: 18px; padding-top: 13px; border-top: 0.75pt solid var(--border); }
  .label { font-size: 8.5pt; color: var(--muted); }
  .value { font-weight: 500; }
  .sub { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; margin-top: 26px; }
  thead { display: table-header-group; }
  th { font-size: 8.5pt; font-weight: 500; color: var(--muted); text-align: left; vertical-align: bottom; padding: 0 7px 3px; border-bottom: 0.75pt solid var(--text); }
  td { vertical-align: top; padding: 10px 7px; border-bottom: 0.75pt solid var(--border); }
  th:first-child, td:first-child { padding-left: 0; }
  th:last-child, td:last-child { padding-right: 0; }
  tr { break-inside: avoid; }
  .num { text-align: right; white-space: nowrap; }
  .item-name { font-weight: 500; }
  .sku { font-size: 8.5pt; color: var(--muted); margin-top: 2px; }
  .amount { font-weight: 600; }
  .total { display: flex; justify-content: flex-end; margin-top: 14px; break-inside: avoid; }
  .total-box { display: flex; align-items: baseline; gap: 32px; padding: 0 0 4px 16px; border-bottom: 3.3pt double var(--text); }
  .total-label { font-weight: 500; color: var(--muted); }
  .total-amount { font-family: "Montserrat", Helvetica, Arial, sans-serif; font-weight: 700; font-size: 20pt; line-height: 1.1; }
  .note { margin-top: 20px; padding: 10px 14px; border-radius: 5px; border-left: 2.25pt solid var(--border); background: var(--surface); break-inside: avoid; }
  .note.good { background: #ecfdf3; border-left-color: #17b26a; color: #05603a; }
  .note.wait { background: #fffaeb; border-left-color: #f79009; color: #93370d; }
  .note.bad { background: #fef3f2; border-left-color: #f04438; color: #912018; }
  .note .why { color: var(--muted); margin-top: 3px; }
  .signatures { display: flex; flex-wrap: wrap; gap: 32px; margin-top: 26px; break-inside: avoid; }
  .signature { width: 214px; }
  .sig-line { position: relative; height: 62px; border-bottom: 0.75pt solid var(--text); margin-top: 4px; }
  .sig-line::before { content: "\00d7"; position: absolute; left: 0; bottom: 1px; font-size: 12pt; color: var(--muted); }
  .sig-line img { position: absolute; left: 15px; bottom: 0; max-width: 174px; max-height: 58px; }
  .sig-who { font-weight: 600; margin-top: 6px; }
  .signed-fields { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin-top: 14px; }
  .signed-fields dt { color: var(--muted); }
  .signed-fields dd { margin: 0; }
</style>
</head>
<body>
  <div class="head">
    <h1>{{ quote.name | default: "Quote" }}</h1>
    <span class="pill print-only {{ status }}">{{ status_label }}</span>
  </div>

  {%- capture parties -%}
    {%- if company and company.name -%}
      <div><div class="label">Prepared for</div><div class="value">{{ company.name }}</div></div>
    {%- endif -%}
    {%- if contact -%}
      {%- if contact.name -%}
        <div><div class="label">Attention</div><div class="value">{{ contact.name }}</div>{% if contact.email %}<div class="sub">{{ contact.email }}</div>{% endif %}</div>
      {%- elsif contact.email -%}
        <div><div class="label">Attention</div><div class="value">{{ contact.email }}</div></div>
      {%- endif -%}
    {%- endif -%}
    {%- if quote.expiration_date -%}
      <div><div class="label">Valid until</div><div class="value">{{ quote.expiration_date | date: "%B %-d, %Y" }}</div></div>
    {%- endif -%}
  {%- endcapture -%}
  {%- if parties != "" %}
  <div class="parties">{{ parties | raw }}</div>
  {%- endif %}

  {%- if lines.size > 0 %}
  <table>
    <thead>
      <tr>
        <th style="width: {% if has_discount %}40{% else %}55{% endif %}%">Item</th>
        <th class="num" style="width: 10%">Qty</th>
        <th class="num" style="width: 17%">Unit price</th>
        {%- if has_discount %}<th class="num" style="width: 15%">Discount</th>{% endif %}
        <th class="num" style="width: 18%">Amount</th>
      </tr>
    </thead>
    <tbody>
      {%- for l in lines %}
      <tr>
        <td><div class="item-name">{{ l.name }}</div>{% if l.sku %}<div class="sku">SKU {{ l.sku }}</div>{% endif %}</td>
        <td class="num">{{ l.quantity | number }}</td>
        <td class="num">{{ l.unit_price | money: cur }}</td>
        {%- if has_discount %}<td class="num">{% if l.discount and l.discount != 0 %}{{ l.discount | money: cur }}{% endif %}</td>{% endif %}
        <td class="num amount">{{ l.amount | money: cur }}</td>
      </tr>
      {%- endfor %}
    </tbody>
  </table>
  {%- endif %}

  <div class="total">
    <div class="total-box">
      <span class="total-label">Total</span>
      <span class="total-amount">{% if total == nil %}n/a{% else %}{{ total | money: cur }}{% endif %}</span>
    </div>
  </div>

  {%- if status == "accepted" or status == "rejected" %}
  <div class="note print-only {% if status == "accepted" %}good{% else %}bad{% endif %}">
    {% if status == "accepted" %}Accepted{% else %}Declined{% endif %} by {{ quote.responder_name | default: "the customer" }}{% if quote.responded_at %} on {{ quote.responded_at | date: "%B %-d, %Y" }}{% endif %}.
    {%- if status == "rejected" and quote.decline_reason %}<div class="why">Reason: {{ quote.decline_reason }}</div>{% endif %}
  </div>
  {%- elsif status == "pending_countersign" %}
  <div class="note print-only wait">Signed by {{ quote.responder_name | default: "the customer" }}{% if quote.customer_signed_at %} on {{ quote.customer_signed_at | date: "%Y-%m-%d %H:%M:%S UTC" }}{% endif %}. We will countersign and confirm shortly.</div>
  {%- elsif status == "expired" %}
  <div class="note print-only">This quote has expired. Contact us if you would like an updated one.</div>
  {%- endif %}

  {%- if quote.customer_signature or quote.countersigner_signature %}
  <div class="signatures print-only">
    {%- if quote.customer_signature %}
    <div class="signature">
      <div class="label">Customer signature</div>
      <div class="sig-line"><img src="{{ quote.customer_signature }}" alt="Customer signature"></div>
      {% if quote.responder_name %}<div class="sig-who">{{ quote.responder_name }}</div>{% endif %}
      {% if quote.customer_signed_at %}<div class="label">Signed {{ quote.customer_signed_at | date: "%Y-%m-%d %H:%M:%S UTC" }}</div>{% endif %}
    </div>
    {%- endif %}
    {%- if quote.countersigner_signature %}
    <div class="signature">
      <div class="label">Countersignature</div>
      <div class="sig-line"><img src="{{ quote.countersigner_signature }}" alt="Countersignature"></div>
      {% if quote.countersigner_name %}<div class="sig-who">{{ quote.countersigner_name }}</div>{% endif %}
      {% if quote.countersigned_at %}<div class="label">Signed {{ quote.countersigned_at | date: "%Y-%m-%d %H:%M:%S UTC" }}</div>{% endif %}
    </div>
    {%- endif %}
  </div>
  {%- endif %}

  {%- if quote.customer_signature and signing and signed %}
  {%- capture answered -%}
    {%- for f in signing -%}{%- assign v = signed[f.key] -%}{%- if v and v != "" -%}<dt>{{ f.label }}</dt><dd>{{ v }}</dd>{%- endif -%}{%- endfor -%}
  {%- endcapture -%}
  {%- if answered != "" %}
  <dl class="signed-fields print-only">{{ answered | raw }}</dl>
  {%- endif %}
  {%- endif %}
</body>
</html>
$tpl$, null, now());

-- ---- the guard ---------------------------------------------------------------------

create or replace function meta.tg_document_template_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if old.record_status = 'deleted' then
    return new;
  end if;
  if old.is_builtin[1] = 'true' then
    if new.record_status in ('deleted', 'merged') then
      perform meta._fail(format('"%s" came with the CRM and cannot be deleted; archive it instead', coalesce(old.name, old.pc_0057_id)), '55006');
    end if;
  end if;
  if new.record_status <> 'deleted' and new.is_builtin is distinct from old.is_builtin then
    perform meta._fail('"Came with the CRM" cannot be changed', '55006');
  end if;
  -- the default stays active, published and the default until another one is
  if old.record_status = 'active' and old.status[1] = 'published' and old.is_default[1] = 'true'
     and (new.record_status <> 'active' or new.status[1] is distinct from 'published' or new.is_default[1] is distinct from 'true')
     and not exists (select 1 from crm.pc_0057 t
                     where t.pc_0057_id <> old.pc_0057_id and t.record_status = 'active' and t.object[1] = old.object[1]
                       and t.status[1] = 'published' and t.is_default[1] = 'true') then
    perform meta._fail(format('"%s" is the default template for %s, and there must always be one: make another template the default first',
      coalesce(old.name, old.pc_0057_id), old.object[1]), '55006');
  end if;
  return new;
end $$;

create trigger template_guard before update on crm.pc_0057
for each row execute function meta.tg_document_template_guard();
