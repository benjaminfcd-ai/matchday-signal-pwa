import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { fetchSeasonFixtures, weekendWindow, midweekWindow } from "./lib/fixtures.js";
import { computeTeamGoalStats } from "./lib/predictions/goalsModel.js";
import { computeOwnEloRatings } from "./lib/predictions/ownElo.js";
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
// FOUR competitions run side by side, each with its own round lifecycle,
// independently — Premier League, Champions League, Bundesliga, and La
// Liga (added Sept 2026 — see README's "Adding a league" section for how
// this was wired in) each have their own live round in the matches table
// at once, distinguished by each row's `competition` column, and one
// competition's round finishing early (or late), or hitting a scraper
// error, never blocks or delays any other competition's round.
//
// WHICH FIXTURES BECOME "A ROUND": this prefers each competition's own
// official matchday number (from football-data.org — see fixtures.js) over
// any calendar-day guess. That matters because a fixture doesn't always
// stay on its "usual" day — a match can get moved to a weekday for TV, a
// postponement gets replayed a few days later — but it keeps the same
// matchday number either way, so grouping by that number (see
// pickRoundFixtures() below) means a rescheduled fixture still lands in
// the right round instead of silently falling outside a fixed calendar
// window and never appearing on the site at all. The Fri–Sun / Mon–Thu
// calendar windows this project used to group by exclusively (see
// weekendWindow()/midweekWindow() in fixtures.js) are kept only as a
// FALLBACK, used when nothing upcoming has a matchday number — chiefly a
// Champions League knockout round (Round of 16 onward), which isn't
// numbered "matchday 1, 2, 3..." the way a league phase is. Bundesliga and
// La Liga are both single-table league seasons with no knockout stage, so
// in practice they should almost always have a matchday number available
// and rarely if ever need this fallback.
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

// Every domestic/continental competition this project tracks. Order here
// only affects log/console ordering — nothing structural depends on it.
// Adding a fifth competition means adding its code here, plus a URL/slug
// entry in each per-source file (see README's "Adding a league" section)
// — nothing else in this file needs to change, since every step below
// already loops over this list generically.
const COMPETITIONS = ["PL", "CL", "BL1", "PD"];
// Competitions whose fixture history feeds the shared goals model (see
// step 3 in main()) — deliberately NOT including "CL": Champions League
// fixtures mix clubs from many different domestic leagues (several of
// which this project doesn't otherwise track) at a different competitive
// level, so folding its scorelines into a domestic league's own average
// would corrupt that league's baseline rather than improve it. A Champions
// League fixture simply gets no goals-model reading — the same graceful
// "no data available" degrade as any other missing source, per this
// project's hard "never fabricate" rule.
const GOALS_MODEL_COMPETITIONS = ["PL", "BL1", "PD"];

function nowIct() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000);
}

