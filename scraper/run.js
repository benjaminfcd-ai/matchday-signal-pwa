import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { fetchSeasonFixtures, weekendWindow } from "./lib/fixtures.js";
import { fetchOptaPrediction } from "./lib/predictions/opta.js";
import { fetchWincomparatorPrediction } from "./lib/predictions/wincomparator.js";
import { fetchSoccervistaPrediction } from "./lib/predictions/soccervista.js";
import { fetchEloPrediction } from "./lib/predictions/elo.js";
import { computeTeamGoalStats, fetchGoalsPrediction } from "./lib/predictions/goalsModel.js";
import { fetchXgContext } from "./lib/xg.js";
import { computeAgreement } from "./lib/agreement.js";
import { fetchStandings } from "./lib/standings.js";

// This scraper runs on ONE recurring schedule — every 3 hours, all week
// (see .github/workflows/research.yml) — rather than the old separate
// Friday/Saturday/Sunday/wrap passes tied to fixed clock times. Real
// kickoff times shift week to week (early Saturday kickoffs, Monday night
// football, internationals moving the whole round around), so instead of
// guessing a fixed time-of-day per weekday, every run does the same four
// things in order: finalize anything that finished since the last run,
// create the next round once the current one is done, (re-)research every
// fixture that's now within RESEARCH_WINDOW_HOURS of its own real kickoff,
// and archive the round once everything in it is finished. Idempotent by
// design — running it again a few minutes early or late, or twice in a
// row, does nothing harmful.
const HARD_RULE_NEVER_FABRICATE = true; // documentation flag — see README "hard rules"

// A fixture starts getting (re-)researched once it's within this many
// hours of its own kickoff — close enough that team news, lineups, and
// published odds are meaningful — and keeps getting refreshed on every
// subsequent run up until kickoff, so the numbers stay current rather than
// being a single stale snapshot from 12h out. Before this window a fixture
// just sits as a placeholder ("Not yet analyzed"). Each refresh re-pulls
// every source fresh — if nothing about a match has actually changed
// upstream, the new pull naturally comes out the same as the old one;
// nothing here forces a prediction to change just because a run happened.
const RESEARCH_WINDOW_HOURS = 12;

function nowIct() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000);
}

