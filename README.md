# Daily Briefing

A short, finite briefing on my iPhone — instead of doom scrolling.
Twice a day a GitHub Actions job reads my news, blog and YouTube feeds, asks
Claude (Haiku 5.5) to keep only what matters, and saves the briefing to Supabase.
The web app on GitHub Pages shows it and ends with **"You're done"**.

```
docs/                  Web app (GitHub Pages, installable on iPhone)
job/briefing.py        Hourly job: fetch → curate with Claude → save briefing
job/resolve_youtube.py Finds YouTube channel ids from channel names
supabase/migrations/   Database schema + starting sections and sources
.github/workflows/     Schedules for the two jobs
```

## Setup checklist (Phase 1)

1. **Database** — Supabase → SQL Editor → paste `supabase/migrations/0001_phase1.sql` → Run.
2. **Your login** — Supabase → Authentication → Users → *Add user* (email + password),
   then turn off *Allow new users to sign up*.
3. **App config** — put the Supabase **Project URL** and **publishable key** in
   `docs/config.js` (these are safe to be public; never the secret key).
4. **GitHub secrets** — repo → Settings → Secrets and variables → Actions → *New repository secret*:
   - `ANTHROPIC_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SECRET_KEY`
   - `YOUTUBE_API_KEY`
5. **YouTube channels** — Actions → *Resolve YouTube channels* → Run workflow.
   Check the matches in the log (or on the app's Sources page).
6. **First briefing** — Actions → *Build briefing* → Run workflow (mode `build-now`).
7. **GitHub Pages** — repo → Settings → Pages → *Deploy from a branch* → `main` / `/docs`.
   Then in Supabase → Authentication → URL Configuration, set the Site URL to the Pages address.
8. **iPhone** — open the Pages address in Safari → Share → *Add to Home Screen*.

## Changing things
- **Briefing times**: `settings.briefing_times` (UK time). The job runs hourly and builds when a time is due.
- **Sources / sections**: the `sources` and `sections` tables. A broken feed shows red on the Sources page.
- **Cost**: each briefing records its Claude cost in `briefings.ai_cost_usd`.

## Roadmap
2. Sport: Welsh rugby & football summaries, F1 results with a position-per-lap chart
3. Settings page, film/TV scores out of 10 with weekly recommendations, notable deaths
4. Share-sheet capture inbox, Instagram/TikTok/Facebook redirect, notifications
