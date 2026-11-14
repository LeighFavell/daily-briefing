"""Films & TV: match what Leigh scores in the app to TMDB, and make weekly picks.

TMDB is free; the key lives in the TMDB_API_KEY secret. Either the short
"API Key" or the long "API Read Access Token" works.
"""
from __future__ import annotations

import os
from collections import Counter
from datetime import datetime, timedelta, timezone

API = "https://api.themoviedb.org/3"
PICKS_MODEL = os.environ.get("PICKS_MODEL", "claude-sonnet-5-5")
SONNET_IN, SONNET_OUT = 2.00, 10.00     # USD per million tokens
PICK_EVERY = timedelta(days=7)


def _auth(key: str) -> tuple[dict, dict]:
    key = key.strip()
    if key.startswith("eyJ"):              # v4 read access token
        return {"Authorization": f"Bearer {key}"}, {}
    return {}, {"api_key": key}


class Tmdb:
    def __init__(self, http, key: str):
        self.http = http
        self.headers, self.params = _auth(key)

    def get(self, path: str, **params) -> dict:
        r = self.http.get(f"{API}{path}", headers=self.headers,
                          params={**self.params, "language": "en-GB", **params})
        r.raise_for_status()
        return r.json()


def _year(item: dict) -> int | None:
    d = item.get("release_date") or item.get("first_air_date") or ""
    return int(d[:4]) if d[:4].isdigit() else None


def _name(item: dict) -> str:
    return item.get("title") or item.get("name") or "?"


# ---------------------------------------------------------------------------
def match_new_titles(db, tmdb: Tmdb, log) -> None:
    """Find TMDB ids for anything added in the app that hasn't been matched yet."""
    pending = db.table("titles").select("*").is_("tmdb_id", "null").is_("match_error", "null").execute().data
    for t in pending:
        params = {"query": t["query"]}
        if t.get("query_year"):
            params["year" if t["media_type"] == "movie" else "first_air_date_year"] = t["query_year"]
        try:
            results = tmdb.get(f"/search/{t['media_type']}", **params).get("results", [])
            if not results and t.get("query_year"):  # year may be off by one
                results = tmdb.get(f"/search/{t['media_type']}", query=t["query"]).get("results", [])
            if not results:
                db.table("titles").update({"match_error": "No match on TMDB"}).eq("id", t["id"]).execute()
                log(f"    no TMDB match: {t['query']}")
                continue
            hit = results[0]
            clash = db.table("titles").select("id").eq("media_type", t["media_type"]) \
                .eq("tmdb_id", hit["id"]).execute().data
            if clash:  # already scored this one: keep the newest score on the existing row
                db.table("titles").update({"score": t["score"], "status": t["status"]}).eq("id", clash[0]["id"]).execute()
                db.table("titles").delete().eq("id", t["id"]).execute()
                continue
            db.table("titles").update({
                "tmdb_id": hit["id"], "title": _name(hit), "year": _year(hit),
                "poster_path": hit.get("poster_path"),
            }).eq("id", t["id"]).execute()
            log(f"    matched: {t['query']} -> {_name(hit)} ({_year(hit)})")
        except Exception as exc:
            db.table("titles").update({"match_error": f"{type(exc).__name__}: {exc}"[:200]}).eq("id", t["id"]).execute()


def picks_due(db) -> bool:
    last = db.table("recommendations").select("batch_at").order("batch_at", desc=True).limit(1).execute().data
    if not last:
        return True
    when = datetime.fromisoformat(last[0]["batch_at"].replace("Z", "+00:00"))
    return datetime.now(timezone.utc) - when >= PICK_EVERY - timedelta(hours=2)


