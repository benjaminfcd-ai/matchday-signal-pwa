// A Poisson goal-expectation model built primarily from each club's ACTUAL
// expected goals (xG) this season — a shot-quality-based measure from
// Understat (see ../xg.js) that's a steadier, faster-converging signal than
// raw goals scored/conceded, especially with only a handful of games
// played. When Understat's current-season xG isn't available for a team
// (site unreachable, or that fixture hasn't been mapped yet), this falls
// back to real goals scored/conceded from football-data.org instead —
// never a guess, just a steadier real number.
//
// TWO free, self-calculated refinements on top of that base signal — no new
// scraping, no new API, just smarter use of data this project already
// fetches every run:
//
// 1. RECENT FORM: a flat season-long average treats a game from August the
//    same as one from last week, which misses real momentum (a team on a
//    4-game unbeaten run plays differently than its season average
//    suggests). Every per-team rate below is now a recency-weighted
//    average — each match counts for FORM_DECAY times as much as the match
//    right after it, so recent games matter more without a hard cutoff
//    that throws older games away entirely (see weightedAverage()).
//
// 2. HOME/AWAY SPLITS: this used to apply one flat adjustment to every
//    team — a fixed +12% home boost, -6% away dampen. Real clubs aren't
//    uniform: some are genuinely stronger at home than away (or vice
//    versa) by more or less than that. Each team's attack/defense rate is
//    now computed separately for its home matches and its away matches
//    (see venueStats()), shrunk toward that SAME team's own overall rate —
//    with a small default home/away nudge built into that shrinkage prior
//    so an early-season fixture (before a team has played enough of its
//    own home or away games yet) still gets a sensible generic assumption,
//    fading out on its own as real venue-specific data accumulates.
//
// This is what drives Over/Under, Correct Score, and the goal-based
// Handicap line; Club Elo (elo.js) and Our Elo (ownElo.js) are left to do
// what they're actually suited for — an independent win/draw/loss reading
// from ratings, not goal totals.
//
// MULTI-LEAGUE (Sept 2026): this used to be Premier-League-only, with one
// shared `leagueAvgGoals` number used both to shrink each team's rate
// toward a sensible baseline AND to convert a matchup's relative strengths
// back into an actual expected goal count. Different leagues score at
// genuinely different rates (Bundesliga is a notably higher-scoring league
// than the other two, historically) — averaging them all into one number
// would quietly corrupt every league's predictions. So this now computes
// EACH competition's stats entirely separately (its own league average, its
// own per-team shrinkage), via computeStatsForCompetition() below, and
// merges the results into one lookup keyed by team name — safe to merge
// because every real fixture this model is ever asked about has both teams
// in the SAME competition, and each team's strength entry below carries its
// OWN competition's leagueAvgGoals baked in for computeGoalsPrediction() to
// use, rather than relying on one shared top-level number.
const PRIOR_GAMES = 4; // shrink this season's rate toward the prior below
const VENUE_PRIOR_GAMES = 3; // shrink a team's home/away-specific rate toward its own overall rate
const FORM_DECAY = 0.85; // each match back in time counts ~85% as much as the next-most-recent one
const DEFAULT_HOME_ATTACK_FACTOR = 1.08; // generic home-advantage assumption, used only until real home-specific data outweighs it
const DEFAULT_AWAY_ATTACK_FACTOR = 0.96;
const DEFAULT_HOME_DEFENSE_FACTOR = 0.94; // teams tend to concede a little less at home
const DEFAULT_AWAY_DEFENSE_FACTOR = 1.06;
const MAX_GOALS = 8;

// Turns a chronological (oldest-first) list of {venue, attack, defense}
// entries into a recency-weighted average for one venue ("home" | "away"),
// or overall (venue = null). Returns { attack, defense, effectiveGames } —
// effectiveGames is the DECAYED count of matches actually used (older
// matches contribute less than a full "1 game" of evidence), which is what
// the shrinkage below uses as its sample size instead of a flat count.
function venueStats(entries, venue) {
  const filtered = venue ? entries.filter((e) => e.venue === venue) : entries;
  if (!filtered.length) return { attack: null, defense: null, effectiveGames: 0 };
  let sumW = 0, sumAttack = 0, sumDefense = 0;
  // filtered is oldest-first; rank 0 = most recent.
  for (let i = 0; i < filtered.length; i++) {
    const rank = filtered.length - 1 - i;
    const w = Math.pow(FORM_DECAY, rank);
    sumW += w;
    sumAttack += w * filtered[i].attack;
    sumDefense += w * filtered[i].defense;
  }
  return { attack: sumAttack / sumW, defense: sumDefense / sumW, effectiveGames: sumW };
}

