/**
 * Phases of the Harris matrix: in the mapping, and in the tables.
 *
 * Modelled as agreed:
 *
 *   unit  –P10 falls within→  E4 Period          one column "Phase" in the units' table
 *   E4    –P120 occurs before→ E4 (order role)   the earlier phase before the later
 *
 * A project whose mapping has no phases gets them on request
 * (addPhasesToMapping): ordinary Studio nodes and edges, written into the
 * canvas like any the Studio draws, with a small phase table — the Studio shows
 * them afterwards and they can be renamed or rewired there. The order needs a
 * second, slim "order" table for the phases, because the Studio pairs two ends
 * on one table row by row: a phase would occur before itself (see the
 * Studio's graphImport.js, self-relations). This module keeps the two tables
 * in step.
 *
 * Order in the tables: each phase row names the phase that follows it
 * (Phase_before = "this one occurs before that one"). Listed here, as in the
 * matrix, youngest first.
 */

import { identifierByRule } from './uriTemplate'
import { addRow, deleteRow, inGroup, rowIdOf, setCell } from './edits'
import { expandId } from './prefixes'
import { readProjectFile, writeProjectFile } from './projectFile'

const CRM = 'http://www.cidoc-crm.org/cidoc-crm/'
export const E4_PERIOD = `${CRM}E4_Period`
export const P10_FALLS_WITHIN = `${CRM}P10_falls_within`
export const P120_OCCURS_BEFORE = `${CRM}P120_occurs_before`

const naturally = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const cell = (row, column) => {
  if (!column) return ''
  const v = row?.[column]
  return v === null || v === undefined ? '' : String(v).trim()
}

/** The entity the matrix's units are, by their type key — the source of the dot-one rule where there is one. */
function unitEntity(model, typeKey) {
  for (const rel of model.dot1Relations) {
    const e = model.entities.get(rel.source)
    if (e?.typeKey === typeKey) return e
  }
  return [...model.entities.values()].find((e) => e.typeKey === typeKey) || null
}

/** Where the mapping keeps the phases of these units, or null. */
export function phaseSetup(model, typeKey) {
  const unit = unitEntity(model, typeKey)
  if (!unit) return null
  const phaseRel = model.relations.find((r) =>
    /P10_falls_within/.test(r.propertyUri) && model.entities.get(r.source)?.typeKey === typeKey && r.joinSource && r.joinTarget)
  if (!phaseRel) return { unit }
  const phase = model.entities.get(phaseRel.target)
  const orderRel = model.relations.find((r) =>
    /P120_occurs_before/.test(r.propertyUri) && r.source === phase.nodeId && r.joinSource && r.joinTarget)
  const role = orderRel ? model.entities.get(orderRel.target) : null
  const holder = model.entities.get(phaseRel.source)
  return { unit: holder, phaseRel, phase, orderRel, role }
}

export function describePhases(workspace, { typeKey }) {
  if (!workspace?.model) return { available: false, canAdd: false, reason: 'Only a project file can be edited.' }
  const setup = phaseSetup(workspace.model, typeKey)
  if (!setup?.unit) return { available: false, canAdd: false, reason: 'No units of this type in the mapping.' }
  if (!setup.phaseRel) {
    return {
      available: false,
      canAdd: true,
      reason: 'The mapping has no phases for these units yet.',
    }
  }
  return { available: true, edgeKey: setup.phaseRel.edgeKey, ordered: !!setup.orderRel }
}

// ---- adding phases to the mapping --------------------------------------------------

