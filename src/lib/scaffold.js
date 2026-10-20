/**
 * Building tables for a mapping that has none.
 *
 * A project saved without its source data — a model drawn in the Studio, or an
 * existing project cleared out to start over — carries the mapping but neither
 * tables nor column names. Without them there is nothing to write into, so the
 * tool has to invent them.
 *
 * The table boundaries are not invented, they are *read*:
 *
 *   an edge WITHOUT join columns connects two nodes on the same table
 *   an edge WITH join columns spans two tables
 *
 * That is what join keys mean in the Studio, and it reproduces all seven tables
 * of the reference project exactly (checked in tests/run-scaffold-check.mjs).
 * Column names have to be made up, and are derived from the explorer names so
 * they read like something a person would have typed.
 *
 * Everything written here also goes back into the canvas nodes, so the project
 * file exported afterwards carries the tables and the Studio sees them too.
 */

import { localName } from './prefixes'
import { MIDPOINT_TYPE } from './projectFile'

/** True when there is nothing to write into. */
export function needsScaffolding(model) {
  if (!model?.entities?.size) return false
  if (!model.tables.size) return true
  // Tables that exist but have no columns are equally unusable.
  return [...model.tables.values()].every((table) => table.columns.length === 0)
}

/** A column name a person might have typed, out of a node's display name. */
function baseName(node) {
  const raw = node.explorerLabel || node.rdfsLabel || localName(node.classUri) || node.nodeId
  return String(raw)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[()[\]{}]/g, '')
    .replace(/[^\p{L}\p{N}._|/-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || node.nodeId
}

function uniqueIn(used, candidate) {
  if (!used.has(candidate)) {
    used.add(candidate)
    return candidate
  }
  for (let n = 2; ; n++) {
    const next = `${candidate}_${n}`
    if (!used.has(next)) {
      used.add(next)
      return next
    }
  }
}

/**
 * Group mapped nodes into tables.
 *
 * Union-find over the edges that carry no join columns. Dot-one needs one extra
 * link: its annotation value lives in the same table as the relation's *target*
 * (in the reference project, the relation type sits beside the related unit), and
 * the split edges around the midpoint would otherwise leave it on its own.
 */
function groupNodes(model) {
  const parent = new Map()
  const find = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)))
      id = parent.get(id)
    }
    return id
  }
  const union = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  const nodes = [...model.entities.keys(), ...model.literals.keys()]
  for (const id of nodes) parent.set(id, id)

  const crossTable = []
  for (const rel of model.relations) {
    if (rel.joinSource && rel.joinTarget) crossTable.push(rel)
    else union(rel.source, rel.target)
  }
  for (const le of model.literalEdges) {
    if (le.joinSource && le.joinTarget) crossTable.push(le)
    else union(le.source, le.literalNodeId)
  }
  for (const rel of model.dot1Relations) {
    if (rel.joinSource && rel.joinTarget) crossTable.push(rel)
    else union(rel.source, rel.target)
    // The annotation value belongs with whichever end holds it — the target,
    // unless source and target are on one table anyway.
    if (rel.valueNodeId) union(rel.valueNodeId, rel.target)
  }

  const groups = new Map()
  for (const id of nodes) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(id)
  }
  return { groups: [...groups.values()], crossTable }
}

/** Degree of a node, to pick the one a table should be named after. */
function degrees(model) {
  const degree = new Map()
  const bump = (id) => degree.set(id, (degree.get(id) || 0) + 1)
  for (const rel of model.relations) {
    bump(rel.source)
    bump(rel.target)
  }
  for (const le of model.literalEdges) bump(le.source)
  return degree
}

/**
 * Create tables, assign a column to every mapped node, and write both into the
 * model and into the canvas nodes.
 *
 * @param {object} model  from readProjectFile
 * @returns {{tables: number, columns: number, assignments: Array, warnings: string[]}}
 */
