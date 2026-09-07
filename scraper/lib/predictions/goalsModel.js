// A Poisson goal-expectation model built from each club's ACTUAL goals
// scored/conceded this season (not a flat league-wide guess) — the standard
// Maher (1982) multiplicative attack/defense-strength approach that most
// professional expected-goals models are built on. This is what drives
// Over/Under, Correct Score, and the goal-based Handicap line; Club Elo
// (elo.js) is left to do what it's actually suited for — an independent
// win/draw/loss reading from ratings, not goal totals. Two teams can have
// the same Elo rating with very different scoring profiles (e.g. a
// low-event defensive side vs. a high-event attacking one) — Elo alone
// can't tell Over/Under apart for those two matches, but their actual goals
// this season can.
//
// EARLY-SEASON NOTE: with only a couple of games played, a team's raw
// scoring rate is noisy — conceding 5 goals in 2 games doesn't reliably
// mean a leaky defense yet. This applies Bayesian shrinkage: each team's
// rate is blended toward the league average, weighted by PRIOR_GAMES worth
// of "pseudo-games" of league-average performance, so small samples pull
// toward the league norm instead of producing wild swings. As more of the
// season is played, real form increasingly outweighs that prior.
const PRIOR_GAMES = 4;
const HOME_GOAL_BOOST = 1.12; // home teams score somewhat more than a neutral venue would suggest
const AWAY_GOAL_DAMPEN = 0.94;
const MAX_GOALS = 8;

// Builds each team's shrunk attack/defense strength (relative to the
// league-average goals/team/game) from every FINISHED match in the fetched
// season fixtures — no extra network calls, since run.js already fetches
// the full season from football-data.org for the schedule itself.
export function computeTeamGoalStats(seasonFixtures) {
  const byTeam = {};
  const ensure = (t) => (byTeam[t] ||= { gf: 0, ga: 0, gp: 0 });

  let totalGoals = 0;
  let totalTeamGames = 0;

  for (const f of seasonFixtures) {
    if (f.status !== "finished" || !f.score) continue;
    const parts = f.score.split(/[–-]/).map((n) => parseInt(n, 10));
    if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) continue;
    const [hGoals, aGoals] = parts;

    const h = ensure(f.home);
    h.gf += hGoals;
    h.ga += aGoals;
    h.gp += 1;

    const a = ensure(f.away);
    a.gf += aGoals;
    a.ga += hGoals;
    a.gp += 1;

    totalGoals += hGoals + aGoals;
    totalTeamGames += 2;
  }

  const leagueAvgGoals = totalTeamGames ? totalGoals / totalTeamGames : 1.35; // per team per game, fallback if season just started

  const strengths = {};
  for (const [team, s] of Object.entries(byTeam)) {
    const shrunkAttack = (s.gf + PRIOR_GAMES * leagueAvgGoals) / (s.gp + PRIOR_GAMES);
    const shrunkDefense = (s.ga + PRIOR_GAMES * leagueAvgGoals) / (s.gp + PRIOR_GAMES);
    strengths[team] = {
      attack: shrunkAttack / leagueAvgGoals,
      defense: shrunkDefense / leagueAvgGoals,
      gamesPlayed: s.gp,
    };
  }

  return { strengths, leagueAvgGoals, teamsWithData: Object.keys(strengths).length };
}

function poissonPmf(k, lambda) {
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

export function computeGoalsPrediction(home, away, teamStrengths) {
  const { strengths, leagueAvgGoals } = teamStrengths;
  const h = strengths[home];
  const a = strengths[away];
  if (!h || !a) return null; // no finished-match data yet for one side — don't guess, per the hard rule

  const homeExp = Math.max(0.3, leagueAvgGoals * h.attack * a.defense * HOME_GOAL_BOOST);
  const awayExp = Math.max(0.3, leagueAvgGoals * a.attack * h.defense * AWAY_GOAL_DAMPEN);

  let pOver25 = 0;
  const grid = [];
  for (let hg = 0; hg <= MAX_GOALS; hg++) {
    for (let ag = 0; ag <= MAX_GOALS; ag++) {
      const p = poissonPmf(hg, homeExp) * poissonPmf(ag, awayExp);
      if (hg + ag >= 3) pOver25 += p;
      grid.push({ hg, ag, p });
    }
  }
  grid.sort((x, y) => y.p - x.p);
  const top = grid[0];

  const round = (x) => Math.round(x * 100);
  const goalDiff = homeExp - awayExp;
  const handicapLine = Math.round(Math.abs(goalDiff) * 4) / 4; // nearest quarter goal
  const handicapTeam = goalDiff >= 0 ? home : away;

  return {
    over25Pct: round(pOver25),
    under25Pct: round(1 - pOver25),
    correctScore: { home: top.hg, away: top.ag, pct: round(top.p) },
    handicap: { team: handicapTeam, line: handicapLine },
    expectedGoals: { home: Math.round(homeExp * 10) / 10, away: Math.round(awayExp * 10) / 10 },
    sampleGames: Math.min(h.gamesPlayed, a.gamesPlayed),
  };
}

export function fetchGoalsPrediction(home, away, teamStrengths) {
  // Not actually async — kept as a plain function that returns a value
  // directly, but named/shaped to slot into run.js the same way as the
  // other (network-fetching) prediction modules.
  try {
    const calc = computeGoalsPrediction(home, away, teamStrengths);
    if (!calc) return null;

    const lowSample = calc.sampleGames < 3;
    const sourceLabel = lowSample ? "Goals model (early-season, low sample)" : "Goals model (calculated)";

    return {
      extras: [
        {
          market: "Over/Under 2.5",
          pick: calc.over25Pct >= 50 ? "Over 2.5" : "Under 2.5",
          pct: calc.over25Pct >= 50 ? calc.over25Pct : calc.under25Pct,
          source: sourceLabel,
        },
        {
          market: "Correct Score",
          pick: `${calc.correctScore.home}-${calc.correctScore.away}`,
          pct: calc.correctScore.pct,
          source: sourceLabel,
        },
        {
          market: "Handicap",
          pick: calc.handicap.line > 0 ? `${calc.handicap.team} -${calc.handicap.line}` : "Pick 'em (no clear favorite)",
          pct: null,
          source: sourceLabel,
        },
      ],
    };
  } catch (err) {
    console.warn(`[goalsModel] failed for ${home} vs ${away}:`, err.message);
    return null;
  }
}
