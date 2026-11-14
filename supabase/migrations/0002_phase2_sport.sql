-- Daily Briefing: Phase 2 (Welsh sport + Formula 1)
-- Run once in the Supabase SQL editor, after 0001.

-- Sport sections can fetch the full match report before summarising.
alter table sections add column if not exists deep_summary boolean not null default false;

-- New source kind for the F1 results API.
alter table sources drop constraint if exists sources_kind_check;
alter table sources add constraint sources_kind_check check (kind in ('rss','youtube','f1'));

-- One row per Grand Prix: everything the app needs to draw the race.
create table if not exists f1_races (
  id           text primary key,            -- e.g. '2026-21'
  item_id      uuid references items(id) on delete set null,
  season       int  not null,
  round        int  not null,
  race_name    text not null,
  race_date    date not null,
  results      jsonb not null,              -- finishing order, grid, status, team
  lap_positions jsonb not null,             -- { "VER": [1,1,2,...], ... }
  pit_stops    jsonb,                       -- { "VER": [18, 41], ... }
  story        text,                        -- AI race summary
  created_at   timestamptz not null default now()
);
alter table f1_races enable row level security;
drop policy if exists "read" on f1_races;
create policy "read" on f1_races for select to authenticated using (true);

-- Sections
insert into sections (id, title, sort_order, ai_rule, deep_summary, max_items) values
('welsh_sport', 'Welsh rugby & football', 8,
 'Only results and match reports for these teams: Wales (rugby and football), Cardiff Rugby, Ospreys, Scarlets, Dragons, Cardiff City, Swansea City, Wrexham. One item per match. Headline gives the score. Skip previews, transfer gossip and opinion pieces unless there is no match news.',
 true, 6),
('f1', 'Formula 1', 9,
 'Race results with a short race story.', false, 1)
on conflict (id) do nothing;

-- Sources (verified on the first run; failures show on the Sources page)
insert into sources (section_id, name, kind, url) values
('welsh_sport', 'BBC Sport Welsh rugby',   'rss', 'https://feeds.bbci.co.uk/sport/rugby-union/welsh/rss.xml'),
('welsh_sport', 'BBC Sport Welsh football','rss', 'https://feeds.bbci.co.uk/sport/football/welsh/rss.xml'),
('welsh_sport', 'BBC Sport Cardiff City',  'rss', 'https://feeds.bbci.co.uk/sport/football/teams/cardiff-city/rss.xml'),
('welsh_sport', 'BBC Sport Swansea City',  'rss', 'https://feeds.bbci.co.uk/sport/football/teams/swansea-city/rss.xml'),
('welsh_sport', 'BBC Sport Wrexham',       'rss', 'https://feeds.bbci.co.uk/sport/football/teams/wrexham/rss.xml'),
('f1',          'F1 results (Jolpica)',    'f1',  'https://api.jolpi.ca/ergast/f1');

-- Fix from the Phase 1 test: the Microsoft AI Blog feed no longer exists.
update sources set name = 'Official Microsoft Blog', url = 'https://blogs.microsoft.com/feed/', last_error = null
where name = 'Microsoft AI Blog';
