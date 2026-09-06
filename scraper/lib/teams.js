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
