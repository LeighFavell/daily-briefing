"""Temporary: check which free standings sources work from GitHub Actions."""
import httpx, json
c = httpx.Client(timeout=20, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0 DailyBriefing"})
def show(url):
    try:
        r = c.get(url); print("\n==", r.status_code, url)
        if r.status_code != 200: return None
        return r.json()
    except Exception as e:
        print("\n== ERR", url, e); return None
for lg in ["eng.1", "eng.2", "eng.3", "eng.4"]:
    d = show(f"https://site.api.espn.com/apis/v2/sports/soccer/{lg}/standings")
    if d:
        ch = d.get("children") or [d]
        for g in ch:
            ents = g.get("standings", {}).get("entries", [])
            names = [e["team"]["displayName"] for e in ents]
            print(g.get("name"), len(ents), [n for n in names if any(w in n for w in ("Cardiff", "Swansea", "Wrexham", "Newport"))])
            if ents and lg == "eng.2":
                e = ents[0]; print(" sample:", e["team"]["displayName"], [(s.get("name"), s.get("displayValue")) for s in e["stats"]])
for lid in ["270557", "180659", "267979", "289234", "271937", "164205"]:
    d = show(f"https://site.api.espn.com/apis/v2/sports/rugby/{lid}/standings")
    if d:
        ch = d.get("children") or [d]
        print("league:", d.get("name"), d.get("abbreviation"))
        for g in ch:
            ents = g.get("standings", {}).get("entries", [])
            print(" ", g.get("name"), len(ents), [e["team"]["displayName"] for e in ents][:16])
            if ents: print("  sample stats:", [(s.get("name"), s.get("displayValue")) for s in ents[0]["stats"]])
for u in ["https://api.jolpi.ca/ergast/f1/current/driverStandings.json", "https://api.jolpi.ca/ergast/f1/current/constructorStandings.json"]:
    d = show(u)
    if d: 
        sl = d["MRData"]["StandingsTable"]["StandingsLists"]
        print(" round", sl[0]["round"] if sl else None, "entries", len((sl[0].get("DriverStandings") or sl[0].get("ConstructorStandings")) if sl else []))
