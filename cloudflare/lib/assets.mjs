// AA Sports — catálogo de imágenes por deporte (CDNs públicos oficiales, $0).
//
// Estrategia: NO re-hospedamos imágenes (peso en el repo + derechos de uso).
// Enlazamos los CDNs públicos que los propios sitios oficiales usan (igual que
// hacen SofaScore/ESPN embebidos), siempre con fallback local (monograma) si
// una imagen no existe. Todo keyless y gratis.
//
// El frontend MLB ya usa estos patrones; los demás quedan listos para las
// Fases 2-4 (NBA, NFL/soccer, tenis).

export const ASSETS = {
  mlb: {
    // Logos de equipos (abbr en minúscula: tex, nyy, chw...)
    teamLogo: (abbr) => `https://a.espncdn.com/i/teamlogos/mlb/500/${abbr}.png`,
    // Cara de cualquier jugador MLB por MLBAM id (pitchers, bateadores...).
    // Tamaños: /spots/120 (chico), /spots/240 (retina).
    headshot: (mlbamId, size = 120) => `https://midfield.mlbstatic.com/v1/people/${mlbamId}/spots/${size}`,
    leagueLogo: () => 'https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png',
  },
  nba: {
    teamLogo: (abbr) => `https://a.espncdn.com/i/teamlogos/nba/500/${abbr}.png`,
    // Cara por NBA player id (cdn oficial de nba.com).
    headshot: (nbaId) => `https://cdn.nba.com/headshots/nba/latest/260x190/${nbaId}.png`,
    leagueLogo: () => 'https://a.espncdn.com/i/teamlogos/leagues/500/nba.png',
  },
  nfl: {
    teamLogo: (abbr) => `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr}.png`,
    headshot: (espnId) => `https://a.espncdn.com/i/headshots/nfl/players/full/${espnId}.png`,
    leagueLogo: () => 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png',
  },
  soccer: {
    // Escudos de clubes por id de ESPN (ej. 86 = Real Madrid).
    clubLogo: (espnTeamId) => `https://a.espncdn.com/i/teamlogos/soccer/500/${espnTeamId}.png`,
    // Banderas de selecciones/países (código ISO-2: mx, es, ar, br...).
    countryFlag: (iso2) => `https://a.espncdn.com/i/teamlogos/countries/500/${iso2}.png`,
  },
  tennis: {
    // Caras de tenistas por id de ESPN.
    headshot: (espnId) => `https://a.espncdn.com/i/headshots/tennis/players/full/${espnId}.png`,
  },
};

// Nota de uso: siempre acompañar con onerror → fallback (monograma con
// iniciales), porque ids retirados/nuevos pueden devolver 404.
