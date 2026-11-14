import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.BRIEFING_CONFIG || {};
const app = document.getElementById("app");
const tabs = document.getElementById("tabs");
const pageTitle = document.getElementById("page-title");

function setNav(tab, title) {
  tabs.hidden = !tab;
  pageTitle.textContent = title || "Briefing";
  tabs.querySelectorAll("a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1800);
}

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
  setNav(null, "Briefing");
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
  setNav("briefing", "Briefing");
  app.innerHTML = `<p class="muted center pad">Loading…</p>`;
  const since = new Date(Date.now() - 14 * 864e5).toISOString();

  const [{ data: rows, error }, { data: sections }, { data: latest }] = await Promise.all([
    db.from("briefing_items")
      .select("briefing_id, rank, section_id, item_id, headline, summary, why_it_matters, briefings!inner(created_at), items(url, published_at, sources(name))")
      .is("read_at", null).gte("briefings.created_at", since),
    db.from("sections").select("id, title, sort_order").order("sort_order"),
    db.from("briefings").select("*").order("created_at", { ascending: false }).limit(1),
  ]);
  if (error) return (app.innerHTML = `<p class="error pad">${esc(error.message)}</p>`);
  const b = latest[0];
  if (!b) {
    app.innerHTML = `<div class="done"><h1>No briefing yet</h1>
      <p class="muted">Your first one arrives ${esc(await nextSlotText())}.</p></div>`;
    return;
  }
  if (!rows.length) return renderDone(b);

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
      <p class="muted"><span id="left">${rows.length}</span> to read</p>
    </section>`;

  for (const s of sections) {
    const items = rows.filter((r) => r.section_id === s.id)
      .sort((a, z) => z.briefings.created_at.localeCompare(a.briefings.created_at) || a.rank - z.rank);
    if (!items.length) continue;
    html += `<section class="section" data-section><h2>${esc(s.title)}</h2>`;
    for (const it of items) {
      const key = `${it.briefing_id}|${it.item_id}`;
      const readBtn = `<button class="readbtn" data-read="${key}" aria-label="Mark as read">✓</button>`;
      if (s.id === "f1" && races[it.item_id]) {
        html += f1Card(it, races[it.item_id]).replace(/<\/article>\s*$/, `<div class="cardfoot"><span></span>${readBtn}</div></article>`)
          .replace('<article class="card item f1"', `<article class="card item f1" data-card="${key}"`);
        continue;
      }
      const src = it.items?.sources?.name || "";
      html += `<article class="card item" data-card="${key}">
          <a href="${esc(it.items?.url)}" target="_blank" rel="noopener">
            <h3>${esc(it.headline)}</h3>
          </a>
          <p>${esc(it.summary)}</p>
          ${it.why_it_matters ? `<p class="why"><strong>Why it matters:</strong> ${esc(it.why_it_matters)}</p>` : ""}
          <div class="cardfoot"><p class="meta">${esc(src)}${it.items?.published_at ? " · " + ago(it.items.published_at) : ""}</p>${readBtn}</div>
        </article>`;
    }
    html += `</section>`;
  }
  html += `<div class="pad center"><button class="primary big" id="finish">Mark all as read</button></div>`;
  app.innerHTML = html;
  wireF1();

  const markRead = (pairs) => {
    const now = new Date().toISOString();
    return Promise.all(pairs.map(([bid, iid]) =>
      db.from("briefing_items").update({ read_at: now }).eq("briefing_id", bid).eq("item_id", iid)));
  };
  const allDone = async () => {
    await db.from("briefings").update({ completed_at: new Date().toISOString() }).eq("id", b.id);
    renderDone(b);
    window.scrollTo(0, 0);
  };

  app.querySelectorAll("[data-read]").forEach((btn) => btn.addEventListener("click", async () => {
    const card = btn.closest("[data-card]");
    btn.disabled = true;
    card.classList.add("gone");
    const { 0: res } = await markRead([btn.dataset.read.split("|")]);
    if (res?.error) { card.classList.remove("gone"); btn.disabled = false; return toast(res.error.message); }
    setTimeout(() => {
      const sec = card.closest("[data-section]");
      card.remove();
      if (!sec.querySelector("[data-card]")) sec.remove();
      const left = app.querySelectorAll("[data-card]").length;
      document.getElementById("left").textContent = left;
      if (!left) allDone();
    }, 250);
  }));

  document.getElementById("finish").addEventListener("click", async () => {
    const pairs = [...app.querySelectorAll("[data-card]")].map((c) => c.dataset.card.split("|"));
    await markRead(pairs);
    allDone();
  });
}

async function renderDone(b) {
  setNav("briefing", "Briefing");
  app.innerHTML = `<div class="done">
      <div class="tick">✓</div>
      <h1>You're done</h1>
      <p>That's everything worth knowing for now.</p>
      <p class="muted">Next briefing ${esc(await nextSlotText())}.</p>
      <button class="link" id="reread">Show the last briefing again</button>
    </div>`;
  document.getElementById("reread").addEventListener("click", async () => {
    await db.from("briefing_items").update({ read_at: null }).eq("briefing_id", b.id);
    await db.from("briefings").update({ completed_at: null }).eq("id", b.id);
    renderBriefing();
  });
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

// ---------------------------------------------------------------- settings
const NO_RULE = new Set(["f1", "films_tv", "youtube"]);
const ADD_KIND = {
  youtube: { kind: "youtube", label: "Add a YouTube channel", name: "Channel name", url: false },
  youtube_discover: { kind: "youtube_topic", label: "Add a topic to watch", name: "Topic, e.g. Fabric tutorials", url: false },
  f1: null,
  films_tv: null,
};

function sourceStatus(src) {
  if (src.kind === "tmdb") return ["ok", "Weekly, from your scores"];
  if (src.last_error) return ["bad", src.last_error];
  if (!src.last_fetched_at) return ["wait", src.kind === "youtube" ? "Will be matched on the next run" : "Not fetched yet"];
  let note = `Checked ${ago(src.last_fetched_at)}`;
  if (src.kind === "youtube" && src.resolved_name && src.resolved_name !== src.name) note = `Matched to “${src.resolved_name}” · ${note}`;
  return ["ok", note];
}

async function renderSettings() {
  setNav("settings", "Settings");
  const [{ data: settings }, { data: sections }, { data: sources }] = await Promise.all([
    db.from("settings").select("*").eq("id", 1).single(),
    db.from("sections").select("*").order("sort_order"),
    db.from("sources").select("*").order("created_at"),
  ]);

  let html = `<section class="section"><div class="card refresh">
      <div class="grow"><strong>Refresh now</strong>
        <div class="meta" id="refresh-note">Fetch the latest news and build a new briefing (about 2 minutes).</div></div>
      <button class="small" id="refresh-btn">Refresh</button>
    </div></section>
    <section class="section"><h2>Briefing times (UK)</h2><div class="card">
      <div class="chips">${settings.briefing_times.map((t) =>
        `<span class="chip-t">${esc(t)}<button data-del-time="${esc(t)}" aria-label="Remove ${esc(t)}">✕</button></span>`).join("")}</div>
      <div class="inline"><input type="time" id="new-time" value="12:30"><button class="small" id="add-time">Add time</button></div>
      <label class="inline">Items per section <input type="number" min="1" max="20" id="default-items" value="${settings.default_items_per_section}"></label>
    </div></section>`;

  sections.forEach((sec, i) => {
    const list = sources.filter((x) => x.section_id === sec.id);
    const add = sec.id in ADD_KIND ? ADD_KIND[sec.id] : { kind: "rss", label: "Add a news feed", name: "Name", url: true };
    html += `<section class="section" data-sec="${esc(sec.id)}"><div class="sec-head">
        <h2>${esc(sec.title)}</h2>
        <div class="sec-tools">
          <button class="icon" data-move="-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
          <button class="icon" data-move="1" ${i === sections.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
          <label class="switch"><input type="checkbox" data-enabled ${sec.enabled ? "checked" : ""}><span></span></label>
        </div></div>
      <div class="card ${sec.enabled ? "" : "off"}">
        <label class="inline">Max items <input type="number" min="1" max="20" data-max placeholder="${settings.default_items_per_section}" value="${sec.max_items ?? ""}"></label>
        ${NO_RULE.has(sec.id) ? "" : `<details><summary>What to include</summary>
          <textarea data-rule rows="5">${esc(sec.ai_rule)}</textarea>
          <button class="small" data-save-rule>Save</button></details>`}
        <div class="list">`;
    for (const src of list) {
      const [st, note] = sourceStatus(src);
      html += `<div class="row" data-src="${src.id}"><span class="dot ${src.enabled ? st : "wait"}"></span>
          <div class="grow"><div>${esc(src.name)}${src.enabled ? "" : " <span class='muted'>(paused)</span>"}</div>
          <div class="meta">${esc(note)}</div></div>
          ${src.kind === "tmdb" || src.kind === "f1" ? "" : `
          <button class="icon" data-pause aria-label="${src.enabled ? "Pause" : "Resume"}">${src.enabled ? "❚❚" : "▶"}</button>
          <button class="icon" data-del-src aria-label="Remove">✕</button>`}</div>`;
    }
    html += `</div>`;
    if (add) {
      html += `<details class="add"><summary>${add.label}</summary>
          <input data-new-name placeholder="${esc(add.name)}">
          ${add.url ? `<input data-new-url type="url" placeholder="RSS feed address (https://…)">` : ""}
          <button class="small" data-add-src="${add.kind}">Add</button></details>`;
    }
    html += `</div></section>`;
  });
  html += `<div class="pad center"><p class="meta">Changes apply from the next briefing.</p>
      <button class="link" id="signout">Sign out</button></div>`;
  app.innerHTML = html;

  // manual refresh
  document.getElementById("refresh-btn").addEventListener("click", refreshNow);

  // times
  const saveTimes = async (times) => {
    times = [...new Set(times)].sort();
    await db.from("settings").update({ briefing_times: times, updated_at: new Date().toISOString() }).eq("id", 1);
    toast("Times saved");
    renderSettings();
  };
  app.querySelectorAll("[data-del-time]").forEach((b) => b.addEventListener("click", () => {
    const rest = settings.briefing_times.filter((t) => t !== b.dataset.delTime);
    if (!rest.length) return toast("Keep at least one time");
    saveTimes(rest);
  }));
  document.getElementById("add-time").addEventListener("click", () => {
    const v = document.getElementById("new-time").value;
    if (v) saveTimes([...settings.briefing_times, v.slice(0, 5)]);
  });
  document.getElementById("default-items").addEventListener("change", async (e) => {
    await db.from("settings").update({ default_items_per_section: +e.target.value || 5 }).eq("id", 1);
    toast("Saved");
  });

  // sections
  app.querySelectorAll("[data-sec]").forEach((el) => {
    const id = el.dataset.sec;
    const idx = sections.findIndex((s) => s.id === id);
    el.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", async () => {
      const other = sections[idx + +b.dataset.move];
      if (!other) return;
      const me = sections[idx];
      await db.from("sections").update({ sort_order: other.sort_order }).eq("id", me.id);
      await db.from("sections").update({ sort_order: me.sort_order }).eq("id", other.id);
      renderSettings();
    }));
    el.querySelector("[data-enabled]").addEventListener("change", async (e) => {
      await db.from("sections").update({ enabled: e.target.checked }).eq("id", id);
      toast(e.target.checked ? "Section on" : "Section off");
      el.querySelector(".card").classList.toggle("off", !e.target.checked);
    });
    el.querySelector("[data-max]").addEventListener("change", async (e) => {
      await db.from("sections").update({ max_items: e.target.value ? +e.target.value : null }).eq("id", id);
      toast("Saved");
    });
    el.querySelector("[data-save-rule]")?.addEventListener("click", async () => {
      await db.from("sections").update({ ai_rule: el.querySelector("[data-rule]").value.trim() }).eq("id", id);
      toast("Saved");
    });
    el.querySelectorAll("[data-src]").forEach((row) => {
      const src = sources.find((x) => x.id === row.dataset.src);
      row.querySelector("[data-pause]")?.addEventListener("click", async () => {
        await db.from("sources").update({ enabled: !src.enabled }).eq("id", src.id);
        renderSettings();
      });
      row.querySelector("[data-del-src]")?.addEventListener("click", async () => {
        if (!confirm(`Remove ${src.name}?`)) return;
        await db.from("sources").delete().eq("id", src.id);
        renderSettings();
      });
    });
    el.querySelector("[data-add-src]")?.addEventListener("click", async (e) => {
      const name = el.querySelector("[data-new-name]").value.trim();
      const url = el.querySelector("[data-new-url]")?.value.trim() || null;
      if (!name) return toast("Add a name");
      if (e.target.dataset.addSrc === "rss" && !/^https?:\/\//.test(url || "")) return toast("Add the feed address");
      const { error } = await db.from("sources").insert({ section_id: id, name, kind: e.target.dataset.addSrc, url });
      if (error) return toast(error.message);
      toast("Added: it'll be checked on the next run");
      renderSettings();
    });
  });

  document.getElementById("signout").addEventListener("click", async () => {
    await db.auth.signOut();
    renderSignIn();
  });
}

async function refreshNow() {
  const btn = document.getElementById("refresh-btn");
  const note = document.getElementById("refresh-note");
  btn.disabled = true;
  btn.textContent = "Starting…";
  const { data: before } = await db.from("briefings").select("id").order("created_at", { ascending: false }).limit(1);
  const { error } = await db.functions.invoke("refresh");
  if (error) {
    btn.disabled = false;
    btn.textContent = "Refresh";
    let detail = error.message;
    try { detail = await error.context.text(); } catch {}
    note.textContent = `Couldn't start the refresh: ${detail}`;
    return;
  }
  btn.textContent = "Working…";
  note.textContent = "Fetching and summarising. This usually takes about 2 minutes. You can leave this page.";
  const started = Date.now();
  const poll = setInterval(async () => {
    const { data } = await db.from("briefings").select("id").order("created_at", { ascending: false }).limit(1);
    const onPage = document.getElementById("refresh-btn") === btn;
    if (data?.[0]?.id && data[0].id !== before?.[0]?.id) {
      clearInterval(poll);
      toast("New briefing ready");
      if (onPage) { btn.disabled = false; btn.textContent = "Refresh"; note.textContent = "Done. New items are in Briefing."; }
    } else if (Date.now() - started > 5 * 60000) {
      clearInterval(poll);
      if (onPage) { btn.disabled = false; btn.textContent = "Refresh"; note.textContent = "Finished, but there was nothing new worth adding."; }
    }
  }, 15000);
}

