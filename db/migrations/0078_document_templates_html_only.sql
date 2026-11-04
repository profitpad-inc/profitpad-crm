-- Document templates are HTML with Liquid only: React templates were dropped
-- (documents are not interactive, and Liquid shows the customer's page
-- without a browser). The "Written in" (kind) property from 0075 is archived;
-- its column and values stay, nothing reads them any more.

select meta.archive_property('document_templates', 'kind');
