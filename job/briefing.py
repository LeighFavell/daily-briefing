"""Daily Briefing job.

Runs hourly on GitHub Actions. When the current UK time has reached one of the
briefing times in Supabase settings (and that briefing hasn't been built yet),
it fetches every enabled source, asks Claude to pick and summarise the best
items per section, and writes a new briefing to Supabase.

Usage:
    python job/briefing.py            # build only if a briefing is due
    python job/briefing.py --force    # build now regardless of time
    python job/briefing.py --fetch-only   # fetch sources, no AI, no briefing
"""
from __future__ import annotations

import argparse
import html
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import feedparser
import httpx

import f1

MODEL = os.environ.get("BRIEFING_MODEL", "claude-haiku-5-5")
# USD per million tokens (Haiku 5.5, prompts under 100K tokens)
PRICE_IN, PRICE_OUT = 0.10, 0.50
MAX_CANDIDATES = 150          # keeps every request well under the 100K-token price step
LOOKBACK = timedelta(hours=48)
LATE_LIMIT = timedelta(hours=3)  # don't build a briefing more than 3h after its slot
USER_AGENT = "DailyBriefing/1.0 (personal RSS reader)"
ANTHROPIC_NEWS_URL = "https://www.anthropic.com/news"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def log(msg: str) -> None:
    print(msg, flush=True)


def clean_text(raw: str | None, limit: int = 500) -> str:
    if not raw:
        return ""
    text = re.sub(r"<[^>]+>", " ", raw)
    text = html.unescape(re.sub(r"\s+", " ", text)).strip()
    return text[:limit]


def entry_time(entry) -> datetime | None:
    for key in ("published_parsed", "updated_parsed"):
        t = entry.get(key)
        if t:
            return datetime(*t[:6], tzinfo=timezone.utc)
    return None


def due_slot(times: list[str], now_local: datetime, built_today: set[str]) -> str | None:
    """Return the briefing slot ('HH:MM') that should be built now, if any."""
    due = None
    for slot in sorted(times):
        hh, mm = (int(x) for x in slot.split(":"))
        slot_dt = now_local.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if slot_dt <= now_local < slot_dt + LATE_LIMIT and slot not in built_today:
            due = slot
    return due


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------
def fetch_rss(client: httpx.Client, url: str) -> list[dict]:
    resp = client.get(url)
    resp.raise_for_status()
    feed = feedparser.parse(resp.content)
    if feed.bozo and not feed.entries:
        raise ValueError(f"not a valid feed: {feed.bozo_exception}")
    items = []
    for e in feed.entries:
        link = e.get("link")
        title = clean_text(e.get("title"), 300)
        if not link or not title:
            continue
        summary = e.get("summary") or ""
        if not summary and e.get("media_description"):
            summary = e.get("media_description")
        items.append({
            "url": link,
            "title": title,
            "raw_summary": clean_text(summary),
            "published_at": entry_time(e),
        })
    return items


def fetch_anthropic_news(client: httpx.Client) -> list[dict]:
    """Anthropic has no RSS feed, so read article links off the news page."""
    resp = client.get(ANTHROPIC_NEWS_URL)
    resp.raise_for_status()
    slugs = []
    for slug in re.findall(r'href="/news/([a-z0-9][a-z0-9\-]+)"', resp.text):
        if slug not in slugs:
            slugs.append(slug)
    return [{
        "url": f"{ANTHROPIC_NEWS_URL}/{slug}",
        "title": slug.replace("-", " ").capitalize(),
        "raw_summary": "",
        "published_at": None,
    } for slug in slugs[:20]]


def fetch_source(client: httpx.Client, src: dict) -> list[dict]:
    if src["kind"] == "youtube":
        if not src.get("youtube_channel_id"):
            raise ValueError("channel id not resolved yet - run the 'Resolve YouTube channels' workflow")
        url = f"https://www.youtube.com/feeds/videos.xml?channel_id={src['youtube_channel_id']}"
        items = fetch_rss(client, url)
        for it in items:
            it["title"] = f"{src['name']}: {it['title']}"
        if src.get("mode") == "marathon_only":
            recent = [i for i in items if i["published_at"]
                      and i["published_at"] > datetime.now(timezone.utc) - timedelta(hours=24)]
            # Games Done Quick uploads a burst of runs during a marathon week
            return items if len(recent) >= 5 else []
        return items
    if not src.get("url"):
        if "anthropic" in src["name"].lower():
            return fetch_anthropic_news(client)
        raise ValueError("no URL set")
    return fetch_rss(client, src["url"])


