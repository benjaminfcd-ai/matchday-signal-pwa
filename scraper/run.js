import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { fetchSeasonFixtures, weekendWindow, midweekWindow } from "./lib/fixtures.js";
import { computeTeamGoalStats } from "./lib/predictions/goalsModel.js";
import { fetchXgContext } from "./lib/xg.js";
import { researchFixture } from "./lib/research.js";
import { fetchStandings } from "./lib/standings.js";

// This scraper runs on ONE recurring schedule — every 3 hours, all week
// (see .github/workflows/research.yml) — rather than the old separate
// Friday/Saturday/Sunday/wrap passes tied to fixed clock times. Real
// kickoff times shift week to week (early Saturday kickoffs, Monday night
// football, internationals moving the whole round around), so instead of
// guessing a fixed time-of-day per weekday, every run does the same four
// things in order, for EACH competition independently: finalize anything
// that finished since the last run, create the next round once the
// current one is done, (re-)research every fixture that's now within
// RESEARCH_WINDOW_HOURS of its own real kickoff, and archive the round
// once everything in it is finished. Idempotent by design — running it
// again a few minutes early or late, or twice in a row, does nothing
// harmful.
//
// Two competitions run side by side, each with its own round lifecycle: the
// Premier League ("PL") uses the Fri–Sun weekend window; the Champions
// League ("CL") uses the Mon–Thu midweek window (see fixtures.js) since CL
// fixtures cluster on weekdays instead. They're independent — a live PL
// round and a live CL round coexist in the matches table at once,
// distinguished by each row's `competition` column, and a live CL round
// finishing early (or late) never blocks or delays the PL round, or vice
// versa.
//
// This 12-hour, per-fixture window is a deliberate design choice, not a
// limitation: every fixture in a round activates independently, 12 hours
// before ITS OWN kickoff — never earlier, and never all at once for the
// whole round. That stays true even when the prediction formula itself
// changes. For the rare occasion a formula change needs to reach fixtures
// that were already researched under the old formula, without waiting for
// each one's own window, use the separate, manually-triggered
// refresh-existing.js instead of changing this schedule — see that file.
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

// The meta table keeps the existing Premier League row's id ("status")
// completely unchanged — zero migration risk for the app's existing reads
// — and Champions League gets its own row at a new id instead of a schema
// restructure.
function metaId(competition) {
  return competition === "PL" ? "status" : `status_${competition}`;
}

function competitionLabel(competition) {
  if (competition === "PL") return "Premier League";
  if (competition === "CL") return "Champions League";
  return competition;
}

function windowForCompetition(competition, ref) {
  return competition === "CL" ? midweekWindow(ref) : weekendWindow(ref);
}

