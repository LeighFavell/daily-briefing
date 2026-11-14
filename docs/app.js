import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.BRIEFING_CONFIG || {};
const app = document.getElementById("app");
const navBriefing = document.getElementById("nav-briefing");
const navSources = document.getElementById("nav-sources");

if (!cfg.supabaseUrl || cfg.supabaseUrl.startsWith("PASTE")) {
  app.innerHTML = `<div class="pad"><h1>Almost there</h1>
    <p>Add your Supabase project URL and publishable key to <code>docs/config.js</code>.</p></div>`;
  throw new Error("config missing");
}

const db = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ---------------------------------------------------------------- helpers
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function ago(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function briefingLabel(b) {
  const d = new Date(b.created_at);
  const day = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const hour = parseInt(b.slot, 10);
  const part = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
  return { part, day };
}

async function nextSlotText() {
  const { data } = await db.from("settings").select("briefing_times").eq("id", 1).single();
  if (!data) return "";
  const now = new Date();
  const hhmm = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  const times = [...data.briefing_times].sort();
  const next = times.find((t) => t > hhmm) || times[0];
  return next > hhmm ? `today at ${next}` : `tomorrow at ${next}`;
}

// ---------------------------------------------------------------- sign in
function renderSignIn(message = "") {
  navBriefing.hidden = navSources.hidden = true;
  app.innerHTML = `
    <form class="card signin" id="signin">
      <h1>Sign in</h1>
      <label>Email <input type="email" name="email" autocomplete="username" required></label>
      <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
      <button class="primary" type="submit">Sign in</button>
      <p class="error">${esc(message)}</p>
    </form>`;
  document.getElementById("signin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { error } = await db.auth.signInWithPassword({ email: f.get("email"), password: f.get("password") });
    if (error) renderSignIn(error.message);
    else route();
  });
}

// ---------------------------------------------------------------- briefing
async function renderBriefing() {
  navBriefing.hidden = true;
  navSources.hidden = false;
  app.innerHTML = `<p class="muted center pad">Loading…</p>`;

  const { data: briefings, error } = await db
    .from("briefings").select("*").order("created_at", { ascending: false }).limit(1);
  if (error) return (app.innerHTML = `<p class="error pad">${esc(error.message)}</p>`);
  const b = briefings[0];
  if (!b) {
    app.innerHTML = `<div class="done"><h1>No briefing yet</h1>
      <p class="muted">Your first one arrives ${esc(await nextSlotText())}.</p></div>`;
    return;
  }
  if (b.completed_at) return renderDone(b, true);

  const [{ data: rows }, { data: sections }] = await Promise.all([
    db.from("briefing_items")
      .select("rank, section_id, item_id, headline, summary, why_it_matters, items(url, published_at, sources(name))")
      .eq("briefing_id", b.id),
    db.from("sections").select("id, title, sort_order").order("sort_order"),
  ]);

  const f1Ids = rows.filter((r) => r.section_id === "f1").map((r) => r.item_id);
  const races = {};
  if (f1Ids.length) {
    const { data: f1rows } = await db.from("f1_races").select("*").in("item_id", f1Ids);
    for (const r of f1rows || []) races[r.item_id] = r;
  }

  if (!b.opened_at) db.from("briefings").update({ opened_at: new Date().toISOString() }).eq("id", b.id).then(() => {});

  const { part, day } = briefingLabel(b);
  let html = `<section class="intro pad">
      <p class="eyebrow">${esc(day)}</p>
      <h1>${esc(part)} briefing</h1>
      <p class="muted">${rows.length} items · about ${Math.max(2, Math.round(rows.length * 0.4))} minutes</p>
    </section>`;

  for (const s of sections) {
    const items = rows.filter((r) => r.section_id === s.id).sort((a, z) => a.rank - z.rank);
    if (!items.length) continue;
    html += `<section class="section"><h2>${esc(s.title)}</h2>`;
    for (const it of items) {
      if (s.id === "f1" && races[it.item_id]) {
        html += f1Card(it, races[it.item_id]);
        continue;
      }
      const src = it.items?.sources?.name || "";
      html += `<article class="card item">
          <a href="${esc(it.items?.url)}" target="_blank" rel="noopener">
            <h3>${esc(it.headline)}</h3>
          </a>
          <p>${esc(it.summary)}</p>
          ${it.why_it_matters ? `<p class="why"><strong>Why it matters:</strong> ${esc(it.why_it_matters)}</p>` : ""}
          <p class="meta">${esc(src)}${it.items?.published_at ? " · " + ago(it.items.published_at) : ""}</p>
        </article>`;
    }
    html += `</section>`;
  }
  html += `<div class="pad center"><button class="primary big" id="finish">I'm done</button></div>`;
  app.innerHTML = html;

  wireF1();
  document.getElementById("finish").addEventListener("click", async () => {
    await db.from("briefings").update({ completed_at: new Date().toISOString() }).eq("id", b.id);
    renderDone(b, false);
    window.scrollTo(0, 0);
  });
}

