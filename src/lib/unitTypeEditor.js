/**
 * The unit type of a stratigraphic unit, set in the matrix (the views'
 * `editor.matrix.unitTypes`, src/views/README.md) — layer, deposit, fill,
 * structure, interface, as the Harris Matrix Editor has them, or any other.
 *
 * Where the mapping keeps it: a type (E55 via P2 has type) on the units' own
 * rows, named "Unit type" / "Einheitstyp" — the matrix template has it. Its
 * identifier comes from its rule (`Unit_type_{Unit_type~local}`), so one value
 * is one node, shared by every unit of that type.
 */

import { inGroup, rowIdOf, setCell } from './edits'
import { expandId } from './prefixes'
import { renderTemplate } from './uriTemplate'
import { LOCAL } from './protocols'

const cell = (row, column) => {
  if (!column) return ''
  const v = row?.[column]
  return v === null || v === undefined ? '' : String(v).trim()
}
const naturally = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const TYPE_NAME = /unit.?type|einheitstyp/i

function unitEntity(model, typeKey) {
  for (const rel of model.dot1Relations) {
    const e = model.entities.get(rel.source)
    if (e?.typeKey === typeKey) return e
  }
  return [...model.entities.values()].find((e) => e.typeKey === typeKey) || null
}

/** Where the mapping keeps the unit type of these units: { unit, rel, type } or null. */
export function unitTypeSetup(model, typeKey) {
  const unit = unitEntity(model, typeKey)
  if (!unit) return null
  const rel = model.relations.find((r) => {
    if (r.source !== unit.nodeId || r.joinSource || !/P2_has_type/.test(r.propertyUri)) return false
    const t = model.entities.get(r.target)
    return t && t.tableId === unit.tableId && t.labelColumn && TYPE_NAME.test(`${r.explorerLabel} ${t.explorerLabel} ${t.labelColumn}`)
  })
  return rel ? { unit, rel, type: model.entities.get(rel.target) } : null
}

/**
 * What the matrix offers: the values of the value list (config.valueLists),
 * then those in the data. { available, edgeKey, options } or { available: false, reason }.
 */
export function describeUnitTypes(workspace, { typeKey }, config = {}) {
  if (!workspace?.model) return { available: false, reason: 'Only a project file can be edited.' }
  const setup = unitTypeSetup(workspace.model, typeKey)
  if (!setup) return { available: false, reason: 'The mapping has no unit type for these units.' }
  const listed = config.valueLists?.[setup.type.nodeId] || []
  const present = new Set()
  for (const row of workspace.model.tables.get(setup.type.tableId)?.rows || []) {
    const v = cell(row, setup.type.labelColumn)
    if (v) present.add(v)
  }
  const extra = [...present].filter((v) => !listed.includes(v)).sort(naturally.compare)
  return { available: true, edgeKey: setup.rel.edgeKey, options: [...listed, ...extra] }
}

/** Give units a type (`value`; '' for none) — on all their rows, one undo. */
export function setUnitType(workspace, { typeKey, unitId, unitIds, value = '', rules = {} }) {
  const { model } = workspace
  const setup = unitTypeSetup(model, typeKey)
  if (!setup) return { ok: false, error: 'The mapping has no unit type for these units.' }
  const { unit, type } = setup
  const ids = new Set(unitIds || [unitId])
  const label = String(value || '').trim()
  const identifier = !label
    ? ''
    : (rules[type.nodeId] && renderTemplate(rules[type.nodeId], { [type.labelColumn]: label }).value) || `Unit_type_${LOCAL(label)}`
  const rows = model.tables.get(unit.tableId).rows.filter((row) => {
    const raw = cell(row, unit.idColumn)
    return raw && ids.has(expandId(raw, model.prefixMap, model.idPrefix, unit.noPrefix))
  })
  if (!rows.length) return { ok: false, error: 'This unit has no row in the units’ table to hold its type.' }
  return inGroup(workspace, () => {
    for (const row of rows) {
      if (cell(row, type.labelColumn) !== label) setCell(workspace, unit.tableId, rowIdOf(row), type.labelColumn, label, { source: 'view' })
      if (type.idColumn !== type.labelColumn && cell(row, type.idColumn) !== identifier) setCell(workspace, unit.tableId, rowIdOf(row), type.idColumn, identifier, { source: 'view' })
    }
    return { ok: true }
  })
}
