import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { fetchSeasonFixtures } from "./lib/fixtures.js";
import { computeTeamGoalStats } from "./lib/predictions/goalsModel.js";
import { fetchXgContext } from "./lib/xg.js";
import { researchFixture } from "./lib/research.js";

// ONE-OFF, MANUALLY-TRIGGERED TOOL — this is NOT part of the regular every-
// 3-hours schedule and has no cron trigger of its own (see
// .github/workflows/refresh-existing.yml: workflow_dispatch only). Run it
// by hand from the GitHub Actions tab whenever you need it; nothing calls
// it automatically.
//
// run.js (the regular scraper) deliberately only (re-)fetches a fixture's
// predictions once it's within 12 hours of its own kickoff, and that stays
// true always — this script does not change that, and never will just by
// existing. What it's for: the rare moment the prediction FORMULA itself
// changes (e.g. moving "Our Prediction" from a single cherry-picked
// reading to an honest multi-source consensus). Fixtures already
// researched under the OLD formula would otherwise keep showing stale
// numbers for days, until each one's own 12-hour window comes around
// naturally. This script re-fetches REAL, CURRENT data from every source
// — Opta, Wincomparator, SoccerVista, Elo, the goals model — for every
// fixture that's already been researched at least once, right now,
// regardless of how far off its kickoff is, so they catch up immediately.
async function main() {
  // Both competitions — a row's own `competition` field picks the right
  // source URLs at research time (see research.js), so every already-
  // researched fixture gets refreshed correctly regardless of which
  // competition it belongs to.
  const [plFixtures, clFixtures] = await Promise.all([
    fetchSeasonFixtures("PL"),
    fetchSeasonFixtures("CL"),
  ]);
  const seasonFixtures = [...plFixtures, ...clFixtures];

  const { data: rows, error: readErr } = await supabaseAdmin.from("matches").select("*");
  if (readErr) throw readErr;

  const toRefresh = (rows || []).filter((r) => r.status === "upcoming" && r.probs && r.probs.length > 0);
  if (!toRefresh.length) {
    console.log("Nothing to refresh — no already-researched upcoming fixtures found in the current round(s).");
    return;
  }
  console.log(`Refreshing ${toRefresh.length} already-researched fixture(s) with fresh data from every source...`);

  const xgContext = await fetchXgContext();
  // Goals model stays Premier-League-only, same as run.js — see that
  // file's comment for why plFixtures (not the combined list) is passed.
  const teamStrengths = computeTeamGoalStats(plFixtures, xgContext);

  // Same crest self-heal as run.js — free, no extra fetch, since seasonFixtures
  // is already pulled above.
  const crestMap = new Map();
  for (const f of seasonFixtures) {
    if (f.homeCrest) crestMap.set(f.home, f.homeCrest);
    if (f.awayCrest) crestMap.set(f.away, f.awayCrest);
  }

  const refreshed = [];
  for (const r of toRefresh) {
    const row = await researchFixture(
      { id: r.id, competition: r.competition, home: r.home, away: r.away, kickoffLocal: r.kickoff_local },
      teamStrengths,
      crestMap
    );
    refreshed.push(row);
    console.log(`  ✓ ${r.home} vs ${r.away} — ${row.standout?.pick ?? "n/a"} ${row.standout?.pct != null ? row.standout.pct + "%" : ""}`);
  }

  const { error: upsertErr } = await supabaseAdmin.from("matches").upsert(refreshed);
  if (upsertErr) throw upsertErr;

  await supabaseAdmin.from("meta").update({ last_updated: new Date().toISOString() }).eq("id", "status");
  await supabaseAdmin.from("meta").update({ last_updated: new Date().toISOString() }).eq("id", "status_CL");
  console.log(`Done — refreshed ${refreshed.length} fixture(s) with live data.`);
}

main().catch((err) => {
  console.error("Refresh run failed:", err);
  process.exit(1);
});
