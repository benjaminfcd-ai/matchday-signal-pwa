import { canonicalTeam, slugify } from "./teams.js";

// football-data.org's free tier (requires a free API token — see README) —
// reliable structured fixture/score data, so the app's core schedule never
// depends on scraping a page that might change its layout.
//
// NOTE: this project originally used TheSportsDB's shared public "test" key
// ("3"). That key turned out to only ever return a handful of demo/sample
// events per league — not the real current-season schedule — so it silently
// produced "no fixtures found" for real weeks. football-data.org's free tier
// requires a one-time signup but actually returns the real data.
const API_BASE = "https://api.football-data.org/v4";
// football-data.org's own competition codes — both are on the free tier
// (confirmed: football-data.org's published free-tier competition list
// includes the UEFA Champions League alongside the "big 5" domestic
// leagues), so no second API key or paid plan is needed for CL support.
const COMPETITION_CODES = { PL: "PL", CL: "CL", BL1: "BL1", PD: "PD" };
const POSTPONED_STATUSES = new Set(["POSTPONED", "SUSPENDED", "CANCELLED"]);

function toIctIso(utcDateIso) {
  // utcDateIso is an ISO string with a Z, e.g. "2026-09-05T19:00:00Z".
  const utcMs = new Date(utcDateIso).getTime();
  const ictMs = utcMs + 7 * 60 * 60 * 1000;
  const d = new Date(ictMs);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+07:00`
  );
}

/**
 * Fetch every fixture for the current season, for the given competition,
 * from football-data.org, mapped into this project's match shape (minus
 * predictions, which come from separate scrapers). Returns ALL fixtures for
 * the season — callers filter down to the window (weekend or midweek) they
 * care about.
 *
 * competition: "PL" (default, unchanged), "CL", "BL1" (Bundesliga), or "PD"
 * (La Liga). PL fixture IDs keep their exact original format (slug +
 * dateTag) — untouched, so existing rows never change ID and never
 * duplicate on upsert. Every other competition gets its own lowercase code
 * as a prefix on that same slug (e.g. "cl-...", "bl1-...", "pd-...") so no
 * two competitions' IDs can ever collide, even for a fixture that happens
 * to share a slug (e.g. two same-named clubs meeting on the same date in
 * different competitions).
 */
export async function fetchSeasonFixtures(competition = "PL") {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    throw new Error(
      "FOOTBALL_DATA_TOKEN must be set (as a GitHub Actions secret) — sign up free at football-data.org/client/register"
    );
  }
  const code = COMPETITION_CODES[competition] || competition;
  const url = `${API_BASE}/competitions/${code}/matches`;
  const res = await fetch(url, { headers: { "X-Auth-Token": token } });
  if (!res.ok) throw new Error(`football-data.org fixtures request failed for ${competition}: ${res.status}`);
  const data = await res.json();
  const matches = data.matches || [];

  return matches
    .filter((m) => m.utcDate)
    .map((m) => {
      const home = canonicalTeam(m.homeTeam?.name || m.homeTeam?.shortName || "");
      const away = canonicalTeam(m.awayTeam?.name || m.awayTeam?.shortName || "");
      const finished = m.status === "FINISHED";
      // football-data.org's own status values (SCHEDULED, TIMED, IN_PLAY,
      // PAUSED, FINISHED, POSTPONED, SUSPENDED, CANCELLED, AWARDED) collapse
      // into three buckets this project actually distinguishes.
      // POSTPONED/SUSPENDED/CANCELLED are all treated the same way — from
      // this project's side the actionable fact is identical either way:
      // this fixture is NOT going to finish on its originally scheduled
      // date, so its stored kickoff time is now stale and it shouldn't
      // block its round from wrapping up (see run.js's
      // finalizeFinishedFixtures() and archiveIfComplete()). If a
      // postponed match later gets a confirmed new date, football-data.org
      // flips its status back to SCHEDULED/TIMED on its own, and it simply
      // reappears here as an ordinary "upcoming" fixture again next run.
      const postponed = !finished && POSTPONED_STATUSES.has(m.status);
      const homeScore = m.score?.fullTime?.home;
      const awayScore = m.score?.fullTime?.away;
      const dateTag = m.utcDate.slice(0, 10).replace(/-/g, "").slice(2);
      const slug = slugify(home, away) + "-" + dateTag;
      return {
        id: competition === "PL" ? slug : `${competition.toLowerCase()}-${slug}`,
        competition,
        home,
        away,
        // football-data.org returns each club's crest URL right alongside the
        // fixture — free, and already fetched for the schedule itself, so no
        // extra request or new dependency is needed to show team badges.
        homeCrest: m.homeTeam?.crest || null,
        awayCrest: m.awayTeam?.crest || null,
        kickoffLocal: toIctIso(m.utcDate),
        status: finished ? "finished" : postponed ? "postponed" : "upcoming",
        score: finished && homeScore != null && awayScore != null
          ? `${homeScore}–${awayScore}`
          : null,
        // The competition's own official round number (an integer, e.g. 4)
        // for a league-phase match, or null for a knockout-stage match that
        // isn't numbered that way (see `stage` below). This is what run.js
        // now uses to group fixtures into "a round" — the organizer's own
        // grouping, rather than guessing from which calendar day a fixture
        // happens to fall on. That matters because a fixture doesn't always
        // stay on its "usual" day: a Premier League match can get moved to
        // a weekday for TV, a postponement gets replayed days later, etc. —
        // it keeps the same matchday number either way, so grouping by this
        // field (instead of a Fri–Sun/Mon–Thu calendar window) means a
        // rescheduled fixture still lands in the right round instead of
        // silently falling outside a fixed window and never appearing.
        matchday: typeof m.matchday === "number" ? m.matchday : null,
        // The competition stage (e.g. "REGULAR_SEASON", "LEAGUE_STAGE",
        // "LAST_16", "QUARTER_FINALS", ...) — used only as a fallback label
        // when `matchday` is null (see run.js's stageLabel()), chiefly for
        // Champions League knockout rounds once the season moves past its
        // numbered league phase.
        stage: m.stage || null,
      };
    });
}

/**
 * Given a reference "now" (ICT), return the Fri/Sat/Sun window that contains
 * (or immediately follows) it — i.e. "this weekend's" matchweek.
 */
export function weekendWindow(nowIct = new Date()) {
  const day = nowIct.getUTCDay(); // 0 Sun .. 6 Sat, using UTC fields on an ICT-shifted date is fine here
  // Find the most recent Friday on/before "now" (0 = this Fri..Sun window)
  const daysSinceFriday = (day - 5 + 7) % 7;
  const friday = new Date(nowIct);
  friday.setUTCDate(friday.getUTCDate() - daysSinceFriday);
  friday.setUTCHours(0, 0, 0, 0);
  const mondayAfter = new Date(friday);
  mondayAfter.setUTCDate(friday.getUTCDate() + 3); // through end of Sunday
  return { start: friday, end: mondayAfter };
}

/**
 * Given a reference "now" (ICT), return the Mon–Thu window that contains
 * (or immediately follows) it — i.e. "this week's" Champions League round.
 * Champions League fixtures cluster midweek (mainly Tue/Wed, occasionally
 * Thu for later rounds) rather than the Fri–Sun spread Premier League uses
 * — this is the complementary window for that, covering Monday 00:00
 * through the start of Friday.
 */
export function midweekWindow(nowIct = new Date()) {
  const day = nowIct.getUTCDay(); // 0 Sun .. 6 Sat
  const daysSinceMonday = (day - 1 + 7) % 7;
  const monday = new Date(nowIct);
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  monday.setUTCHours(0, 0, 0, 0);
  const fridayAfter = new Date(monday);
  fridayAfter.setUTCDate(monday.getUTCDate() + 4); // through end of Thursday
  return { start: monday, end: fridayAfter };
}import { supabaseAdmin } from "./lib/supabaseAdmin.js";
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
function pickRoundFixtures(competition, seasonFixtures, ref) {
  const upcomingWithMatchday = seasonFixtures.filter((f) => f.status === "upcoming" && f.matchday != null);

  if (upcomingWithMatchday.length > 0) {
    const nextMatchday = Math.min(...upcomingWithMatchday.map((f) => f.matchday));
    const windowFixtures = seasonFixtures
      .filter((f) => f.matchday === nextMatchday)
      .sort((a, b) => new Date(a.kickoffLocal) - new Date(b.kickoffLocal));
    return { windowFixtures, matchday: nextMatchday, stage: windowFixtures[0]?.stage || null };
  }

  const { start, end } = windowForCompetition(competition, ref);
  const windowFixtures = seasonFixtures
    .filter((f) => {
      const t = new Date(f.kickoffLocal).getTime();
      return t >= start.getTime() && t < end.getTime();
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
    // Already recorded as postponed on an earlier run — leave it alone.
    // It's excluded from research (see main()'s toResearch filter, which
    // only ever picks up "upcoming" rows) and won't block this round from
    // archiving (see archiveIfComplete() below); it naturally drops out of
    // the table entirely once the round archives, and reappears on its own
    // as an ordinary fixture if/when football-data.org gives it a
    // confirmed new date (see the postponed comment in fixtures.js).
    if (row.status === "postponed") continue;
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
    } else if (hoursUntil(row.kickoff_local) < -3) {
      // Kickoff was more than 3 hours ago and this row still can't be
      // resolved to a finished (or postponed) fixture by id, kickoff time,
      // or team names — flag it instead of failing silently, so a fixture
      // stuck showing "Live" on the site has a matching line in these logs
      // to investigate (either football-data.org hasn't marked it FINISHED
      // yet, or it's genuinely dropped out of the fetched fixture list).
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

  const { windowFixtures, matchday, stage } = pickRoundFixtures(competition, seasonFixtures, nowIct());
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

  const stillUndecided = freshRows.filter((r) => r.status === "upcoming");
  if (stillUndecided.length > 0) return;

  const playedRows = freshRows.filter((r) => r.status === "finished");
  const postponedRows = freshRows.filter((r) => r.status === "postponed");
  // Everything in the round is postponed and nothing has actually been
  // played yet — extremely rare (e.g. a whole matchday moved for an
  // international break), but there's nothing real to archive here, so
  // just leave the round open rather than writing an empty archived entry.
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
});import { useEffect, useMemo, useState, useCallback } from "react";
import Head from "next/head";
import { supabase } from "../lib/supabaseClient";
import { computeRoundAccuracy, gradePrediction } from "../lib/results";

const TZ = "Asia/Ho_Chi_Minh";

// This one round only had 3 of its 10 fixtures actually researched before a
// since-fixed scraper bug (see scraper/run.js) — a 3-game sample makes the
// accuracy badge (0/3 — 0%) more misleading than informative. Rather than a
// general small-sample rule, this just suppresses the badge for this one
// archived round by its label; the real graded count stays visible, nothing
// is invented. Safe to delete once this round ages out of "Past rounds".
//
// Same treatment for the first-ever Champions League round: a separate bug
// in ensureRoundExists() (also since fixed — see scraper/run.js) archived
// and silently rebuilt this exact round from scratch over a dozen times
// before it ever properly finished, so every one of those archive snapshots
// — deleted on 2026-09-12 — reflected only a partial, mid-reset grading
// rather than the real, complete result. This round's real result is a
// permanently unknowable mix of that history, so its badge is suppressed
// for good (not just until it ages out) rather than shown with a number
// that would just be guessing. Every Champions League round from here on
// uses the exact same accuracy rule as Premier League — no other special
// case is planned or needed.
const HIDE_ACCURACY_FOR_ROUNDS = new Set([
  "Premier League · 2026-09-04 – 2026-09-06",
  "Champions League · 2026-09-08 – 2026-09-10",
]);
const AGREE_LABEL = { good: "Models agree", warn: "Models lean, not sure", bad: "Models conflict", split: "Split, tight" };

// A fixture stays "upcoming" in the database until the scraper's next run
// finalizes it (see finalizeFinishedFixtures in scraper/run.js) — normally
// within 3 hours of full time. This buffer is deliberately generous (90
// min play + stoppage/extra time + a walkout margin) so a match that's
// genuinely still being played keeps showing "Live"; past it, "Live" would
// be actively misleading (implying we're tracking it in real time, which
// this project never does — no live-score source exists here), so the
// card instead shows an honest "awaiting result" state. This is purely a
// display fallback for the rare lag between full time and the next scrape
// — see run.js's new byTeams matching fallback for the actual fix to the
// underlying case (a stuck fixture that never gets picked up at all).
const MATCH_LIVE_BUFFER_MIN = 150;
function minutesSinceKickoff(kickoffIso) {
  return (Date.now() - new Date(kickoffIso).getTime()) / 60000;
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  } catch { return "--:--"; }
}
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
  } catch { return ""; }
}
// Stable "YYYY-MM-DD" grouping key in ICT — used to bucket fixtures by
// matchday for the day tabs, independent of the display format above.
function dayKey(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
  } catch { return ""; }
}
function fmtStamp(iso) {
  if (!iso) return "Last analyzed —";
  try {
    return "Last analyzed " + new Date(iso).toLocaleString("en-GB", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ,
    }) + " (ICT)";
  } catch { return "Last analyzed —"; }
}

// Mirrors scraper/lib/agreement.js's favoredSide() — kept as a small local
// copy (same pattern as lib/results.js) since this runs client-side against
// data already in the browser, to find the single most one-sided individual
// reading for the Hero "Highest single reading" card. Not used to compute
// "Our Prediction" itself — that consensus is precomputed server-side and
// arrives on m.standout.
function favoredSide(p) {
  if (p.home != null && p.draw != null && p.away != null) {
    const entries = [["home", p.home], ["draw", p.draw], ["away", p.away]];
    entries.sort((a, b) => b[1] - a[1]);
    return { label: entries[0][0], value: entries[0][1] };
  }
  if (p.home != null) return { label: "home", value: p.home };
  if (p.away != null) return { label: "away", value: p.away };
  return null;
}

// Rows written before Champions League support existed have no
// `competition` column value other than the schema default — defaulting to
// "PL" here client-side too means an older row displays exactly where it
// always has, with no migration needed.
function rowToMatch(r) {
  return {
    id: r.id, competition: r.competition || "PL", home: r.home, away: r.away, kickoffLocal: r.kickoff_local,
    homeCrest: r.home_crest || null, awayCrest: r.away_crest || null,
    status: r.status, score: r.score,
    probs: r.probs || [], extras: r.extras || [], standout: r.standout || {},
    agreement: r.agreement, agreementNote: r.agreement_note, forebetNote: r.forebet_note,
  };
}

// Mirrors scraper/run.js's metaId()/competitionLabel() — the Premier League
// meta row keeps its original id ("status") untouched; Champions League
// gets its own row at "status_CL" instead of a schema change.
function metaId(competition) {
  return competition === "PL" ? "status" : `status_${competition}`;
}
// Same pattern as metaId(), for the standings table — see scraper/run.js's
// standings refresh step. Premier League keeps its original "current" row
// id untouched; Champions League gets its own row at "current_CL".
function standingsId(competition) {
  return competition === "PL" ? "current" : `current_${competition}`;
}
const COMPETITIONS = [
  { id: "PL", label: "Premier League" },
  { id: "CL", label: "Champions League" },
  { id: "BL1", label: "Bundesliga" },
  { id: "PD", label: "La Liga" },
];

// A small team badge — renders nothing (rather than a broken-image icon) for
// older fixtures scraped before crest URLs were captured; self-heals once
// that fixture is next (re-)researched. See scraper/run.js.
function Crest({ src, alt }) {
  if (!src) return null;
  return <img className="crest" src={src} alt={alt} loading="lazy" />;
}

function ProbBars({ p, home, away }) {
  // A source can publish just one side (e.g. Wincomparator always does) —
  // that value can land in EITHER p.home or p.away depending on which team
  // it favors, so both must be checked here, not just p.home, or a real
  // away-favored single-side reading gets wrongly reported as unpublished.
  // A bare percentage means nothing to a visitor without the team it
  // belongs to, so name the actual favored team rather than just "home".
  if (p.home == null || p.draw == null || p.away == null) {
    const singleSidePct = p.home != null ? p.home : p.away;
    const favoredTeam = p.home != null ? home : away;
    return (
      <div className="prob-row">
        <div className="src"><span>{p.source}</span></div>
        <div className="prob-na">
          {singleSidePct != null
            ? `${favoredTeam} to win — ${singleSidePct}% (only side published)`
            : "Not published for this fixture"}
        </div>
      </div>
    );
  }
  return (
    <div className="prob-row">
      <div className="src"><span>{p.source}</span><span>{p.home}% / {p.draw}% / {p.away}%</span></div>
      <div className="prob-bars">
        <div className="prob-seg home" style={{ flex: p.home }} />
        <div className="prob-seg draw" style={{ flex: p.draw }} />
        <div className="prob-seg away" style={{ flex: p.away }} />
      </div>
    </div>
  );
}

// Every source is still shown — nothing is hidden or dropped — but Opta,
// Wincomparator, and AI Research are pulled out as the featured reads (per
// the site's stated flow: Our Prediction → Opta → Wincomparator → AI
// Research → the rest), with any remaining sources (SoccerVista, Club
// Elo, ...) tucked under a collapsed "+N more sources" toggle so the card
// isn't a wall of equally-weighted numbers. A fixture missing any one of
// these just skips that slot. AI Research is featured alongside the other
// two named sources because it's the one that actually goes out and checks
// a broad spread of sites for this fixture (see scraper/lib/predictions/
// aiResearch.js) rather than reading one fixed page — its own "Sources
// Checked" tag (under "Other signals" below) shows how many real sites it
// found something on.
const FEATURED_SOURCES = ["Opta Analyst", "Wincomparator", "AI Research (multi-source)"];

function MatchCard({ m, open, onToggle }) {
  const minsSinceKickoff = m.status === "upcoming" ? minutesSinceKickoff(m.kickoffLocal) : null;
  const isLive = minsSinceKickoff != null && minsSinceKickoff >= 0 && minsSinceKickoff <= MATCH_LIVE_BUFFER_MIN;
  const isAwaitingResult = minsSinceKickoff != null && minsSinceKickoff > MATCH_LIVE_BUFFER_MIN;
  // Reconstructs and grades "Our Prediction" from this match's raw source
  // readings once it's finished — see gradePrediction() in lib/results.js
  // for why (the scraper overwrites the display standout text with a plain
  // "Match complete — score" the moment a fixture finishes, but leaves
  // `probs` untouched). null for a finished fixture that was never
  // actually researched — that fixture just falls back to the plain
  // "Match complete" box below, same as before this feature existed.
  const grade = m.status === "finished" ? gradePrediction(m) : null;
  const predictedText = grade
    ? grade.predicted === "draw" ? "Draw" : `${grade.predicted === "home" ? m.home : m.away} to win`
    : null;
  const featured = FEATURED_SOURCES
    .map((name) => (m.probs || []).find((p) => p.source === name))
    .filter(Boolean);
  const others = (m.probs || []).filter((p) => !FEATURED_SOURCES.includes(p.source));
  return (
    <div className={`match ${open ? "open" : ""} ${m.status === "finished" ? "is-finished" : ""}`}>
      <div className="match-head" onClick={() => onToggle(m.id)}>
        <div>
          <div className="teams">
            <Crest src={m.homeCrest} alt="" />
            {m.home} vs {m.away}
            <Crest src={m.awayCrest} alt="" />
          </div>
          <div className="meta-line">
            {m.status === "finished"
              ? "Full time"
              : m.status === "postponed"
              ? "Postponed — new date to be confirmed"
              : `${fmtDate(m.kickoffLocal)} · ${fmtTime(m.kickoffLocal)} ICT`}
          </div>
        </div>
        <div className="head-right">
          {m.status === "finished" ? (
            <span className="status-chip">Final {m.score || ""}</span>
          ) : m.status === "postponed" ? (
            <span className="status-chip postponed">Postponed</span>
          ) : isLive ? (
            <span className="status-chip live">Live</span>
          ) : isAwaitingResult ? (
            <span className="status-chip pending">Full time — result pending</span>
          ) : null}
          {m.agreement && (
            <span className={`agree-chip ${m.agreement}`}>{AGREE_LABEL[m.agreement] || m.agreement}</span>
          )}
          <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
      </div>
      <div className="match-body">
        {m.status === "finished" ? (
          grade ? (
            <div className={`standout result ${grade.correct ? "win" : "loss"}`}>
              <div className="label">
                Our Prediction
                <span className={`result-chip ${grade.correct ? "win" : "loss"}`}>
                  {grade.correct ? "✓ Correct" : "✗ Incorrect"}
                </span>
              </div>
              <div className="pick">Predicted {predictedText} — final score {m.score}</div>
            </div>
          ) : (
            m.standout && m.standout.pick && (
              <div className="standout">
                <div className="label">Result</div>
                <div className="pick">{m.standout.pick}</div>
                <div className="note">This fixture finished without ever being researched, so there's no original prediction to grade.</div>
              </div>
            )
          )
        ) : m.status === "postponed" ? (
          <div className="standout postponed-note">
            <div className="label">Postponed</div>
            <div className="pick">New date not yet confirmed</div>
            <div className="note">
              football-data.org hasn't posted a new kickoff time yet — this fixture will disappear from here and
              reappear as an ordinary upcoming match once it has one. Any predictions below are from before the
              postponement and may no longer be current.
            </div>
          </div>
        ) : (
          m.standout && m.standout.pick && (
            <div className="standout">
              <div className="label">Our Prediction</div>
              <div className="pick">
                {m.standout.pick}
                {m.standout.pct != null ? ` — ${m.standout.pct}%` : ""}
              </div>
              {m.standout.totalSources > 0 && (
                <div className="consensus-line">
                  {m.standout.sourcesUsed === m.standout.totalSources
                    ? `All ${m.standout.totalSources} sources checked agree on this`
                    : `${m.standout.sourcesUsed} of ${m.standout.totalSources} sources checked favor this`}
                </div>
              )}
              {m.standout.note && <div className="note">{m.standout.note}</div>}
            </div>
          )
        )}
        {m.probs && m.probs.length > 0 ? (
          <>
            {featured.length > 0 ? (
              <div className="probs">
                {featured.map((p, i) => <ProbBars key={i} p={p} home={m.home} away={m.away} />)}
              </div>
            ) : (
              others.length > 0 && (
                <div className="prob-na">Opta, Wincomparator, and AI Research aren't published yet for this fixture — see sources below.</div>
              )
            )}
            {others.length > 0 && (
              <details className="more-sources">
                <summary>+ {others.length} more source{others.length > 1 ? "s" : ""}</summary>
                <div className="probs">
                  {others.map((p, i) => <ProbBars key={i} p={p} home={m.home} away={m.away} />)}
                </div>
              </details>
            )}
          </>
        ) : (
          <div className="prob-na">No numeric source accessible for this fixture yet.</div>
        )}
        {m.extras && m.extras.length > 0 && (
          <>
            <div className="extra-title">Other signals</div>
            <div className="extras">
              {m.extras.map((e, i) => (
                <span className="extra-tag" key={i}><b>{e.pick}</b> — {e.market}{e.pct != null ? ` (${e.pct}%)` : ""} · {e.source}</span>
              ))}
            </div>
          </>
        )}
        {(m.agreementNote || m.forebetNote) && (
          <div className="note">{m.agreementNote}{m.forebetNote ? " " + m.forebetNote : ""}</div>
        )}
      </div>
    </div>
  );
}

function Hero({ matches }) {
  // Highlights are for what's still to come. A finished match keeps its
  // probs untouched (see finalizeFinishedFixtures in scraper/run.js — only
  // status/score/standout change), so without the status check here a
  // striking reading from an already-played game would keep showing as
  // "Highest single reading" long after the result is known. Requiring
  // m.probs.length too just rules out untouched "Not yet analyzed"
  // placeholders, which couldn't produce a reading anyway.
  // Deliberately "upcoming" only, not "!== finished" — a postponed fixture
  // may still carry probs from before it was postponed, and those are now
  // stale against an unknown future kickoff, so it shouldn't be eligible
  // to headline the hero.
  const candidates = matches.filter((m) => m.status === "upcoming" && m.probs.length);
  // "Most agreed-upon" — m.agreement === "good" already means every source
  // checked favored the same side with decent average confidence (see
  // scraper/lib/agreement.js), so this needs no extra unanimity flag.
  const unanimous = candidates.find((m) => m.agreement === "good");
  // "Highest single reading" is deliberately NOT read from m.standout — that
  // field is now "Our Prediction" (a consensus across sources). This scans
  // every source's own raw reading across every match to find the single
  // most one-sided number actually published this round, and names which
  // source published it.
  const highest = candidates.reduce((best, m) => {
    for (const p of m.probs || []) {
      const r = favoredSide(p);
      if (!r) continue;
      if (!best || r.value > best.value) best = { ...r, source: p.source, match: m };
    }
    return best;
  }, null);

  if (!unanimous && !highest) return null;

  return (
    <div className="hero">
      {unanimous && (
        <div className="hero-block">
          <div className="eyebrow"><span className="dot" />Most agreed-upon</div>
          <div className="hero-title">
            {unanimous.standout.pick === "Draw"
              ? `${unanimous.home} vs ${unanimous.away} — Draw`
              : `${unanimous.standout.pick} to beat ${
                  unanimous.standout.pick === unanimous.home ? unanimous.away : unanimous.home
                }`}
          </div>
          <p className="hero-desc">Every model checked points the same way — direction is solid, though confidence varies by source.</p>
        </div>
      )}
      {highest && (
        <div className="hero-block">
          <div className="eyebrow"><span className="dot" />Highest single reading</div>
          <div className="hero-title">
            {highest.label === "draw" ? "Draw" : highest.label === "home" ? highest.match.home : highest.match.away}
            , {highest.match.home} vs {highest.match.away}
          </div>
          <p className="hero-desc"><b>{highest.value}%</b> from {highest.source} — the single most one-sided number found this round.</p>
        </div>
      )}
    </div>
  );
}

// Position bands are the standard EPL convention this season: top 4 into the
// Champions League, 5th into the Europa League, bottom 3 relegated. Purely a
// visual cue — the numbers themselves come straight from football-data.org.
function plZoneClass(position) {
  if (position <= 4) return "ucl";
  if (position === 5) return "uel";
  if (position >= 18) return "rel";
  return "";
}

// Champions League's 36-team league-phase table (since the 2024/25 reform):
// the top 8 go straight through to the Round of 16, 9th-24th get a
// two-legged playoff round for the remaining knockout spots, and 25th-36th
// are eliminated from Europe entirely. Confirmed against current UEFA
// coverage of the format — not guessed, per this project's hard rule.
function clZoneClass(position) {
  if (position <= 8) return "r16";
  if (position <= 24) return "playoff";
  return "out";
}

// Bundesliga (18 clubs, 2026-27 season): top 4 into the Champions League,
// 5th into the Europa League. 16th enters a two-legged relegation/
// promotion playoff against 2.Bundesliga's 3rd-place side rather than being
// automatically relegated — this reuses the same "rel" (danger) color as
// 17th-18th rather than adding a fourth visual band, same level of
// simplification this project already uses for the CL playoff-round band
// above; it's a purely visual cue; the numbers themselves come from
// football-data.org.
function bundesligaZoneClass(position) {
  if (position <= 4) return "ucl";
  if (position === 5) return "uel";
  if (position >= 16) return "rel";
  return "";
}

// La Liga (20 clubs, 2026-27 season): top 4 into the Champions League,
// 5th-6th into the Europa League (the exact 5th/6th vs Conference League
// split shifts a little depending on cup winners, so this project keeps
// the same simplified 3-band convention used everywhere else rather than
// chasing that each season), bottom 3 relegated.
function laLigaZoneClass(position) {
  if (position <= 4) return "ucl";
  if (position <= 6) return "uel";
  if (position >= 18) return "rel";
  return "";
}

// One config per competition: which zone-class function colors its rows,
// and what that coloring means in the legend underneath the table. Central
// place to add a fifth competition's table styling without touching
// StandingsTable's own JSX.
const STANDINGS_ZONE_CONFIG = {
  PL: {
    zoneClass: plZoneClass,
    legend: [
      { cls: "ucl", label: "Champions League" },
      { cls: "uel", label: "Europa League" },
      { cls: "rel", label: "Relegation" },
    ],
  },
  CL: {
    zoneClass: clZoneClass,
    legend: [
      { cls: "r16", label: "Round of 16 (direct)" },
      { cls: "playoff", label: "Playoff round" },
      { cls: "out", label: "Eliminated" },
    ],
  },
  BL1: {
    zoneClass: bundesligaZoneClass,
    legend: [
      { cls: "ucl", label: "Champions League" },
      { cls: "uel", label: "Europa League" },
      { cls: "rel", label: "Relegation / play-off" },
    ],
  },
  PD: {
    zoneClass: laLigaZoneClass,
    legend: [
      { cls: "ucl", label: "Champions League" },
      { cls: "uel", label: "Europa League" },
      { cls: "rel", label: "Relegation" },
    ],
  },
};

function StandingsTable({ standings, competition }) {
  const rows = standings?.rows || [];
  const compLabel = COMPETITIONS.find((c) => c.id === competition)?.label || competition;
  if (!rows.length) {
    return (
      <div className="empty-state">
        <h3>{compLabel} table not available yet</h3>
        <p>The league table is refreshed on the same schedule as predictions — check back shortly.</p>
      </div>
    );
  }
  const config = STANDINGS_ZONE_CONFIG[competition] || STANDINGS_ZONE_CONFIG.PL;
  const zoneClass = config.zoneClass;
  return (
    <div className="table-wrap">
      <table className="standings">
        <thead>
          <tr>
            <th className="num">#</th>
            <th className="team-col">Team</th>
            <th className="num">MP</th>
            <th className="num">W</th>
            <th className="num">D</th>
            <th className="num">L</th>
            <th className="num">GD</th>
            <th className="num pts">Pts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.team} className={zoneClass(r.position)}>
              <td className="num zone-cell"><span className="zone-bar" />{r.position}</td>
              <td className="team-col">
                <Crest src={r.crest} alt="" />
                {r.team}
              </td>
              <td className="num">{r.played}</td>
              <td className="num">{r.won}</td>
              <td className="num">{r.draw}</td>
              <td className="num">{r.lost}</td>
              <td className="num">{r.goalDifference > 0 ? `+${r.goalDifference}` : r.goalDifference}</td>
              <td className="num pts">{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="table-legend">
        {config.legend.map((item) => (
          <span key={item.cls}><span className={`zone-swatch ${item.cls}`} />{item.label}</span>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const [view, setView] = useState("this"); // this | past | table | how
  const [competition, setCompetition] = useState("PL"); // PL | CL | BL1 | PD — toggle at the top of "This round's signal"
  const [metaRows, setMetaRows] = useState([]); // every competition's meta rows — pick the active one when rendering
  const [matches, setMatches] = useState([]);
  const [archived, setArchived] = useState([]);
  const [standingsRows, setStandingsRows] = useState([]); // every competition's standings rows — pick the active one when rendering
  const [openId, setOpenId] = useState(null);
  const [connected, setConnected] = useState(false);
  const [selectedDay, setSelectedDay] = useState(null); // null = "All"; task 1a — day tabs on Upcoming

  const loadAll = useCallback(async () => {
    if (!supabase) return;
    // meta and standings are both fetched without an id filter so every
    // competition's row comes back at once — Premier League ("status" /
    // "current") plus a "status_<CODE>" / "current_<CODE>" row per other
    // competition (CL, BL1, PD) — the toggle below just picks which one to
    // show, no refetch.
    const [{ data: metaData }, { data: matchRows }, { data: archRows }, { data: standingsData }] = await Promise.all([
      supabase.from("meta").select("*"),
      supabase.from("matches").select("*"),
      supabase.from("archived_rounds").select("*").order("archived_at", { ascending: false }),
      supabase.from("standings").select("*"),
    ]);
    if (metaData) setMetaRows(metaData);
    if (matchRows) setMatches(matchRows.map(rowToMatch));
    if (archRows) setArchived(archRows);
    if (standingsData) setStandingsRows(standingsData);
    setConnected(true);
  }, []);

  useEffect(() => {
    loadAll();
    if (!supabase) return;
    const channel = supabase
      .channel("matchday-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "matches" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "meta" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "archived_rounds" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "standings" }, loadAll)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loadAll]);

  // "This round's signal" shows one competition at a time — the toggle
  // just swaps this filter, no refetch, since `matches` already holds both.
  const compMatches = useMemo(
    () => matches.filter((m) => m.competition === competition),
    [matches, competition]
  );
  const meta = useMemo(() => {
    const row = metaRows.find((r) => r.id === metaId(competition));
    return row || { round_label: COMPETITIONS.find((c) => c.id === competition)?.label || competition, last_updated: null };
  }, [metaRows, competition]);

  // The currently-selected competition's display name — used everywhere an
  // empty-state or heading needs to name it, instead of a competition-by-
  // competition ternary that would need a new branch for every league added.
  const activeCompLabel = COMPETITIONS.find((c) => c.id === competition)?.label || competition;

  // "Table" view shows one competition's standings at a time — same toggle,
  // no refetch, since standingsRows already holds both.
  const standings = useMemo(
    () => standingsRows.find((r) => r.id === standingsId(competition)) || null,
    [standingsRows, competition]
  );

  const sorted = useMemo(
    () => compMatches.slice().sort((a, b) => new Date(a.kickoffLocal) - new Date(b.kickoffLocal)),
    [compMatches]
  );

  // Past rounds gets the same toggle and filter as "This round's signal" —
  // archived_rounds rows carry their own `competition` (set at archive
  // time in scraper/run.js), defaulting to "PL" for rounds archived before
  // Champions League support existed.
  const compArchived = useMemo(
    () => archived.filter((r) => (r.competition || "PL") === competition),
    [archived, competition]
  );
  const upcoming = sorted.filter((m) => m.status === "upcoming");
  const past = sorted.filter((m) => m.status === "finished");
  // Shown in their own always-visible section, separate from the day-tab
  // filtered upcoming list — a postponed fixture's stored kickoff time is
  // stale (see run.js's finalizeFinishedFixtures), so it doesn't belong to
  // any real day tab, and it's deliberately excluded from "Past rounds"
  // once the round archives (see archiveIfComplete in scraper/run.js) —
  // this is the only place it's still visible on the site at all.
  const postponed = sorted.filter((m) => m.status === "postponed");

  // task 1a — one tab per distinct matchday among the upcoming fixtures,
  // e.g. "Sat 12 Sept" / "Sun 13 Sept". Derived fresh from `upcoming` each
  // render so it stays correct as fixtures finish and drop out of the list.
  const upcomingDays = useMemo(() => {
    const seen = new Map();
    for (const m of upcoming) {
      const key = dayKey(m.kickoffLocal);
      if (key && !seen.has(key)) seen.set(key, { key, label: fmtDate(m.kickoffLocal) });
    }
    return Array.from(seen.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [upcoming]);

  // Guard against a stale selection (e.g. that day's last fixture just
  // finished and the tab disappeared) by falling back to "All" rather than
  // showing an empty list with no visible way back.
  const activeDay = selectedDay && upcomingDays.some((d) => d.key === selectedDay) ? selectedDay : null;
  const visibleUpcoming = activeDay ? upcoming.filter((m) => dayKey(m.kickoffLocal) === activeDay) : upcoming;

  const toggle = (id) => setOpenId((cur) => (cur === id ? null : id));

  return (
    <>
      <Head>
        <title>Premier League Signal — Match Predictions Compared</title>
        <meta
          name="description"
          content="Compare independent Premier League, Champions League, Bundesliga, and La Liga match predictions from Opta Analyst, Wincomparator, SoccerVista, Club Elo ratings, a self-calculated Elo rating, a form- and venue-aware Poisson goals model, and an AI research pass that checks a broad spread of sites per fixture. Auto-updated every 3 hours. No odds, no betting picks."
        />
      </Head>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="mark">PL</div>
            <div>
              <div className="name">Premier League Signal</div>
              <div className="sub">Predictions, compared</div>
            </div>
          </div>
          <nav>
            <div className={`nav-item ${view === "this" ? "active" : ""}`} onClick={() => setView("this")}>This round</div>
            <div className={`nav-item ${view === "past" ? "active" : ""}`} onClick={() => setView("past")}>Past rounds</div>
            <div className={`nav-item ${view === "table" ? "active" : ""}`} onClick={() => setView("table")}>Table</div>
            <div className={`nav-item ${view === "how" ? "active" : ""}`} onClick={() => setView("how")}>How this works</div>
          </nav>
          <div className="legend">
            <div className="legend-title">Sources checked</div>
            <div className="legend-row"><span>Opta Analyst</span><span className="dim">win probability</span></div>
            <div className="legend-row"><span>Wincomparator</span><span className="dim">1X2 + goals</span></div>
            <div className="legend-row"><span>SoccerVista</span><span className="dim">1X2 + goals</span></div>
            <div className="legend-row"><span>Club Elo</span><span className="dim">win probability</span></div>
            <div className="legend-row"><span>Our Elo</span><span className="dim">win probability, calculated</span></div>
            <div className="legend-row"><span>Goals model</span><span className="dim">form + venue aware</span></div>
            <div className="legend-row"><span>AI Research</span><span className="dim">~10 sites, synthesized</span></div>
          </div>
          <div className="legend">
            <div className="legend-row">
              <span><span className="live-dot" /> {connected ? "Live" : "Connecting…"}</span>
            </div>
          </div>
        </aside>

        <main>
          {view === "this" && (
            <>
              <div className="comp-tabs">
                {COMPETITIONS.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className={`comp-tab ${competition === c.id ? "active" : ""}`}
                    onClick={() => setCompetition(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <div className="topbar">
                <div>
                  <h1>This round's signal</h1>
                  <div className="sub">{meta.round_label}</div>
                </div>
                <div className="sync">
                  <div className="stamp">{fmtStamp(meta.last_updated)}</div>
                  <span className="status-pill"><span className="live-dot" />Auto-updating</span>
                </div>
              </div>

              <Hero matches={compMatches} />

              <div className="section-label">Upcoming — kickoff times in Ho Chi Minh City (ICT)</div>

              {upcomingDays.length > 1 && (
                <div className="day-tabs">
                  <button
                    type="button"
                    className={`day-tab ${activeDay === null ? "active" : ""}`}
                    onClick={() => setSelectedDay(null)}
                  >
                    All
                  </button>
                  {upcomingDays.map((d) => (
                    <button
                      type="button"
                      key={d.key}
                      className={`day-tab ${activeDay === d.key ? "active" : ""}`}
                      onClick={() => setSelectedDay(d.key)}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="matches">
                {visibleUpcoming.length ? (
                  visibleUpcoming.map((m) => <MatchCard key={m.id} m={m} open={openId === m.id} onToggle={toggle} />)
                ) : (
                  <div className="empty-state">
                    <p style={{ margin: 0 }}>No upcoming {activeCompLabel} fixtures left in this round — check back once the next round is analyzed.</p>
                  </div>
                )}
              </div>

              {postponed.length > 0 && (
                <>
                  <div className="section-label">Postponed — new date not yet confirmed</div>
                  <div className="matches">
                    {postponed.map((m) => <MatchCard key={m.id} m={m} open={openId === m.id} onToggle={toggle} />)}
                  </div>
                </>
              )}

              <p className="footer-note">
                This page updates itself automatically — a scheduled job checks every fixture every 3 hours and (re-)researches it once it's within 12 hours of kickoff, writing straight to the database behind this page, so every open tab refreshes live with no button to press. AI Research specifically checks in more often as kickoff nears — every 2 hours, once a fixture is within 6 hours of its own kickoff — since that's the window where team news and lineups actually change. As soon as a fixture is confirmed finished, it moves straight into the <b>Past rounds</b> tab — that round's accuracy percentage only appears there once every fixture in it has been played.
              </p>
              <p className="footer-note">
                This site is a research tool, not betting advice — it doesn't encourage placing bets and makes no promise of accuracy or profit. Agreement between models is a signal, not a guarantee, about any specific match. If you choose to bet elsewhere, please only do so with money you can afford to lose.
              </p>
            </>
          )}

          {view === "past" && (
            <>
              <div className="comp-tabs">
                {COMPETITIONS.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className={`comp-tab ${competition === c.id ? "active" : ""}`}
                    onClick={() => setCompetition(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <div className="topbar">
                <div>
                  <h1>Past rounds</h1>
                  <div className="sub">Finished fixtures land here the moment they're checked — a round's accuracy only shows once every fixture in it has been played</div>
                </div>
              </div>

              {past.length > 0 && (
                <>
                  <div className="section-label">{meta.round_label} — in progress ({past.length} of {sorted.length} played)</div>
                  <div className="matches">
                    {past.map((m) => <MatchCard key={m.id} m={m} open={openId === m.id} onToggle={toggle} />)}
                  </div>
                  <p className="footer-note">This round isn't archived yet — its accuracy percentage will appear below once its last fixture is finished.</p>
                </>
              )}

              {compArchived.length > 0 && past.length > 0 && (
                <div className="section-label">Completed rounds</div>
              )}

              {compArchived.length > 0 ? (
                compArchived.map((r) => {
                  const { correct, graded } = computeRoundAccuracy(r.matches || []);
                  const pct = graded ? Math.round((correct / graded) * 100) : null;
                  const hideBadge = HIDE_ACCURACY_FOR_ROUNDS.has(r.round_label);
                  return (
                    <div className="archived-round" key={r.id}>
                      <div>
                        <div className="rtitle">{r.round_label}</div>
                        <div className="rsub">{(r.matches || []).length} fixtures analyzed · archived {fmtStamp(r.archived_at).replace("Last analyzed ", "")}</div>
                      </div>
                      {pct != null && !hideBadge ? (
                        <span className={`accuracy-chip ${pct > 50 ? "good" : "bad"}`}>{correct}/{graded} correct — {pct}%</span>
                      ) : (
                        <span className="accuracy-chip none">Not enough graded picks</span>
                      )}
                    </div>
                  );
                })
              ) : (
                past.length === 0 && (
                  <div className="empty-state">
                    <h3>No completed {activeCompLabel} rounds yet</h3>
                    <p>Finished fixtures will land here as soon as they're checked; the round's accuracy badge appears once every fixture in it has been played.</p>
                  </div>
                )
              )}
            </>
          )}

          {view === "table" && (
            <>
              <div className="comp-tabs">
                {COMPETITIONS.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className={`comp-tab ${competition === c.id ? "active" : ""}`}
                    onClick={() => setCompetition(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <div className="topbar">
                <div>
                  <h1>{activeCompLabel} table</h1>
                  <div className="sub">
                    {standings?.updated_at
                      ? fmtStamp(standings.updated_at)
                      : "Refreshed on the same schedule as predictions"}
                  </div>
                </div>
              </div>
              <StandingsTable standings={standings} competition={competition} />
            </>
          )}

          {view === "how" && (
            <div className="how">
              <h3>How this works</h3>
              <p>Each fixture is checked against several independent, methodology-transparent prediction models rather than a single "top pick" source — no individual site in this space has a verified, audited accuracy record, so agreement across models is treated as the meaningful signal, not any one source's claimed win rate.</p>
              <p>Each match card leads with "Our Prediction" — not one more model, but an honest consensus of whichever outcome the majority of that fixture's sources lean toward, and how many of them agree. Below it, Opta Analyst, Wincomparator, and AI Research are shown individually, with any remaining sources (SoccerVista, Club Elo, Our Elo) tucked under a "more sources" toggle so every number is still there, just not competing for attention. AI Research is the one source that isn't reading a single fixed page — it's Claude, given live web search, checking a broad spread of independent sites for that specific fixture and synthesizing one honest reading, the same kind of research you'd get asking an AI assistant directly, just run automatically as part of every scrape (its "Sources Checked" tag under "Other signals" shows how many real sites it actually found something on). Our Elo is a second, independently-calculated Elo-style rating alongside Club Elo's — built entirely from this project's own recorded results rather than fetched from clubelo.com, so it starts from scratch each season and becomes a more meaningful read as more of the season is actually played. The Goals model behind Over/Under, Correct Score, and Handicap now weighs recent matches more than early-season ones and works out each team's own home form separately from its away form, instead of assuming every team gets the same generic home-advantage boost. This page shows win/draw/loss probabilities and secondary markets (both-teams-to-score, over/under goals, correct score) exactly as published or synthesized by each source. It intentionally excludes betting odds, stakes, or "place a bet" actions — it's a research view, not a betting tool.</p>
              <p>Premier League, Champions League, Bundesliga, and La Liga fixtures all get the exact same treatment, side by side under the toggle at the top of "This round's signal" — Champions League just runs on its own schedule, since its fixtures cluster midweek rather than on weekends; the other three all follow the same weekend-round schedule.</p>
              <p>A scheduled job (not this page) checks every fixture every 3 hours and researches it once it's within 12 hours of kickoff, writing results straight into the database this page reads from — so every open tab updates automatically, live, with nothing to click. AI Research runs on its own tighter schedule on top of that: every 2 hours, once a fixture is within 6 hours of kickoff, since that's the window where team news and lineups actually firm up — every other source doesn't benefit from checking that often, so only AI Research's reading refreshes on that faster cadence.</p>
              <p><b>Disclaimer:</b> this site does not encourage or facilitate betting in any way, and nothing on it is betting advice. Nothing here is a guarantee of accuracy or profit — model agreement is a signal about a match, not a certainty, and no source on this page (including this site itself) has a verified long-term accuracy record. If you choose to bet elsewhere, please do so only with money you can afford to lose, and stop if it stops being fun.</p>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
