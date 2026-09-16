// "Our Elo" — a second, independently-calculated Elo-style rating, built
// entirely from this project's OWN data (real match results already
// fetched from football-data.org every run) rather than a third-party
// site's numbers. This exists ALONGSIDE Club Elo (elo.js), not instead of
// it: Club Elo carries years of accumulated rating history and is a well-
// established, independently maintained system; this one starts every club
// from the exact same flat baseline and only updates from matches this
// project has itself already recorded — so EARLY in a season it
// necessarily has much less to go on than Club Elo's long history. As the
// season accumulates real results, this becomes a genuinely independent
// read: not one more site's opinion, just this project's own arithmetic
// run over its own data, with nothing to scrape and nothing that can go
// down or block this project the way an external site can.
//
// The rating system itself is the standard, publicly-documented Elo
// method (the same one used across chess and most public football-Elo
// projects): a result updates the winner's (and loses the loser's) rating
// by K times the gap between what actually happened and what the pre-
// match ratings predicted should happen, with a flat home-advantage
// adjustment folded into that expectation. Margin of victory isn't
// factored into the update (a deliberate simplification, not an
// oversight) — a possible future refinement, not needed for this to be a
// genuine, useful independent signal.
//
// The win/draw/loss CONVERSION below (rating gap -> expected goal
// difference -> a Poisson model -> a clean 1X2 split) deliberately mirrors
// elo.js's own math exactly, so the two Elo-based sources are apples-to-
// apples with each other and differ only in WHERE the underlying rating
// number came from.
const BASELINE_RATING = 1500;
const K_FACTOR = 32; // how much one result can move a rating — enough to meaningfully separate teams within a season
const HOME_ADV = 100; // same convention as elo.js

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// Processes every FINISHED fixture from BOTH competitions, in chronological
// order, into one shared per-club rating — a club's Champions League form
// feeds the same single rating its Premier League matches do, the same way
// Club Elo itself treats a club's whole body of work rather than keeping
// separate per-competition numbers. Fixtures with no legible final score
// are skipped (never guessed). Returns { [team]: rating } — a team that
// hasn't finished a single match yet this season (very start of the
// season) simply has no entry, which fetchOwnEloPrediction below treats as
// "no data yet", the same missing-data case every other source already
// handles.
export function computeOwnEloRatings(allFixtures) {
  const finished = (allFixtures || [])
    .filter((f) => f.status === "finished" && f.score)
    .slice()
    .sort((a, b) => new Date(a.kickoffLocal) - new Date(b.kickoffLocal));

  const ratings = {};
  const ratingOf = (t) => (ratings[t] ??= BASELINE_RATING);

  for (const f of finished) {
    const parts = f.score.split(/[–-]/).map((n) => parseInt(n, 10));
    if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) continue;
    const [hGoals, aGoals] = parts;

    const homeRating = ratingOf(f.home);
    const awayRating = ratingOf(f.away);
    const expectedHome = expectedScore(homeRating + HOME_ADV, awayRating);
    const actualHome = hGoals > aGoals ? 1 : hGoals === aGoals ? 0.5 : 0;

    const delta = K_FACTOR * (actualHome - expectedHome);
    ratings[f.home] = homeRating + delta;
    ratings[f.away] = awayRating - delta;
  }

  return ratings;
}

function poissonPmf(k, lambda) {
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

// Same conversion elo.js uses — see the top-of-file comment for why.
export function computeOwnEloPrediction(homeRating, awayRating) {
  const dr = homeRating - awayRating + HOME_ADV;
  const expGoalDiff = dr / 173; // ~173 Elo points ≈ 1 goal, the same commonly-cited approximation elo.js uses
  const AVG_TOTAL_GOALS = 2.7;
  const homeExp = Math.max(0.35, AVG_TOTAL_GOALS / 2 + expGoalDiff / 2);
  const awayExp = Math.max(0.35, AVG_TOTAL_GOALS / 2 - expGoalDiff / 2);

  const MAX_GOALS = 8;
  let pHome = 0, pDraw = 0, pAway = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = poissonPmf(h, homeExp) * poissonPmf(a, awayExp);
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
    }
  }
  const round = (x) => Math.round(x * 100);
  return { home: round(pHome), draw: round(pDraw), away: round(pAway) };
}

// Not actually async — matches the naming/shape convention of the other
// prediction modules (fetchXPrediction) so it slots into research.js the
// same way, even though this one is pure local arithmetic with nothing to
// fetch over the network.
export function fetchOwnEloPrediction(home, away, ratings) {
  try {
    const homeRating = ratings?.[home];
    const awayRating = ratings?.[away];
    if (homeRating == null || awayRating == null) return null; // no finished matches recorded yet for one side — never a guess

    const calc = computeOwnEloPrediction(homeRating, awayRating);
    return {
      prob: {
        source: "Our Elo (calculated)",
        url: null,
        home: calc.home,
        draw: calc.draw,
        away: calc.away,
      },
    };
  } catch (err) {
    console.warn(`[ownElo] failed for ${home} vs ${away}:`, err.message);
    return null;
  }
}
