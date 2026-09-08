import { canonicalTeam } from "./teams.js";

// Same football-data.org free-tier token already used for fixtures — the
// standings endpoint for the Premier League is included on the free plan,
// so this needs no new signup, key, or paid service.
const API_BASE = "https://api.football-data.org/v4";
const COMPETITION = "PL";

/**
 * Fetch the current Premier League table from football-data.org. Returns the
 * overall ("TOTAL", not home/away-split) standings as a plain array, ordered
 * by position, or [] if the competition has no table yet (e.g. pre-season).
 */
export async function fetchStandings() {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    throw new Error(
      "FOOTBALL_DATA_TOKEN must be set (as a GitHub Actions secret) — sign up free at football-data.org/client/register"
    );
  }
  const url = `${API_BASE}/competitions/${COMPETITION}/standings`;
  const res = await fetch(url, { headers: { "X-Auth-Token": token } });
  if (!res.ok) throw new Error(`football-data.org standings request failed: ${res.status}`);
  const data = await res.json();

  const total = (data.standings || []).find((s) => s.type === "TOTAL");
  if (!total || !Array.isArray(total.table)) return [];

  return total.table.map((row) => ({
    position: row.position,
    team: canonicalTeam(row.team?.name || row.team?.shortName || ""),
    crest: row.team?.crest || null,
    played: row.playedGames ?? 0,
    won: row.won ?? 0,
    draw: row.draw ?? 0,
    lost: row.lost ?? 0,
    goalsFor: row.goalsFor ?? 0,
    goalsAgainst: row.goalsAgainst ?? 0,
    goalDifference: row.goalDifference ?? 0,
    points: row.points ?? 0,
  }));
}