function dayOfIct(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

function hoursUntil(kickoffIso, fromMs = Date.now()) {
  return (new Date(kickoffIso).getTime() - fromMs) / (60 * 60 * 1000);
}

async function researchFixture(f, teamStrengths, crestMap) {
  const [opta, win, soccervista, elo] = await Promise.all([
    fetchOptaPrediction(f.home, f.away),
    fetchWincomparatorPrediction(f.home, f.away),
    fetchSoccervistaPrediction(f.home, f.away),
    fetchEloPrediction(f.home, f.away),
  ]);
  // Not a network fetch — computed from this season's real results, which
  // were already fetched once for the whole run (see main()).
  const goals = fetchGoalsPrediction(f.home, f.away, teamStrengths);

  // Opta/Wincomparator/Elo/SoccerVista all contribute a 1X2 reading when
  // available (used for the win/draw/away agreement calculation). Over/
  // Under, Correct Score and Handicap come from the goals model (real
  // scoring data — see goalsModel.js for why that's more accurate here than
  // Elo alone) plus SoccerVista's own published picks, merged into "extras".
  const probs = [opta, win, soccervista?.prob, elo?.prob].filter(Boolean);
  const extras = [...(goals?.extras || []), ...(soccervista?.extras || [])];
  const { agreement, agreementNote, standout } = computeAgreement(probs, f.home, f.away);

  return {
    id: f.id,
    home: f.home,
    away: f.away,
    // f comes from a fresh DB row here (see main()), which won't carry crest
    // fields for a fixture created before team badges existed — crestMap is
    // built fresh from football-data.org every run, so this self-heals the
    // first time each fixture is (re-)researched.
    home_crest: crestMap?.get(f.home) ?? f.homeCrest ?? null,
    away_crest: crestMap?.get(f.away) ?? f.awayCrest ?? null,
    kickoff_local: f.kickoffLocal,
    status: "upcoming",
    score: null,
    probs,
    extras,
    standout,
    agreement,
    agreement_note: agreementNote,
    forebet_note: null,
    updated_at: new Date().toISOString(),
  };
}

function placeholderFixture(f) {
  return {
    id: f.id,
    home: f.home,
    away: f.away,
    home_crest: f.homeCrest || null,
    away_crest: f.awayCrest || null,
    kickoff_local: f.kickoffLocal,
    status: "upcoming",
    score: null,
    probs: [],
    extras: [],
    standout: { market: "—", pick: "Not yet analyzed", pct: null, source: null, note: "Checked closer to kickoff." },
    agreement: null,
    agreement_note: "Not yet analyzed — checked closer to kickoff.",
    forebet_note: null,
    updated_at: new Date().toISOString(),
  };
}

async function finalizeFinishedFixtures(currentRows, seasonFixtures) {
  const byId = new Map(seasonFixtures.map((f) => [f.id, f]));
  const updates = [];
  for (const row of currentRows) {
    if (row.status === "finished") continue;
    const fresh = byId.get(row.id);
    if (fresh && fresh.status === "finished") {
      updates.push({
        ...row,
        status: "finished",
        score: fresh.score,
        standout: { market: "—", pick: `Match complete — ${fresh.score}`, pct: null, source: null, note: "Result recorded for round completeness." },
        updated_at: new Date().toISOString(),
      });
    }
  }
  if (updates.length) {
    const { error } = await supabaseAdmin.from("matches").upsert(updates);
    if (error) throw error;
    console.log(`Finalized ${updates.length} finished fixture(s).`);
  }
  return updates.map((u) => u.id);
}

// Archives the previous round (if one exists) and creates the next one
// from the coming Fri–Sun window, as soon as the current round is either
// empty or entirely in the past. Every fixture starts as a placeholder —
// research happens later, per-fixture, once each one enters its own
// RESEARCH_WINDOW_HOURS window (see main()). Safe to call on every run:
// it's a no-op whenever a round is already in progress.
async function ensureRoundExists(seasonFixtures) {
  const { data: currentRows, error: readErr } = await supabaseAdmin.from("matches").select("*");
  if (readErr) throw readErr;

  const allPast = currentRows.length > 0 && currentRows.every((r) => new Date(r.kickoff_local) < new Date());
  if (currentRows.length > 0 && !allPast) {
    return false; // a round is already in progress — nothing to do
  }

  if (currentRows.length > 0) {
    const { data: metaRow } = await supabaseAdmin.from("meta").select("*").eq("id", "status").maybeSingle();
    await supabaseAdmin.from("archived_rounds").insert({
      round_label: metaRow?.round_label || "Premier League",
      matches: currentRows,
      archived_at: new Date().toISOString(),
    });
    await supabaseAdmin.from("matches").delete().neq("id", "__none__");
    console.log(`Archived ${currentRows.length} fixture(s) from the previous round.`);
  }

  const { start, end } = weekendWindow(nowIct());
  console.log(`Weekend window: ${start.toISOString()} to ${end.toISOString()}`);
  const weekendFixtures = seasonFixtures.filter((f) => {
    const t = new Date(f.kickoffLocal).getTime();
    return t >= start.getTime() && t < end.getTime();
  });
  if (weekendFixtures.length === 0) {
    console.warn("No fixtures found in that window yet — will check again next run.");
    return false;
  }

  const rows = weekendFixtures.map(placeholderFixture);
  const { error: upsertErr } = await supabaseAdmin.from("matches").upsert(rows);
  if (upsertErr) throw upsertErr;

  const firstDate = dayOfIct(weekendFixtures[0].kickoffLocal);
  const lastDate = dayOfIct(weekendFixtures[weekendFixtures.length - 1].kickoffLocal);
  await supabaseAdmin.from("meta").upsert({
    id: "status",
    round_label: `Premier League · ${firstDate} – ${lastDate}`,
    last_updated: new Date().toISOString(),
  });
  console.log(
    `New round created: ${rows.length} fixture(s) as placeholders — each gets researched automatically once it's ` +
      `within ${RESEARCH_WINDOW_HOURS}h of its own kickoff.`
  );
  return true;
}

// Archives the round once every fixture in it has finished (leaves it open
// if anything's still pending, e.g. a postponement).
async function archiveIfComplete() {
  const { data: freshRows, error } = await supabaseAdmin.from("matches").select("*");
  if (error) throw error;
  if (!freshRows || freshRows.length === 0) return;

  const stillUpcoming = freshRows.filter((r) => r.status !== "finished");
  if (stillUpcoming.length > 0) return;

  const { data: metaRow } = await supabaseAdmin.from("meta").select("*").eq("id", "status").maybeSingle();
  await supabaseAdmin.from("archived_rounds").insert({
    round_label: metaRow?.round_label || "Premier League",
    matches: freshRows,
    archived_at: new Date().toISOString(),
  });
  await supabaseAdmin.from("matches").delete().neq("id", "__none__");
  console.log(`Round complete — archived ${freshRows.length} fixture(s).`);
}

async function main() {
  const seasonFixtures = await fetchSeasonFixtures();
  console.log(
    `Fetched ${seasonFixtures.length} season fixture(s) total.` +
      (seasonFixtures.length
        ? ` First: ${seasonFixtures[0].kickoffLocal} (${seasonFixtures[0].home} vs ${seasonFixtures[0].away}). Last: ${seasonFixtures[seasonFixtures.length - 1].kickoffLocal}.`
        : "")
  );

  // 1. Finalize anything that finished since the last run.
  const { data: currentRows, error: readErr } = await supabaseAdmin.from("matches").select("*");
  if (readErr) throw readErr;
  if (currentRows.length) {
    await finalizeFinishedFixtures(currentRows, seasonFixtures);
  }

  // 2. Create the next round once the current one is done (or there isn't
  // one yet) and its fixtures are known from football-data.org.
  await ensureRoundExists(seasonFixtures);

  // 3. (Re-)research every fixture now inside its pre-kickoff window.
  const xgContext = await fetchXgContext();
  const xgTeamsCurrent = xgContext.current ? Object.keys(xgContext.current).length : 0;
  const xgTeamsPrevious = xgContext.previous ? Object.keys(xgContext.previous).length : 0;

  const teamStrengths = computeTeamGoalStats(seasonFixtures, xgContext);
  console.log(
    `Goals model: computed scoring strength for ${teamStrengths.teamsWithData} team(s) ` +
      `(league avg ${teamStrengths.leagueAvgGoals.toFixed(2)} goals/team/game so far). ` +
      `xG context: ${xgTeamsCurrent} team(s) with current-season Understat data, ` +
      `${xgTeamsPrevious} with last-season data for the early-season prior.` +
      (xgTeamsCurrent === 0 ? " (Understat unreachable or unparsed this run — falling back to goals-only, as designed.)" : "")
  );

  const { data: freshRows, error: freshErr } = await supabaseAdmin.from("matches").select("*");
  if (freshErr) throw freshErr;
  const toResearch = (freshRows || []).filter((r) => {
    if (r.status !== "upcoming") return false;
    const h = hoursUntil(r.kickoff_local);
    return h > 0 && h <= RESEARCH_WINDOW_HOURS;
  });

  // Team crest URLs, keyed by canonical team name — rebuilt fresh every run
  // from football-data.org (see fixtures.js) so even a fixture created
  // before team badges existed gets one the next time it's (re-)researched.
  const crestMap = new Map();
  for (const f of seasonFixtures) {
    if (f.homeCrest) crestMap.set(f.home, f.homeCrest);
    if (f.awayCrest) crestMap.set(f.away, f.awayCrest);
  }

  if (toResearch.length) {
    const researched = await Promise.all(
      toResearch.map((r) =>
        researchFixture({ id: r.id, home: r.home, away: r.away, kickoffLocal: r.kickoff_local }, teamStrengths, crestMap)
      )
    );
    const { error: upsertErr } = await supabaseAdmin.from("matches").upsert(researched);
    if (upsertErr) throw upsertErr;
    console.log(`(Re-)researched ${researched.length} fixture(s) inside their ${RESEARCH_WINDOW_HOURS}h pre-kickoff window.`);
  } else {
    console.log("Nothing currently inside its pre-kickoff research window.");
  }

  // Crest badges don't need to wait for a fixture's research window — the
  // URL is free, already fetched above for every fixture this season, and
  // updating it isn't a "re-research" (predictions/probs are untouched).
  // Backfill any fixture that's still missing one — e.g. created before
  // this feature existed — right away rather than waiting up to kickoff.
  // Skip anything just (re-)researched above; it already got a fresh crest.
  const toResearchIds = new Set(toResearch.map((r) => r.id));
  const crestBackfill = (freshRows || [])
    .filter((r) => !toResearchIds.has(r.id))
    .filter((r) => (!r.home_crest && crestMap.get(r.home)) || (!r.away_crest && crestMap.get(r.away)))
    .map((r) => ({
      ...r,
      home_crest: crestMap.get(r.home) || r.home_crest || null,
      away_crest: crestMap.get(r.away) || r.away_crest || null,
    }));
  if (crestBackfill.length) {
    const { error: crestErr } = await supabaseAdmin.from("matches").upsert(crestBackfill);
    if (crestErr) throw crestErr;
    console.log(`Backfilled crest badge(s) for ${crestBackfill.length} fixture(s) not otherwise touched this run.`);
  }

  // 4. Archive the round once every fixture in it has finished.
  await archiveIfComplete();

  // 5. Refresh the league table. Best-effort: a standings hiccup shouldn't
  // fail the whole run when fixtures/predictions already succeeded.
  try {
    const standingsRows = await fetchStandings();
    if (standingsRows.length) {
      await supabaseAdmin.from("standings").upsert({
        id: "current",
        rows: standingsRows,
        updated_at: new Date().toISOString(),
      });
      console.log(`Refreshed league table (${standingsRows.length} team(s)).`);
    } else {
      console.warn("Standings table came back empty — leaving the last known table in place.");
    }
  } catch (err) {
    console.warn("Standings refresh failed (non-fatal):", err.message || err);
  }

  await supabaseAdmin.from("meta").update({ last_updated: new Date().toISOString() }).eq("id", "status");
}

main().catch((err) => {
  console.error("Scraper run failed:", err);
  process.exit(1);
});