def article_text(client: httpx.Client, url: str, limit: int = 6000) -> str:
    """Pull the readable paragraphs out of an article page (good enough for BBC match reports)."""
    resp = client.get(url)
    resp.raise_for_status()
    paras = re.findall(r"<p[^>]*>(.*?)</p>", resp.text, flags=re.S | re.I)
    text = " ".join(clean_text(p, 2000) for p in paras)
    return text[:limit]


def cost_of(usage) -> float:
    return (usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT) / 1_000_000


def deep_summary(claude, http: httpx.Client, url: str, headline: str) -> tuple[str | None, float]:
    """Summarise the full article: the result and how the game was played."""
    try:
        body = article_text(http, url)
    except Exception as exc:
        log(f"    could not read article {url}: {exc}")
        return None, 0.0
    if len(body) < 300:
        return None, 0.0
    msg = claude.messages.create(
        model=MODEL, max_tokens=300,
        messages=[{"role": "user", "content":
                   "In 2-3 sentences of British English, give the result and how it was won "
                   "(key moments, who scored or starred, turning points). Plain text only.\n\n"
                   f"Headline: {headline}\n\nReport:\n{body}"}],
    )
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    return (text or None), cost_of(msg.usage)


# ---------------------------------------------------------------------------
# Curation with Claude
# ---------------------------------------------------------------------------
CURATE_TOOL = {
    "name": "submit_section",
    "description": "Submit the curated items for this briefing section.",
    "input_schema": {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "ids": {"type": "array", "items": {"type": "integer"},
                                "description": "Candidate numbers covering this story; first is the best source."},
                        "headline": {"type": "string", "description": "Clear, plain headline, max ~12 words."},
                        "summary": {"type": "string", "description": "1-2 sentences: what happened and the key fact."},
                        "why_it_matters": {"type": "string",
                                           "description": "Optional one line on why it matters to the reader."},
                    },
                    "required": ["ids", "headline", "summary"],
                },
            }
        },
        "required": ["items"],
    },
}

READER = ("The reader is Leigh, who lives in Llantwit Major, South Wales, and leads a data, "
          "BI and AI consulting practice (Microsoft Fabric, Power BI, Dynamics 365, Azure). "
          "He wants a short, finite briefing instead of doom scrolling, so be selective.")


def curate(anthropic_client, section: dict, candidates: list[dict], limit: int):
    lines = []
    for n, c in enumerate(candidates):
        when = c["published_at"][:16] if c.get("published_at") else "unknown time"
        lines.append(f"[{n}] ({c['source_name']}, {when}) {c['title']}\n    {c['raw_summary'][:300]}")
    prompt = (
        f"{READER}\n\nSection: {section['title']}\nRule: {section['ai_rule']}\n\n"
        f"From the candidates below, choose at most {limit} items that best fit the rule, most important first. "
        "Merge candidates that cover the same story into one item (list all their numbers in ids). "
        "It is fine to return fewer items, or none, if little qualifies. Use British English.\n\n"
        "Candidates:\n" + "\n".join(lines)
    )
    msg = anthropic_client.messages.create(
        model=MODEL,
        max_tokens=2500,
        tools=[CURATE_TOOL],
        tool_choice={"type": "tool", "name": "submit_section"},
        messages=[{"role": "user", "content": prompt}],
    )
    cost = (msg.usage.input_tokens * PRICE_IN + msg.usage.output_tokens * PRICE_OUT) / 1_000_000
    picked = []
    for block in msg.content:
        if block.type == "tool_use":
            picked = block.input.get("items", [])
    return picked[:limit], cost


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def fetch_f1(db, http: httpx.Client, src: dict, max_age_days: int) -> list[dict]:
    """Store the latest Grand Prix (once) and return it as a single item."""
    race = f1.fetch_latest_race(http, src["url"].rstrip("/"), max_age_days)
    if not race:
        return []
    existing = db.table("f1_races").select("id").eq("id", race["id"]).execute().data
    if not existing:
        db.table("f1_races").insert({
            "id": race["id"], "season": race["season"], "round": race["round"],
            "race_name": race["race_name"], "race_date": race["race_date"],
            "results": race["results"], "lap_positions": race["lap_positions"],
            "pit_stops": race["pit_stops"],
        }).execute()
    winner = race["results"][0]
    return [{
        "url": race["url"],
        "title": f"{race['race_name']} {race['season']}: {winner['name']} wins",
        "raw_summary": f1.race_facts(race)[:500],
        "published_at": race["start"],
        "race_id": race["id"],
    }]