async function renderDone(b, already) {
  navBriefing.hidden = true;
  navSources.hidden = false;
  app.innerHTML = `<div class="done">
      <div class="tick">✓</div>
      <h1>You're done</h1>
      <p>That's everything worth knowing for now.</p>
      <p class="muted">Next briefing ${esc(await nextSlotText())}.</p>
      ${already ? `<button class="link" id="reread">Read this briefing again</button>` : ""}
    </div>`;
  if (already) {
    document.getElementById("reread").addEventListener("click", async () => {
      await db.from("briefings").update({ completed_at: null }).eq("id", b.id);
      renderBriefing();
    });
  }
}

// ---------------------------------------------------------------- Formula 1
const TEAM_COLOURS = {
  red_bull: "#3671C6", ferrari: "#E8002D", mercedes: "#00A19C", mclaren: "#FF8000",
  aston_martin: "#229971", alpine: "#0093CC", williams: "#64C4FF", rb: "#6692FF",
  racing_bulls: "#6692FF", sauber: "#52E252", audi: "#9A1B2F", haas: "#8C8F93", cadillac: "#C8A55A",
};
function teamColour(id) {
  if (TEAM_COLOURS[id]) return TEAM_COLOURS[id];
  let h = 0;
  for (const ch of id || "") h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 50%)`;
}

function lapChart(race) {
  const results = race.results;
  const n = results.length;
  const laps = Math.max(...Object.values(race.lap_positions).map((a) => a.length), 1);
  const W = 360, H = 30 + n * 14, L = 24, R = 36, T = 10, B = 20;
  const x = (lap) => L + ((lap - 1) / Math.max(laps - 1, 1)) * (W - L - R);
  const y = (pos) => T + ((pos - 1) / Math.max(n - 1, 1)) * (H - T - B);
  const seenTeam = {};
  let svg = `<svg class="lapchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Position of each driver on every lap">`;
  for (const p of [1, 5, 10, 15, 20].filter((p) => p <= n)) {
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}" class="grid"/>
            <text x="${L - 5}" y="${y(p) + 3}" class="axis" text-anchor="end">P${p}</text>`;
  }
  for (const lap of [1, Math.round(laps / 2), laps]) {
    svg += `<text x="${x(lap)}" y="${H - 5}" class="axis" text-anchor="middle">${lap === 1 ? "Lap 1" : lap}</text>`;
  }
  // draw from last place up so the leaders sit on top
  for (const r of [...results].reverse()) {
    const pos = race.lap_positions[r.code] || [];
    const pts = pos.map((p, i) => (p ? `${x(i + 1).toFixed(1)},${y(p).toFixed(1)}` : null)).filter(Boolean);
    if (pts.length < 2) continue;
    const dashed = seenTeam[r.team_id] ? 'stroke-dasharray="4 3"' : "";
    seenTeam[r.team_id] = true;
    const colour = teamColour(r.team_id);
    svg += `<g class="drv" data-code="${esc(r.code)}">
        <polyline points="${pts.join(" ")}" stroke="${colour}" ${dashed}/>`;
    for (const lap of race.pit_stops?.[r.code] || []) {
      const p = pos[lap - 1];
      if (p) svg += `<circle cx="${x(lap)}" cy="${y(p)}" r="2.6" fill="${colour}"/>`;
    }
    const lastIdx = pos.reduce((acc, p, i) => (p ? i : acc), 0);
    svg += `<text x="${x(lastIdx + 1) + 4}" y="${y(pos[lastIdx]) + 3}" class="code" fill="${colour}">${esc(r.code)}</text></g>`;
  }
  return svg + `</svg>`;
}

