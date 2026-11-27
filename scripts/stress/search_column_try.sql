-- Experiment: stored search text column + trigram index. Undo: search_column_undo.sql
alter table crm.pc_0010 add column stress_search text generated always as
  (public.stress_contact_search_text(name, first_name, last_name, email, phone)) stored;
create index stress_search_col_trgm on crm.pc_0010 using gin (stress_search gin_trgm_ops);
analyze crm.pc_0010;