// Blends a (possibly null, if no matches at that venue yet) observed value
// toward a prior, weighted by how much real evidence backs the observed
// value versus priorGames worth of the prior. Null-safe: no matches yet at
// this venue just returns the prior outright.
function shrinkToward(value, effectiveGames, prior, priorGames) {
  const v = value == null ? 0 : value;
  return (v * effectiveGames + prior * priorGames) / (effectiveGames + priorGames);
}

// Builds each team's chronological, venue-tagged goals history from real
// finished results (football-data.org) — the fallback signal whenever
// Understat's xG isn't available for a team.
function buildGoalsHistory(seasonFixtures) {
  const byTeam = {};
  const ensure = (t) => (byTeam[t] ||= []);
  const finished = (seasonFixtures || [])
    .filter((f) => f.status === "finished" && f.score)
    .slice()
    .sort((a, b) => new Date(a.kickoffLocal) - new Date(b.kickoffLocal));
  for (const f of finished) {
    const parts = f.score.split(/[–-]/).map((n) => parseInt(n, 10));
    if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) continue;
    const [hGoals, aGoals] = parts;
    ensure(f.home).push({ date: f.kickoffLocal, venue: "home", attack: hGoals, defense: aGoals });
    ensure(f.away).push({ date: f.kickoffLocal, venue: "away", attack: aGoals, defense: hGoals });
  }
  return byTeam;
}

// Picks which signal to use for one team — Understat's xG when it has at
// least one game recorded this season (steadier, see top-of-file comment),
// otherwise real goals. Never mixes the two game-by-game (different units),
// only switches wholesale per team.
function normalizeEntries(xgEntries, goalsEntries) {
  if (xgEntries && xgEntries.length > 0) {
    return {
      usingXg: true,
      entries: xgEntries.map((g) => ({ venue: g.venue, attack: g.xgFor, defense: g.xgAgainst })),
    };
  }
  return {
    usingXg: false,
    entries: (goalsEntries || []).map((g) => ({ venue: g.venue, attack: g.attack, defense: g.defense })),
  };
}

// Builds ONE competition's shrunk, venue-specific attack/defense strengths
// (relative to THAT competition's own average goals/team/game) from every
// FINISHED match in its season fixtures, blended with Understat's xG
// context for that same competition when available. This is the same
// calculation computeTeamGoalStats() always did — now just wrapped as a
// per-competition helper so the multi-league version below can call it once
// per league and merge the results (see the top-of-file comment for why
// leagues can't just be pooled into one shared average).
function computeStatsForCompetition(seasonFixtures, xgContext = {}) {
  const xgCurrent = xgContext.current || null;
  const xgPrevious = xgContext.previous || null;

  const goalsHistory = buildGoalsHistory(seasonFixtures);

  let totalGoals = 0;
  let totalTeamGames = 0;
  for (const f of seasonFixtures || []) {
    if (f.status !== "finished" || !f.score) continue;
    const parts = f.score.split(/[–-]/).map((n) => parseInt(n, 10));
    if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) continue;
    totalGoals += parts[0] + parts[1];
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

  const teams = new Set([...Object.keys(goalsHistory), ...(xgCurrent ? Object.keys(xgCurrent) : [])]);
  const strengths = {};

  for (const team of teams) {
    const { usingXg, entries } = normalizeEntries(xgCurrent?.[team], goalsHistory[team]);
    if (!entries.length) continue; // no finished-match data yet for this team — leave it out entirely, never a guess

    const overall = venueStats(entries, null);
    const home = venueStats(entries, "home");
    const away = venueStats(entries, "away");

    // Prior: this team's own last-season xG rate when Understat has it,
    // otherwise this competition's league-average xG rate.
    const prevTeam = xgPrevious?.[team];
    const usingPreviousSeasonPrior = !!(prevTeam && prevTeam.games > 0);
    const priorAttack = usingPreviousSeasonPrior ? prevTeam.xgFor / prevTeam.games : leagueAvgXg;
    const priorDefense = usingPreviousSeasonPrior ? prevTeam.xgAgainst / prevTeam.games : leagueAvgXg;

    // Level 1: this season's recency-weighted overall rate, shrunk toward
    // the prior above — same shrinkage this project has always used, just
    // recency-weighted now instead of a flat season average.
    const shrunkOverallAttack = shrinkToward(overall.attack, overall.effectiveGames, priorAttack, PRIOR_GAMES);
    const shrunkOverallDefense = shrinkToward(overall.defense, overall.effectiveGames, priorDefense, PRIOR_GAMES);

    // Level 2: home/away-specific rate, shrunk toward THIS team's own
    // overall rate (not the generic league prior) — nudged by a small
    // default home/away factor so a team with no home (or away) games yet
    // this season still gets a sensible generic assumption, exactly like
    // the old flat constants did, fading out as real venue data arrives.
    const shrunkHomeAttack = shrinkToward(home.attack, home.effectiveGames, shrunkOverallAttack * DEFAULT_HOME_ATTACK_FACTOR, VENUE_PRIOR_GAMES);
    const shrunkHomeDefense = shrinkToward(home.defense, home.effectiveGames, shrunkOverallDefense * DEFAULT_HOME_DEFENSE_FACTOR, VENUE_PRIOR_GAMES);
    const shrunkAwayAttack = shrinkToward(away.attack, away.effectiveGames, shrunkOverallAttack * DEFAULT_AWAY_ATTACK_FACTOR, VENUE_PRIOR_GAMES);
    const shrunkAwayDefense = shrinkToward(away.defense, away.effectiveGames, shrunkOverallDefense * DEFAULT_AWAY_DEFENSE_FACTOR, VENUE_PRIOR_GAMES);

    strengths[team] = {
      homeAttack: shrunkHomeAttack / leagueAvgGoals,
      homeDefense: shrunkHomeDefense / leagueAvgGoals,
      awayAttack: shrunkAwayAttack / leagueAvgGoals,
      awayDefense: shrunkAwayDefense / leagueAvgGoals,
      // Carried on every team's own entry (not just returned once at the
      // top level) so computeGoalsPrediction() can convert a matchup's
      // relative strengths back into real expected goals using THIS
      // competition's own average, even after every competition's teams
      // have been merged into one flat lookup — see computeTeamGoalStats().
      leagueAvgGoals,
      gamesPlayed: entries.length,
      usingXg,
      usingPreviousSeasonPrior,
    };
  }

  return { strengths, leagueAvgGoals, teamsWithData: Object.keys(strengths).length };
}

