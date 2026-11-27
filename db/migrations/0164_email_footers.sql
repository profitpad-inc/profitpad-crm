-- Email footers managed in one place (Settings → Email, Footers). Each is
-- HTML with Liquid ({{ mailing_address }}, {{ unsubscribe_url }} in the
-- marketing one, {{ today }}); null means the CRM's built-in footer
-- (api/src/email/render.ts). The marketing footer ends every campaign email
-- whose template does not place {{ unsubscribe_url }} itself; the
-- transactional one ends tests, notices and other one-to-one email the CRM
-- lays out.

alter table auth.email_settings
  add column marketing_footer text check (char_length(marketing_footer) <= 20000),
  add column transactional_footer text check (char_length(transactional_footer) <= 20000);
