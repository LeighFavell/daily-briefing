// Supabase Edge Function: "refresh"
// Starts the GitHub Actions "Build briefing" job when you tap "Refresh now" in the app.
// Needs one secret in Supabase: GITHUB_TOKEN (fine-grained token, Actions: read & write on daily-briefing).
import { createClient } from "npm:@supabase/supabase-js@2";

const REPO = "LeighFavell/daily-briefing";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Only you (signed in) can trigger a refresh
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Not signed in", { status: 401, headers: cors });

  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/briefing.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "daily-briefing-app",
    },
    body: JSON.stringify({ ref: "main", inputs: { mode: "build-now" } }),
  });
  if (!res.ok) {
    return new Response(`GitHub said ${res.status}: ${await res.text()}`, { status: 502, headers: cors });
  }
  return new Response(JSON.stringify({ started: true }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
