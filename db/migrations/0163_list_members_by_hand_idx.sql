-- Faster list refreshes (follow-up to 0159, 2026-11-27). Timed on a copy
-- with a million contacts: an hourly refresh that changed nothing took
-- 9.5 s, now about 2 s. Most of that time was finding the members added by
-- hand, by probing the members once per match (6 s at a million); this
-- index finds those few directly. The rest was comparing the matches with
-- the members by sorting a million ids; the refresh now hashes them
-- (api/src/lists/members.ts, refreshList).

create index if not exists list_members_by_hand_idx on meta.list_members (list_id) where added_by is not null;
