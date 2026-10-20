/**
 * Values and records from QGIS — the
 * companions of lib/geometryWriter.js.
 *
 * Values: a field of a linked layer written into an attribute of the linked
 * nodes. Where the node has the attribute, it is written where it was read
 * (viewEditor.js — the same cells the Explorer's ✎ writes); where it has none
 * yet, into the column the mapping reads that attribute from, on the node's own
 * rows. An attribute joined from several different values is not touched.
 *
 * Records: a feature whose key is in no node becomes a record of the type its
 * layer is linked to — a unit for a units layer, a find for a finds layer: its
 * key where the link reads it (the label, an attribute, or the identifier), its
 * identifier minted by the sidecar's rule, then its geometry. A record shows as a
 * node once a relation brings it into being — as in the Studio, a record with
 * nothing but values is no node yet; the result says which.
 *
 * Each transfer is one journal group: one undo.
 */

import { addRow, inGroup, rowIdOf, setCell } from './edits'
import { expandId } from './prefixes'
import { renderTemplate } from './uriTemplate'
import { attributeCells, describeAttribute } from './viewEditor'
import { writeGeometries } from './geometryWriter'

const cell = (row, column) => {
  if (!column) return ''
  const v = row?.[column]
  return v === null || v === undefined ? '' : String(v).trim()
}
const local = (uri) => String(uri || '').split(/[/#]/).pop().replace(/^.*:/, '')
const slugLocal = (v) => String(v || '').trim()
  .replace(/[äöüÄÖÜß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' }[c]))
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[_-]+|[_-]+$/g, '')

const idOf = (model, entity, raw) => expandId(raw, model.prefixMap, model.idPrefix, entity.noPrefix)

/** The rows of a node, and the mapping node they are read as: [{ entity, rows }]. */
function homes(model, nodeId) {
  const out = []
  for (const e of model.entities.values()) {
    const rows = (model.tables.get(e.tableId)?.rows || []).filter((r) => {
      const raw = cell(r, e.idColumn)
      return raw && idOf(model, e, raw) === nodeId
    })
    if (rows.length) out.push({ entity: e, rows })
  }
  return out
}

/** The column an attribute is read from for this entity, on its own rows — or null. */
function attributeColumn(model, entity, attrKey) {
  for (const le of model.literalEdges) {
    if (le.source !== entity.nodeId || le.joinSource || le.attrKey !== attrKey) continue
    const lit = model.literals.get(le.literalNodeId)
    if (lit && lit.tableId === entity.tableId && lit.valueColumn) return lit.valueColumn
  }
  return null
}

const valueOf = (graph, nodeId, attrKey) => {
  const v = graph?.nodes?.[nodeId]?.a?.[attrKey]
  return Array.isArray(v) ? v.join('; ') : v === undefined || v === null ? '' : String(v)
}

// ---- values ---------------------------------------------------------------------------

/** Whether a node's attribute can take a value: { writable, current, mode, reason? }. */
export function describeValue(workspace, graph, nodeId, attrKey) {
  if (!workspace?.materializer) return { writable: false, current: '', reason: 'Only a project file can be edited — this graph came without its tables.' }
  const current = valueOf(graph, nodeId, attrKey)
  if (attributeCells(workspace, nodeId, attrKey).length) {
    const verdict = describeAttribute(workspace, nodeId, attrKey)
    return verdict.editable ? { writable: true, current, mode: 'attribute' } : { writable: false, current, reason: verdict.reason }
  }
  for (const { entity } of homes(workspace.model, nodeId)) {
    if (attributeColumn(workspace.model, entity, attrKey)) return { writable: true, current, mode: 'create' }
  }
  if (!graph?.nodes?.[nodeId] && !homes(workspace.model, nodeId).length) return { writable: false, current: '', reason: 'No such node in the project.' }
  return { writable: false, current, reason: `The mapping reads "${attrKey}" for this kind of node from nowhere on its rows.` }
}

/** Values into an attribute: items [{ nodeId, value }]. One journal group. */
export function writeValues(workspace, graph, attrKey, items) {
  const failed = []
  let written = 0
  let unchanged = 0
  inGroup(workspace, () => {
    for (const { nodeId, value } of items || []) {
      const text = value === null || value === undefined ? '' : String(value).trim()
      const d = describeValue(workspace, graph, nodeId, attrKey)
      if (!d.writable) { failed.push({ nodeId, reason: d.reason }); continue }
      if (d.current === text) { unchanged++; continue }
      let n = 0
      if (d.mode === 'attribute') {
        for (const c of attributeCells(workspace, nodeId, attrKey)) if (setCell(workspace, c.tableId, c.rowId, c.column, text, { source: 'bridge' })) n++
      } else {
        for (const { entity, rows } of homes(workspace.model, nodeId)) {
          const column = attributeColumn(workspace.model, entity, attrKey)
          if (!column) continue
          const table = workspace.model.tables.get(entity.tableId)
          if (!table.columns.includes(column)) table.columns.push(column)
          for (const row of rows) if (setCell(workspace, entity.tableId, rowIdOf(row), column, text, { source: 'bridge' })) n++
          break
        }
      }
      if (n) written++
      else unchanged++
    }
  })
  return { ok: true, written, unchanged, failed }
}

// ---- records ------------------------------------------------------------------------------

/** The entity records of a node type are entered as — the one with a row-of-its-own identity. */
function entityForType(model, nodeType) {
  const candidates = [...model.entities.values()].filter((e) => e.typeKey === nodeType && e.idColumn)
  return candidates[0] || null
}

/** How a key from QGIS becomes the cells of a new record: { values, raw } or { error }. */
function recordCells(model, config, entity, spec, key) {
  const values = {}
  if (spec.nodeSource === 'id') {
    values[entity.idColumn] = key
  } else if (spec.nodeSource === 'label') {
    if (!entity.labelColumn) return { error: 'This kind of node has no name column to take the key.' }
    values[entity.labelColumn] = key
  } else {
    const column = attributeColumn(model, entity, spec.nodeAttr)
    if (!column) return { error: `The mapping reads "${spec.nodeAttr}" for this kind of node from nowhere on its rows.` }
    values[column] = key
    if (entity.labelColumn && entity.labelColumn !== entity.idColumn) values[entity.labelColumn] = key
  }
  if (!values[entity.idColumn]) {
    const rule = config?.uriRules?.[entity.nodeId]
    const minted = rule ? renderTemplate(rule, { ...values, [entity.labelColumn || entity.idColumn]: key }) : null
    values[entity.idColumn] = minted?.value && !minted.missing.length ? minted.value : slugLocal(key)
  }
  return { values, raw: values[entity.idColumn] }
}

/** Which of these keys would become new records, and how: [{ key, nodeId, creatable, reason? }]. */
export function describeNewRecords(workspace, config, spec, keys) {
  const { model } = workspace || {}
  if (!model) return (keys || []).map((key) => ({ key, creatable: false, reason: 'Only a project file can be edited.' }))
  const entity = entityForType(model, spec?.nodeType)
  return (keys || []).map((key) => {
    if (!entity) return { key, creatable: false, reason: 'The mapping has no records of this kind of node.' }
    const r = recordCells(model, config, entity, spec, String(key).trim())
    if (r.error) return { key, creatable: false, reason: r.error }
    const nodeId = idOf(model, entity, r.raw)
    if (homes(model, nodeId).length) return { key, nodeId, creatable: false, reason: `There is a record ${r.raw} already.` }
    // The key itself, where the link reads it: a unit called so exists already,
    // whatever identifier it was given.
    const table = model.tables.get(entity.tableId)
    const keyColumns = Object.keys(r.values).filter((c) => c !== entity.idColumn || spec.nodeSource === 'id')
    const norm = (v) => String(v || '').trim().toLowerCase()
    const twin = (table?.rows || []).find((row) => keyColumns.some((c) => norm(row[c]) === norm(key)))
    if (twin) return { key, creatable: false, reason: `“${key}” is there already (${cell(twin, entity.idColumn)}).` }
    return { key, nodeId, creatable: true, identifier: r.raw }
  })
}

/**
 * New records for keys of a layer, with their geometry: items [{ key, wkt? }].
 * One journal group (geometries included).
 * @returns {{ ok, created: [{ key, nodeId, visible }], failed: [{ key, reason }] }}
 */
export function createRecords(workspace, graph, config, spec, items, rematerialize) {
  const { model } = workspace
  const entity = entityForType(model, spec?.nodeType)
  const created = []
  const failed = []
  inGroup(workspace, () => {
    const withGeometry = []
    for (const { key, wkt } of items || []) {
      const [d] = describeNewRecords(workspace, config, spec, [key])
      if (!d.creatable) { failed.push({ key, reason: d.reason }); continue }
      const r = recordCells(model, config, entity, spec, String(key).trim())
      addRow(workspace, entity.tableId, r.values, { source: 'bridge', note: `new record ${key} from QGIS` })
      created.push({ key, nodeId: d.nodeId })
      if (wkt) withGeometry.push({ nodeId: d.nodeId, wkt })
    }
    if (withGeometry.length) {
      const g = writeGeometries(workspace, graph, withGeometry, config)
      for (const f of g.failed) {
        const c = created.find((x) => x.nodeId === f.nodeId)
        if (c) c.geometry = f.reason
      }
    }
  })
  const fresh = rematerialize ? rematerialize() : null
  for (const c of created) c.visible = !!fresh?.nodes?.[c.nodeId]
  return { ok: true, created, failed, kind: entity ? entity.explorerLabel || local(entity.classUri) : '' }
}

