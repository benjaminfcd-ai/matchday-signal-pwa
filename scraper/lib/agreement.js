// Turns a list of {source, home, draw, away} probability readings into the
// same good/warn/bad/split labeling this project has used from the start —
// computed mechanically here (no AI judgment call), which is the honest
// trade-off of moving off a Claude-run research pass: see the project README.
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

export function computeAgreement(probs, home, away) {
  const readings = probs
    .map((p) => ({ source: p.source, ...favoredSide(p) }))
    .filter((r) => r.label != null);

  if (readings.length === 0) {
    return {
      agreement: null,
      agreementNote: "No numeric source accessible for this fixture yet.",
      standout: { market: "—", pick: "Not yet analyzed", pct: null, source: null, note: "Checked closer to kickoff." },
    };
  }

  const counts = {};
  for (const r of readings) counts[r.label] = (counts[r.label] || 0) + 1;
  const topLabel = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const topReadings = readings.filter((r) => r.label === topLabel);
  const ratio = topReadings.length / readings.length;
  const avgConfidence = topReadings.reduce((s, r) => s + r.value, 0) / topReadings.length;
  const bestReading = readings.reduce((best, r) => (r.value > (best?.value ?? -1) ? r : best), null);
  const teamName = (label) => (label === "home" ? home : label === "away" ? away : "the draw");

  let agreement;
  if (ratio === 1 && readings.length >= 2) agreement = avgConfidence >= 45 ? "good" : "split";
  else if (ratio === 1) agreement = "warn"; // only one source published — can't call it agreement yet
  else if (ratio >= 0.5) agreement = "warn";
  else agreement = "bad";

  const noteBySources = readings.map((r) => r.source).join(", ");
  let agreementNote;
  if (agreement === "good") agreementNote = `${noteBySources} all point to ${teamName(topLabel)}.`;
  else if (agreement === "split") agreementNote = `${noteBySources} lean the same way but without a strong favorite — a tight one.`;
  else if (agreement === "warn") agreementNote = `${noteBySources} lean toward ${teamName(topLabel)}, but not unanimously.`;
  else agreementNote = `${noteBySources} disagree on the likely outcome.`;

  return {
    agreement,
    agreementNote,
    standout: {
      market: "Match Winner",
      pick: teamName(bestReading.label),
      pct: bestReading.value,
      source: ratio === 1 && readings.length >= 2 ? "unanimous" : bestReading.source,
      note: null,
    },
  };
}
