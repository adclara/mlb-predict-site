// AA Sports — parser compartido de odds de ESPN (scoreboard).
//
// ESPN publica las cuotas en formas distintas según deporte/liga/época:
//   a) legado: o.homeTeamOdds/awayTeamOdds/drawOdds con .moneyLine (americano)
//   b) nuevo:  o.moneyline = { home, away, draw } con el precio dentro de
//      close/current/open (.odds como "+150"/"EVEN") o campos sueltos
//   c) solo spread (NBA histórico/vivo): o.spread (línea del local)
// Este módulo prueba todas y devuelve probabilidades DES-VIGADAS.

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };

export function toDecimal(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (/^even$/i.test(s)) s = '+100';
  const n = num(s.replace(/^\+/, ''));
  if (n == null) return null;
  if (Math.abs(n) < 20) return n > 1 ? n : null;            // ya decimal
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);       // americano → decimal
}

export function priceFrom(side) {
  if (side == null) return null;
  if (typeof side === 'number' || typeof side === 'string') return toDecimal(side);
  for (const k of ['close', 'current', 'open']) {
    const lvl = side[k];
    if (lvl && typeof lvl === 'object') {
      const d = toDecimal(lvl.odds ?? lvl.american ?? lvl.moneyLine ?? lvl.value ?? lvl.decimal);
      if (d) return d;
    }
  }
  return toDecimal(side.moneyLine ?? side.moneyline ?? side.odds ?? side.american ?? side.value ?? side.decimal);
}

// precios decimales H/A(/D) desde el objeto odds, probando ambos formatos
function decimals(o) {
  if (!o) return {};
  let dh = priceFrom(o.homeTeamOdds), da = priceFrom(o.awayTeamOdds), dd = priceFrom(o.drawOdds);
  const ml = o.moneyline;
  if ((!dh || !da || !dd) && ml && typeof ml === 'object') {
    dh = dh || priceFrom(ml.home);
    da = da || priceFrom(ml.away);
    dd = dd || priceFrom(ml.draw);
  }
  return { dh, da, dd };
}

// soccer: 1X2 des-vigado → { pH, pD, pA } o null
export function probs3way(o) {
  const { dh, da, dd } = decimals(o);
  if (!dh || !da || !dd) return null;
  const ih = 1 / dh, id = 1 / dd, ia = 1 / da, s = ih + id + ia;
  return { pH: ih / s, pD: id / s, pA: ia / s };
}

// NBA (y otros a 2 salidas): moneyline des-vigado; fallback spread→prob con
// la relación Elo (≈28 pts de Elo por punto de spread; el spread es del local,
// negativo = local favorito). → { pH, pA, src: 'ml'|'spread' } o null
export function probs2way(o) {
  const { dh, da } = decimals(o);
  if (dh && da) {
    const ih = 1 / dh, ia = 1 / da, s = ih + ia;
    return { pH: ih / s, pA: ia / s, src: 'ml' };
  }
  const spread = num(o && o.spread);
  if (spread != null && spread !== 0) {
    const pH = 1 / (1 + Math.pow(10, (spread * 28) / 400));
    return { pH, pA: 1 - pH, src: 'spread' };
  }
  return null;
}
