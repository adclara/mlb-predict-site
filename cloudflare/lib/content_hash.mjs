import { createHash } from 'node:crypto'

// Hash de hechos, decisiones y resultados. Los timestamps de transporte pueden
// cambiar en cada observación sin que haya cambiado el contenido público.
export function semanticContentHash(doc) {
  const semantic = (value) => {
    if (Array.isArray(value)) return value.map(semantic)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'updated_at' && key !== 'content_hash')
      .map(([key, child]) => [key, semantic(child)]))
  }
  return createHash('sha256').update(JSON.stringify(semantic(doc))).digest('hex')
}
