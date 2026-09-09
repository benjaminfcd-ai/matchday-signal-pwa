import { fetchOptaPrediction } from "./predictions/opta.js";
import { fetchWincomparatorPrediction } from "./predictions/wincomparator.js";
import { fetchSoccervistaPrediction } from "./predictions/soccervista.js";
import { fetchEloPrediction } from "./predictions/elo.js";
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
export async function researchFixture(f, teamStrengths, crestMap) {
  const [opta, win, soccervista, elo] = await Promise.all([
    fetchOptaPrediction(f.home, f.away),
    fetchWincomparatorPrediction(f.home, f.away),
    fetchSoccervistaPrediction(f.home, f.away),
    fetchEloPrediction(f.home, f.away),
  ]);
  // Not a network fetch — computed from this season's real results, which
  // were already fetched once for the whole run (see run.js / main()).
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
