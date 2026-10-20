/**
 * Editing the Harris matrix: "A lies above B" back to the table rows a dot-one
 * rule of the mapping reads it from.
 *
 * The matrix (the GraphExplorer's Matrix view) speaks of units and relations;
 * the truth is the tables. A dot-one rule (model.dot1Relations) says where a
 * relation lives:
 *
 *   joined     the source unit's row carries the join key of the target
 *              (joinSource) and the qualifier — one row per relation, the
 *              unit's identity repeated. The example project, and every
 *              Studio import of a graph.
 *   same row   source and target sit in one row (no join keys) — the target's
 *              identifier beside the source's. The HME's own export.
 *   relation   a table of relations: each row the source's key (the join),
 *   table      the target's identifier and the kind. The reference project's
 *              tbl_2.
 *
 * A first relation fills the unit's own row where that row has none yet; every
 * further one is a row of its own, as the format wants multi-valued relations.
 * A qualifier is written the way the table already writes them ("ueber",
 * "contemporary_with", ".../Relationstyp_above"), so a drawn relation is not
 * told apart from an entered one. Every action is one journal group: one undo.
 *
 * The GraphExplorer's README ("Editing") describes the calls; the store
 * re-materialises after each.
 */

import { addRow, deleteRow, inGroup, rowIdOf, setCell } from './edits'
import { expandId } from './prefixes'
import { canonicalDot1 } from './keys'
import { renderTemplate } from './uriTemplate'
import { classify, oppositeKind } from '../views/lib/harrisMatrix'

const cell = (row, column) => {
  if (!column) return ''
  const v = row?.[column]
  return v === null || v === undefined ? '' : String(v).trim()
}

/** The dot-one rule for this property, preferring the one whose source is the matrix's type. */
function ruleFor(model, baseProp, typeKey) {
  const candidates = model.dot1Relations.filter((r) => r.propertyUri === baseProp)
  const withEntities = candidates
    .map((rel) => ({ rel, source: model.entities.get(rel.source), target: model.entities.get(rel.target) }))
    .filter((r) => r.source && r.target)
  return withEntities.find((r) => r.source.typeKey === typeKey) || withEntities[0] || null
}

/** Where a rule keeps one relation: 'source-row', 'same-row', 'relation-row' — or null. */
function patternOf({ rel, source, target }) {
  const joined = !!(rel.joinSource && rel.joinTarget)
  if (!joined) return source.tableId === target.tableId && rel.valueTableId === source.tableId ? 'same-row' : null
  if (rel.valueTableId === source.tableId) return 'source-row'
  if (rel.valueTableId === target.tableId) return 'relation-row'
  return null
}

const nodeIdOf = (model, entity, raw) => expandId(raw, model.prefixMap, model.idPrefix, entity.noPrefix)

/** Rows of an entity's table that stand for this node. */
function rowsOf(model, entity, nodeId) {
  const table = model.tables.get(entity.tableId)
  if (!table) return []
  return table.rows.filter((row) => {
    const raw = cell(row, entity.idColumn)
    return raw && nodeIdOf(model, entity, raw) === nodeId
  })
}

/**
 * How the table writes this kind of word: the shape of an existing qualifier
 * cell ("oeai:ueber", ".../Relationstyp_above", "contemporary_with") with the
 * new word in it. Falls back to the word itself, spaces as underscores (the
 * URI-safe form the Studio's export reads back as words).
 */