function f1Card(it, race) {
  const res = race.results;
  const moved = res
    .filter((r) => /^\d+$/.test(r.pos_text))
    .map((r) => ({ ...r, gain: (r.grid === 0 ? res.length : r.grid) - r.pos }));
  const best = [...moved].sort((a, z) => z.gain - a.gain)[0];
  const worst = [...moved].sort((a, z) => a.gain - z.gain)[0];
  const out = res.filter((r) => !/^\d+$/.test(r.pos_text));

  let rowsHtml = "";
  for (const r of res.filter((r) => /^\d+$/.test(r.pos_text)).slice(0, 10)) {
    const g = (r.grid === 0 ? res.length : r.grid) - r.pos;
    const change = g > 0 ? `<span class="up">▲${g}</span>` : g < 0 ? `<span class="down">▼${-g}</span>` : `<span class="muted">–</span>`;
    rowsHtml += `<tr data-code="${esc(r.code)}"><td>${r.pos}</td>
        <td><span class="chip" style="background:${teamColour(r.team_id)}"></span>${esc(r.name)}</td>
        <td class="muted">${r.grid === 0 ? "PL" : "P" + r.grid}</td><td>${change}</td></tr>`;
  }
  return `<article class="card item f1">
      <a href="${esc(it.items?.url)}" target="_blank" rel="noopener"><h3>${esc(it.headline)}</h3></a>
      <p>${esc(it.summary)}</p>
      <p class="meta">Position on every lap · dots are pit stops · tap a driver to highlight</p>
      ${lapChart(race)}
      <table class="results"><thead><tr><th></th><th>Driver</th><th>Grid</th><th>+/−</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table>
      <p class="meta">${best && best.gain > 0 ? `Biggest gain: <strong>${esc(best.name)}</strong> +${best.gain} · ` : ""}${worst && worst.gain < 0 ? `Biggest drop: <strong>${esc(worst.name)}</strong> ${worst.gain}` : ""}</p>
      ${out.length ? `<p class="meta">Did not finish: ${out.map((r) => `${esc(r.name)} (${esc(r.status)})`).join(", ")}</p>` : ""}
    </article>`;
}

function wireF1() {
  document.querySelectorAll(".item.f1").forEach((card) => {
    let active = null;
    card.querySelectorAll("tr[data-code], g.drv").forEach((el) =>
      el.addEventListener("click", () => {
        const code = el.dataset.code;
        active = active === code ? null : code;
        card.querySelectorAll("g.drv").forEach((g) => {
          g.classList.toggle("dim", !!active && g.dataset.code !== active);
          g.classList.toggle("hi", g.dataset.code === active);
        });
        card.querySelectorAll("tr[data-code]").forEach((tr) => tr.classList.toggle("sel", tr.dataset.code === active));
      })
    );
  });
}

// ---------------------------------------------------------------- sources
async function renderSources() {
  navBriefing.hidden = false;
  navSources.hidden = true;
  const [{ data: sources }, { data: sections }] = await Promise.all([
    db.from("sources").select("*").order("name"),
    db.from("sections").select("id, title, sort_order").order("sort_order"),
  ]);
  let html = `<section class="intro pad"><h1>Sources</h1>
    <p class="muted">Feed health from the last run. Editing comes in a later phase.</p></section>`;
  for (const s of sections) {
    const list = sources.filter((x) => x.section_id === s.id);
    if (!list.length) continue;
    html += `<section class="section"><h2>${esc(s.title)}</h2><div class="card list">`;
    for (const src of list) {
      let status, note = "";
      if (src.last_error) { status = "bad"; note = src.last_error; }
      else if (!src.last_fetched_at) { status = "wait"; note = "Not fetched yet"; }
      else { status = "ok"; note = `Checked ${ago(src.last_fetched_at)}`; }
      if (src.kind === "youtube" && src.resolved_name && src.resolved_name !== src.name) {
        note = `Matched to “${src.resolved_name}” · ${note}`;
      }
      html += `<div class="row"><span class="dot ${status}"></span>
          <div><div>${esc(src.name)}${src.enabled ? "" : " <span class='muted'>(paused)</span>"}</div>
          <div class="meta">${esc(note)}</div></div></div>`;
    }
    html += `</div></section>`;
  }
  html += `<div class="pad center"><button class="link" id="signout">Sign out</button></div>`;
  app.innerHTML = html;
  document.getElementById("signout").addEventListener("click", async () => {
    await db.auth.signOut();
    renderSignIn();
  });
}

// ---------------------------------------------------------------- routing
async function route() {
  const { data } = await db.auth.getSession();
  if (!data.session) return renderSignIn();
  if (location.hash === "#sources") return renderSources();
  return renderBriefing();
}

navSources.addEventListener("click", () => { location.hash = "sources"; });
navBriefing.addEventListener("click", () => { location.hash = ""; });
window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") route(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
route();
