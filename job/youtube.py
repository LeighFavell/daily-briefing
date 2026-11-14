"""YouTube Data API helpers: find channel ids, and search topics for good new videos.

Quota (free 10,000 units a day): a search costs 100 units, a video lookup 1.
Two topics searched twice a day is about 400 units.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

API = "https://www.googleapis.com/youtube/v3"


def resolve_channels(db, http, key: str, log) -> None:
    """Fill in channel ids for any YouTube channel added without one."""
    todo = db.table("sources").select("*").eq("kind", "youtube").is_("youtube_channel_id", "null").execute().data
    for src in todo:
        r = http.get(f"{API}/search", params={"part": "snippet", "type": "channel", "maxResults": 1,
                                              "q": src["name"], "key": key})
        r.raise_for_status()
        items = r.json().get("items", [])
        if not items:
            db.table("sources").update({"last_error": "No YouTube channel found with that name"}) \
                .eq("id", src["id"]).execute()
            continue
        snip = items[0]["snippet"]
        db.table("sources").update({"youtube_channel_id": snip["channelId"], "resolved_name": snip["channelTitle"],
                                    "last_error": None}).eq("id", src["id"]).execute()
        log(f"    YouTube channel matched: {src['name']} -> {snip['channelTitle']}")


def _duration_minutes(iso: str) -> float:
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso or "")
    if not m:
        return 0
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return d * 1440 + h * 60 + mi + s / 60


def search_topic(http, key: str, topic: str, days: int = 7) -> list[dict]:
    """Recent, well-watched videos on a topic (Shorts filtered out)."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    query = re.sub(r"\(.*?\)", " ", topic).strip()          # "(e.g. ...)" helps people, not search
    r = http.get(f"{API}/search", params={
        "part": "snippet", "type": "video", "q": query, "order": "relevance", "maxResults": 20,
        "publishedAfter": since, "relevanceLanguage": "en", "key": key,
    })
    r.raise_for_status()
    ids = [it["id"]["videoId"] for it in r.json().get("items", []) if it["id"].get("videoId")]
    if not ids:
        return []
    v = http.get(f"{API}/videos", params={"part": "snippet,statistics,contentDetails", "id": ",".join(ids), "key": key})
    v.raise_for_status()
    out = []
    for it in v.json().get("items", []):
        mins = _duration_minutes(it["contentDetails"].get("duration"))
        if mins < 3:          # skip Shorts and teasers
            continue
        views = int(it["statistics"].get("viewCount", 0))
        snip = it["snippet"]
        out.append({
            "url": f"https://www.youtube.com/watch?v={it['id']}",
            "title": f"{snip['channelTitle']}: {snip['title']}",
            "raw_summary": f"{views:,} views, {round(mins)} min. {snip.get('description', '')[:300]}",
            "published_at": datetime.fromisoformat(snip["publishedAt"].replace("Z", "+00:00")),
        })
    return out