export function qualifierCell(model, rule, word) {
  const table = model.tables.get(rule.rel.valueTableId)
  const target = canonicalDot1(word)
  const underscore = (w) => w.replace(/ /g, '_')
  let template = null
  for (const row of table?.rows || []) {
    const raw = cell(row, rule.rel.valueColumn)
    if (!raw) continue
    const canonical = canonicalDot1(raw)
    if (canonical === target) return raw // the very spelling already in use
    if (template) continue
    for (const variant of [canonical, underscore(canonical)]) {
      const at = raw.toLowerCase().lastIndexOf(variant)
      if (at >= 0 && at + variant.length === raw.length) {
        template = { before: raw.slice(0, at), underscores: variant.includes('_') || /_/.test(raw.slice(at)) }
        break
      }
    }
  }
  if (template) return template.before + (template.underscores || /[/:#]/.test(template.before) ? underscore(target) : target)
  return underscore(target)
}

// ---- describing ---------------------------------------------------------------------

/**
 * The matrices the mapping can hold, also before any unit is entered: one per
 * stratigraphic (dot-one) rule whose units can be written. [{ typeKey, baseProp, label }]
 */
export function matrixRules(workspace) {
  const model = workspace?.model
  if (!model) return []
  const out = []
  for (const rel of model.dot1Relations) {
    const source = model.entities.get(rel.source)
    const target = model.entities.get(rel.target)
    if (!source || !target || !patternOf({ rel, source, target })) continue
    if (out.some((r) => r.typeKey === source.typeKey && r.baseProp === rel.propertyUri)) continue
    out.push({ typeKey: source.typeKey, baseProp: rel.propertyUri, label: source.explorerLabel || source.typeKey })
  }
  return out
}

export function describeMatrix(workspace, { baseProp, typeKey }) {
  if (!workspace?.model) return { editable: false, reason: 'Only a project file can be edited — this graph came without its tables.' }
  const rule = ruleFor(workspace.model, baseProp, typeKey)
  if (!rule) return { editable: false, reason: 'The mapping has no stratigraphic (dot-one) rule for this relation.' }
  if (!patternOf(rule)) {
    return { editable: false, reason: 'This mapping keeps the kind of relation in a table that is neither the unit\'s nor the relation\'s own — there is no single row to write a relation into.' }
  }
  return { editable: true }
}

// ---- writing --------------------------------------------------------------------------

/** The node id a new unit will have, and the rows that make it exist. */
function createUnit(workspace, rule, entity, { identifier, label }) {
  const { model } = workspace
  const values = { [entity.idColumn]: identifier }
  if (entity.labelColumn && entity.labelColumn !== entity.idColumn) values[entity.labelColumn] = label
  addRow(workspace, entity.tableId, values, { source: 'view', note: `new unit ${label}` })
  return nodeIdOf(model, entity, identifier)
}

/** A node's identifier as this entity writes it, if any row has it. */
function rawFor(model, entity, nodeId) {
  const row = rowsOf(model, entity, nodeId)[0]
  return row ? cell(row, entity.idColumn) : null
}

/** The identity of a unit as the source entity writes it: raw id and label. */
function identity(model, entity, nodeId, fallbackRows = []) {
  const row = rowsOf(model, entity, nodeId)[0] || fallbackRows[0]
  return row
    ? { raw: cell(row, entity.idColumn), label: cell(row, entity.labelColumn) }
    : null
}

/**
 * "a <kind> b". `a`/`b` are node ids, or null with newUnits.a / newUnits.b
 * ({ label, identifier }) for a unit entered with this relation.
 */
export function addMatrixRelation(workspace, { baseProp, typeKey, a, b, word, newUnits = {} }) {
  const verdict = describeMatrix(workspace, { baseProp, typeKey })
  if (!verdict.editable) return { ok: false, error: verdict.reason }
  const { model } = workspace
  const rule = ruleFor(model, baseProp, typeKey)
  const { rel, source, target } = rule
  const pattern = patternOf(rule)
  if (!a && !newUnits.a) return { ok: false, error: 'No first unit.' }
  if (!b && !newUnits.b) return { ok: false, error: 'No second unit.' }
  if (a && b && a === b) return { ok: false, error: 'A unit cannot relate to itself.' }

  return inGroup(workspace, () => {
    // Units entered with the relation exist as a record of the matrix's type.
    if (!a) a = createUnit(workspace, rule, source, newUnits.a)
    if (!b) b = createUnit(workspace, rule, source, newUnits.b)

    const src = identity(model, source, a)
    if (!src) return { ok: false, error: 'The first unit has no row in the table its relations are kept in.' }
    const qualifier = qualifierCell(model, rule, word)
    const sourceRows = rowsOf(model, source, a)

    if (pattern === 'relation-row') {
      // One row of the relation table: the source's key, the target as the
      // target entity writes it, the kind.
      const key = cell(sourceRows[0], rel.joinSource)
      if (!key) return { ok: false, error: 'The first unit has no value in the column its relations are joined by.' }
      const tgtRaw = rawFor(model, target, b) || identity(model, source, b)?.raw
      if (!tgtRaw || nodeIdOf(model, target, tgtRaw) !== b) return { ok: false, error: 'The second unit cannot be written as a relation partner.' }
      const label = identity(model, source, b)?.label || identity(model, target, b)?.label || ''
      const values = { [rel.joinTarget]: key, [target.idColumn]: tgtRaw, [rel.valueColumn]: qualifier }
      if (target.labelColumn && target.labelColumn !== target.idColumn) values[target.labelColumn] = label
      const relations = model.tables.get(target.tableId).rows
      const free = relations.find((row) => cell(row, rel.joinTarget) === key && !cell(row, target.idColumn) && !cell(row, rel.valueColumn))
      if (free) {
        for (const [column, value] of Object.entries(values)) setCell(workspace, target.tableId, rowIdOf(free), column, value, { source: 'view' })
      } else {
        addRow(workspace, target.tableId, values, { source: 'view' })
      }
    } else if (pattern === 'source-row') {
      // The target must be found by the join: a row in the target's table.
      let targetRow = rowsOf(model, target, b)[0]
      if (!targetRow) {
        const tgt = identity(model, source, b) || identity(model, target, b)
        if (!tgt) return { ok: false, error: 'The second unit has no row to be joined to.' }
        const values = { [target.idColumn]: tgt.raw }
        if (target.labelColumn && target.labelColumn !== target.idColumn) values[target.labelColumn] = tgt.label
        if (rel.joinTarget !== target.idColumn) values[rel.joinTarget] = tgt.raw
        addRow(workspace, target.tableId, values, { source: 'view' })
        targetRow = rowsOf(model, target, b)[0]
      }
      const key = cell(targetRow, rel.joinTarget)
      const free = sourceRows.find((row) => !cell(row, rel.joinSource) && !cell(row, rel.valueColumn))
      if (free) {
        setCell(workspace, source.tableId, rowIdOf(free), rel.joinSource, key, { source: 'view' })
        setCell(workspace, source.tableId, rowIdOf(free), rel.valueColumn, qualifier, { source: 'view' })
      } else {
        const values = { [source.idColumn]: src.raw, [rel.joinSource]: key, [rel.valueColumn]: qualifier }
        if (source.labelColumn && source.labelColumn !== source.idColumn) values[source.labelColumn] = src.label
        addRow(workspace, source.tableId, values, { source: 'view' })
      }
    } else {
      const tgt = identity(model, target, b) || identity(model, source, b)
      if (!tgt) return { ok: false, error: 'The second unit has no identifier to write beside the first.' }
      const free = sourceRows.find((row) => !cell(row, target.idColumn) && !cell(row, rel.valueColumn))
      const values = { [target.idColumn]: tgt.raw, [rel.valueColumn]: qualifier }
      if (target.labelColumn && target.labelColumn !== target.idColumn) values[target.labelColumn] = tgt.label
      if (free) {
        for (const [column, value] of Object.entries(values)) setCell(workspace, source.tableId, rowIdOf(free), column, value, { source: 'view' })
      } else {
        values[source.idColumn] = src.raw
        if (source.labelColumn && source.labelColumn !== source.idColumn) values[source.labelColumn] = src.label
        addRow(workspace, source.tableId, values, { source: 'view' })
      }
    }
    return { ok: true, a, b }
  })
}

/**
 * Remove the statements between a and b for this property, whichever of them
 * states it. With `kind`, only those that say "a <kind> b" — so of "A above B"
 * and "B above A", the one meant can go and the other stay.
 */
export function removeMatrixRelation(workspace, { baseProp, typeKey, a, b, kind }) {
  const verdict = describeMatrix(workspace, { baseProp, typeKey })
  if (!verdict.editable) return { ok: false, error: verdict.reason }
  const { model, materializer } = workspace
  const rule = ruleFor(model, baseProp, typeKey)
  const { rel, source, target } = rule
  const pattern = patternOf(rule)

  const says = (p) => {
    if (!kind) return true
    const stated = classify(p.value)
    return p.role === 'source' ? stated === kind : stated === oppositeKind(kind)
  }
  const statements = materializer.provenanceOf(a).filter((p) =>
    p.kind === 'dot1' && p.rule.propertyUri === baseProp && p.partner === b && says(p))
  if (!statements.length) return { ok: false, error: 'These two units are not related.' }

  return inGroup(workspace, () => {
    const touched = new Set()
    const targetLabel = target.labelColumn !== target.idColumn ? target.labelColumn : null
    for (const p of statements) {
      if (pattern === 'relation-row') {
        // A row of the relation table is the relation: it goes, unless it
        // holds something else besides.
        const row = p.tgtRow
        const own = new Set([rel.joinTarget, target.idColumn, targetLabel, rel.valueColumn])
        const onlyRelation = Object.keys(row).every((column) => own.has(column) || !cell(row, column))
        if (onlyRelation) deleteRow(workspace, target.tableId, rowIdOf(row), { source: 'view' })
        else for (const column of [target.idColumn, targetLabel, rel.valueColumn].filter(Boolean)) setCell(workspace, target.tableId, rowIdOf(row), column, '', { source: 'view' })
        continue
      }
      const row = p.srcRow // the unit's row: joinSource + qualifier, or both units side by side
      const clear = pattern === 'source-row' ? [rel.joinSource, rel.valueColumn] : [target.idColumn, targetLabel, rel.valueColumn].filter(Boolean)
      for (const column of clear) setCell(workspace, source.tableId, rowIdOf(row), column, '', { source: 'view' })
      touched.add(row)
    }
    // A row left holding nothing but the unit's identity is dropped — as long
    // as the unit keeps another row, so it does not vanish with its relation.
    const identityColumns = new Set([source.idColumn, source.labelColumn, ...Object.values(source.labelColumnI18n || {})])
    for (const row of touched) {
      const unitId = nodeIdOf(model, source, cell(row, source.idColumn))
      const others = rowsOf(model, source, unitId).filter((r) => r !== row)
      const bare = Object.keys(row).every((column) => identityColumns.has(column) || !cell(row, column))
      if (bare && others.length) deleteRow(workspace, source.tableId, rowIdOf(row), { source: 'view' })
    }
    return { ok: true }
  })
}

/** Change the kind of relation between a and b: the old statements go, one new one comes. */
export function setMatrixRelation(workspace, payload) {
  return inGroup(workspace, () => {
    const removed = removeMatrixRelation(workspace, { ...payload, kind: payload.from })
    if (!removed.ok) return removed
    return addMatrixRelation(workspace, payload)
  })
}

/**
 * An identifier for a unit entered by its label: the identifier rule of the
 * settings where there is one, otherwise what the existing ones look like —
 * the label itself, or the prefix they share in front of it.
 */
export function suggestUnitIdentifier(workspace, config, { baseProp, typeKey, label }) {
  const rule = workspace?.model && ruleFor(workspace.model, baseProp, typeKey)
  const entity = rule?.source || [...(workspace?.model?.entities.values() || [])].find((e) => e.typeKey === typeKey)
  if (!entity || !label) return label || ''
  const template = config?.uriRules?.[entity.nodeId]
  if (template) {
    // Only a rule that is fully served by the label: one that needs another
    // column of the row (empty for a unit not entered yet) would give every
    // new unit the same identifier.
    const { value, missing } = renderTemplate(template, { [entity.labelColumn || entity.idColumn]: label })
    if (value && !missing.length) return value
  }
  const prefixes = new Map()
  for (const row of workspace.model.tables.get(entity.tableId)?.rows || []) {
    const raw = cell(row, entity.idColumn)
    const lab = cell(row, entity.labelColumn)
    if (!raw || !lab || !raw.endsWith(lab)) continue
    const prefix = raw.slice(0, raw.length - lab.length)
    prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1)
  }
  let best = ''
  let count = 0
  for (const [prefix, n] of prefixes) if (n > count) { best = prefix; count = n }
  return best + label
}
