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
      .select("rank, section_id, headline, summary, why_it_matters, items(url, published_at, sources(name))")
      .eq("briefing_id", b.id),
    db.from("sections").select("id, title, sort_order").order("sort_order"),
  ]);

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