function uniqueName(base, taken) {
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}_${i}`)) i++
  return `${base}_${i}`
}

/**
 * Put phases into the mapping: an E4 Period with its table, P10 from the
 * units, P120 between phases. Not an undoable edit — a change of the mapping,
 * said so by the caller. Returns { ok, column } with the new column of the
 * units' table.
 */
export function addPhasesToMapping(workspace, { typeKey }) {
  const { model } = workspace
  const setup = phaseSetup(model, typeKey)
  if (!setup?.unit) return { ok: false, error: 'No units of this type in the mapping.' }
  if (setup.phaseRel) return { ok: false, error: 'The mapping has phases already.' }
  const unit = setup.unit
  const unitTable = model.tables.get(unit.tableId)
  const unitNode = model.canvas.nodes.find((n) => n.id === unit.nodeId)

  const nodeIds = new Set(model.canvas.nodes.map((n) => n.id))
  const phaseNodeId = uniqueName('nPhase', nodeIds)
  nodeIds.add(phaseNodeId)
  const roleNodeId = uniqueName('nPhaseOrder', nodeIds)
  const stamp = Date.now().toString(36)
  const tableId = `phases_${stamp}`
  const roleTableId = `phases_${stamp}_order`
  const column = uniqueName('Phase', new Set(unitTable.columns))

  const phaseTable = { id: tableId, name: 'Phases', rows: [], columns: ['Phase_ID', 'Phase', 'Phase_before'] }
  const roleTable = { id: roleTableId, name: 'Phases · order', rows: [], columns: ['Phase_ID', 'Phase'] }
  model.tables.set(tableId, phaseTable)
  model.tables.set(roleTableId, roleTable)
  if (!unitTable.columns.includes(column)) unitTable.columns.push(column)

  const at = unitNode?.position || { x: 0, y: 0 }
  const node = (id, position, data) => ({ id, type: 'ontologyNode', position, data })
  const phaseData = {
    label: 'E4_Period',
    uri: E4_PERIOD,
    nodeType: 'subject',
    rdfs_label: '',
    nodeColor: '#c5a3d6',
    mappedColumn: 'Phase_ID',
    labelColumn: 'Phase',
    tableId,
    tableName: 'Phases',
    tableRows: phaseTable.rows,
    instanceLabel: '',
    noPrefix: false,
    explorerLabel: 'Phase',
    isFreeNode: false,
  }
  const roleData = { ...phaseData, tableId: roleTableId, tableName: 'Phases · order', tableRows: roleTable.rows }

  // Edges look like the Studio's own: its style, arrow and label.
  const template = model.canvas.edges.find((e) => e.data?.propertyUri && !e.data?.isSplitSeg1 && !e.data?.isSplitSeg2 && !e.data?.isDotOne)
  const look = template
    ? Object.fromEntries(['focusable', 'style', 'markerEnd', 'labelStyle', 'labelBgStyle', 'labelBgPadding', 'labelBgBorderRadius'].filter((k) => k in template).map((k) => [k, template[k]]))
    : {}
  const edge = (id, source, target, label, data) => ({
    ...look, id, source, target, sourceHandle: 'r-s', targetHandle: 'l-t', label, data: { label, ...data },
  })

  model.canvas.nodes.push(
    node(phaseNodeId, { x: at.x + 420, y: at.y - 40 }, phaseData),
    node(roleNodeId, { x: at.x + 840, y: at.y - 40 }, roleData),
  )
  model.canvas.edges.push(
    edge(`e_${unit.nodeId}_${phaseNodeId}`, unit.nodeId, phaseNodeId, 'P10_falls_within', {
      propertyUri: P10_FALLS_WITHIN, joinColumnSource: column, joinColumnTarget: 'Phase_ID', explorerLabel: 'falls within phase',
    }),
    edge(`e_${phaseNodeId}_${roleNodeId}`, phaseNodeId, roleNodeId, 'P120_occurs_before', {
      propertyUri: P120_OCCURS_BEFORE, joinColumnSource: 'Phase_before', joinColumnTarget: 'Phase_ID', explorerLabel: '', noInverse: true,
    }),
  )
  // The Studio's table summary names the new tables too.
  if (Array.isArray(model.fileFields?.tables)) {
    model.fileFields.tables.push(
      { tableId, name: 'Phases', headers: [...phaseTable.columns], rowCount: 0 },
      { tableId: roleTableId, name: 'Phases · order', headers: [...roleTable.columns], rowCount: 0 },
    )
  }

  // The mapping part of the model read anew from the canvas; the tables —
  // their rows and the identities the journal refers to — stay as they are.
  const fresh = readProjectFile(writeProjectFile(model))
  for (const key of ['entities', 'literals', 'relations', 'literalEdges', 'dot1Relations']) model[key] = fresh[key]
  workspace.materializer = null
  return { ok: true, column }
}

// ---- phases in the tables ------------------------------------------------------------

/** The phases as the tables hold them, youngest first: [{ id, raw, label, rowId }]. */
export function listPhases(workspace, { typeKey }) {
  const setup = workspace?.model && phaseSetup(workspace.model, typeKey)
  if (!setup?.phaseRel) return []
  const { model } = workspace
  const { phase } = setup
  const rows = model.tables.get(phase.tableId)?.rows || []
  const items = rows
    .map((row) => ({ raw: cell(row, phase.idColumn), label: cell(row, phase.labelColumn), before: cell(row, setup.orderRel?.joinSource), rowId: rowIdOf(row) }))
    .filter((p) => p.raw)
  const byRaw = new Map(items.map((p) => [p.raw, p]))
  // Follow "occurs before" from the oldest — the phase no other one points at.
  const pointedAt = new Set(items.map((p) => p.before).filter((b) => byRaw.has(b)))
  const starts = items.filter((p) => !pointedAt.has(p.raw)).sort((a, b) => naturally.compare(a.label, b.label))
  const oldestFirst = []
  const seen = new Set()
  for (const start of starts) {
    let p = start
    while (p && !seen.has(p.raw)) {
      seen.add(p.raw)
      oldestFirst.push(p)
      p = byRaw.get(p.before)
    }
  }
  for (const p of items) if (!seen.has(p.raw)) oldestFirst.push(p) // a cycle's remains
  return oldestFirst.reverse().map((p) => ({
    id: expandId(p.raw, model.prefixMap, model.idPrefix, phase.noPrefix),
    raw: p.raw,
    label: p.label || p.raw,
    rowId: p.rowId,
  }))
}

/** Write the order youngest-first as "occurs before" chains — only the cells that change. */
function writeOrder(workspace, setup, youngestFirst) {
  const { model } = workspace
  const table = model.tables.get(setup.phase.tableId)
  const oldestFirst = [...youngestFirst].reverse()
  oldestFirst.forEach((p, i) => {
    const next = oldestFirst[i + 1]?.raw || ''
    const row = table.rows.find((r) => rowIdOf(r) === p.rowId)
    if (row && cell(row, setup.orderRel.joinSource) !== next) {
      setCell(workspace, setup.phase.tableId, p.rowId, setup.orderRel.joinSource, next, { source: 'view' })
    }
  })
}

const slug = (label) => label.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'phase'

/**
 * A new phase, the youngest. Its identifier by the phase's rule (`rules`, the
 * settings' identifier rules by node), else "Phase_" + its name.
 */
export function createPhase(workspace, { typeKey, label, rules = {} }) {
  const setup = phaseSetup(workspace.model, typeKey)
  if (!setup?.phaseRel || !setup.orderRel) return { ok: false, error: 'The mapping has no phases for these units.' }
  const name = String(label || '').trim()
  if (!name) return { ok: false, error: 'A phase needs a name.' }
  const existing = listPhases(workspace, { typeKey })
  if (existing.some((p) => p.label.toLowerCase() === name.toLowerCase())) return { ok: false, error: `There is a phase "${name}" already.` }
  const raw = identifierByRule(rules[setup.phase.nodeId], { [setup.phase.labelColumn]: name }, new Set(existing.map((p) => p.raw)), `Phase_${slug(name)}`)
  return inGroup(workspace, () => {
    const { phase, role, orderRel } = setup
    const rowId = addRow(workspace, phase.tableId, { [phase.idColumn]: raw, [phase.labelColumn]: name, [orderRel.joinSource]: '' }, { source: 'view', note: `new phase ${name}` })
    if (role) addRow(workspace, role.tableId, { [role.idColumn]: raw, [role.labelColumn]: name }, { source: 'view' })
    writeOrder(workspace, setup, [{ raw, rowId }, ...existing])
    return { ok: true, id: expandId(raw, workspace.model.prefixMap, workspace.model.idPrefix, phase.noPrefix) }
  })
}

export function renamePhase(workspace, { typeKey, phaseId, label }) {
  const setup = phaseSetup(workspace.model, typeKey)
  const p = listPhases(workspace, { typeKey }).find((x) => x.id === phaseId)
  const name = String(label || '').trim()
  if (!setup?.phaseRel || !p) return { ok: false, error: 'No such phase.' }
  if (!name) return { ok: false, error: 'A phase needs a name.' }
  return inGroup(workspace, () => {
    setCell(workspace, setup.phase.tableId, p.rowId, setup.phase.labelColumn, name, { source: 'view' })
    const roleRow = setup.role && workspace.model.tables.get(setup.role.tableId).rows.find((r) => cell(r, setup.role.idColumn) === p.raw)
    if (roleRow) setCell(workspace, setup.role.tableId, rowIdOf(roleRow), setup.role.labelColumn, name, { source: 'view' })
    return { ok: true }
  })
}

/** Move a phase one place: 'younger' (up) or 'older' (down). */
export function movePhase(workspace, { typeKey, phaseId, direction }) {
  const setup = phaseSetup(workspace.model, typeKey)
  if (!setup?.orderRel) return { ok: false, error: 'The phases have no order in the mapping.' }
  const list = listPhases(workspace, { typeKey })
  const i = list.findIndex((p) => p.id === phaseId)
  const j = direction === 'younger' ? i - 1 : i + 1
  if (i < 0 || j < 0 || j >= list.length) return { ok: false, error: 'It is at the end already.' }
  ;[list[i], list[j]] = [list[j], list[i]]
  return inGroup(workspace, () => {
    writeOrder(workspace, setup, list)
    return { ok: true }
  })
}

/** Remove a phase no unit belongs to. */
export function deletePhase(workspace, { typeKey, phaseId }) {
  const setup = phaseSetup(workspace.model, typeKey)
  const list = listPhases(workspace, { typeKey })
  const p = list.find((x) => x.id === phaseId)
  if (!setup?.phaseRel || !p) return { ok: false, error: 'No such phase.' }
  const unitRows = workspace.model.tables.get(setup.unit.tableId).rows
  if (unitRows.some((r) => cell(r, setup.phaseRel.joinSource) === p.raw)) {
    return { ok: false, error: `Units still belong to "${p.label}" — assign them elsewhere first.` }
  }
  return inGroup(workspace, () => {
    deleteRow(workspace, setup.phase.tableId, p.rowId, { source: 'view' })
    const roleRow = setup.role && workspace.model.tables.get(setup.role.tableId).rows.find((r) => cell(r, setup.role.idColumn) === p.raw)
    if (roleRow) deleteRow(workspace, setup.role.tableId, rowIdOf(roleRow), { source: 'view' })
    writeOrder(workspace, setup, list.filter((x) => x.id !== phaseId))
    return { ok: true }
  })
}

/**
 * The phase of a unit — or of several (`unitIds`: the units of an object
 * dropped onto a phase) — written into each one's first row and cleared from
 * any other. One journal group: one undo.
 */
export function setUnitPhase(workspace, { typeKey, unitId, unitIds, phaseId }) {
  const setup = phaseSetup(workspace.model, typeKey)
  if (!setup?.phaseRel) return { ok: false, error: 'The mapping has no phases for these units.' }
  const { model } = workspace
  const p = phaseId ? listPhases(workspace, { typeKey }).find((x) => x.id === phaseId) : null
  if (phaseId && !p) return { ok: false, error: 'No such phase.' }
  const unit = setup.unit
  const wanted = new Set(unitIds?.length ? unitIds : [unitId])
  const rowsOf = new Map([...wanted].map((id) => [id, []]))
  for (const row of model.tables.get(unit.tableId).rows) {
    const raw = cell(row, unit.idColumn)
    if (!raw) continue
    const id = expandId(raw, model.prefixMap, model.idPrefix, unit.noPrefix)
    if (rowsOf.has(id)) rowsOf.get(id).push(row)
  }
  const without = [...rowsOf].filter(([, rows]) => !rows.length).map(([id]) => id)
  if (without.length === wanted.size) {
    return { ok: false, error: wanted.size === 1 ? 'This unit has no row in the units’ table to hold its phase.' : 'None of these units has a row in the units’ table to hold its phase.' }
  }
  // The value the join matches in the phase table — the identifier where the
  // mapping was made here, whatever column a mapping from elsewhere joins by.
  const phaseRow = p && model.tables.get(setup.phase.tableId).rows.find((r) => rowIdOf(r) === p.rowId)
  const key = phaseRow ? cell(phaseRow, setup.phaseRel.joinTarget) : ''
  return inGroup(workspace, () => {
    for (const rows of rowsOf.values()) {
      rows.forEach((row, i) => setCell(workspace, unit.tableId, rowIdOf(row), setup.phaseRel.joinSource, i === 0 ? key : '', { source: 'view' }))
    }
    return { ok: true, assigned: wanted.size - without.length, without }
  })
}
