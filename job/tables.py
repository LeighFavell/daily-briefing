"""League tables for the Sport tab.

Football and rugby come from ESPN's public standings feed; F1 from Jolpica.
Football tables follow the teams: whichever English league Cardiff, Swansea and
Wrexham are in this season is the one shown (so promotion/relegation just works).
"""
from __future__ import annotations

from datetime import datetime, timezone

ESPN = "https://site.api.espn.com/apis/v2/sports"
JOLPICA = "https://api.jolpi.ca/ergast/f1"

FOOTBALL_TEAMS = ["Cardiff City", "Swansea City", "Wrexham"]
FOOTBALL_LEAGUES = ["eng.1", "eng.2", "eng.3", "eng.4"]
RUGBY_TEAMS = ["Cardiff Blues", "Cardiff Rugby", "Ospreys", "Scarlets", "Dragons", "Wales"]

SOCCER_COLS = [("P", "gamesPlayed"), ("W", "wins"), ("D", "ties"), ("L", "losses"),
               ("GD", "pointDifferential"), ("Pts", "points")]
RUGBY_COLS = [("P", "gamesPlayed"), ("W", "gamesWon"), ("D", "gamesDrawn"), ("L", "gamesLost"),
              ("PD", "pointsDifference"), ("BP", "bonusPoints"), ("Pts", "points")]


def _espn_groups(http, url: str, cols, highlight: list[str], only_with_highlight=False) -> tuple[str, list[dict]]:
    r = http.get(url)
    r.raise_for_status()
    d = r.json()
    groups = []
    for g in d.get("children") or [d]:
        entries = g.get("standings", {}).get("entries", [])
        rows = []
        for e in entries:
            stats = {s.get("name"): s.get("displayValue") for s in e.get("stats", [])}
            name = e["team"].get("shortDisplayName") or e["team"]["displayName"]
            full = e["team"]["displayName"]
            rows.append({
                "pos": int(stats.get("rank") or 0) or None,
                "name": "Cardiff Rugby" if full == "Cardiff Blues" else full if len(full) <= 22 else name,
                "cells": [stats.get(key, "") or "0" for _, key in cols],
                "hi": any(full == t for t in highlight),
            })
        rows.sort(key=lambda x: (x["pos"] is None, x["pos"] or 0))
        if not rows or (only_with_highlight and not any(x["hi"] for x in rows)):
            continue
        groups.append({"name": g.get("name") or d.get("name"), "columns": [c for c, _ in cols], "rows": rows})
    return d.get("name") or "", groups


def football(http) -> list[dict]:
    groups = []
    for lg in FOOTBALL_LEAGUES:
        _, gs = _espn_groups(http, f"{ESPN}/soccer/{lg}/standings", SOCCER_COLS, FOOTBALL_TEAMS, only_with_highlight=True)
        groups += gs
    return groups


def rugby(http) -> list[dict]:
    groups = []
    for lid, only_hi in (("270557", False), ("271937", True), ("180659", False)):
        try:
            _, gs = _espn_groups(http, f"{ESPN}/rugby/{lid}/standings", RUGBY_COLS, RUGBY_TEAMS, only_with_highlight=only_hi)
        except Exception:
            continue
        for g in gs:
            if lid == "271937":
                g["name"] = f"Champions Cup – {g['name']}"
        groups += gs
    return groups


def f1(http) -> list[dict]:
    groups = []
    d = http.get(f"{JOLPICA}/current/driverStandings.json").json()["MRData"]["StandingsTable"]["StandingsLists"]
    if d:
        rows = [{
            "pos": int(s["position"]) if s.get("position") else None,
            "name": f"{s['Driver']['givenName'][0]}. {s['Driver']['familyName']}",
            "cells": [s["Constructors"][-1]["name"] if s.get("Constructors") else "", s["wins"], s["points"]],
            "hi": False,
        } for s in d[0]["DriverStandings"]]
        groups.append({"name": f"Drivers (after round {d[0]['round']})", "columns": ["Team", "Wins", "Pts"], "rows": rows})
    c = http.get(f"{JOLPICA}/current/constructorStandings.json").json()["MRData"]["StandingsTable"]["StandingsLists"]
    if c:
        rows = [{
            "pos": int(s["position"]) if s.get("position") else None,
            "name": s["Constructor"]["name"], "cells": [s["wins"], s["points"]], "hi": False,
        } for s in c[0]["ConstructorStandings"]]
        groups.append({"name": "Constructors", "columns": ["Wins", "Pts"], "rows": rows})
    return groups


SPORTS = [("football", "Football", football), ("rugby", "Rugby", rugby), ("f1", "Formula 1", f1)]


def update_all(db, http, log) -> None:
    for order, (sid, title, fn) in enumerate(SPORTS, start=1):
        try:
            groups = fn(http)
            if not groups:
                continue
            db.table("standings").upsert({
                "id": sid, "title": title, "sort_order": order, "groups": groups,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).execute()
            log(f"  tables ok   {title}: {', '.join(g['name'] for g in groups)}")
        except Exception as exc:
            log(f"  tables FAIL {title}: {type(exc).__name__}: {exc}")