// ---------------------------------------------------------------- films & TV
const POSTER = (p, w = 154) => (p ? `https://image.tmdb.org/t/p/w${w}${p}` : "");
const scoreSelect = (val, attr, label = "Score") =>
  `<select ${attr}><option value="">${label}</option>${[10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
    .map((n) => `<option value="${n}" ${n === val ? "selected" : ""}>${n}/10</option>`).join("")}</select>`;

async function renderFilms() {
  setNav("films", "Films & TV");
  const [{ data: recs }, { data: titles }] = await Promise.all([
    db.from("recommendations").select("*").order("batch_at", { ascending: false }).limit(15),
    db.from("titles").select("*").order("score", { ascending: false, nullsFirst: false }).order("created_at"),
  ]);
  const latest = recs[0]?.batch_at;
  const picks = recs.filter((r) => r.batch_at === latest && r.status === "new");
  const watchlist = titles.filter((t) => t.status === "watchlist");
  const rated = titles.filter((t) => t.status === "rated");

  let html = `<section class="section"><h2>This week's picks</h2>`;
  if (!picks.length) {
    html += `<div class="card"><p class="muted">${recs.length ? "You've been through this week's picks. New ones arrive weekly." : "Your first picks arrive with the next briefing."}</p></div>`;
  }
  for (const r of picks) {
    html += `<article class="card pick" data-rec="${r.id}">
        ${r.poster_path ? `<img src="${POSTER(r.poster_path)}" alt="" loading="lazy">` : `<div class="noposter"></div>`}
        <div class="grow">
          <h3><a href="https://www.themoviedb.org/${r.media_type}/${r.tmdb_id}" target="_blank" rel="noopener">${esc(r.title)}</a></h3>
          <p class="meta">${r.year || ""} · ${r.media_type === "movie" ? "Film" : "TV"}${r.where_to_watch ? " · " + esc(r.where_to_watch) : ""}</p>
          <p>${esc(r.reason)}</p>
          <div class="btns">
            <span class="seen">${scoreSelect(null, "data-seen-score", "Seen it: score")}</span>
            <button class="small" data-act="watchlist">Want to watch</button>
            <button class="small ghost" data-act="not_interested">Not for me</button>
          </div>
        </div></article>`;
  }
  html += `</section>`;

  html += `<section class="section"><h2>Add something you've watched</h2><div class="card addtitle">
      <input id="t-name" placeholder="Title">
      <div class="inline">
        <input id="t-year" type="number" placeholder="Year" min="1900" max="2100">
        <select id="t-type"><option value="movie">Film</option><option value="tv">TV</option></select>
        ${scoreSelect(null, 'id="t-score"')}
      </div>
      <button class="primary" id="t-add">Add score</button>
    </div></section>`;

  if (watchlist.length) {
    html += `<section class="section"><h2>Want to watch</h2><div class="card list">`;
    for (const t of watchlist) html += titleRow(t, true);
    html += `</div></section>`;
  }
  html += `<section class="section"><h2>Your scores (${rated.length})</h2><div class="card list">`;
  for (const t of rated) html += titleRow(t, false);
  html += `</div></section><div class="pad"><p class="meta center">Film data from TMDB.</p></div>`;
  app.innerHTML = html;

  // picks
  app.querySelectorAll("[data-rec]").forEach((card) => {
    const r = picks.find((x) => x.id === card.dataset.rec);
    const base = { query: r.title, query_year: r.year, media_type: r.media_type, tmdb_id: r.tmdb_id,
                   title: r.title, year: r.year, poster_path: r.poster_path };
    const finish = async (status, titleRow) => {
      const { error } = await db.from("titles").insert({ ...base, ...titleRow });
      if (error && !/duplicate/i.test(error.message)) return toast(error.message);
      await db.from("recommendations").update({ status }).eq("id", r.id);
      card.remove();
      toast("Saved");
    };
    card.querySelector("[data-seen-score]").addEventListener("change", (e) => {
      if (e.target.value) finish("seen", { score: +e.target.value, status: "rated" });
    });
    card.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () =>
      finish(b.dataset.act, { status: b.dataset.act })));
  });

  document.getElementById("t-add").addEventListener("click", async () => {
    const query = document.getElementById("t-name").value.trim();
    const score = +document.getElementById("t-score").value;
    if (!query) return toast("Add a title");
    if (!score) return toast("Pick a score");
    const { error } = await db.from("titles").insert({
      query, query_year: +document.getElementById("t-year").value || null,
      media_type: document.getElementById("t-type").value, score,
    });
    if (error) return toast(error.message);
    toast("Added. It'll be matched on the next run");
    renderFilms();
  });

  app.querySelectorAll("[data-title]").forEach((row) => {
    const id = row.dataset.title;
    row.querySelector("[data-score]")?.addEventListener("change", async (e) => {
      if (!e.target.value) return;
      await db.from("titles").update({ score: +e.target.value, status: "rated", updated_at: new Date().toISOString() }).eq("id", id);
      toast("Score saved");
      if (row.closest("section").querySelector("h2").textContent.startsWith("Want")) renderFilms();
    });
    row.querySelector("[data-del-title]").addEventListener("click", async () => {
      await db.from("titles").delete().eq("id", id);
      row.remove();
    });
  });
}

function titleRow(t, watch) {
  const name = t.title || t.query;
  const year = t.year || t.query_year;
  const note = t.match_error ? "Couldn't find this one. Check the spelling or add the year."
    : !t.tmdb_id ? "Matching on the next run…" : t.media_type === "movie" ? "Film" : "TV";
  return `<div class="row titlerow" data-title="${t.id}">
      ${t.poster_path ? `<img src="${POSTER(t.poster_path, 92)}" alt="" loading="lazy">` : `<div class="noposter sm"></div>`}
      <div class="grow"><div>${esc(name)}${year ? ` <span class="muted">(${year})</span>` : ""}</div>
        <div class="meta ${t.match_error ? "error" : ""}">${esc(note)}</div></div>
      ${scoreSelect(watch ? null : t.score, "data-score")}
      <button class="icon" data-del-title aria-label="Remove">✕</button></div>`;
}

// ---------------------------------------------------------------- routing
async function route() {
  const { data } = await db.auth.getSession();
  if (!data.session) return renderSignIn();
  window.scrollTo(0, 0);
  if (location.hash === "#settings" || location.hash === "#sources") return renderSettings();
  if (location.hash === "#films") return renderFilms();
  return renderBriefing();
}

window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !location.hash) route();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
route();
