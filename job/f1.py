"""Formula 1 results from the free Jolpica API (the successor to Ergast).

Builds everything the app needs for one Grand Prix: the finishing order,
each driver's position on every lap, pit-stop laps, and a race story.
"""
from __future__ import annotations

import time
from datetime import date, datetime, timedelta, timezone

PAGE = 100  # Jolpica's maximum page size


def _get(http, url: str, params: dict | None = None) -> dict:
    for attempt in range(3):
        resp = http.get(url, params=params)
        if resp.status_code == 429:          # rate limited: back off and retry
            time.sleep(2 + attempt * 3)
            continue
        resp.raise_for_status()
        time.sleep(0.3)                       # stay well inside the burst limit
        return resp.json()["MRData"]
    resp.raise_for_status()
    return {}


def _paged_races(http, url: str) -> list[dict]:
    """Fetch every page of a laps/pitstops query and return the race's pages."""
    pages, offset = [], 0
    while True:
        data = _get(http, url, {"limit": PAGE, "offset": offset})
        races = data["RaceTable"]["Races"]
        if races:
            pages.append(races[0])
        offset += PAGE
        if offset >= int(data.get("total", 0)):
            return pages


def fetch_latest_race(http, base: str, max_age_days: int) -> dict | None:
    """Return the most recent Grand Prix if it finished within max_age_days."""
    data = _get(http, f"{base}/current/last/results.json")
    races = data["RaceTable"]["Races"]
    if not races:
        return None
    race = races[0]
    race_day = date.fromisoformat(race["date"])
    if (date.today() - race_day).days > max_age_days:
        return None
    season, rnd = int(race["season"]), int(race["round"])

    code_of, results = {}, []
    for r in race["Results"]:
        drv = r["Driver"]
        code = drv.get("code") or drv["familyName"][:3].upper()
        code_of[drv["driverId"]] = code
        results.append({
            "pos": int(r["position"]),
            "pos_text": r.get("positionText", r["position"]),
            "code": code,
            "name": f"{drv['givenName']} {drv['familyName']}",
            "team": r["Constructor"]["name"],
            "team_id": r["Constructor"]["constructorId"],
            "grid": int(r.get("grid") or 0),
            "status": r.get("status", ""),
            "laps": int(r.get("laps") or 0),
            "points": float(r.get("points") or 0),
        })

    # Position of every driver on every lap
    total_laps = max((r["laps"] for r in results), default=0)
    lap_positions: dict[str, list] = {r["code"]: [None] * total_laps for r in results}
    for page in _paged_races(http, f"{base}/{season}/{rnd}/laps.json"):
        for lap in page.get("Laps", []):
            n = int(lap["number"])
            for t in lap["Timings"]:
                code = code_of.get(t["driverId"])
                if code and 0 < n <= total_laps:
                    lap_positions[code][n - 1] = int(t["position"])

    pit_stops: dict[str, list[int]] = {}
    try:
        for page in _paged_races(http, f"{base}/{season}/{rnd}/pitstops.json"):
            for p in page.get("PitStops", []):
                code = code_of.get(p["driverId"])
                if code:
                    pit_stops.setdefault(code, []).append(int(p["lap"]))
    except Exception:
        pit_stops = {}  # pit data sometimes arrives later; the race still works without it

    start = race["date"] + "T" + race.get("time", "14:00:00Z")
    return {
        "id": f"{season}-{rnd:02d}",
        "season": season,
        "round": rnd,
        "race_name": race["raceName"],
        "race_date": race["date"],
        "start": datetime.fromisoformat(start.replace("Z", "+00:00")),
        "url": race.get("url") or f"https://www.formula1.com/en/results/{season}",
        "results": results,
        "lap_positions": lap_positions,
        "pit_stops": pit_stops,
    }


def race_facts(race: dict) -> str:
    """Compact text of the race for the AI to write a story from."""
    lines = [f"{race['race_name']} {race['season']} (round {race['round']})", "Result:"]
    for r in race["results"]:
        grid = "pit lane" if r["grid"] == 0 else f"P{r['grid']}"
        pits = race["pit_stops"].get(r["code"], [])
        pit_txt = f", pitted lap {', '.join(map(str, pits))}" if pits else ""
        lines.append(f"  {r['pos_text']}. {r['name']} ({r['team']}) from {grid}, {r['status']}{pit_txt}")

    # Who led when
    leaders, prev = [], None
    laps = len(next(iter(race["lap_positions"].values()), []))
    for i in range(laps):
        leader = next((c for c, p in race["lap_positions"].items() if p[i] == 1), None)
        if leader and leader != prev:
            leaders.append(f"lap {i + 1}: {leader}")
            prev = leader
    if leaders:
        lines.append("Lead changes: " + "; ".join(leaders))
    return "\n".join(lines)


def write_story(claude, model: str, race: dict) -> tuple[str, float, int, int]:
    prompt = (
        "Write a short race report (3-4 sentences, British English) for someone who didn't watch. "
        "Cover who won and how, the key battles or strategy calls, notable retirements, and anyone "
        "who gained or lost a lot of places. Plain text, no headings.\n\n" + race_facts(race)
    )
    msg = claude.messages.create(model=model, max_tokens=500, messages=[{"role": "user", "content": prompt}])
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    return text, 0.0, msg.usage.input_tokens, msg.usage.output_tokens
