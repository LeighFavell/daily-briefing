-- League tables for the Sport tab (updated by the hourly job)
create table if not exists standings (
  id          text primary key,      -- 'football', 'rugby', 'f1'
  title       text not null,
  sort_order  int not null default 0,
  groups      jsonb not null,        -- [{name, columns, rows:[{pos,name,cells,hi}]}]
  updated_at  timestamptz not null default now()
);
alter table standings enable row level security;
drop policy if exists "read" on standings;
create policy "read" on standings for select to authenticated using (true);