// Builds attack/defense strengths across MULTIPLE competitions at once.
// `fixturesByCompetition` and `xgContextByCompetition` are both objects
// keyed by competition code (e.g. { PL: [...], BL1: [...], PD: [...] } and
// { PL: {current,previous}, BL1: {...}, PD: {...} } — the exact shape
// fetchXgContext() in xg.js now returns). Each competition is computed
// entirely independently via computeStatsForCompetition() above, then
// merged into one flat `strengths` lookup keyed by team name — safe
// because a club only ever appears in one of these domestic leagues at a
// time, so there's no risk of one competition's entry overwriting
// another's for the same team.
export function computeTeamGoalStats(fixturesByCompetition, xgContextByCompetition = {}) {
  const strengths = {};
  const byCompetition = {};
  let teamsWithData = 0;

  for (const [competition, seasonFixtures] of Object.entries(fixturesByCompetition || {})) {
    const result = computeStatsForCompetition(seasonFixtures, xgContextByCompetition[competition] || {});
    Object.assign(strengths, result.strengths);
    teamsWithData += result.teamsWithData;
    byCompetition[competition] = { leagueAvgGoals: result.leagueAvgGoals, teamsWithData: result.teamsWithData };
  }

  return { strengths, teamsWithData, byCompetition };
}

function poissonPmf(k, lambda) {
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

export function computeGoalsPrediction(home, away, teamStrengths) {
  const { strengths } = teamStrengths;
  const h = strengths[home];
  const a = strengths[away];
  if (!h || !a) return null; // no finished-match data yet for one side — don't guess, per the hard rule

  // Both teams in any real fixture this model is asked about belong to the
  // SAME competition, so either side's own `leagueAvgGoals` is the right
  // baseline here — using the home team's is an arbitrary but harmless
  // choice (see computeStatsForCompetition() for where this value comes
  // from and why it's carried per-team rather than as one shared number).
  const leagueAvgGoals = h.leagueAvgGoals;

  // Each team's own home/away-specific attack and defense strength already
  // carries whatever real home-advantage (or lack of it) that team has
  // shown this season — see computeStatsForCompetition() — so no separate
  // flat home-boost/away-dampen multiplier is applied here on top of it.
  const homeExp = Math.max(0.3, leagueAvgGoals * h.homeAttack * a.awayDefense);
  const awayExp = Math.max(0.3, leagueAvgGoals * a.awayAttack * h.homeDefense);

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
