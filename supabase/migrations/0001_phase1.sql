-- Daily Briefing: Phase 1 schema
-- Run once in the Supabase SQL editor.
-- Access model: single user. The web page signs in as Leigh (sign-ups disabled),
-- so any "authenticated" user is Leigh. The scheduled GitHub Actions job uses the
-- secret key, which bypasses row-level security.

-- ---------------------------------------------------------------------------
-- Settings (one row)
-- ---------------------------------------------------------------------------
create table settings (
  id                     int primary key default 1 check (id = 1),
  timezone               text  not null default 'Europe/London',
  briefing_times         text[] not null default '{07:00,18:00}',  -- local HH:MM
  default_items_per_section int not null default 5,
  updated_at             timestamptz not null default now()
);
insert into settings default values;

-- ---------------------------------------------------------------------------
-- Sections of the briefing (editable order, on/off, size, AI filter rule)
-- ---------------------------------------------------------------------------
create table sections (
  id          text primary key,            -- e.g. 'wales_uk_news'
  title       text not null,
  sort_order  int  not null,
  enabled     boolean not null default true,
  max_items   int,                          -- null = use settings default
  ai_rule     text not null                 -- what to keep / how to summarise
);

-- ---------------------------------------------------------------------------
-- Sources (RSS feeds and YouTube channels)
-- ---------------------------------------------------------------------------
create table sources (
  id                 uuid primary key default gen_random_uuid(),
  section_id         text not null references sections(id) on delete cascade,
  name               text not null,
  kind               text not null check (kind in ('rss','youtube')),
  url                text,                  -- RSS URL (YouTube URL is built from channel id)
  youtube_channel_id text,                  -- null until resolved/confirmed
  resolved_name      text,                  -- channel title found by the resolver, for Leigh to confirm
  mode               text not null default 'all'
                     check (mode in ('all','marathon_only')),  -- GDQ = marathon_only
  enabled            boolean not null default true,
  last_fetched_at    timestamptz,
  last_error         text,                  -- shown in settings so broken feeds are visible
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Raw items fetched from sources (deduplicated by URL)
-- ---------------------------------------------------------------------------
create table items (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid not null references sources(id) on delete cascade,
  url           text not null unique,
  title         text not null,
  raw_summary   text,
  published_at  timestamptz,
  fetched_at    timestamptz not null default now(),
  considered_at timestamptz                -- set once the AI has looked at it, so it is never re-sent
);
create index items_source_published on items (source_id, published_at desc);

-- ---------------------------------------------------------------------------
-- Briefings and their curated items
-- ---------------------------------------------------------------------------
create table briefings (
  id            uuid primary key default gen_random_uuid(),
  slot          text not null,              -- the local time it was built for, e.g. '07:00'
  created_at    timestamptz not null default now(),
  opened_at     timestamptz,
  completed_at  timestamptz,                -- set when "You're done" is reached
  ai_cost_usd   numeric(10,5)               -- tracked so spend stays visible
);

create table briefing_items (
  briefing_id     uuid not null references briefings(id) on delete cascade,
  item_id         uuid not null references items(id) on delete cascade,
  section_id      text not null references sections(id),
  rank            int  not null,
  headline        text not null,            -- AI-tidied title
  summary         text not null,            -- 1-2 lines
  why_it_matters  text,                     -- used by the Microsoft section
  primary key (briefing_id, item_id),
  unique (item_id)                          -- an item only ever appears once (no repeats)
);

-- ---------------------------------------------------------------------------
-- Row-level security: signed-in user can read everything and edit settings,
-- sections and sources; only the job (secret key) writes items and briefings.
-- ---------------------------------------------------------------------------
alter table settings       enable row level security;
alter table sections       enable row level security;
alter table sources        enable row level security;
alter table items          enable row level security;
alter table briefings      enable row level security;
alter table briefing_items enable row level security;

create policy "read"  on settings       for select to authenticated using (true);
create policy "edit"  on settings       for update to authenticated using (true);
create policy "all"   on sections       for all    to authenticated using (true) with check (true);
create policy "all"   on sources        for all    to authenticated using (true) with check (true);
create policy "read"  on items          for select to authenticated using (true);
create policy "read"  on briefings      for select to authenticated using (true);
create policy "mark"  on briefings      for update to authenticated using (true);  -- opened/completed
create policy "read"  on briefing_items for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Seed: sections
-- ---------------------------------------------------------------------------
insert into sections (id, title, sort_order, ai_rule) values
('wales_uk_news', 'Wales & UK', 1,
 'Local news affecting South Wales first, then Wales-wide, then major UK news. Merge duplicate stories across outlets. Skip trivia and celebrity gossip.'),
('world_costs', 'World: prices & markets', 2,
 'Only global stories likely to affect UK prices, food, energy, markets or cost of living. Drop all other world news.'),
('ev_battery', 'EV battery tech', 3,
 'Only battery technology: chemistry, energy density, range, charging speed, cost, manufacturing scale. Drop car launches, reviews and company drama.'),
('microsoft_data_ai', 'Microsoft data & AI', 4,
 'New or changed features in Microsoft Fabric, Power BI, Copilot and related data/AI tools. One feature per item, plus one line on why it matters for a BI and data consultancy.'),
('ai_models', 'AI models', 5,
 'Model and product news for Claude and Copilot, plus major competitor model launches. Skip opinion pieces and funding rumours.'),
('apple', 'Apple', 6,
 'Significant Apple news: releases, OS updates, notable rumours with good sourcing. Skip deals and minor accessories.'),
('youtube', 'New on YouTube', 7,
 'List new uploads from the subscribed channels with a one-line description. Do not filter out subscribed channels.');

-- ---------------------------------------------------------------------------
-- Seed: sources. Feed URLs are verified on the first job run; failures show
-- in sources.last_error. YouTube channel ids are resolved and confirmed with
-- Leigh before use.
-- ---------------------------------------------------------------------------
insert into sources (section_id, name, kind, url) values
('wales_uk_news',     'BBC News Wales',      'rss', 'https://feeds.bbci.co.uk/news/wales/rss.xml'),
('wales_uk_news',     'BBC News UK',         'rss', 'https://feeds.bbci.co.uk/news/uk/rss.xml'),
('wales_uk_news',     'WalesOnline',         'rss', 'https://www.walesonline.co.uk/news/?service=rss'),
('wales_uk_news',     'Nation.Cymru',        'rss', 'https://nation.cymru/feed/'),
('world_costs',       'BBC Business',        'rss', 'https://feeds.bbci.co.uk/news/business/rss.xml'),
('world_costs',       'BBC World',           'rss', 'https://feeds.bbci.co.uk/news/world/rss.xml'),
('world_costs',       'Guardian Business',   'rss', 'https://www.theguardian.com/uk/business/rss'),
('ev_battery',        'Electrek',            'rss', 'https://electrek.co/feed/'),
('ev_battery',        'InsideEVs',           'rss', 'https://insideevs.com/rss/news/all/'),
('ev_battery',        'CleanTechnica',       'rss', 'https://cleantechnica.com/feed/'),
('microsoft_data_ai', 'Microsoft Fabric Blog','rss', 'https://blog.fabric.microsoft.com/en-us/blog/feed/'),
('microsoft_data_ai', 'Power BI Blog',       'rss', 'https://powerbi.microsoft.com/en-us/blog/feed/'),
('microsoft_data_ai', 'Microsoft 365 Blog',  'rss', 'https://www.microsoft.com/en-us/microsoft-365/blog/feed/'),
('ai_models',         'Anthropic News',      'rss', null),   -- no official RSS; job scrapes the news page
('ai_models',         'Microsoft AI Blog',   'rss', 'https://blogs.microsoft.com/ai/feed/'),
('apple',             'MacRumors',           'rss', 'https://feeds.macrumors.com/MacRumors-All'),
('apple',             '9to5Mac',             'rss', 'https://9to5mac.com/feed/');

insert into sources (section_id, name, kind, mode) values
('youtube', 'Alex Steele',      'youtube', 'all'),
('youtube', 'Chainsaw100',      'youtube', 'all'),
('youtube', 'Ali Spagnola',     'youtube', 'all'),
('youtube', 'Bikes and Beards', 'youtube', 'all'),
('youtube', 'BeardMeatsFood',   'youtube', 'all'),
('youtube', 'ElectroBOOM',      'youtube', 'all'),
('youtube', 'Gohjoe',           'youtube', 'all'),
('youtube', 'Drae',             'youtube', 'all'),
('youtube', 'Games Done Quick', 'youtube', 'marathon_only');

update sections set max_items = 10 where id = 'youtube';
