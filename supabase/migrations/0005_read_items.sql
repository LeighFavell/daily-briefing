-- Mark individual briefing items as read; unread items stay until you read them.
alter table briefing_items add column if not exists read_at timestamptz;
drop policy if exists "mark" on briefing_items;
create policy "mark" on briefing_items for update to authenticated using (true);
