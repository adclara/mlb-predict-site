export function assessUsSportsPipeline({ live, today, health }) {
  if (health?.ok === true) return { level: 'ok', reason: null };
  const liveGames = Array.isArray(live?.games) ? live.games : [];
  const todayEvents = Array.isArray(today?.events) ? today.events : [];
  const liveSourceFailed = typeof live?.note === 'string' && /upstream|error|fail/i.test(live.note);
  if (!liveSourceFailed && liveGames.length === 0 && todayEvents.length === 0) {
    return {
      level: 'warning',
      reason: `jornada vacía; pipeline ${health?.state || 'unknown'} age=${health?.age_seconds ?? 'n/a'}s`,
    };
  }
  return {
    level: 'error',
    reason: `pipeline ${health?.state || 'unknown'} age=${health?.age_seconds ?? 'n/a'}s`,
  };
}
