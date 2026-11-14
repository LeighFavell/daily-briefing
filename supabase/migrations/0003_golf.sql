-- Daily Briefing: men's professional golf results
insert into sections (id, title, sort_order, ai_rule, deep_summary, max_items) values
('golf', 'Golf', 10,
 'Only men''s professional golf: final results of PGA Tour, DP World Tour and LIV events, the majors, Ryder Cup and other major team events. One item per tournament once it has finished; headline gives the winner and winning score. Mention how Welsh and other British players finished if notable. Skip women''s golf, amateur golf, equipment, tips, previews and gossip.',
 true, 3)
on conflict (id) do nothing;

insert into sources (section_id, name, kind, url) values
('golf', 'BBC Sport Golf', 'rss', 'https://feeds.bbci.co.uk/sport/golf/rss.xml');