export function scaffoldTables(model, options = {}) {
  const { groups, crossTable } = groupNodes(model)
  const degree = degrees(model)
  const warnings = []
  const assignments = []

  // Where a join column tells us what a node's identifier column is called, use
  // that name — otherwise the join would point at a column nobody created.
  const joinNameFor = new Map()
  for (const rel of model.relations) {
    if (rel.joinSource && !joinNameFor.has(rel.source)) joinNameFor.set(rel.source, rel.joinSource)
  }
  for (const rel of model.dot1Relations) {
    if (rel.joinSource && !joinNameFor.has(rel.source)) joinNameFor.set(rel.source, rel.joinSource)
  }

  const tableOf = new Map() // nodeId -> tableId
  model.tables.clear()

  groups.forEach((members, index) => {
    const tableId = `tbl_${index + 1}`
    const used = new Set()
    const columns = []
    const add = (name) => {
      const unique = uniqueIn(used, name)
      columns.push(unique)
      return unique
    }

    // Name the table after its best-connected entity — that is the record the
    // table is really about.
    const named = members
      .filter((id) => model.entities.has(id))
      .sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0))[0]
    const tableName = named ? baseName(model.entities.get(named)) : tableId

    for (const nodeId of members) {
      tableOf.set(nodeId, tableId)
      const entity = model.entities.get(nodeId)

      if (entity) {
        const base = baseName(entity)
        const preferred = joinNameFor.get(nodeId)
        entity.idColumn = add(preferred || `${base}_ID`)
        // A label column only where it would carry something different from the
        // identifier; a literal-mode node has one value and one column.
        entity.labelColumn = entity.noPrefix ? entity.idColumn : add(base)
        entity.tableId = tableId
        assignments.push({ nodeId, tableId, label: base, idColumn: entity.idColumn, labelColumn: entity.labelColumn })
        continue
      }

      const literal = model.literals.get(nodeId)
      if (!literal) continue
      const base = baseName(literal)
      if (literal.noPrefix) {
        literal.valueColumn = add(base)
        literal.idColumn = literal.valueColumn
      } else {
        // Not in literal mode: the note becomes a resource, so it needs an
        // identifier column of its own next to the text.
        literal.idColumn = add(`${base}_ID`)
        literal.valueColumn = add(base)
      }
      literal.tableId = tableId
      assignments.push({ nodeId, tableId, label: base, idColumn: literal.idColumn, labelColumn: literal.valueColumn })
    }

    model.tables.set(tableId, { id: tableId, name: tableName, rows: [], columns })
  })

  // Join keys are columns too, and they are named by the edges, not by us.
  for (const rel of crossTable) {
    const sourceId = rel.source
    const targetId = rel.target || rel.literalNodeId
    const sourceTable = model.tables.get(tableOf.get(sourceId))
    const targetTable = model.tables.get(tableOf.get(targetId))
    if (sourceTable && rel.joinSource && !sourceTable.columns.includes(rel.joinSource)) {
      sourceTable.columns.push(rel.joinSource)
    }
    if (targetTable && rel.joinTarget && !targetTable.columns.includes(rel.joinTarget)) {
      targetTable.columns.push(rel.joinTarget)
    }
    if (sourceTable && targetTable && sourceTable.id === targetTable.id) {
      warnings.push(
        `"${rel.joinSource}" → "${rel.joinTarget}" joins two nodes that ended up on the same table (${sourceTable.id}).`
      )
    }
  }

  // Nodes connected without join keys were put on one table. If that was not the
  // intention, the join keys are missing — say so rather than let it surprise
  // anyone later.
  if (groups.length === 1 && model.entities.size > 3) {
    warnings.push(
      'Every node ended up on a single table, because no edge carries join keys. Set them in the Studio where two nodes come from different sources.'
    )
  }

  writeBackToCanvas(model, tableOf)

  return {
    tables: model.tables.size,
    columns: [...model.tables.values()].reduce((n, t) => n + t.columns.length, 0),
    assignments,
    warnings,
  }
}

/**
 * Put the assignment into the canvas nodes as well.
 *
 * Without this the scaffolding would live only in memory: the exported project
 * file would still have `mappedColumn: null` and the Studio would see an empty
 * mapping again.
 */
function writeBackToCanvas(model, tableOf) {
  for (const node of model.canvas.nodes) {
    if (node.type === MIDPOINT_TYPE) continue
    const entity = model.entities.get(node.id)
    const literal = model.literals.get(node.id)
    const source = entity || literal
    if (!source) continue
    node.data = {
      ...node.data,
      tableId: source.tableId,
      tableName: model.tables.get(source.tableId)?.name || '',
      mappedColumn: entity ? entity.idColumn : literal.idColumn,
      labelColumn: entity ? entity.labelColumn : literal.valueColumn,
      tableRows: [],
    }
  }
}
