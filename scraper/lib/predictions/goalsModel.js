// A Poisson goal-expectation model built primarily from each club's ACTUAL
// expected goals (xG) this season — a shot-quality-based measure from
// Understat (see ../xg.js) that's a steadier, faster-converging signal than
// raw goals scored/conceded, especially with only a handful of games
// played. When Understat's current-season xG isn't available for a team
// (site unreachable, or that fixture hasn't been mapped yet), this falls
// back to real goals scored/conceded from football-data.org instead —
// never a guess, just a steadier real number.
//
// EARLY-SEASON PRIOR: with only a couple of games played, ANY per-game
// rate is noisy — goals or xG. This blends each team's current-season rate
// toward a PRIOR, weighted by PRIOR_GAMES worth of "pseudo-games" of that
// prior. The prior itself is smarter than a flat league average: it's that
// team's own final xG rate from LAST season when Understat has it (a
// genuinely informative anchor — a team that concedes a lot tends to keep
// doing so), falling back to the current league-average xG rate only for a
// newly promoted team with no top-flight history to draw on.
//
// This is what drives Over/Under, Correct Score, and the goal-based
// Handicap line; Club Elo (elo.js) is left to do what it's actually suited
// for — an independent win/draw/loss reading from ratings, not goal
// totals.
const PRIOR_GAMES = 4;
const HOME_GOAL_BOOST = 1.12; // home teams score somewhat more than a neutral venue would suggest
const AWAY_GOAL_DAMPEN = 0.94;
const MAX_GOALS = 8;

// Builds each team's shrunk attack/defense strength (relative to the
// league-average goals/team/game) from every FINISHED match in the fetched
// season fixtures, blended with Understat's xG context when available.
// `xgContext` is `{ current, previous }` from xg.js — either can be null
// (Understat unreachable this run, or a specific team missing from it),
// in which case that team's strength falls back to real goals only, per
// the hard "never fabricate" rule.
export function computeTeamGoalStats(seasonFixtures, xgContext = {}) {
  const xgCurrent = xgContext.current || null;
  const xgPrevious = xgContext.previous || null;

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

  // League-average xG rate (last season), used as the prior only for a
  // team Understat has no history for (e.g. newly promoted).
  let leagueAvgXg = leagueAvgGoals;
  if (xgPrevious) {
    const withData = Object.values(xgPrevious).filter((t) => t.games > 0);
    if (withData.length) {
      leagueAvgXg = withData.reduce((sum, t) => sum + t.xgFor / t.games, 0) / withData.length;
    }
  }

  const strengths = {};
  for (const [team, s] of Object.entries(byTeam)) {
    const xgNow = xgCurrent?.[team];
    const usingXg = !!(xgNow && xgNow.games > 0);

    // This season's rate: prefer Understat's xG (steadier), fall back to
    // real goals from football-data.org.
    const gamesForRate = usingXg ? xgNow.games : s.gp;
    const attackNow = usingXg ? xgNow.xgFor / xgNow.games : s.gp ? s.gf / s.gp : leagueAvgGoals;
    const defenseNow = usingXg ? xgNow.xgAgainst / xgNow.games : s.gp ? s.ga / s.gp : leagueAvgGoals;

    // Prior: this team's own last-season xG rate when Understat has it,
    // otherwise the league-average xG rate.
    const prevTeam = xgPrevious?.[team];
    const usingPreviousSeasonPrior = !!(prevTeam && prevTeam.games > 0);
    const priorAttack = usingPreviousSeasonPrior ? prevTeam.xgFor / prevTeam.games : leagueAvgXg;
    const priorDefense = usingPreviousSeasonPrior ? prevTeam.xgAgainst / prevTeam.games : leagueAvgXg;

    const shrunkAttack = (attackNow * gamesForRate + priorAttack * PRIOR_GAMES) / (gamesForRate + PRIOR_GAMES);
    const shrunkDefense = (defenseNow * gamesForRate + priorDefense * PRIOR_GAMES) / (gamesForRate + PRIOR_GAMES);

    strengths[team] = {
      attack: shrunkAttack / leagueAvgGoals,
      defense: shrunkDefense / leagueAvgGoals,
      gamesPlayed: s.gp,
      usingXg,
      usingPreviousSeasonPrior,
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
    xgBased: !!(h.usingXg && a.usingXg),
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
    const sourceLabel = calc.xgBased
      ? lowSample
        ? "Goals model (xG-based, early-season)"
        : "Goals model (xG-based)"
      : lowSample
      ? "Goals model (early-season, low sample)"
      : "Goals model (calculated)";

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
