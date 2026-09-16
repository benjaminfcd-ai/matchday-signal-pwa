import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { fetchSeasonFixtures } from "./lib/fixtures.js";
import { computeTeamGoalStats } from "./lib/predictions/goalsModel.js";
import { computeOwnEloRatings } from "./lib/predictions/ownElo.js";
import { fetchXgContext } from "./lib/xg.js";
import { researchFixture } from "./lib/research.js";
import { mergeAiResearch } from "./lib/aiResearchMerge.js";

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
// reading to an honest multi-source consensus, or adding a new league).
// Fixtures already researched under the OLD formula would otherwise keep
// showing stale numbers for days, until each one's own 12-hour window
// comes around naturally. This script re-fetches REAL, CURRENT data from
// every source — Opta, Wincomparator, SoccerVista, Elo, the goals model —
// for every fixture that's already been researched at least once, right
// now, regardless of how far off its kickoff is, so they catch up
// immediately. AI Research normally runs on its own separate 6-hour-window
// / every-2-hours schedule (see ai-research-refresh.js) rather than this
// 12-hour one, but since this script is an explicit, one-off, catch-
// everything-up-right-now tool, it re-runs AI Research too, unconditionally
// — see the mergeAiResearch() call below.
//
// COMPETITIONS covered here mirrors run.js exactly (see that file's
// top-of-file comment for what each list is for) — kept as its own copy
// rather than a shared import, since these two files are meant to stay
// independently readable end to end.
const COMPETITIONS = ["PL", "CL", "BL1", "PD"];
const GOALS_MODEL_COMPETITIONS = ["PL", "BL1", "PD"];

async function main() {
  // Every competition — a row's own `competition` field picks the right
  // source URLs at research time (see research.js), so every already-
  // researched fixture gets refreshed correctly regardless of which
  // competition it belongs to.
  const fixturesByCompetition = {};
  await Promise.all(
    COMPETITIONS.map(async (competition) => {
      fixturesByCompetition[competition] = await fetchSeasonFixtures(competition);
    })
  );
  const seasonFixtures = COMPETITIONS.flatMap((c) => fixturesByCompetition[c]);

  const { data: rows, error: readErr } = await supabaseAdmin.from("matches").select("*");
  if (readErr) throw readErr;

  const toRefresh = (rows || []).filter((r) => r.status === "upcoming" && r.probs && r.probs.length > 0);
  if (!toRefresh.length) {
    console.log("Nothing to refresh — no already-researched upcoming fixtures found in the current round(s).");
    return;
  }
  console.log(`Refreshing ${toRefresh.length} already-researched fixture(s) with fresh data from every source...`);

  const xgContext = await fetchXgContext(GOALS_MODEL_COMPETITIONS);
  // Goals model runs across every domestic league this project tracks (see
  // run.js's GOALS_MODEL_COMPETITIONS comment for why Champions League is
  // excluded) — each league's own average computed independently, then
  // merged by team name, same as run.js.
  const goalsFixtures = {};
  for (const competition of GOALS_MODEL_COMPETITIONS) goalsFixtures[competition] = fixturesByCompetition[competition];
  const teamStrengths = computeTeamGoalStats(goalsFixtures, xgContext);
  // Our Elo, same as run.js — computed from EVERY competition's finished
  // fixtures at once (see ownElo.js).
  const ownEloRatings = computeOwnEloRatings(seasonFixtures);

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
      crestMap,
      ownEloRatings
    );
    // Layer AI Research on top, same as its normal dedicated schedule
    // would — see the comment above and scraper/lib/aiResearchMerge.js.
    const { row: withAi, found: aiFound } = await mergeAiResearch(row);
    refreshed.push(withAi);
    console.log(
      `  ✓ ${r.home} vs ${r.away} — ${withAi.standout?.pick ?? "n/a"} ${withAi.standout?.pct != null ? withAi.standout.pct + "%" : ""}` +
        (aiFound ? " (AI Research updated)" : "")
    );
  }

  const { error: upsertErr } = await supabaseAdmin.from("matches").upsert(refreshed);
  if (upsertErr) throw upsertErr;

  // A no-op for any competition whose meta row doesn't exist yet.
  for (const competition of COMPETITIONS) {
    const id = competition === "PL" ? "status" : `status_${competition}`;
    await supabaseAdmin.from("meta").update({ last_updated: new Date().toISOString() }).eq("id", id);
  }
  console.log(`Done — refreshed ${refreshed.length} fixture(s) with live data.`);
}

main().catch((err) => {
  console.error("Refresh run failed:", err);
  process.exit(1);
});
