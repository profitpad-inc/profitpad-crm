// A user's own mailbox addresses: the Google and Microsoft addresses they sign
// in with, plus any a Super Admin linked for them (auth.linked_mailboxes,
// Settings → Users). Never the editable Email property of the user record, so
// whoever can edit users cannot point someone's mailbox at another address.
// Each address is reached through the organization's service account for its
// domain (providerFor), if there is one. Columns: user_id, email (lower case).
export const USER_MAILBOXES_SQL = `(
  select user_id, lower(email) as email from auth.identities where provider in ('google', 'microsoft') and email is not null
  union
  select user_id, email from auth.linked_mailboxes
)`;
