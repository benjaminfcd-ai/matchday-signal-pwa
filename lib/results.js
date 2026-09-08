// Grades each finished match's headline prediction against its final score,
// so "Past rounds" can show a real correct/incorrect ratio instead of just
// a fixture count. This is computed here (client-side, from data already
// stored per match) rather than in the scraper, because the scraper
// overwrites a finished match's display "standout" text with "Match
// complete — score" once it's done (see finalizeFinishedFixtures in
// scraper/run.js) — but it deliberately leaves every source's raw
// probabilities (`probs`) untouched, so the original prediction can always
// be reconstructed from those, the same way it was first computed.
//
// "Correct" here means: whichever side (home/draw/away) the MAJORITY of
// published readings favored — the same consensus rule the live site's
// "Our Prediction" box uses (see scraper/lib/agreement.js) — matches the
// actual final result. This only grades the match-winner call, not
// Over/Under, Correct Score, or Handicap; those could be graded the same
// way later.
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

function predictedWinnerLabel(probs) {
  const readings = (probs || []).map(favoredSide).filter(Boolean);
  if (!readings.length) return null;
  const counts = {};
  for (const r of readings) counts[r.label] = (counts[r.label] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]; // "home" | "draw" | "away"
}

function actualWinnerLabel(score) {
  if (!score) return null;
  const parts = score.split(/[–-]/).map((n) => parseInt(n, 10));
  if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) return null;
  const [h, a] = parts;
  if (h > a) return "home";
  if (a > h) return "away";
  return "draw";
}

// Returns { correct, graded } for one round's worth of matches. "graded"
// excludes any match that was never actually analyzed (no probs — e.g. a
// placeholder that finished without ever getting researched) or has no
// parseable final score — per this project's hard rule, we never guess at
// a grade for a match with nothing to grade it against.
export function computeRoundAccuracy(matches) {
  let correct = 0;
  let graded = 0;
  for (const m of matches || []) {
    if (m.status !== "finished") continue;
    const predicted = predictedWinnerLabel(m.probs);
    const actual = actualWinnerLabel(m.score);
    if (predicted == null || actual == null) continue;
    graded += 1;
    if (predicted === actual) correct += 1;
  }
  return { correct, graded };
}
