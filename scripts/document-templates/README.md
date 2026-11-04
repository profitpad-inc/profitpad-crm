# Document templates

Template sources kept here so they can be installed on a tenant (`POST /v1/document-templates` or the MCP tool `create_document_template`). See `docs/architecture.md` "Document templates" for how templates work.

- `fairbank-quotation.liquid` (kind `html`, page margin `0in`): Fairbank Equipment's Eclipse quotation form, copied from their HubSpot quote template (quotes.fairbankequipment.com). The CSS is theirs, unchanged, plus HubSpot's `.hs-quotes` base rule (its 24px line height sets the box heights). It reads the quote's name (the quote number), `expiration_date` and `amount`, the company's name and address (QUOTE TO), the lines (`quantity`, `uom`, `sku`, `name`, `description`, `unit_price`, `amount`), and these quote properties when they exist (blank otherwise): `customer_number`, `customer_po`, `job_name`, `salesperson_code`, `ship_via`, `terms`, `ship_date` (date), `freight_allowed` (Yes/No dropdown), `shipping_amount` (number), `branch_name`, `branch_address` (multi-line), `ship_to_name`, `ship_to_street`, `ship_to_city`, `quote_notes`. Writer is the user who created the quote. The barcode is drawn by the CRM (no barcodeapi.org) and the logo is fetched by the server. "1 of 1" is fixed text, as on their page.
- `react-example.tsx` (kind `react`): a small React template that uses the `data` prop, a QR code and a SQL data source named `summary`:

```json
{"summary": {"sql": "select count(*)::int as line_count, coalesce(sum(l.amount), 0) as total from view_data.associations a join view_data.lines l on l.pc_0020_id = a.other_record_id where a.object_type_id = 'pc_0022' and a.record_id = :record_id and a.other_object_type_id = 'pc_0020'"}}
```