function placeholderFixture(f) {
  return {
    id: f.id,
    competition: f.competition,
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

// seasonFixtures here is the COMBINED list across both competitions — safe
// because PL and CL fixture IDs can never collide (see fixtures.js), so one
// id -> fixture map works for both at once.
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

// Archives the previous round for THIS competition (if one exists) and
// creates the next one from its coming window (weekend for PL, midweek for
// CL), as soon as the current round for this competition is either empty
// or entirely in the past. Every fixture starts as a placeholder — research
// happens later, per-fixture, once each one enters its own
// RESEARCH_WINDOW_HOURS window (see main()). Safe to call on every run:
// it's a no-op whenever a round for this competition is already in
// progress. Filters everything by `competition` so a PL and a CL round can
// live in the matches table at the same time without interfering with each
// other.
async function ensureRoundExists(competition, seasonFixtures) {
  const { data: currentRows, error: readErr } = await supabaseAdmin
    .from("matches")
    .select("*")
    .eq("competition", competition);
  if (readErr) throw readErr;

  const allPast = currentRows.length > 0 && currentRows.every((r) => new Date(r.kickoff_local) < new Date());
  if (currentRows.length > 0 && !allPast) {
    return false; // a round is already in progress for this competition — nothing to do
  }

  if (currentRows.length > 0) {
    const { data: metaRow } = await supabaseAdmin.from("meta").select("*").eq("id", metaId(competition)).maybeSingle();
    await supabaseAdmin.from("archived_rounds").insert({
      round_label: metaRow?.round_label || competitionLabel(competition),
      matches: currentRows,
      competition,
      archived_at: new Date().toISOString(),
    });
    await supabaseAdmin.from("matches").delete().eq("competition", competition);
    console.log(`Archived ${currentRows.length} ${competitionLabel(competition)} fixture(s) from the previous round.`);
  }

  const { start, end } = windowForCompetition(competition, nowIct());
  console.log(`${competitionLabel(competition)} window: ${start.toISOString()} to ${end.toISOString()}`);
  const windowFixtures = seasonFixtures.filter((f) => {
    const t = new Date(f.kickoffLocal).getTime();
    return t >= start.getTime() && t < end.getTime();
  });
  if (windowFixtures.length === 0) {
    console.warn(`No ${competitionLabel(competition)} fixtures found in that window yet — will check again next run.`);
    return false;
  }

  const rows = windowFixtures.map(placeholderFixture);
  const { error: upsertErr } = await supabaseAdmin.from("matches").upsert(rows);
  if (upsertErr) throw upsertErr;

  const firstDate = dayOfIct(windowFixtures[0].kickoffLocal);
  const lastDate = dayOfIct(windowFixtures[windowFixtures.length - 1].kickoffLocal);
  await supabaseAdmin.from("meta").upsert({
    id: metaId(competition),
    round_label: `${competitionLabel(competition)} · ${firstDate} – ${lastDate}`,
    last_updated: new Date().toISOString(),
  });
  console.log(
    `New ${competitionLabel(competition)} round created: ${rows.length} fixture(s) as placeholders — each gets researched automatically once it's ` +
      `within ${RESEARCH_WINDOW_HOURS}h of its own kickoff.`
  );
  return true;
}

// Archives this competition's round once every fixture in it has finished
// (leaves it open if anything's still pending, e.g. a postponement).
async function archiveIfComplete(competition) {
  const { data: freshRows, error } = await supabaseAdmin.from("matches").select("*").eq("competition", competition);
  if (error) throw error;
  if (!freshRows || freshRows.length === 0) return;

  const stillUpcoming = freshRows.filter((r) => r.status !== "finished");
  if (stillUpcoming.length > 0) return;

  const { data: metaRow } = await supabaseAdmin.from("meta").select("*").eq("id", metaId(competition)).maybeSingle();
  await supabaseAdmin.from("archived_rounds").insert({
    round_label: metaRow?.round_label || competitionLabel(competition),
    matches: freshRows,
    competition,
    archived_at: new Date().toISOString(),
  });
  await supabaseAdmin.from("matches").delete().eq("competition", competition);
  console.log(`${competitionLabel(competition)} round complete — archived ${freshRows.length} fixture(s).`);
}

async function main() {
  const [plFixtures, clFixtures] = await Promise.all([
    fetchSeasonFixtures("PL"),
    fetchSeasonFixtures("CL"),
  ]);
  const seasonFixtures = [...plFixtures, ...clFixtures];
  console.log(
    `Fetched ${plFixtures.length} Premier League and ${clFixtures.length} Champions League season fixture(s).`
  );

  // 1. Finalize anything that finished since the last run (both
  // competitions at once — one combined read, since each row already
  // carries its own `competition`).
  const { data: currentRows, error: readErr } = await supabaseAdmin.from("matches").select("*");
  if (readErr) throw readErr;
  if (currentRows.length) {
    await finalizeFinishedFixtures(currentRows, seasonFixtures);
  }

  // 2. Create the next round for each competition once its current one is
  // done (or there isn't one yet) and its fixtures are known from
  // football-data.org. Independent per competition — see ensureRoundExists.
  await ensureRoundExists("PL", plFixtures);
  await ensureRoundExists("CL", clFixtures);

  // 3. (Re-)research every fixture (either competition) now inside its
  // pre-kickoff window.
  const xgContext = await fetchXgContext();
  const xgTeamsCurrent = xgContext.current ? Object.keys(xgContext.current).length : 0;
  const xgTeamsPrevious = xgContext.previous ? Object.keys(xgContext.previous).length : 0;

  // The goals model is built from Premier League results only (see
  // goalsModel.js) — passing plFixtures rather than the combined list keeps
  // its league-average baseline meaningful, instead of diluting it with
  // Champions League scorelines it was never designed around. A Champions
  // League fixture just gets no goals-model reading — the same graceful
  // "no data available" degrade as any other missing source, per this
  // project's hard "never fabricate" rule.
  const teamStrengths = computeTeamGoalStats(plFixtures, xgContext);
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
  // Built from both competitions' season fixtures at once.
  const crestMap = new Map();
  for (const f of seasonFixtures) {
    if (f.homeCrest) crestMap.set(f.home, f.homeCrest);
    if (f.awayCrest) crestMap.set(f.away, f.awayCrest);
  }

  if (toResearch.length) {
    const researched = await Promise.all(
      toResearch.map((r) =>
        researchFixture(
          { id: r.id, competition: r.competition, home: r.home, away: r.away, kickoffLocal: r.kickoff_local },
          teamStrengths,
          crestMap
        )
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

  // 4. Archive each competition's round once every fixture in it has
  // finished.
  await archiveIfComplete("PL");
  await archiveIfComplete("CL");

  // 5. Refresh the league table for each competition. Best-effort and
  // independent per competition: a standings hiccup for one shouldn't fail
  // the whole run, and shouldn't block the other competition's table either
  // — same "current" row id the app has always read for Premier League
  // (untouched), plus a new "current_CL" row for the Champions League
  // league-phase table (see standings.js — it's fetched the same way).
  for (const competition of ["PL", "CL"]) {
    try {
      const standingsRows = await fetchStandings(competition);
      if (standingsRows.length) {
        await supabaseAdmin.from("standings").upsert({
          id: competition === "PL" ? "current" : `current_${competition}`,
          competition,
          rows: standingsRows,
          updated_at: new Date().toISOString(),
        });
        console.log(`Refreshed ${competitionLabel(competition)} table (${standingsRows.length} team(s)).`);
      } else {
        console.warn(`${competitionLabel(competition)} standings came back empty — leaving the last known table in place.`);
      }
    } catch (err) {
      console.warn(`${competitionLabel(competition)} standings refresh failed (non-fatal):`, err.message || err);
    }
  }

  await supabaseAdmin.from("meta").update({ last_updated: new Date().toISOString() }).eq("id", "status");
  // A no-op until the first Champions League round is ever created — that
  // round's own upsert (see ensureRoundExists) is what first creates this
  // row, so an update against a row that doesn't exist yet simply matches
  // nothing.
  await supabaseAdmin.from("meta").update({ last_updated: new Date().toISOString() }).eq("id", "status_CL");
}

main().catch((err) => {
  console.error("Scraper run failed:", err);
  process.exit(1);
});
