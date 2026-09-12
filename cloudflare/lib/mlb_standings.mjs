// Factual standings only: no model, prediction, publication gate, or storage writes.
const ROOT = 'https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings';

export function mlbStandingsRequest(now = new Date()) {
  const season = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric',
  }).format(now));
  return {
    season,
    cacheTag: `mlb-div-v2-${season}`,
    upstream: `${ROOT}?level=3&season=${season}`,
    alternate: `${ROOT}?season=${season}`,
  };
}

function numeric(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseMlbStandings(data, expectedSeason) {
  const season = numeric(data?.season?.year ?? data?.season?.displayName);
  // Never turn a successful HTTP response for a different season into current data.
  if (season !== Number(expectedSeason)) throw new Error('MLB standings season mismatch');

  const mapEntries = (entries) => (entries || []).map((entry, index) => {
    const find = (name) => (entry.stats || []).find((stat) => stat.name === name || stat.type === name);
    const display = (name) => {
      const stat = find(name);
      return stat ? (stat.displayValue ?? stat.value ?? null) : null;
    };
    const measured = (name) => {
      const stat = find(name);
      return stat ? (numeric(stat.value) ?? numeric(stat.displayValue)) : null;
    };
    const wins = measured('wins'), losses = measured('losses');
    const observedPct = measured('winPercent');
    const percentage = wins !== null && losses !== null && wins >= 0 && losses >= 0 && wins + losses > 0
      ? wins / (wins + losses)
      : observedPct !== null && observedPct >= 0 && observedPct <= 1 ? observedPct : null;
    const seed = measured('playoffSeed');
    return {
      index, percentage, seed: seed !== null && seed > 0 ? seed : null,
      row: {
        code: entry.team?.abbreviation || null,
        name: entry.team?.shortDisplayName || entry.team?.displayName || null,
        logo: entry.team?.logos?.[0]?.href || null,
        gp: display('gamesPlayed'), w: display('wins'), d: display('ties'), l: display('losses'),
        pct: display('winPercent'), gb: display('gamesBehind'),
        gd: display('pointDifferential') ?? display('goalDifferential') ?? display('pointsDiff'),
        pts: display('points'),
      },
    };
  });
  const collect = (node) => node?.standings?.entries?.length
    ? [{ name: node.name || node.abbreviation || '', entries: mapEntries(node.standings.entries) }]
    : (node?.children || []).flatMap(collect);
  const sections = collect(data).map(({ name, entries }) => {
    // ESPN MLB does not reliably provide "rank" or ordered arrays. Sort complete
    // records using unrounded win fractions, with the provider's playoff seed
    // breaking exact ties only when the entire section has trustworthy seeds.
    // Never display a league playoff seed as a division rank.
    const complete = entries.every((entry) => entry.percentage !== null);
    const seeds = entries.map((entry) => entry.seed);
    const seeded = seeds.every((seed) => seed !== null) && new Set(seeds).size === seeds.length;
    if (complete) entries.sort((a, b) => b.percentage - a.percentage
      || (seeded ? a.seed - b.seed : 0) || a.index - b.index);
    return {
      name,
      rows: entries.map(({ row }, index) => ({ ...row, rank: complete ? index + 1 : null })),
    };
  });
  return { season: String(season), sections };
}
