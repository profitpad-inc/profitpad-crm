-- An integration can carry an example of the data views send it
-- (callIntegration(key, data)): the contract between the view and the
-- workflow on the other end. Shown to view builders; a call whose data does
-- not match its shape still goes out, with a warning logged in the view's
-- runtime errors. Test sends use it when no data is given.

alter table auth.view_integrations
  add column data_example jsonb check (data_example is null or octet_length(data_example::text) <= 20000);
