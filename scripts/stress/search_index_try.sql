-- Experiment: one trigram-indexed search text per contact. Undo: search_index_undo.sql
create or replace function public.stress_contact_search_text(n text, f text, l text, em jsonb, ph jsonb)
returns text language sql immutable parallel safe as $$
  select concat_ws(chr(31), n, f, l, concat_ws(' ', f, l),
    (select string_agg(e ->> 'value', chr(31)) from jsonb_array_elements(case jsonb_typeof(em) when 'array' then em else '[]' end) e),
    (select string_agg((e ->> 'value') || chr(31) || regexp_replace(e ->> 'value', '[^0-9]', '', 'g'), chr(31))
       from jsonb_array_elements(case jsonb_typeof(ph) when 'array' then ph else '[]' end) e))
$$;
create index concurrently if not exists stress_contact_search_trgm on crm.pc_0010
  using gin (public.stress_contact_search_text(name, first_name, last_name, email, phone) gin_trgm_ops);
