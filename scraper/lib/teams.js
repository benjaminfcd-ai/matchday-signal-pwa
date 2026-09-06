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
};

const FLAT_ALIASES = Object.entries(TEAM_ALIASES).flatMap(([canonical, names]) =>
  names.map((n) => [n.toLowerCase(), canonical])
);

// Resolve any spelling/short-name of a club to its canonical name, or return
// the input unchanged if unrecognized (better to keep an unrecognized name
// visible than silently drop the fixture).
export function canonicalTeam(name) {
  if (!name) return name;
  const hit = FLAT_ALIASES.find(([alias]) => alias === name.trim().toLowerCase());
  return hit ? hit[1] : name.trim();
}

export function slugify(home, away) {
  const s = (t) => t.toLowerCase().replace(/[^a-z]+/g, "").slice(0, 4);
  return `${s(home)}-${s(away)}`;
}
