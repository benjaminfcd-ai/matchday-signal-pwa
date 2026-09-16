import { fetchOptaPrediction } from "./predictions/opta.js";
import { fetchWincomparatorPrediction } from "./predictions/wincomparator.js";
import { fetchSoccervistaPrediction } from "./predictions/soccervista.js";
import { fetchEloPrediction } from "./predictions/elo.js";
import { fetchGoalsPrediction } from "./predictions/goalsModel.js";
import { fetchOwnEloPrediction } from "./predictions/ownElo.js";
import { computeAgreement } from "./agreement.js";

// Pulls a fresh reading from every source for one fixture and turns it into
// a full matches-table row. Shared by run.js (the regular every-3-hours
// scraper, which only calls this once a fixture is within its own
// RESEARCH_WINDOW_HOURS of kickoff) and refresh-existing.js (the one-off,
// manually-triggered tool that re-runs this against already-researched
// fixtures regardless of the window — see that file for when to use it).
// Keeping this in one place means both always compute a fixture's
// prediction the exact same way.
//
// f.competition selects which competition's source URLs to use ("PL" or
// "CL") — defaults to "PL" so any caller that doesn't pass it (or a row
// stored before competition existed) keeps behaving exactly as before.
// Elo, Our Elo, and the goals model don't need it: Elo works from team
// names alone, Our Elo is computed from real results across both
// competitions at once (see ownElo.js), and the goals model is Premier-
// League-only by nature (see goalsModel.js) — it gracefully returns no
// reading for non-PL clubs, same as any other missing-data case under this
// project's "never fabricate" rule.
//
// NOTE: a 5th source, Forebet, was tried and removed — its page couldn't be
// verified against real content (blocked direct access) and its extraction
// heuristic never reliably matched real fixtures, so it consistently
// returned nothing. Rather than keep dead weight, it was pulled out
// entirely; see git history if it's ever worth revisiting with a better
// approach to that site.
//
// AI Research (aiResearch.js) is a different kind of source from the rest
// — instead of reading one fixed page, it asks Claude to do a broad,
// multi-site web search across a wide spread of independent prediction
// sites for one fixture and synthesize one honest reading — and it is
// DELIBERATELY NOT called from here. It runs on its own, tighter schedule
// instead: every 2 hours, only once a fixture is within 6 hours of its own
// kickoff (see scraper/ai-research-refresh.js and
// .github/workflows/ai-research-refresh.yml), rather than this function's
// 12-hour-window / every-3-hours cadence. That's a deliberate choice, not
// an oversight: team news and lineups firm up close to kickoff, so AI
// Research benefits from checking more often right before a match in a way
// the other, static-page sources below don't. ai-research-refresh.js (and
// refresh-existing.js, for its one-off manual catch-up) merge AI
// Research's reading into a row ON TOP of whatever this function already
// wrote — see scraper/lib/aiResearchMerge.js — without touching anything
// this function computed. If you're looking for why a freshly-created
// placeholder fixture has no AI Research reading yet even after this
// function has run: that's expected, it arrives later, closer to kickoff.
//
// `ownEloRatings` is the { [team]: rating } map computed ONCE per run by
// computeOwnEloRatings() (see ownElo.js) from every finished fixture across
// both competitions, and passed in here the same way `teamStrengths` is —
// computing it fresh per-fixture would be wasteful (it's the exact same
// whole-season calculation every time) and isn't needed anyway, since it
// only depends on results that have already happened, not on which
// fixture is being researched right now.
export async function researchFixture(f, teamStrengths, crestMap, ownEloRatings) {
  const competition = f.competition || "PL";
  const [opta, win, soccervista, elo] = await Promise.all([
    fetchOptaPrediction(f.home, f.away, competition),
    fetchWincomparatorPrediction(f.home, f.away, competition),
    fetchSoccervistaPrediction(f.home, f.away, competition),
    fetchEloPrediction(f.home, f.away),
  ]);
  // Neither of these is a network fetch — both computed from data already
  // fetched once for the whole run (see run.js / main()).
  const goals = fetchGoalsPrediction(f.home, f.away, teamStrengths);
  const ownElo = fetchOwnEloPrediction(f.home, f.away, ownEloRatings);

  // Opta/Wincomparator/Elo/SoccerVista/Our Elo all contribute a 1X2 reading
  // when available (used for the win/draw/away agreement calculation). Over/
  // Under, Correct Score and Handicap come from the goals model (real
  // scoring data — see goalsModel.js for why that's more accurate here than
  // Elo alone) plus SoccerVista's own published picks, merged into "extras".
  // AI Research's contribution to both arrays is layered on separately,
  // later — see the comment above.
  const probs = [opta, win, soccervista?.prob, elo?.prob, ownElo?.prob].filter(Boolean);
  const extras = [...(goals?.extras || []), ...(soccervista?.extras || [])];
  const { agreement, agreementNote, standout } = computeAgreement(probs, f.home, f.away);

  return {
    id: f.id,
    competition,
    home: f.home,
    away: f.away,
    // f comes from a fresh DB row here, which won't carry crest fields for
    // a fixture created before team badges existed — crestMap is built
    // fresh from football-data.org every run, so this self-heals the first
    // time each fixture is (re-)researched.
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
