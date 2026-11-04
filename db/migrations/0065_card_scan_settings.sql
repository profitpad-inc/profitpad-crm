-- Card scanner settings (api/src/card-scan.ts, Settings → Card scanner).
-- Cards are read on this server with Tesseract unless an admin adds an
-- Anthropic API key and picks Claude. One row; the key is sealed with
-- secret-box.ts (CALENDAR_TOKEN_KEY) and never sent back to the UI, only its
-- last four characters. It lives in auth, not ui.settings, because
-- GET /v1/ui/settings is readable by every signed-in user.

create table auth.card_scan_settings (
  id boolean primary key default true check (id),
  reader text not null default 'tesseract' check (reader in ('tesseract', 'claude')),
  claude_model text not null default 'claude-haiku-5-5' check (claude_model in ('claude-haiku-5-5', 'claude-opus-5-5')),
  anthropic_key bytea,
  key_hint text check (char_length(key_hint) <= 8),
  updated_by text,
  updated_at timestamptz not null default now(),
  check (reader = 'tesseract' or anthropic_key is not null)
);

insert into auth.card_scan_settings (id) values (true);

grant select, insert, update on auth.card_scan_settings to test_crm_api;
