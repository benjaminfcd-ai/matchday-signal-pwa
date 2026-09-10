import { canonicalTeam } from "./teams.js";

// Same football-data.org free-tier token already used for fixtures — the
// standings endpoint is included on the free plan for both competitions
// this project tracks, so no new signup, key, or paid service is needed.
const API_BASE = "https://api.football-data.org/v4";

/**
 * Fetch the current table for the given competition ("PL" or "CL") from
 * football-data.org. Returns the overall ("TOTAL", not home/away-split)
 * standings as a plain array, ordered by position, or [] if the competition
 * has no table yet (e.g. pre-season).
 *
 * For "CL" this is the 36-team league-phase table (one combined table, not
 * the old group stage) — football-data.org publishes it the same way as a
 * domestic league's table, under the same "TOTAL" standings type, so no
 * special-casing is needed here beyond which competition code to call.
 */
export async function fetchStandings(competition = "PL") {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    throw new Error(
      "FOOTBALL_DATA_TOKEN must be set (as a GitHub Actions secret) — sign up free at football-data.org/client/register"
    );
  }
  const url = `${API_BASE}/competitions/${competition}/standings`;
  const res = await fetch(url, { headers: { "X-Auth-Token": token } });
  if (!res.ok) throw new Error(`football-data.org standings request failed for ${competition}: ${res.status}`);
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
