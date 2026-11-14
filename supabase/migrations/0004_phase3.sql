-- Daily Briefing: Phase 3 (settings, films & TV, notable deaths, YouTube discovery)
-- Run once in the Supabase SQL editor, after 0001-0003.

-- New source kinds
alter table sources drop constraint if exists sources_kind_check;
alter table sources add constraint sources_kind_check
  check (kind in ('rss','youtube','f1','youtube_topic','tmdb'));

-- Let the app delete items' parents cleanly when a source is removed
-- (items already cascade from sources; briefing_items cascade from items).

-- ---------------------------------------------------------------------------
-- Films and TV you've scored (or marked not interested / want to watch)
-- ---------------------------------------------------------------------------
create table if not exists titles (
  id           uuid primary key default gen_random_uuid(),
  query        text not null,                 -- what was typed in the app
  query_year   int,
  media_type   text not null check (media_type in ('movie','tv')),
  score        int check (score between 1 and 10),
  status       text not null default 'rated'
               check (status in ('rated','not_interested','watchlist')),
  tmdb_id      int,                            -- filled in by the job
  title        text,
  year         int,
  poster_path  text,
  match_error  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists titles_tmdb on titles (media_type, tmdb_id) where tmdb_id is not null;

-- Weekly picks
create table if not exists recommendations (
  id            uuid primary key default gen_random_uuid(),
  batch_at      timestamptz not null default now(),
  media_type    text not null,
  tmdb_id       int not null,
  title         text not null,
  year          int,
  poster_path   text,
  reason        text not null,
  where_to_watch text,
  status        text not null default 'new'
                check (status in ('new','seen','not_interested','watchlist')),
  item_id       uuid references items(id) on delete set null
);

alter table titles          enable row level security;
alter table recommendations enable row level security;
drop policy if exists "all"  on titles;
drop policy if exists "read" on recommendations;
drop policy if exists "mark" on recommendations;
create policy "all"  on titles          for all    to authenticated using (true) with check (true);
create policy "read" on recommendations for select to authenticated using (true);
create policy "mark" on recommendations for update to authenticated using (true);

-- Settings page needs to add/remove briefing times and edit sections/sources:
-- sections and sources already allow everything for the signed-in user.

-- ---------------------------------------------------------------------------
-- New sections
-- ---------------------------------------------------------------------------
insert into sections (id, title, sort_order, ai_rule, deep_summary, max_items) values
('youtube_discover', 'Worth a watch', 11,
 'Pick the best new videos on these topics: genuinely useful or high-quality, from credible creators. Avoid clickbait, Shorts, reaction videos and reuploads. One line on why each is worth watching.',
 false, 3),
('notable_deaths', 'Notable deaths', 12,
 'Only deaths of people Leigh would care about: actors, directors, writers and crew connected to the films, TV and YouTube channels listed below, or to closely similar sci-fi, action and crime films and shows; plus major Welsh figures and sporting greats in rugby, football, F1 and golf. Skip everyone else. If nobody qualifies, return no items.',
 false, 3),
('films_tv', 'Films & TV picks', 13,
 'Weekly recommendations.', false, 5)
on conflict (id) do nothing;

insert into sources (section_id, name, kind, url) values
('youtube_discover', 'Claude Code',                     'youtube_topic', null),
('youtube_discover', 'Journalling and notebooks (e.g. Paper Republic refills)', 'youtube_topic', null),
('notable_deaths',   'BBC Entertainment & Arts',        'rss', 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml'),
('notable_deaths',   'BBC News UK (deaths)',            'rss', 'https://feeds.bbci.co.uk/news/rss.xml'),
('films_tv',         'Films & TV picks (TMDB)',         'tmdb', null);

-- ---------------------------------------------------------------------------
-- Seed favourites (scored 9 for now: change any score in the app)
-- ---------------------------------------------------------------------------
insert into titles (query, query_year, media_type, score) values
('The Fifth Element', 1997, 'movie', 9),
('The Hunt for Red October', 1990, 'movie', 9),
('Alien', 1979, 'movie', 9),
('Aliens', 1986, 'movie', 9),
('Interstellar', 2014, 'movie', 9),
('Spectral', 2016, 'movie', 9),
('Starship Troopers', 1997, 'movie', 9),
('Ready Player One', 2018, 'movie', 9),
('The Shawshank Redemption', 1994, 'movie', 9),
('The Running Man', 1987, 'movie', 9),
('Event Horizon', 1997, 'movie', 9),
('Total Recall', 1990, 'movie', 9),
('The Terminator', 1984, 'movie', 9),
('Terminator 2: Judgment Day', 1991, 'movie', 9),
('Star Trek: The Next Generation', null, 'tv', 9),
('Star Trek: Deep Space Nine', null, 'tv', 9),
('Star Trek: Voyager', null, 'tv', 9),
('Star Trek: Enterprise', null, 'tv', 9),
('Star Trek', 1966, 'tv', 9),
('Star Trek: Discovery', null, 'tv', 9),
('Star Trek: Picard', null, 'tv', 9),
('Star Trek: Strange New Worlds', null, 'tv', 9),
('Star Trek: Lower Decks', null, 'tv', 9),
('Stargate SG-1', null, 'tv', 9),
('The Rookie', 2018, 'tv', 9),
('Castle', 2009, 'tv', 9),
('NCIS', 2003, 'tv', 9),
('Game of Thrones', null, 'tv', 9);
