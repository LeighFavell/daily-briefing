"""Find the channel id for every YouTube source that doesn't have one yet.

Uses the YouTube Data API search (about 100 quota units per channel, out of a
free 10,000 a day). The channel title it finds is saved in sources.resolved_name
so Leigh can check it's the right channel before relying on it.

Usage:
    python job/resolve_youtube.py           # resolve channels with no id
    python job/resolve_youtube.py --all     # re-resolve every channel
"""
import argparse
import os
import re
import sys

import httpx
from supabase import create_client

SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"



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
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    key = os.environ.get("YOUTUBE_API_KEY")
    if not key:
        print("YOUTUBE_API_KEY secret is not set.")
        return 1
    db = create_client(supabase_url(), os.environ["SUPABASE_SECRET_KEY"].strip())
    q = db.table("sources").select("*").eq("kind", "youtube")
    if not args.all:
        q = q.is_("youtube_channel_id", "null")
    sources = q.execute().data

    print(f"{'Your name':<20} {'Channel found':<35} Channel id")
    for src in sources:
        r = httpx.get(SEARCH_URL, params={
            "part": "snippet", "type": "channel", "maxResults": 1, "q": src["name"], "key": key,
        }, timeout=20)
        r.raise_for_status()
        results = r.json().get("items", [])
        if not results:
            print(f"{src['name']:<20} {'(no match)':<35}")
            continue
        snip = results[0]["snippet"]
        cid = snip["channelId"]
        db.table("sources").update({
            "youtube_channel_id": cid,
            "resolved_name": snip["channelTitle"],
            "last_error": None,
        }).eq("id", src["id"]).execute()
        print(f"{src['name']:<20} {snip['channelTitle']:<35} {cid}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
