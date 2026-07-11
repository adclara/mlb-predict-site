-- AA Sports — Fase 5: cuentas OPCIONALES (login con Google).
-- Datos mínimos: lo que Google entrega en el login (nombre, email, foto).
-- Nada de PII adicional; el usuario puede borrar su cuenta desde la app.
-- Ejecutar una vez:
--   wrangler d1 execute aa-sports --remote --file schema_auth.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,            -- 'google'
  provider_id TEXT NOT NULL,         -- sub de Google
  email TEXT,
  name TEXT,
  picture TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_id)
);

-- favoritos sincronizados (por ahora ids de evento; multi-deporte listo)
CREATE TABLE IF NOT EXISTS user_favs (
  user_id INTEGER NOT NULL,
  sport TEXT NOT NULL,
  code TEXT NOT NULL,
  PRIMARY KEY (user_id, sport, code)
);
