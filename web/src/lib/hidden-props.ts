// Properties shown elsewhere on a record's page (builder, answers, link and
// signing cards) rather than as raw values. The record page leaves them out of
// its property list, and phone cards on tables leave them out too.
export const HIDDEN_PROPS: Record<string, string[]> = {
  forms: ['definition', 'public_key', 'slug'],
  quotes: ['public_key', 'slug', 'signing_fields', 'signed_fields', 'customer_signature', 'countersigner_signature'],
  invoices: ['public_key', 'slug'],
  form_submissions: ['summary', 'submission_values'],
  booking_pages: ['public_key', 'slug', 'availability', 'timezone', 'form_before_id', 'form_after_id', 'duration_minutes', 'duration_options', 'co_hosts', 'co_hosts_unchecked'],
  files: ['public_token', 'storage_key'],
  views: ['icon', 'draft_source', 'draft_queries', 'source', 'queries'],
  email_campaigns: ['audience'],
  // the list page's member columns (pages/ListPage.tsx); its filters show as JSON
  lists: ['member_columns'],
  // the Preview tab (EmailTemplateCard)
  email_templates: ['body'],
  emails: ['reply_token']
};
