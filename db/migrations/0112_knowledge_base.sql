-- Knowledge base (api/src/knowledge.ts, Settings → Knowledge base, MCP
-- get_knowledge and the knowledge write tools): articles the business writes
-- about itself, such as its ideal customer profile, revenue, sales team,
-- products and pricing, competitors and sales process, so AI agents connected
-- over MCP have that context.
--
-- Each role says what its users may do with it (auth.roles.knowledge_access):
-- none, read, or edit (add, change, delete); someone with several roles gets
-- the most of them, and Super Admins always edit. Existing roles start at
-- read. Articles marked admins_only are seen and changed by admins only. Every
-- saved version is kept in knowledge_revisions with who saved it and from
-- where (ui, mcp, api), so a change an agent made can be seen and undone.

alter table auth.roles add column knowledge_access text not null default 'read'
  check (knowledge_access in ('none', 'read', 'edit'));

create table ui.knowledge_articles (
  id bigserial primary key,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  body text not null default '' check (char_length(body) <= 50000),
  admins_only boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_by text not null,
  updated_via text not null default 'ui' check (updated_via in ('ui', 'mcp', 'api')),
  updated_at timestamptz not null default now()
);
create unique index knowledge_articles_title_key on ui.knowledge_articles (lower(btrim(title)));
grant select, insert, update, delete on ui.knowledge_articles to pc_api;
grant usage on sequence ui.knowledge_articles_id_seq to pc_api;

create table ui.knowledge_revisions (
  id bigserial primary key,
  article_id bigint not null references ui.knowledge_articles (id) on delete cascade,
  title text not null,
  body text not null,
  admins_only boolean not null,
  saved_by text not null,
  saved_via text not null check (saved_via in ('ui', 'mcp', 'api')),
  saved_at timestamptz not null default now()
);
create index knowledge_revisions_article_idx on ui.knowledge_revisions (article_id, id desc);
grant select, insert, delete on ui.knowledge_revisions to pc_api;
grant usage on sequence ui.knowledge_revisions_id_seq to pc_api;
