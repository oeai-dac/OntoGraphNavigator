/**
 * Geometries written back from QGIS.
 *
 * Where a node's geometry lives, the graph says: a WKT value on the node itself
 * (the GraphExplorer example: "Geometry" on a unit), or on a node one relation
 * away (the reference project and the BDA mapping: unit –O32i was located by→
 * S23 "Einmessung" carrying the WKT). There it is written, as the Map writes a
 * geometry moved on screen: through the cells it was read from (viewEditor.js).
 *
 * A node with no geometry yet gets one where the mapping keeps geometries for
 * its kind: a WKT column on the unit's rows, directly or through such a
 * measurement node, whose identifier the sidecar's rule mints (or
 * "<unit>_<name of the measurement>").
 *
 * All the geometries of one transfer are one journal group: one undo.
 */

import { inGroup, rowIdOf, setCell } from './edits'
import { expandId } from './prefixes'
import { renderTemplate } from './uriTemplate'
import { describeAttribute, attributeCells } from './viewEditor'
import { looksLikeWkt } from '../views/lib/wkt'

const cell = (row, column) => {
  if (!column) return ''
  const v = row?.[column]
  return v === null || v === undefined ? '' : String(v).trim()
}
const local = (uri) => String(uri || '').split(/[/#]/).pop().replace(/^.*:/, '')
const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Geometrie'

/** Attribute keys that hold WKT somewhere in the graph — the geometry keys of this project. */
function wktKeys(graph) {
  if (graph.__wktKeys) return graph.__wktKeys
  const keys = new Set()
  for (const nd of Object.values(graph.nodes || {})) {
    for (const [k, v] of Object.entries(nd.a || {})) {
      const first = Array.isArray(v) ? v[0] : v
      if (typeof first === 'string' && looksLikeWkt(first)) keys.add(k)
    }
  }
  Object.defineProperty(graph, '__wktKeys', { value: keys, enumerable: false })
  return keys
}

const wktOf = (nd, key) => {
  const v = nd?.a?.[key]
  return String(Array.isArray(v) ? v[0] : v ?? '').trim()
}

/**
 * The rows that are this node, and the mapping node they are read as — the one
 * that has a place for a geometry, where several read the same node (a unit
 * entered with a relation is also its partner, "SE (Relation)").
 */
function homeOf(model, graph, nodeId) {
  let fallback = null
  for (const e of model.entities.values()) {
    const rows = (model.tables.get(e.tableId)?.rows || []).filter((r) => {
      const raw = cell(r, e.idColumn)
      return raw && expandId(raw, model.prefixMap, model.idPrefix, e.noPrefix) === nodeId
    })
    if (!rows.length) continue
    const place = placeInMapping(model, graph, e)
    if (place) return { entity: e, rows, place }
    fallback = fallback || { entity: e, rows, place: null }
  }
  return fallback
}

const isWktLiteral = (model, graph, lit, attrKey) =>
  /wktLiteral$/i.test(local(lit.classUri)) || wktKeys(graph).has(attrKey)

/** Where the mapping keeps a geometry for this entity, on its own rows: directly, or one node away. */
function placeInMapping(model, graph, entity) {
  for (const le of model.literalEdges) {
    if (le.source !== entity.nodeId || le.joinSource) continue
    const lit = model.literals.get(le.literalNodeId)
    if (lit && lit.tableId === entity.tableId && isWktLiteral(model, graph, lit, le.attrKey)) return { via: null, literal: lit, attrKey: le.attrKey }
  }
  for (const rel of model.relations) {
    if (rel.source !== entity.nodeId || rel.joinSource) continue
    const via = model.entities.get(rel.target)
    if (!via || via.tableId !== entity.tableId) continue
    for (const le of model.literalEdges) {
      if (le.source !== via.nodeId || le.joinSource) continue
      const lit = model.literals.get(le.literalNodeId)
      if (lit && lit.tableId === entity.tableId && isWktLiteral(model, graph, lit, le.attrKey)) return { via, literal: lit, attrKey: le.attrKey, relation: rel }
    }
  }
  return null
}

/**
 * Where this node's geometry is, or would go.
 * @returns {{ writable, current, where, mode?, holder?, key?, reason? }}
 */
export function describeGeometry(workspace, graph, nodeId) {
  if (!workspace?.materializer) return { writable: false, current: '', reason: 'Only a project file can be edited — this graph came without its tables.' }
  const nd = graph?.nodes?.[nodeId]
  if (!nd) {
    // A record just entered (from QGIS, say) has rows, but no node until a
    // relation brings it into being — its geometry can still be written.
    const home = homeOf(workspace.model, graph, nodeId)
    if (!home) return { writable: false, current: '', reason: 'No such node in the project.' }
    if (!home.place) return { writable: false, current: '', reason: 'The mapping keeps no geometry for this kind of node — add one in the Studio (e.g. a WKT literal).' }
    return { writable: true, mode: 'create', current: '', where: `new: ${home.place.via ? `${home.place.via.explorerLabel || local(home.place.via.classUri)} · ` : ''}${home.place.attrKey}` }
  }
  const keys = wktKeys(graph)
  const candidates = []
  for (const k of Object.keys(nd.a || {})) if (keys.has(k) && wktOf(nd, k)) candidates.push({ holder: nodeId, key: k, where: k })
  for (const [rel, targets] of Object.entries(nd.o || {})) {
    if (rel.includes('#dot1:')) continue
    for (const t of targets) {
      const x = graph.nodes[t]
      for (const k of Object.keys(x?.a || {})) if (keys.has(k) && wktOf(x, k)) candidates.push({ holder: t, key: k, where: `${x.l || t} · ${k}` })
    }
  }
  for (const c of candidates) {
    const verdict = describeAttribute(workspace, c.holder, c.key)
    if (verdict.editable) {
      return { writable: true, mode: 'attribute', holder: c.holder, key: c.key, where: c.where, current: wktOf(graph.nodes[c.holder], c.key), others: candidates.length - 1 }
    }
  }
  if (candidates.length) {
    const c = candidates[0]
    return { writable: false, current: wktOf(graph.nodes[c.holder], c.key), where: c.where, reason: describeAttribute(workspace, c.holder, c.key).reason }
  }
  // No geometry yet: where the mapping keeps one for this kind of node.
  const own = homeOf(workspace.model, graph, nodeId)
  if (!own) return { writable: false, current: '', reason: 'This node has no row of its own to hold a geometry.' }
  const { place } = own
  if (!place) return { writable: false, current: '', reason: 'The mapping keeps no geometry for this kind of node — add one in the Studio (e.g. a WKT literal).' }
  const where = place.via ? `new: ${place.via.explorerLabel || local(place.via.classUri)} · ${place.attrKey}` : `new: ${place.attrKey}`
  return { writable: true, mode: 'create', current: '', where }
}

/**
 * Write geometries: items [{ nodeId, wkt }]. One journal group.
 * @returns {{ ok, written, unchanged, failed: [{ nodeId, reason }] }}
 */
export function writeGeometries(workspace, graph, items, config = {}) {
  const failed = []
  let written = 0
  let unchanged = 0
  inGroup(workspace, () => {
    for (const { nodeId, wkt } of items) {
      const value = String(wkt || '').trim()
      if (!looksLikeWkt(value)) { failed.push({ nodeId, reason: 'Not a WKT geometry.' }); continue }
      const d = describeGeometry(workspace, graph, nodeId)
      if (!d.writable) { failed.push({ nodeId, reason: d.reason }); continue }
      if (d.current === value) { unchanged++; continue }
      if (d.mode === 'attribute') {
        let n = 0
        for (const c of attributeCells(workspace, d.holder, d.key)) {
          if (setCell(workspace, c.tableId, c.rowId, c.column, value, { source: 'bridge' })) n++
        }
        if (n) written++
        else unchanged++
        continue
      }
      // A new geometry, on the node's own rows.
      const { entity, rows, place } = homeOf(workspace.model, graph, nodeId)
      const first = rows[0]
      const values = { [place.literal.valueColumn]: value }
      if (place.via) {
        const rule = config.uriRules?.[place.via.nodeId]
        const minted = rule ? renderTemplate(rule, first) : null
        const id = minted?.value && !minted.missing.length
          ? minted.value
          : `${cell(first, entity.idColumn)}_${slug(place.via.explorerLabel || local(place.via.classUri))}`
        values[place.via.idColumn] = cell(first, place.via.idColumn) || id
        if (place.via.labelColumn && place.via.labelColumn !== place.via.idColumn && !cell(first, place.via.labelColumn)) {
          values[place.via.labelColumn] = `${place.via.explorerLabel || local(place.via.classUri)} ${cell(first, entity.labelColumn) || cell(first, entity.idColumn)}`
        }
      }
      const table = workspace.model.tables.get(entity.tableId)
      for (const c of Object.keys(values)) if (!table.columns.includes(c)) table.columns.push(c)
      for (const row of rows) for (const [c, v] of Object.entries(values)) setCell(workspace, entity.tableId, rowIdOf(row), c, v, { source: 'bridge' })
      written++
    }
  })
  return { ok: true, written, unchanged, failed }
}