function dayOfIct(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

function hoursUntil(kickoffIso, fromMs = Date.now()) {
  return (new Date(kickoffIso).getTime() - fromMs) / (60 * 60 * 1000);
}

// Mirrors pages/index.js's FAR_OUT_RESCHEDULE_DAYS/isFarOutReschedule (kept
// as a small local copy rather than a shared import — same pattern this
// project already uses elsewhere, e.g. metaId()/standingsId() vs the app's
// own copies). A fixture whose kickoff is still this many days out doesn't
// belong to whatever round it's nominally grouped under anymore — see
// archiveIfComplete() below for what that means for round completion, and
// keep this threshold in sync with the frontend's copy so "still holding
// this round open" and "still hidden from this round's page" always agree.
const FAR_OUT_RESCHEDULE_DAYS = 10;
function isFarOutReschedule(row) {
  return hoursUntil(row.kickoff_local) > FAR_OUT_RESCHEDULE_DAYS * 24;
}

// The meta table keeps the existing Premier League row's id ("status")
// completely unchanged — zero migration risk for the app's existing reads
// — and every other competition gets its own row at "status_<CODE>"
// instead of a schema restructure. Generic by construction, so a new
// competition needs no change here.
function metaId(competition) {
  return competition === "PL" ? "status" : `status_${competition}`;
}

function competitionLabel(competition) {
  if (competition === "PL") return "Premier League";
  if (competition === "CL") return "Champions League";
  if (competition === "BL1") return "Bundesliga";
  if (competition === "PD") return "La Liga";
  return competition;
}

// Champions League fixtures cluster midweek; every other competition this
// project tracks (Premier League, Bundesliga, La Liga) is a domestic
// league that plays its main round across the weekend — so this only needs
// to special-case CL, and any future weekend league added to COMPETITIONS
// above gets the right window automatically without a change here. This
// fallback matters far less than it used to now that matchday-based
// grouping (see pickRoundFixtures() below) is the primary method — see the
// top-of-file comment.
function windowForCompetition(competition, ref) {
  return competition === "CL" ? midweekWindow(ref) : weekendWindow(ref);
}

// Human-readable names for the football-data.org `stage` values that show
// up once matchday numbers run out (see the comment above). Only used as a
// label when matchday is null — an unmapped/unexpected stage value just
// falls back to the generic "Round" in the caller rather than crashing.
const STAGE_LABELS = {
  LEAGUE_STAGE: "League phase",
  GROUP_STAGE: "League phase",
  PLAYOFFS: "Knockout playoff round",
  PLAYOFF_ROUND_1: "Knockout playoff round",
  PLAYOFF_ROUND_2: "Knockout playoff round",
  LAST_64: "Round of 64",
  LAST_32: "Round of 32",
  LAST_16: "Round of 16",
  QUARTER_FINALS: "Quarter-finals",
  SEMI_FINALS: "Semi-finals",
  THIRD_PLACE: "Third-place play-off",
  FINAL: "Final",
  REGULAR_SEASON: "Regular season",
};
function stageLabel(stage) {
  return STAGE_LABELS[stage] || null;
}

// Picks which fixtures become "the next round" for this competition.
// Prefers the real matchday number (see the top-of-file comment); falls
// back to the old Fri–Sun/Mon–Thu calendar-window guess only when nothing
// upcoming carries a matchday number at all.
// `archivedIds` (added alongside the far-out-reschedule handling in
// archiveIfComplete()) is the set of fixture ids already sitting inside a
// PAST archived_rounds snapshot for this competition — see the comment on
// this parameter in ensureRoundExists() for the resurrection bug it exists
// to prevent. Defaults to an empty set so every other caller/behavior is
// unchanged.
function pickRoundFixtures(competition, seasonFixtures, ref, archivedIds = new Set()) {
  const upcomingWithMatchday = seasonFixtures.filter((f) => f.status === "upcoming" && f.matchday != null);

  if (upcomingWithMatchday.length > 0) {
    const nextMatchday = Math.min(...upcomingWithMatchday.map((f) => f.matchday));
    const windowFixtures = seasonFixtures
      .filter((f) => f.matchday === nextMatchday && !archivedIds.has(f.id))
      .sort((a, b) => new Date(a.kickoffLocal) - new Date(b.kickoffLocal));
    return { windowFixtures, matchday: nextMatchday, stage: windowFixtures[0]?.stage || null };
  }

  const { start, end } = windowForCompetition(competition, ref);
  const windowFixtures = seasonFixtures
    .filter((f) => {
      const t = new Date(f.kickoffLocal).getTime();
      return t >= start.getTime() && t < end.getTime() && !archivedIds.has(f.id);
    })
    .sort((a, b) => new Date(a.kickoffLocal) - new Date(b.kickoffLocal));
  return { windowFixtures, matchday: null, stage: windowFixtures[0]?.stage || null };
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

// seasonFixtures here is the COMBINED list across every competition — safe
// because every competition's fixture IDs are prefixed by that
// competition's own code (see fixtures.js) and can never collide, so one
// id -> fixture map works for all of them at once.
async function finalizeFinishedFixtures(currentRows, seasonFixtures) {
  const byId = new Map(seasonFixtures.map((f) => [f.id, f]));
  // Fallback index for a row whose id no longer matches any freshly-fetched
  // fixture — e.g. a team-name/alias correction (like the "AS Roma"/"Como"
  // fix on 2026-09-10) changes the derived id text even though it's still
  // the exact same real-world match, silently orphaning the row from the
  // by-id lookup above forever. Kickoff time doesn't depend on spelling, so
  // it's a far more stable anchor: keyed by (competition, exact kickoff
  // timestamp), and only used when it resolves to exactly ONE fixture — a
  // genuine same-time kickoff collision (several matches at once) is left
  // alone rather than risk finalizing the wrong one.
  const byKickoff = new Map();
  for (const f of seasonFixtures) {
    const key = `${f.competition}|${f.kickoffLocal}`;
    byKickoff.set(key, byKickoff.has(key) ? undefined : f); // undefined marks a collision
  }
  // Third fallback, tried last: (competition, home, away) alone, ignoring
  // both id and kickoff time. Added Sept 2026 after a real fixture (La
  // Liga, Real Sociedad vs Celta Vigo) got stuck showing "Live" for
  // several days — neither byId nor byKickoff resolved it, most likely
  // because its kickoff time drifted slightly (a reschedule) at the same
  // time as an id-affecting change, so both of the above missed it
  // simultaneously. Two clubs playing each other can't appear twice within
  // one competition's current round, so this is safe whenever it resolves
  // to exactly one fixture — same collision-guard pattern as byKickoff.
  const byTeams = new Map();
  for (const f of seasonFixtures) {
    const key = `${f.competition}|${f.home}|${f.away}`;
    byTeams.set(key, byTeams.has(key) ? undefined : f);
  }

  const updates = [];
  const stillUnresolved = [];
  for (const row of currentRows) {
    if (row.status === "finished") continue;
    const fresh =
      byId.get(row.id) ||
      byKickoff.get(`${row.competition}|${row.kickoff_local}`) ||
      byTeams.get(`${row.competition}|${row.home}|${row.away}`);
    if (fresh && fresh.status === "finished") {
      updates.push({
        ...row,
        status: "finished",
        score: fresh.score,
        standout: { market: "—", pick: `Match complete — ${fresh.score}`, pct: null, source: null, note: "Result recorded for round completeness." },
        updated_at: new Date().toISOString(),
      });
    } else if (fresh && fresh.status === "postponed") {
      // Real postponement (or suspension/cancellation — see fixtures.js) —
      // stop treating this row as "upcoming at kickoff_local", since that
      // time is now stale. Doesn't touch probs/extras, so if it later gets
      // rescheduled and researched again under a fresh matchday pass, the
      // old readings just get overwritten the normal way.
      updates.push({
        ...row,
        status: "postponed",
        standout: { market: "—", pick: "Postponed", pct: null, source: null, note: "New date not yet confirmed." },
        updated_at: new Date().toISOString(),
      });
    } else if (
      fresh &&
      fresh.status === "upcoming" &&
      (fresh.kickoffLocal !== row.kickoff_local || row.status === "postponed")
    ) {
      // A genuine reschedule to a new date/time while still "upcoming" —
      // covers two real cases: (1) a fixture that skipped straight from its
      // old kickoff to a newly-confirmed one without football-data.org ever
      // reporting an intermediate POSTPONED status in between (this is what
      // actually happened to La Liga's Levante vs Athletic Club — it never
      // showed as postponed here, it just sat stale, because this branch
      // didn't exist yet), and (2) a row THIS project had already marked
      // "postponed" that has now been given a confirmed new date, matching
      // the behavior promised in fixtures.js's POSTPONED_STATUSES comment.
      // Either way the fix is the same: adopt the fresh kickoff time so the
      // site stops showing a stale "Live"/"result pending" badge for a
      // match that's actually scheduled again in the future — it re-enters
      // its own RESEARCH_WINDOW_HOURS window automatically once that new
      // date is close (see main()), no different from any other fixture.
      updates.push({
        ...row,
        status: "upcoming",
        kickoff_local: fresh.kickoffLocal,
        home_crest: fresh.homeCrest || row.home_crest,
        away_crest: fresh.awayCrest || row.away_crest,
        // A row that had been sitting as "postponed" carries a stale
        // "Postponed" standout box and no probs — clear those out to an
        // honest "not yet analyzed" placeholder rather than leaving
        // postponement text showing under a match that's upcoming again.
        // A row that was never postponed (just silently stale) keeps its
        // existing standout/probs untouched, since those are still
        // meaningful predictions for the same fixture.
        ...(row.status === "postponed"
          ? {
              standout: { market: "—", pick: "Not yet analyzed", pct: null, source: null, note: "Rescheduled — checked closer to the new kickoff." },
              probs: [],
              extras: [],
              agreement: null,
              agreement_note: "Rescheduled — checked closer to the new kickoff.",
            }
          : {}),
        updated_at: new Date().toISOString(),
      });
    } else if (row.status !== "postponed" && hoursUntil(row.kickoff_local) < -3) {
      // Kickoff was more than 3 hours ago and this row still can't be
      // resolved to a finished (or postponed/rescheduled) fixture by id,
      // kickoff time, or team names — flag it instead of failing silently,
      // so a fixture stuck showing "Live" on the site has a matching line
      // in these logs to investigate (either football-data.org hasn't
      // marked it FINISHED yet, or it's genuinely dropped out of the
      // fetched fixture list). A row already "postponed" is excluded here
      // deliberately — its stored kickoff_local is expected to be stale
      // until a real reschedule is found above, so it isn't a bug worth
      // logging every run.
      stillUnresolved.push(`${row.home} vs ${row.away} (${row.competition}, id=${row.id}, kickoff=${row.kickoff_local})`);
    }
  }
  if (updates.length) {
    const { error } = await supabaseAdmin.from("matches").upsert(updates);
    if (error) throw error;
    console.log(`Finalized ${updates.length} finished fixture(s).`);
  }
  if (stillUnresolved.length) {
    console.warn(
      `${stillUnresolved.length} fixture(s) are well past kickoff but still not resolved to "finished":\n  ` +
        stillUnresolved.join("\n  ")
    );
  }
  return updates.map((u) => u.id);
}

// Creates the next round for THIS competition from its coming window
// (weekend for PL/BL1/PD, midweek for CL), but ONLY once the table is
// genuinely empty for that competition — i.e. after archiveIfComplete() has
// already retired the previous round because every fixture in it actually
// finished. Every fixture starts as a placeholder — research happens
// later, per-fixture, once each one enters its own RESEARCH_WINDOW_HOURS
// window (see main()). Filters everything by `competition` so every
// competition's round can live in the matches table at the same time
// without interfering with each other.
//
// IMPORTANT: this function used to also archive-and-recreate a round on its
// own whenever every row's kickoff time had passed ("allPast"), regardless
// of whether those fixtures were actually marked "finished". That was a
// bug, not a safety net: a fixture can be past kickoff but still
// "upcoming" for a while (football-data.org hasn't posted FINISHED yet, or
// finalizeFinishedFixtures() hasn't matched it this run) — and "now" can
// still fall inside the SAME weekend/midweek window as those very
// fixtures, so the "next" round computed here was actually identical to
// the one just deleted. The result was a destructive reset-and-rebuild
// loop, once per run: it wiped every in-progress row back to a blank
// "Not yet analyzed" placeholder (which is why finished-looking matches
// kept showing "Live" forever) and created a fresh duplicate
// archived_rounds entry each time. Round retirement is now handled
// EXCLUSIVELY by archiveIfComplete() (step 4 in main()), which only
// archives once every fixture's status is actually "finished" — this
// function only ever creates, never archives.
async function ensureRoundExists(competition, seasonFixtures) {
  const { data: currentRows, error: readErr } = await supabaseAdmin
    .from("matches")
    .select("*")
    .eq("competition", competition);
  if (readErr) throw readErr;

  if (currentRows.length > 0) {
    return false; // a round already exists for this competition — nothing to do, whether it's finished or not (archiveIfComplete handles retirement)
  }

  // Every fixture id already sitting inside a PAST archived_rounds snapshot
  // for this competition — passed into pickRoundFixtures() so it can never
  // pick one of them back up. Without this guard, a fixture that shares its
  // matchday number with an already-graded round — a postponed fixture
  // finally given a new date, or a far-out reschedule left out of the
  // archive on purpose (see archiveIfComplete() below) — would, the moment
  // it re-enters `upcomingWithMatchday`, make pickRoundFixtures() treat that
  // whole matchday as "the next round" again and pull every already-
  // archived fixture sharing that number back in too. Those then get mapped
  // through placeholderFixture() below, which unconditionally sets
  // `status: "upcoming"` — silently overwriting graded results that are
  // sitting safely in archived_rounds with blank "Not yet analyzed" rows.
  // This is exactly the class of bug documented at the top of
  // ensureRoundExists() below (the old "allPast" auto-archive-and-recreate
  // logic) — same failure mode, different trigger.
  const { data: archivedRows, error: archErr } = await supabaseAdmin
    .from("archived_rounds")
    .select("matches")
    .eq("competition", competition);
  if (archErr) throw archErr;
  const archivedIds = new Set((archivedRows || []).flatMap((r) => (r.matches || []).map((m) => m.id)));

  const { windowFixtures, matchday, stage } = pickRoundFixtures(competition, seasonFixtures, nowIct(), archivedIds);
  console.log(
    matchday != null
      ? `${competitionLabel(competition)} next round: Matchday ${matchday} (${windowFixtures.length} fixture(s))`
      : `${competitionLabel(competition)} next round: no matchday number available — using calendar-window fallback (${windowFixtures.length} fixture(s), stage=${stage || "unknown"})`
  );
  if (windowFixtures.length === 0) {
    console.warn(`No ${competitionLabel(competition)} fixtures found for the next round yet — will check again next run.`);
    return false;
  }

  // Guard against recreating a round whose real-world fixtures have ALL
  // already kicked off. With matchday-based selection (the normal case
  // now) this mostly can't happen — pickRoundFixtures() only ever picks a
  // matchday that still has at least one fixture in "upcoming" status, and
  // once every one of a round's fixtures is actually "finished" it drops
  // out of that pool on its own, so the next call naturally advances to
  // the next matchday instead of re-selecting the same one. It stays as a
  // safety net for the calendar-window FALLBACK path though — that's the
  // scenario this guard was originally written for: the old Fri-Sun/Mon-
  // Thu window logic re-resolves to "the window containing (or immediately
  // preceding) now" for every call throughout that period, so the instant
  // `matches` is empty for a competition for ANY reason while "now" still
  // falls in that same period — right after archiveIfComplete() retires a
  // finished round, or an out-of-band cleanup like a manual archived_rounds
  // deletion — this function would otherwise recreate the exact same,
  // already-concluded round from scratch as blank "Not yet analyzed"
  // placeholders, producing a fresh duplicate archived_rounds entry every
  // single cycle until the calendar rolls into a genuinely new window.
  const nowMs = nowIct().getTime();
  const allAlreadyKickedOff = windowFixtures.every((f) => new Date(f.kickoffLocal).getTime() < nowMs);
  if (allAlreadyKickedOff) {
    console.warn(
      `${competitionLabel(competition)}: every fixture in the current window has already kicked off — ` +
        `this would just recreate an already-concluded round. Skipping; will check again next run once the ` +
        `calendar rolls into a window with genuinely upcoming fixtures.`
    );
    return false;
  }

  const rows = windowFixtures.map(placeholderFixture);
  const { error: upsertErr } = await supabaseAdmin.from("matches").upsert(rows);
  if (upsertErr) throw upsertErr;

  const firstDate = dayOfIct(windowFixtures[0].kickoffLocal);
  const lastDate = dayOfIct(windowFixtures[windowFixtures.length - 1].kickoffLocal);
  // Matchday number in the label when we have one — it's a clearer,
  // more stable identifier than a date range now that a round's fixtures
  // aren't guaranteed to fall within one neat calendar window (that's the
  // whole point of grouping by matchday instead — see the top-of-file
  // comment). Falls back to a human stage name (or a generic "Round") for
  // the rare calendar-window-fallback case instead.
  const roundLabel = matchday != null
    ? `${competitionLabel(competition)} · Matchday ${matchday} · ${firstDate} – ${lastDate}`
    : `${competitionLabel(competition)} · ${stageLabel(stage) || "Round"} · ${firstDate} – ${lastDate}`;
  await supabaseAdmin.from("meta").upsert({
    id: metaId(competition),
    round_label: roundLabel,
    last_updated: new Date().toISOString(),
  });
  console.log(
    `New ${competitionLabel(competition)} round created (${roundLabel}): ${rows.length} fixture(s) as placeholders — each gets researched automatically once it's ` +
      `within ${RESEARCH_WINDOW_HOURS}h of its own kickoff.`
  );
  return true;
}

// Archives this competition's round once every fixture in it is DECIDED —
// meaning "finished" or "postponed" (see fixtures.js and
// finalizeFinishedFixtures() above for what "postponed" covers). A
// postponed fixture doesn't hold the round open the way it used to: it's
// left out of the archived snapshot entirely (never shown in "Past
// rounds" — see pages/index.js and README's "Postponed fixtures" note)
// and just drops out of the live table along with the rest of the round
// when it's deleted below. It isn't lost — if/when football-data.org gives
// it a confirmed new date, it comes back through the normal pipeline as
// its own small round once it's actually played (see the comment on
// POSTPONED_STATUSES in fixtures.js for why this is safe).
async function archiveIfComplete(competition) {
  const { data: freshRows, error } = await supabaseAdmin.from("matches").select("*").eq("competition", competition);
  if (error) throw error;
  if (!freshRows || freshRows.length === 0) return;

  // A fixture that's still technically "upcoming" but has been rescheduled
  // well past the rest of its round (see finalizeFinishedFixtures()'s
  // reschedule branch, and pages/index.js's matching frontend rule) gets
  // the exact same treatment a genuinely postponed fixture already gets
  // below: it doesn't hold the round open, and it's left out of the
  // archived snapshot rather than waited on indefinitely. It isn't lost —
  // it drops out of the live table along with the rest of the round when
  // everything is deleted below, and comes back through the normal
  // pipeline as its own small round once pickRoundFixtures() picks it up
  // again (safely, thanks to the archivedIds guard in ensureRoundExists()
  // above — it can never drag the fixtures archived here back with it).
  const stillUndecided = freshRows.filter((r) => r.status === "upcoming" && !isFarOutReschedule(r));
  if (stillUndecided.length > 0) return;

  const playedRows = freshRows.filter((r) => r.status === "finished");
  const postponedRows = freshRows.filter((r) => r.status === "postponed");
  const farOutRows = freshRows.filter((r) => r.status === "upcoming" && isFarOutReschedule(r));
  // Everything in the round is postponed/far-out-rescheduled and nothing
  // has actually been played yet — extremely rare (e.g. a whole matchday
  // moved for an international break), but there's nothing real to archive
  // here, so just leave the round open rather than writing an empty
  // archived entry.
  if (playedRows.length === 0) return;

  const { data: metaRow } = await supabaseAdmin.from("meta").select("*").eq("id", metaId(competition)).maybeSingle();
  await supabaseAdmin.from("archived_rounds").insert({
    round_label: metaRow?.round_label || competitionLabel(competition),
    matches: playedRows,
    competition,
    archived_at: new Date().toISOString(),
  });
  await supabaseAdmin.from("matches").delete().eq("competition", competition);
  console.log(
    `${competitionLabel(competition)} round complete — archived ${playedRows.length} fixture(s)` +
      (postponedRows.length
        ? ` (${postponedRows.length} postponed fixture(s) left out of the archive — will resurface once rescheduled)`
        : "") +
      (farOutRows.length
        ? ` (${farOutRows.length} far-out-rescheduled fixture(s) left out of the archive — will resurface closer to their new kickoff)`
        : "") +
      "."
  );
}

async function main() {
  const fixturesByCompetition = {};
  await Promise.all(
    COMPETITIONS.map(async (competition) => {
      fixturesByCompetition[competition] = await fetchSeasonFixtures(competition);
    })
  );
  const seasonFixtures = COMPETITIONS.flatMap((c) => fixturesByCompetition[c]);
  console.log(
    COMPETITIONS.map((c) => `${fixturesByCompetition[c].length} ${competitionLabel(c)}`).join(", ") +
      ` season fixture(s) fetched.`
  );

  // 1. Finalize anything that finished since the last run (every
  // competition at once — one combined read, since each row already
  // carries its own `competition`).
  const { data: currentRows, error: readErr } = await supabaseAdmin.from("matches").select("*");
  if (readErr) throw readErr;
  if (currentRows.length) {
    await finalizeFinishedFixtures(currentRows, seasonFixtures);
  }

  // 2. Create the next round for each competition once its current one is
  // done (or there isn't one yet) and its fixtures are known from
  // football-data.org. Independent per competition — see ensureRoundExists.
  for (const competition of COMPETITIONS) {
    await ensureRoundExists(competition, fixturesByCompetition[competition]);
  }

  // 3. (Re-)research every fixture (any competition) now inside its
  // pre-kickoff window.
  const xgContext = await fetchXgContext(GOALS_MODEL_COMPETITIONS);
  for (const competition of GOALS_MODEL_COMPETITIONS) {
    const c = xgContext[competition] || {};
    const cur = c.current ? Object.keys(c.current).length : 0;
    const prev = c.previous ? Object.keys(c.previous).length : 0;
    console.log(
      `xG context (${competitionLabel(competition)}): ${cur} team(s) with current-season Understat data, ` +
        `${prev} with last-season data for the early-season prior.` +
        (cur === 0 ? " (Understat unreachable or unparsed this run — falling back to goals-only, as designed.)" : "")
    );
  }

  // The goals model runs across every domestic league this project tracks
  // (NOT Champions League — see GOALS_MODEL_COMPETITIONS above for why),
  // each with its own league-average baseline computed independently, then
  // merged into one lookup by team name — see goalsModel.js.
  const goalsFixtures = {};
  for (const competition of GOALS_MODEL_COMPETITIONS) goalsFixtures[competition] = fixturesByCompetition[competition];
  const teamStrengths = computeTeamGoalStats(goalsFixtures, xgContext);
  console.log(
    `Goals model: computed scoring strength for ${teamStrengths.teamsWithData} team(s) across ${GOALS_MODEL_COMPETITIONS.length} league(s) — ` +
      Object.entries(teamStrengths.byCompetition)
        .map(([c, s]) => `${competitionLabel(c)}: ${s.teamsWithData} team(s), avg ${s.leagueAvgGoals.toFixed(2)} goals/team/game`)
        .join("; ")
  );

  // Our Elo (see ownElo.js) — computed ONCE per run from every finished
  // fixture across EVERY competition (a club's Champions League results
  // feed the same rating its domestic-league results do), then passed into
  // every researchFixture() call below, the same way teamStrengths is.
  const ownEloRatings = computeOwnEloRatings(seasonFixtures);
  console.log(`Our Elo: computed rating(s) for ${Object.keys(ownEloRatings).length} team(s) with at least one finished match this season.`);

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
  // Built from every competition's season fixtures at once.
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
          crestMap,
          ownEloRatings
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
  for (const competition of COMPETITIONS) {
    await archiveIfComplete(competition);
  }

  // 5. Refresh the league table for each competition. Best-effort and
  // independent per competition: a standings hiccup for one shouldn't fail
  // the whole run, and shouldn't block any other competition's table either
  // — same "current" row id the app has always read for Premier League
  // (untouched), plus a "current_<CODE>" row for every other competition
  // (see standings.js — it's fetched the same way for all of them).
  for (const competition of COMPETITIONS) {
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

  // A no-op for any competition whose meta row doesn't exist yet — that
  // row's own upsert (see ensureRoundExists) is what first creates it, so
  // an update against a row that doesn't exist yet simply matches nothing.
  for (const competition of COMPETITIONS) {
    await supabaseAdmin.from("meta").update({ last_updated: new Date().toISOString() }).eq("id", metaId(competition));
  }
}

main().catch((err) => {
  console.error("Scraper run failed:", err);
  process.exit(1);
});
