/**
 * A large model from the reference project, for measuring — not for checking
 * against a reference export.
 *
 * Every table is repeated `factor` times. In copy k, every value in a column
 * that identifies something (an entity's id column, a join column on either
 * side) is suffixed with `~k`, so each copy is its own set of sites, units and
 * finds with its own stratigraphy, and joins stay within the copy.
 *
 * Values that already are prefixed names or URIs (`oeai:fragment`) are left
 * alone. Those are thesaurus concepts, and in real data a material is shared by
 * every find made of it, not minted per site. Keeping them shared reproduces
 * what makes large graphs hard: a few hub nodes with very long incoming lists.
 *
 * The decision is per value, not per column, so a join between a suffixed and
 * an unsuffixed column cannot arise — both sides see the same value and make
 * the same decision.
 */

const SHARED = /^([a-z][\w.-]*:|https?:\/\/)/i

export function identifyingColumns(model) {
  const cols = new Set()
  for (const e of model.entities.values()) if (e.idColumn) cols.add(e.idColumn)
  for (const list of [model.relations, model.dot1Relations, model.literalEdges]) {
    for (const r of list) {
      if (r.joinSource) cols.add(r.joinSource)
      if (r.joinTarget) cols.add(r.joinTarget)
    }
  }
  return cols
}

/** Returns a new model; the input is not touched. Copy 0 keeps the original values. */
export function scaleModel(model, factor) {
  const cols = identifyingColumns(model)
  const tables = new Map()
  for (const [id, table] of model.tables) {
    const rows = []
    for (let k = 0; k < factor; k++) {
      for (const row of table.rows) {
        if (k === 0) {
          rows.push({ ...row })
          continue
        }
        const copy = {}
        for (const [col, value] of Object.entries(row)) {
          const s = value === null || value === undefined ? '' : String(value).trim()
          copy[col] = cols.has(col) && s && !SHARED.test(s) ? `${s}~${k}` : value
        }
        rows.push(copy)
      }
    }
    tables.set(id, { ...table, rows, columns: [...table.columns] })
  }
  return { ...model, tables }
}
