// Read-only semantic production check. No credentials, mutations, or model gates.
import assert from 'node:assert/strict';
const api = process.env.AA_API_BASE || 'https://aa-sports-api.opsmira9.workers.dev';
const season = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' }).format(new Date());
const response = await fetch(`${api}/v1/mlb/standings`, { signal: AbortSignal.timeout(30000) });
assert.equal(response.status, 200, 'MLB standings must respond successfully');
const body = await response.json();
assert.equal(String(body.season), season, 'MLB standings must identify the requested current ET season');
assert.equal(body.sections?.length, 6, 'Expected the six MLB divisions, not an empty or league-only fallback');
const codes = [];
for (const section of body.sections) {
  assert.equal(section.rows.length, 5, `${section.name}: expected five teams`);
  let previous = Infinity;
  for (const [index, row] of section.rows.entries()) {
    assert.equal(row.rank, index + 1, `${section.name}: division rank must be sequential`);
    assert.ok(row.w !== null && row.l !== null && String(row.w).trim() !== '' && String(row.l).trim() !== '', 'Missing win/loss data');
    const wins = Number(row.w), losses = Number(row.l);
    assert.ok(Number.isFinite(wins) && Number.isFinite(losses) && wins >= 0 && losses >= 0, 'Invalid win/loss data');
    const fraction = wins + losses > 0 ? wins / (wins + losses) : Number(row.pct);
    assert.ok(Number.isFinite(fraction) && fraction <= previous + 1e-12, `${section.name}: standings out of order at ${row.code}`);
    previous = fraction;
    assert.ok(row.code, 'Missing team code');
    codes.push(row.code);
  }
}
assert.equal(new Set(codes).size, 30, 'MLB standings must contain 30 unique teams');
console.log(JSON.stringify({
  ok: true, checked_at: new Date().toISOString(), season: body.season,
  sections: body.sections.length, teams: codes.length,
  divisions: body.sections.map(s => ({ name: s.name, order: s.rows.map(r => r.code) })),
}, null, 2));
