import { fetchOptaPrediction } from "./predictions/opta.js";
import { fetchWincomparatorPrediction } from "./predictions/wincomparator.js";
import { fetchSoccervistaPrediction } from "./predictions/soccervista.js";
import { fetchEloPrediction } from "./predictions/elo.js";
import { fetchForebetPrediction } from "./predictions/forebet.js";
import { fetchGoalsPrediction } from "./predictions/goalsModel.js";
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
// Elo and the goals model don't need it: Elo works from team names alone,
// and the goals model is Premier-League-only by nature (see goalsModel.js)
// — it gracefully returns no reading for non-PL clubs, same as any other
// missing-data case under this project's "never fabricate" rule.
export async function researchFixture(f, teamStrengths, crestMap) {
  const competition = f.competition || "PL";
  const [opta, win, soccervista, elo, forebet] = await Promise.all([
    fetchOptaPrediction(f.home, f.away, competition),
    fetchWincomparatorPrediction(f.home, f.away, competition),
    fetchSoccervistaPrediction(f.home, f.away, competition),
    fetchEloPrediction(f.home, f.away),
    fetchForebetPrediction(f.home, f.away, competition),
  ]);
  // Not a network fetch — computed from this season's real results, which
  // were already fetched once for the whole run (see run.js / main()).
  const goals = fetchGoalsPrediction(f.home, f.away, teamStrengths);

  // Opta/Wincomparator/Elo/SoccerVista/Forebet all contribute a 1X2 reading
  // when available (used for the win/draw/away agreement calculation). Over/
  // Under, Correct Score and Handicap come from the goals model (real
  // scoring data — see goalsModel.js for why that's more accurate here than
  // Elo alone) plus SoccerVista's own published picks, merged into "extras".
  const probs = [opta, win, soccervista?.prob, elo?.prob, forebet].filter(Boolean);
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