def make_picks(db, tmdb: Tmdb, claude, log, how_many: int = 5) -> tuple[list[dict], float]:
    """Choose this week's picks. Returns the new recommendation rows and the AI cost."""
    titles = db.table("titles").select("*").not_.is_("tmdb_id", "null").execute().data
    rated = [t for t in titles if t["status"] == "rated" and t["score"]]
    liked = sorted([t for t in rated if t["score"] >= 7], key=lambda t: -t["score"])
    disliked = [t for t in rated if t["score"] <= 4]
    exclude = {(t["media_type"], t["tmdb_id"]) for t in titles}
    for r in db.table("recommendations").select("media_type,tmdb_id").execute().data:
        exclude.add((r["media_type"], r["tmdb_id"]))
    if not liked:
        log("    no liked titles yet; skipping picks")
        return [], 0.0

    # Candidates: TMDB recommendations for the titles you like most
    votes: Counter = Counter()
    because: dict = {}
    info: dict = {}
    for t in liked[:15]:
        for item in tmdb.get(f"/{t['media_type']}/{t['tmdb_id']}/recommendations").get("results", [])[:20]:
            key = (t["media_type"], item["id"])
            if key in exclude or item.get("vote_count", 0) < 200:
                continue
            votes[key] += 1
            because.setdefault(key, []).append(t["title"])
            info[key] = item
    ranked = sorted(votes, key=lambda k: (votes[k], info[k].get("vote_average", 0)), reverse=True)[:30]
    if not ranked:
        return [], 0.0

    # Where to watch in the UK (subscription services first)
    where: dict = {}
    for key in ranked:
        try:
            gb = tmdb.get(f"/{key[0]}/{key[1]}/watch/providers").get("results", {}).get("GB", {})
            subs = [p["provider_name"] for p in gb.get("flatrate", [])]
            rent = [p["provider_name"] for p in gb.get("rent", [])]
            where[key] = ", ".join(subs[:3]) if subs else (f"Rent: {', '.join(rent[:2])}" if rent else "")
        except Exception:
            where[key] = ""

    lines = []
    for n, key in enumerate(ranked):
        it = info[key]
        lines.append(
            f"[{n}] {_name(it)} ({_year(it) or '?'}, {'film' if key[0] == 'movie' else 'TV'}), "
            f"rating {it.get('vote_average', 0):.1f}, similar to: {', '.join(because[key][:3])}; "
            f"UK: {where[key] or 'not streaming'}. {(it.get('overview') or '')[:220]}"
        )
    liked_txt = "; ".join(f"{t['title']} ({t['score']}/10)" for t in liked[:40])
    disliked_txt = "; ".join(f"{t['title']} ({t['score']}/10)" for t in disliked[:20]) or "none yet"
    prompt = (
        "Recommend films and TV for Leigh this week.\n"
        f"He scored these highly: {liked_txt}\nHe disliked: {disliked_txt}\n\n"
        f"Choose the {how_many} best picks from the candidates below. Mix films and TV, prefer things he can "
        "stream in the UK, and avoid more of the same franchise he's already scored. For each, write one "
        "sentence (British English) on why he'd enjoy it, naming a title he liked.\n\nCandidates:\n" + "\n".join(lines)
    )
    tool = {
        "name": "submit_picks", "description": "Submit the picks.",
        "input_schema": {"type": "object", "required": ["picks"], "properties": {"picks": {
            "type": "array", "items": {"type": "object", "required": ["n", "reason"], "properties": {
                "n": {"type": "integer"}, "reason": {"type": "string"}}}}}},
    }
    msg = claude.messages.create(model=PICKS_MODEL, max_tokens=1500, tools=[tool],
                                 tool_choice={"type": "tool", "name": "submit_picks"},
                                 messages=[{"role": "user", "content": prompt}])
    cost = (msg.usage.input_tokens * SONNET_IN + msg.usage.output_tokens * SONNET_OUT) / 1_000_000
    picks = next((b.input.get("picks", []) for b in msg.content if b.type == "tool_use"), [])

    batch = datetime.now(timezone.utc).isoformat()
    rows = []
    for p in picks[:how_many]:
        if not 0 <= p.get("n", -1) < len(ranked):
            continue
        key = ranked[p["n"]]
        it = info[key]
        rows.append({
            "batch_at": batch, "media_type": key[0], "tmdb_id": key[1], "title": _name(it),
            "year": _year(it), "poster_path": it.get("poster_path"), "reason": p["reason"],
            "where_to_watch": where.get(key) or None,
        })
    if rows:
        db.table("recommendations").insert(rows).execute()
    log(f"    {len(rows)} film & TV picks (${cost:.4f})")
    return rows, cost


def picks_as_items(rows: list[dict]) -> list[dict]:
    return [{
        "url": f"https://www.themoviedb.org/{r['media_type']}/{r['tmdb_id']}",
        "title": f"{r['title']} ({r['year']})" if r.get("year") else r["title"],
        "raw_summary": r["reason"] + (f" Watch on: {r['where_to_watch']}." if r.get("where_to_watch") else ""),
        "published_at": datetime.now(timezone.utc),
    } for r in rows]


def favourites_text(db, limit: int = 60) -> str:
    """Titles Leigh likes, for the notable-deaths filter."""
    rows = db.table("titles").select("title,query,score").eq("status", "rated").gte("score", 7) \
        .order("score", desc=True).limit(limit).execute().data
    return ", ".join(r["title"] or r["query"] for r in rows)
