-- Booking pages get an address the user picks (/p/book/#intro-call) next to
-- the random public_key. Lowercase letters, digits and dashes, 3 to 60
-- characters, unique (case-insensitive). The API finds a page by either.

select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'slug', p_label => 'Page address', p_type => 'text',
  p_options => '{"single_line": true, "unique": true, "case_insensitive": true, "regex": "^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$"}',
  p_description => 'The end of the booking link (/p/book/#intro-call). Lowercase letters, digits and dashes.', p_is_native => true);
