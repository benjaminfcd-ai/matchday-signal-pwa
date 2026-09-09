// Canonical Premier League club names + common aliases used by fixture/
// prediction sources, so text scraped from different sites can be matched
// to the same fixture. Extend this list if a club is promoted/relegated.
export const TEAM_ALIASES = {
  "Arsenal": ["Arsenal"],
  "Aston Villa": ["Aston Villa", "Villa"],
  "Bournemouth": ["Bournemouth", "AFC Bournemouth"],
  "Brentford": ["Brentford"],
  "Brighton and Hove Albion": ["Brighton", "Brighton & Hove Albion", "Brighton and Hove Albion"],
  "Burnley": ["Burnley"],
  "Chelsea": ["Chelsea"],
  "Crystal Palace": ["Crystal Palace", "Palace"],
  "Everton": ["Everton"],
  "Fulham": ["Fulham"],
  "Leeds United": ["Leeds", "Leeds United"],
  "Liverpool": ["Liverpool"],
  "Manchester City": ["Man City", "Manchester City"],
  "Manchester United": ["Man Utd", "Man United", "Manchester United"],
  "Newcastle United": ["Newcastle", "Newcastle United"],
  "Nottingham Forest": ["Nottingham Forest", "Nott'm Forest", "Forest"],
  "Sunderland": ["Sunderland"],
  "Tottenham Hotspur": ["Tottenham", "Spurs", "Tottenham Hotspur"],
  "West Ham United": ["West Ham", "West Ham United"],
  "Wolverhampton Wanderers": ["Wolves", "Wolverhampton Wanderers", "Wolverhampton"],
  "Ipswich Town": ["Ipswich", "Ipswich Town"],
  "Leicester City": ["Leicester", "Leicester City"],
  "Southampton": ["Southampton"],

  // Champions League — major European clubs likely to appear in a given
  // season's league-phase draw. This list is deliberately best-effort, not
  // exhaustive: canonicalTeam()'s partial-match fallback below already
  // handles most unlisted clubs reasonably (a club not listed here just
  // keeps its source-provided name rather than getting normalized across
  // sources) — same graceful, "never fabricate" degrade as the rest of
  // this project. Extend this list as real CL fixtures reveal club-name
  // mismatches between football-data.org and the scraped prediction sites.
  "Real Madrid": ["Real Madrid", "Real Madrid CF"],
  "Barcelona": ["Barcelona", "FC Barcelona", "Barça"],
  "Atletico Madrid": ["Atletico Madrid", "Atlético Madrid", "Atletico de Madrid", "Club Atlético de Madrid"],
  "Bayern Munich": ["Bayern Munich", "Bayern München", "FC Bayern München", "Bayern"],
  "Borussia Dortmund": ["Borussia Dortmund", "Dortmund", "BVB"],
  "RB Leipzig": ["RB Leipzig", "Leipzig"],
  "Bayer Leverkusen": ["Bayer Leverkusen", "Leverkusen", "Bayer 04 Leverkusen"],
  "Paris Saint-Germain": ["Paris Saint-Germain", "PSG", "Paris SG"],
  "Monaco": ["Monaco", "AS Monaco"],
  "Marseille": ["Marseille", "Olympique de Marseille", "OM"],
  "Juventus": ["Juventus", "Juventus FC", "Juve"],
  "Inter Milan": ["Inter Milan", "Inter", "FC Internazionale Milano", "Internazionale"],
  "AC Milan": ["AC Milan", "Milan"],
  "Napoli": ["Napoli", "SSC Napoli"],
  "Atalanta": ["Atalanta", "Atalanta BC"],
  "Benfica": ["Benfica", "SL Benfica"],
  "Porto": ["Porto", "FC Porto"],
  "Sporting CP": ["Sporting CP", "Sporting Clube de Portugal", "Sporting Lisbon"],
  "Ajax": ["Ajax", "AFC Ajax"],
  "PSV Eindhoven": ["PSV Eindhoven", "PSV"],
  "Feyenoord": ["Feyenoord", "Feyenoord Rotterdam"],
  "Club Brugge": ["Club Brugge", "Club Brugge KV"],
  "Union Saint-Gilloise": ["Union Saint-Gilloise", "Royale Union Saint-Gilloise"],
  "Celtic": ["Celtic", "Celtic FC"],
  "Shakhtar Donetsk": ["Shakhtar Donetsk", "Shakhtar"],
  "Dynamo Kyiv": ["Dynamo Kyiv", "Dynamo Kiev"],
  "Red Bull Salzburg": ["Red Bull Salzburg", "RB Salzburg", "Salzburg"],
  "Sturm Graz": ["Sturm Graz"],
  "Slavia Prague": ["Slavia Prague", "SK Slavia Praha"],
  "Sparta Prague": ["Sparta Prague", "AC Sparta Praha"],
  "Galatasaray": ["Galatasaray", "Galatasaray SK"],
  "Fenerbahce": ["Fenerbahce", "Fenerbahçe"],
  "Olympiacos": ["Olympiacos", "Olympiacos FC"],
  "PAOK": ["PAOK", "PAOK FC"],
  "Bodo/Glimt": ["Bodo/Glimt", "Bodø/Glimt", "FK Bodø/Glimt"],
  "Copenhagen": ["Copenhagen", "FC København", "FC Copenhagen"],
  "Qarabag": ["Qarabag", "Qarabağ", "Qarabag FK"],
};

const FLAT_ALIASES = Object.entries(TEAM_ALIASES).flatMap(([canonical, names]) =>
  names.map((n) => [n.toLowerCase(), canonical])
);

// Resolve any spelling/short-name of a club to its canonical name, or return
// the input unchanged if unrecognized (better to keep an unrecognized name
// visible than silently drop the fixture).
export function canonicalTeam(name) {
  if (!name) return name;
  // football-data.org names include the club suffix, e.g. "Arsenal FC",
  // "AFC Bournemouth" — strip that before matching against our aliases.
  const stripped = name.trim().replace(/^AFC\s+/i, "").replace(/\s+F\.?C\.?$/i, "").trim();
  const lower = stripped.toLowerCase();
  const exact = FLAT_ALIASES.find(([alias]) => alias === lower);
  if (exact) return exact[1];
  const partial = FLAT_ALIASES.find(([alias]) => lower.includes(alias) || alias.includes(lower));
  return partial ? partial[1] : stripped;
}

export function slugify(home, away) {
  const s = (t) => t.toLowerCase().replace(/[^a-z]+/g, "").slice(0, 4);
  return `${s(home)}-${s(away)}`;
}