def supabase_url() -> str:
    """Accept the URL with stray spaces or a /rest/v1/ ending, and say clearly if it looks wrong."""
    url = os.environ["SUPABASE_URL"].strip().rstrip("/")
    url = re.sub(r"/rest/v1$", "", url)
    if not re.fullmatch(r"https://[a-z0-9]+\.supabase\.co", url):
        raise SystemExit(f"SUPABASE_URL secret looks wrong: expected https://<project>.supabase.co, "
                         f"got something {len(url)} characters long starting {url[:12]!r}")
    return url


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="build a briefing now")
    ap.add_argument("--fetch-only", action="store_true", help="fetch sources only")
    ap.add_argument("--f1-days", type=int, default=4,
                    help="include the latest Grand Prix if it finished within this many days")
    args = ap.parse_args()

    from supabase import create_client
    db = create_client(supabase_url(), os.environ["SUPABASE_SECRET_KEY"].strip())

    settings = db.table("settings").select("*").eq("id", 1).single().execute().data
    tz = ZoneInfo(settings["timezone"])
    now_local = datetime.now(tz)

    slot = None
    if not args.fetch_only:
        day_start = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
        built = db.table("briefings").select("slot") \
            .gte("created_at", day_start.astimezone(timezone.utc).isoformat()).execute().data
        built_today = {b["slot"] for b in built}
        slot = due_slot(settings["briefing_times"], now_local, built_today)
        if args.force:
            slot = slot or now_local.strftime("%H:%M")
        if not slot:
            log(f"{now_local:%H:%M} {settings['timezone']}: no briefing due. Done.")
            return 0
        log(f"Building briefing for slot {slot}")

    # 1. Fetch every enabled source -------------------------------------------
    sections = db.table("sections").select("*").eq("enabled", True).order("sort_order").execute().data
    sources = db.table("sources").select("*").eq("enabled", True).execute().data
    by_id = {s["id"]: s for s in sources}

    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=20, follow_redirects=True) as http:
        for src in sources:
            now_iso = datetime.now(timezone.utc).isoformat()
            try:
                if src["kind"] == "f1":
                    items = fetch_f1(db, http, src, args.f1_days)
                else:
                    items = fetch_source(http, src)
                rows = [{
                    "source_id": src["id"],
                    "url": it["url"],
                    "title": it["title"],
                    "raw_summary": it["raw_summary"],
                    "published_at": it["published_at"].isoformat() if it["published_at"] else None,
                } for it in items]
                if rows:
                    db.table("items").upsert(rows, on_conflict="url", ignore_duplicates=True).execute()
                if src["kind"] == "f1" and items:
                    item = db.table("items").select("id").eq("url", items[0]["url"]).single().execute().data
                    db.table("f1_races").update({"item_id": item["id"]}).eq("id", items[0]["race_id"]).execute()
                db.table("sources").update({"last_fetched_at": now_iso, "last_error": None}) \
                    .eq("id", src["id"]).execute()
                log(f"  ok    {src['name']}: {len(rows)} entries")
            except Exception as exc:  # keep going; the error is shown in the app
                err = f"{type(exc).__name__}: {exc}"[:300]
                db.table("sources").update({"last_fetched_at": now_iso, "last_error": err}) \
                    .eq("id", src["id"]).execute()
                log(f"  FAIL  {src['name']}: {err}")

    if args.fetch_only:
        return 0

    # 2. Curate each section ---------------------------------------------------
    import anthropic
    claude = anthropic.Anthropic()
    cutoff = (datetime.now(timezone.utc) - LOOKBACK).isoformat()
    total_cost = 0.0
    picked_rows: list[dict] = []
    considered: list[str] = []

    for section in sections:
        src_ids = [s["id"] for s in sources if s["section_id"] == section["id"]]
        if not src_ids:
            continue
        limit = section.get("max_items") or settings["default_items_per_section"]
        cand = db.table("items").select("*").in_("source_id", src_ids).is_("considered_at", "null") \
            .gte("fetched_at", cutoff).order("published_at", desc=True).limit(MAX_CANDIDATES * 2).execute().data
        # drop anything clearly older than the lookback window
        if section["id"] != "f1":  # a race can be a few days old and still be news
            cand = [c for c in cand if not c["published_at"] or c["published_at"] >= cutoff]
        cand = cand[:MAX_CANDIDATES]
        for c in cand:
            c["source_name"] = by_id[c["source_id"]]["name"]
        considered += [c["id"] for c in cand]
        if not cand:
            log(f"  {section['title']}: nothing new")
            continue

        if section["id"] == "f1":
            chosen, cost = [], 0.0
            for n, c in enumerate(cand[:limit]):
                race = db.table("f1_races").select("*").eq("item_id", c["id"]).single().execute().data
                story, _, tin, tout = f1.write_story(claude, MODEL, race)
                cost += (tin * PRICE_IN + tout * PRICE_OUT) / 1_000_000
                db.table("f1_races").update({"story": story}).eq("id", race["id"]).execute()
                winner = race["results"][0]
                chosen.append({"ids": [n], "headline": f"{winner['name']} wins the {race['race_name']}",
                               "summary": story})
        elif section["id"] == "youtube":
            # Subscriptions are never filtered: list every new upload.
            chosen = [{"ids": [n], "headline": c["title"], "summary": c["raw_summary"][:200] or "New video"}
                      for n, c in enumerate(cand[:limit])]
            cost = 0.0
        else:
            chosen, cost = curate(claude, section, cand, limit)
            if section.get("deep_summary"):
                with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=20, follow_redirects=True) as http:
                    for pick in chosen:
                        ids = [i for i in pick.get("ids", []) if 0 <= i < len(cand)]
                        if ids:
                            text, extra = deep_summary(claude, http, cand[ids[0]]["url"], pick["headline"])
                            cost += extra
                            if text:
                                pick["summary"] = text
        total_cost += cost
        for rank, pick in enumerate(chosen, start=1):
            ids = [i for i in pick.get("ids", []) if 0 <= i < len(cand)]
            if not ids:
                continue
            picked_rows.append({
                "item_id": cand[ids[0]]["id"],
                "section_id": section["id"],
                "rank": rank,
                "headline": pick["headline"],
                "summary": pick["summary"],
                "why_it_matters": pick.get("why_it_matters") or None,
            })
        log(f"  {section['title']}: {len(chosen)} of {len(cand)} kept (${cost:.4f})")

    # 3. Save ------------------------------------------------------------------
    # an item can only appear once, even if two sections picked it
    seen, unique_rows = set(), []
    for r in picked_rows:
        if r["item_id"] not in seen:
            seen.add(r["item_id"])
            unique_rows.append(r)

    if unique_rows:
        briefing = db.table("briefings").insert({"slot": slot, "ai_cost_usd": round(total_cost, 5)}) \
            .execute().data[0]
        for r in unique_rows:
            r["briefing_id"] = briefing["id"]
        db.table("briefing_items").insert(unique_rows).execute()
        log(f"Briefing saved: {len(unique_rows)} items, AI cost ${total_cost:.4f}")
    else:
        log("Nothing new worth including; no briefing saved.")

    now_iso = datetime.now(timezone.utc).isoformat()
    for i in range(0, len(considered), 200):
        db.table("items").update({"considered_at": now_iso}).in_("id", considered[i:i + 200]).execute()
    return 0


if __name__ == "__main__":
    sys.exit(main())
