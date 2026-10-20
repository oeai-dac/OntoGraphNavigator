/**
 * Objects and object groups of the Harris matrix: in the mapping, and in the tables.
 *
 * Modelled as agreed:
 *
 *   unit    –P46i forms part of→  object    (a wall, a room, a grave)
 *   object  –P46i forms part of→  group     (the BDA's "Objektgruppe")
 *
 * One object per unit. Two ways a mapping keeps them, both edited here:
 *
 *   own table   the units' table names the object in a join column, the
 *               object has a row of its own (what addObjectsToMapping makes:
 *               E26 Physical Feature with a table) -- objects and groups can
 *               exist before any unit belongs to them;
 *   same row    the object's identifier and name are columns of the units'
 *               table itself (the HME export, the reference project) -- an
 *               object exists through the units that name it, and a group
 *               through the objects.
 *
 * Ids are the graph's node ids (expandId), as the views know them.
 */

import { addRow, deleteRow, inGroup, rowIdOf, setCell } from './edits'
import { expandId } from './prefixes'
import { identifierByRule } from './uriTemplate'
import { readProjectFile, writeProjectFile } from './projectFile'

const CRM = 'http://www.cidoc-crm.org/cidoc-crm/'
export const E26_PHYSICAL_FEATURE = `${CRM}E26_Physical_Feature`
export const P46I_FORMS_PART_OF = `${CRM}P46i_forms_part_of`

const naturally = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const cell = (row, column) => {
  if (!column) return ''
  const v = row?.[column]
  return v === null || v === undefined ? '' : String(v).trim()
}
const joined = (rel) => !!(rel?.joinSource && rel?.joinTarget)
const isPartOf = (r) => /P46i_forms_part_of/.test(r.propertyUri) && !r.dot1

function unitEntity(model, typeKey) {
  for (const rel of model.dot1Relations) {
    const e = model.entities.get(rel.source)
    if (e?.typeKey === typeKey) return e
  }
  return [...model.entities.values()].find((e) => e.typeKey === typeKey) || null
}

/** A "forms part of" relation from an entity of `fromType` to an entity of another type, or null. */
function partOfFrom(model, fromType, notTypes) {
  return model.relations.find((r) => {
    if (!isPartOf(r)) return false
    const s = model.entities.get(r.source)
    const t = model.entities.get(r.target)
    if (s?.typeKey !== fromType || !t || notTypes.includes(t.typeKey)) return false
    // Joined, or both ends on one row of one table; anything else cannot be written here.
    return joined(r) || s.tableId === t.tableId
  }) || null
}

/** Where the mapping keeps the objects (and groups) of these units, or { unit } / null. */
export function objectSetup(model, typeKey) {
  const unit = unitEntity(model, typeKey)
  if (!unit) return null
  const objectRel = partOfFrom(model, typeKey, [typeKey])
  if (!objectRel) return { unit }
  const object = model.entities.get(objectRel.target)
  const holder = model.entities.get(objectRel.source)
  const groupRel = partOfFrom(model, object.typeKey, [typeKey, object.typeKey])
  const group = groupRel ? model.entities.get(groupRel.target) : null
  return { unit: holder, objectRel, object, groupRel, group }
}

export function describeObjects(workspace, { typeKey }) {
  if (!workspace?.model) return { available: false, canAdd: false, reason: 'Only a project file can be edited.' }
  const setup = objectSetup(workspace.model, typeKey)
  if (!setup?.unit) return { available: false, canAdd: false, reason: 'No units of this type in the mapping.' }
  if (!setup.objectRel) {
    return { available: false, canAdd: true, reason: 'The mapping has no objects for these units yet.' }
  }
  return {
    available: true,
    edgeKey: setup.objectRel.edgeKey,
    groupEdgeKey: setup.groupRel?.edgeKey || null,
    // Objects (groups) can exist before anything belongs to them: in a table of
    // their own, or — kept on the units' rows — on a row of their own until a
    // unit (an object) takes them (holding rows, below).
    standalone: true,
    groups: !!setup.groupRel,
    groupsStandalone: !!setup.groupRel,
    canAddGroups: !setup.groupRel,
  }
}

// ---- adding objects and groups to the mapping ------------------------------------

function uniqueName(base, taken) {
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}_${i}`)) i++
  return `${base}_${i}`
}

/**
 * Put what is missing into the mapping: objects (E26 Physical Feature with a
 * table, P46i from a new column "Object" of the units' table) and groups (the
 * same, P46i from a new column "Object_group" where the objects are kept).
 * Not an undoable edit — a change of the mapping, said so by the caller.
 */
export function addObjectsToMapping(workspace, { typeKey }) {
  const { model } = workspace
  let setup = objectSetup(model, typeKey)
  if (!setup?.unit) return { ok: false, error: 'No units of this type in the mapping.' }
  if (setup.objectRel && setup.groupRel) return { ok: false, error: 'The mapping has objects and groups already.' }

  const nodeIds = new Set(model.canvas.nodes.map((n) => n.id))
  const stamp = Date.now().toString(36)
  const template = model.canvas.edges.find((e) => e.data?.propertyUri && !e.data?.isSplitSeg1 && !e.data?.isSplitSeg2 && !e.data?.isDotOne)
  const look = template
    ? Object.fromEntries(['focusable', 'style', 'markerEnd', 'labelStyle', 'labelBgStyle', 'labelBgPadding', 'labelBgBorderRadius'].filter((k) => k in template).map((k) => [k, template[k]]))
    : {}
  const edge = (id, source, target, label, data) => ({
    ...look, id, source, target, sourceHandle: 'r-s', targetHandle: 'l-t', label, data: { label, ...data },
  })
  const featureNode = (id, position, tableId, tableName, table, idColumn, labelColumn, explorerLabel) => ({
    id,
    type: 'ontologyNode',
    position,
    data: {
      label: 'E26_Physical_Feature',
      uri: E26_PHYSICAL_FEATURE,
      nodeType: 'subject',
      rdfs_label: '',
      nodeColor: '#c8a882',
      mappedColumn: idColumn,
      labelColumn,
      tableId,
      tableName,
      tableRows: table.rows,
      instanceLabel: '',
      noPrefix: false,
      explorerLabel,
      isFreeNode: false,
    },
  })
  const addTable = (tableId, name, columns) => {
    const table = { id: tableId, name, rows: [], columns }
    model.tables.set(tableId, table)
    if (Array.isArray(model.fileFields?.tables)) model.fileFields.tables.push({ tableId, name, headers: [...columns], rowCount: 0 })
    return table
  }
  const added = []

  let objectNodeId = setup.object?.nodeId
  let objectTableId = setup.object?.tableId
  const unitNode = model.canvas.nodes.find((n) => n.id === setup.unit.nodeId)
  const at = unitNode?.position || { x: 0, y: 0 }
  if (!setup.objectRel) {
    const unitTable = model.tables.get(setup.unit.tableId)
    const column = uniqueName('Object', new Set(unitTable.columns))
    unitTable.columns.push(column)
    objectTableId = `objects_${stamp}`
    const table = addTable(objectTableId, 'Objects', ['Object_ID', 'Object', 'Object_group'])
    objectNodeId = uniqueName('nObject', nodeIds)
    nodeIds.add(objectNodeId)
    model.canvas.nodes.push(featureNode(objectNodeId, { x: at.x + 420, y: at.y + 120 }, objectTableId, 'Objects', table, 'Object_ID', 'Object', 'Object'))
    model.canvas.edges.push(edge(`e_${setup.unit.nodeId}_${objectNodeId}`, setup.unit.nodeId, objectNodeId, 'P46i_forms_part_of', {
      propertyUri: P46I_FORMS_PART_OF, joinColumnSource: column, joinColumnTarget: 'Object_ID', explorerLabel: 'forms part of object',
    }))
    added.push('objects')
  }
  if (!setup.groupRel) {
    // The group column goes where the objects are kept: their own table, or the units' rows.
    const holderTable = model.tables.get(objectTableId)
    const column = holderTable.columns.includes('Object_group') && !setup.objectRel
      ? 'Object_group'
      : uniqueName('Object_group', new Set(holderTable.columns))
    if (!holderTable.columns.includes(column)) holderTable.columns.push(column)
    const groupTableId = `object_groups_${stamp}`
    const table = addTable(groupTableId, 'Object groups', ['Group_ID', 'Group'])
    const groupNodeId = uniqueName('nObjectGroup', nodeIds)
    nodeIds.add(groupNodeId)
    const objectNode = model.canvas.nodes.find((n) => n.id === objectNodeId)
    const from = objectNode?.position || at
    model.canvas.nodes.push(featureNode(groupNodeId, { x: from.x + 420, y: from.y }, groupTableId, 'Object groups', table, 'Group_ID', 'Group', 'Object group'))
    model.canvas.edges.push(edge(`e_${objectNodeId}_${groupNodeId}`, objectNodeId, groupNodeId, 'P46i_forms_part_of', {
      propertyUri: P46I_FORMS_PART_OF, joinColumnSource: column, joinColumnTarget: 'Group_ID', explorerLabel: 'forms part of group',
    }))
    added.push('groups')
  }
  // Keep the files' table summary in step for tables that got a column.
  if (Array.isArray(model.fileFields?.tables)) {
    for (const entry of model.fileFields.tables) {
      const t = model.tables.get(entry.tableId)
      if (t) entry.headers = [...t.columns]
    }
  }

  const fresh = readProjectFile(writeProjectFile(model))
  for (const key of ['entities', 'literals', 'relations', 'literalEdges', 'dot1Relations']) model[key] = fresh[key]
  workspace.materializer = null
  setup = objectSetup(model, typeKey)
  return { ok: !!setup?.objectRel && !!setup.groupRel, added }
}

// ---- reading -----------------------------------------------------------------------

/** The rows that carry an entity's values: its own table, or the rows of the table it shares. */
function rowsWith(model, entity, raw) {
  return (model.tables.get(entity.tableId)?.rows || []).filter((r) => cell(r, entity.idColumn) === raw)
}

/** Distinct { raw, label, rowId } of an entity's table (the first row of each). */
function distinct(model, entity) {
  const seen = new Map()
  for (const row of model.tables.get(entity.tableId)?.rows || []) {
    const raw = cell(row, entity.idColumn)
    if (!raw || seen.has(raw)) continue
    seen.set(raw, { raw, label: cell(row, entity.labelColumn) || raw, rowId: rowIdOf(row) })
  }
  return [...seen.values()]
}

const idOf = (model, entity, raw) => expandId(raw, model.prefixMap, model.idPrefix, entity.noPrefix)

/** The target row a reference cell points at: the value a join matches, or the same row. */
function targetOf(model, rel, target, row) {
  if (!joined(rel)) {
    const raw = cell(row, target.idColumn)
    return raw ? { raw, label: cell(row, target.labelColumn) || raw } : null
  }
  const key = cell(row, rel.joinSource)
  if (!key) return null
  const t = (model.tables.get(target.tableId)?.rows || []).find((r) => cell(r, rel.joinTarget) === key)
  const raw = t ? cell(t, target.idColumn) : ''
  return raw ? { raw, label: cell(t, target.labelColumn) || raw } : null
}

/** The groups, by name: [{ id, raw, label }]. */
export function listGroups(workspace, { typeKey }) {
  const { model } = workspace || {}
  const setup = model && objectSetup(model, typeKey)
  if (!setup?.groupRel) return []
  const { group } = setup
  return distinct(model, group)
    .sort((a, b) => naturally.compare(a.label, b.label))
    .map((g) => ({ id: idOf(model, group, g.raw), raw: g.raw, label: g.label }))
}

/** The objects, by name, each with its group: [{ id, raw, label, group }]. */
export function listObjects(workspace, { typeKey }) {
  const { model } = workspace || {}
  const setup = model && objectSetup(model, typeKey)
  if (!setup?.objectRel) return []
  const { object, groupRel, group } = setup
  return distinct(model, object)
    .sort((a, b) => naturally.compare(a.label, b.label))
    .map((o) => {
      const row = model.tables.get(object.tableId).rows.find((r) => rowIdOf(r) === o.rowId)
      const g = groupRel ? targetOf(model, groupRel, group, row) : null
      return { id: idOf(model, object, o.raw), raw: o.raw, label: o.label, group: g ? idOf(model, group, g.raw) : null }
    })
}

// ---- writing -----------------------------------------------------------------------

const slug = (label) => label.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x'

function set(workspace, tableId, row, column, value) {
  if (!column || cell(row, column) === value) return
  setCell(workspace, tableId, rowIdOf(row), column, value, { source: 'view' })
}

/**
 * Point `row` (of `tableId`) at a target through `rel`: the join cell, or —
 * on one row — the target's identifier and name. `to` = { raw, label, row } or null.
 */
function writeRef(workspace, tableId, row, rel, target, to) {
  if (joined(rel)) {
    set(workspace, tableId, row, rel.joinSource, to?.row ? cell(to.row, rel.joinTarget) : to?.raw || '')
    return
  }
  set(workspace, tableId, row, target.idColumn, to?.raw || '')
  if (target.labelColumn && target.labelColumn !== target.idColumn) set(workspace, tableId, row, target.labelColumn, to?.raw ? to.label : '')
}

/** One entry of `list` by id, with its row where it has one of its own. */
function find(workspace, list, entity, id) {
  const item = list.find((x) => x.id === id)
  if (!item) return null
  const row = rowsWith(workspace.model, entity, item.raw)[0]
  return { ...item, row }
}

function unitRows(model, unit, unitId) {
  return model.tables.get(unit.tableId).rows.filter((row) => {
    const raw = cell(row, unit.idColumn)
    return raw && idOf(model, unit, raw) === unitId
  })
}

/** Rows that say which group an object forms part of: its own row, or the rows of its units. */
function objectRows(model, setup, raw) {
  return rowsWith(model, setup.object, raw)
}

/**
 * The identifier of a new object (group): by its rule (`rules`, the settings'
 * identifier rules by node, rendered on its name), else prefix + its name.
 */
function newRaw(prefix, label, taken, entity = null, rules = {}) {
  const rule = entity && rules?.[entity.nodeId]
  return identifierByRule(rule, entity?.labelColumn ? { [entity.labelColumn]: label } : {}, taken, `${prefix}_${slug(label)}`)
}

/**
 * Objects kept on the units' rows exist through their units. One made before
 * any unit belongs to it is kept on a holding row: a row of the units' table
 * with no unit, only the object (and its group) — or only the group, for a
 * group no object belongs to yet. It produces the object (the group) and
 * nothing else, and goes once a unit (an object) carries what it holds.
 */
const isHolding = (setup, row) => !cell(row, setup.unit.idColumn)

/** Holding rows no longer needed: their object is on a unit's row, their group on an object's. */
function tidyHolding(workspace, setup) {
  const { model } = workspace
  const rows = model.tables.get(setup.unit.tableId).rows
  const objectOn = new Set()
  const groupOn = new Set()
  for (const row of rows) {
    const o = cell(row, setup.object.idColumn)
    if (o && !isHolding(setup, row)) objectOn.add(o)
    if (o && setup.group && !joined(setup.groupRel)) {
      const g = cell(row, setup.group.idColumn)
      if (g) groupOn.add(g)
    }
  }
  for (const row of [...rows]) {
    if (!isHolding(setup, row)) continue
    const o = cell(row, setup.object.idColumn)
    const g = setup.group && !joined(setup.groupRel) ? cell(row, setup.group.idColumn) : ''
    if ((o && objectOn.has(o)) || (!o && g && groupOn.has(g))) deleteRow(workspace, setup.unit.tableId, rowIdOf(row), { source: 'view' })
  }
}

/** A new object: a row of its own — in its table, or a holding row of the units' table. */
export function createObject(workspace, { typeKey, label, groupId = null, rules = {} }) {
  const setup = objectSetup(workspace.model, typeKey)
  if (!setup?.objectRel) return { ok: false, error: 'The mapping has no objects for these units.' }
  const name = String(label || '').trim()
  if (!name) return { ok: false, error: 'An object needs a name.' }
  const existing = listObjects(workspace, { typeKey })
  if (existing.some((o) => o.label.toLowerCase() === name.toLowerCase())) return { ok: false, error: `There is an object "${name}" already.` }
  const raw = newRaw('Object', name, new Set(existing.map((o) => o.raw)), setup.object, rules)
  return inGroup(workspace, () => {
    const { object } = setup
    addRow(workspace, object.tableId, { [object.idColumn]: raw, ...(object.labelColumn ? { [object.labelColumn]: name } : {}) }, { source: 'view', note: `new object ${name}` })
    const id = idOf(workspace.model, object, raw)
    if (groupId) {
      const r = setObjectGroup(workspace, { typeKey, objectId: id, groupId })
      if (!r.ok) throw new Error(r.error)
    }
    return { ok: true, id }
  })
}

/** A new group: a row of its own — in its table, or a holding row where the objects are kept. */
export function createGroup(workspace, { typeKey, label, rules = {} }) {
  const setup = objectSetup(workspace.model, typeKey)
  if (!setup?.groupRel) return { ok: false, error: 'The mapping has no object groups.' }
  const name = String(label || '').trim()
  if (!name) return { ok: false, error: 'A group needs a name.' }
  const existing = listGroups(workspace, { typeKey })
  if (existing.some((g) => g.label.toLowerCase() === name.toLowerCase())) return { ok: false, error: `There is a group "${name}" already.` }
  const raw = newRaw('Group', name, new Set(existing.map((g) => g.raw)), setup.group, rules)
  return inGroup(workspace, () => {
    const { group } = setup
    addRow(workspace, group.tableId, { [group.idColumn]: raw, ...(group.labelColumn ? { [group.labelColumn]: name } : {}) }, { source: 'view', note: `new object group ${name}` })
    return { ok: true, id: idOf(workspace.model, group, raw) }
  })
}

/**
 * The object of one unit — an existing one (`objectId`), a new one
 * (`newLabel`), or none — written into its first row and cleared from the others.
 */
export function setUnitObject(workspace, { typeKey, unitId, objectId = null, newLabel = '', rules = {} }) {
  const setup = objectSetup(workspace.model, typeKey)
  if (!setup?.objectRel) return { ok: false, error: 'The mapping has no objects for these units.' }
  const { model } = workspace
  const rows = unitRows(model, setup.unit, unitId)
  if (!rows.length) return { ok: false, error: 'This unit has no row in the units\' table to hold its object.' }
  const name = String(newLabel || '').trim()
  return inGroup(workspace, () => {
    let to = null
    let groupTo = null
    if (name) {
      const existing = listObjects(workspace, { typeKey })
      const same = existing.find((o) => o.label.toLowerCase() === name.toLowerCase())
      if (same) objectId = same.id
      else if (joined(setup.objectRel)) {
        const made = createObject(workspace, { typeKey, label: name, rules })
        if (!made.ok) throw new Error(made.error)
        objectId = made.id
      } else {
        to = { raw: newRaw('Object', name, new Set(existing.map((o) => o.raw)), setup.object, rules), label: name }
      }
    }
    if (objectId && !to) {
      const o = find(workspace, listObjects(workspace, { typeKey }), setup.object, objectId)
      if (!o) throw new Error('No such object.')
      to = { raw: o.raw, label: o.label, row: o.row }
      // On one row with its units, the object's group travels with it.
      if (setup.groupRel && !joined(setup.objectRel) && o.row) {
        groupTo = { keep: true, from: o.row }
      }
    }
    rows.forEach((row, i) => {
      writeRef(workspace, setup.unit.tableId, row, setup.objectRel, setup.object, i === 0 ? to : null)
      if (setup.groupRel && !joined(setup.objectRel)) {
        // The group cells of this row follow the object it names.
        const src = i === 0 && groupTo?.from
        const g = src ? targetOf(model, setup.groupRel, setup.group, src) : null
        const groupRow = g && joined(setup.groupRel) ? rowsWith(model, setup.group, g.raw)[0] : null
        writeRef(workspace, setup.unit.tableId, row, setup.groupRel, setup.group, g ? { ...g, row: groupRow } : null)
      }
    })
    if (!joined(setup.objectRel)) tidyHolding(workspace, setup)
    return { ok: true, id: to ? idOf(model, setup.object, to.raw) : null }
  })
}

/** The group of one object — an existing one, a new one (`newLabel`), or none — on every row that carries the object. */
export function setObjectGroup(workspace, { typeKey, objectId, groupId = null, newLabel = '', rules = {} }) {
  const setup = objectSetup(workspace.model, typeKey)
  if (!setup?.groupRel) return { ok: false, error: 'The mapping has no object groups.' }
  const { model } = workspace
  const o = listObjects(workspace, { typeKey }).find((x) => x.id === objectId)
  if (!o) return { ok: false, error: 'No such object.' }
  const name = String(newLabel || '').trim()
  return inGroup(workspace, () => {
    let to = null
    if (name) {
      const existing = listGroups(workspace, { typeKey })
      const same = existing.find((g) => g.label.toLowerCase() === name.toLowerCase())
      if (same) groupId = same.id
      else if (joined(setup.groupRel)) {
        const made = createGroup(workspace, { typeKey, label: name, rules })
        if (!made.ok) throw new Error(made.error)
        groupId = made.id
      } else {
        to = { raw: newRaw('Group', name, new Set(existing.map((g) => g.raw)), setup.group, rules), label: name }
      }
    }
    if (groupId && !to) {
      const g = find(workspace, listGroups(workspace, { typeKey }), setup.group, groupId)
      if (!g) throw new Error('No such group.')
      to = { raw: g.raw, label: g.label, row: g.row }
    }
    for (const row of objectRows(model, setup, o.raw)) writeRef(workspace, setup.object.tableId, row, setup.groupRel, setup.group, to)
    if (!joined(setup.objectRel) && !joined(setup.groupRel)) tidyHolding(workspace, setup)
    return { ok: true }
  })
}

function renameIn(workspace, entity, raw, name) {
  if (!entity.labelColumn || entity.labelColumn === entity.idColumn) {
    return { ok: false, error: 'Here the name is the identifier — it is changed in the table.' }
  }
  for (const row of rowsWith(workspace.model, entity, raw)) set(workspace, entity.tableId, row, entity.labelColumn, name)
  return { ok: true }
}

export function renameObject(workspace, { typeKey, objectId, label }) {
  const setup = objectSetup(workspace.model, typeKey)
  const o = setup?.objectRel && listObjects(workspace, { typeKey }).find((x) => x.id === objectId)
  const name = String(label || '').trim()
  if (!o) return { ok: false, error: 'No such object.' }
  if (!name) return { ok: false, error: 'An object needs a name.' }
  return inGroup(workspace, () => renameIn(workspace, setup.object, o.raw, name))
}

export function renameGroup(workspace, { typeKey, groupId, label }) {
  const setup = objectSetup(workspace.model, typeKey)
  const g = setup?.groupRel && listGroups(workspace, { typeKey }).find((x) => x.id === groupId)
  const name = String(label || '').trim()
  if (!g) return { ok: false, error: 'No such group.' }
  if (!name) return { ok: false, error: 'A group needs a name.' }
  return inGroup(workspace, () => renameIn(workspace, setup.group, g.raw, name))
}

/** Remove an object no unit belongs to: its row — in its table, or its holding row. */
export function deleteObject(workspace, { typeKey, objectId }) {
  const setup = objectSetup(workspace.model, typeKey)
  const o = setup?.objectRel && find(workspace, listObjects(workspace, { typeKey }), setup.object, objectId)
  if (!o) return { ok: false, error: 'No such object.' }
  if (!joined(setup.objectRel)) {
    const rows = rowsWith(workspace.model, setup.object, o.raw)
    if (rows.some((r) => !isHolding(setup, r))) return { ok: false, error: `Units still belong to "${o.label}" — assign them elsewhere first.` }
    return inGroup(workspace, () => {
      for (const row of rows) deleteRow(workspace, setup.unit.tableId, rowIdOf(row), { source: 'view' })
      return { ok: true }
    })
  }
  const key = cell(o.row, setup.objectRel.joinTarget)
  if (workspace.model.tables.get(setup.unit.tableId).rows.some((r) => cell(r, setup.objectRel.joinSource) === key)) {
    return { ok: false, error: `Units still belong to "${o.label}" — assign them elsewhere first.` }
  }
  return inGroup(workspace, () => {
    for (const row of rowsWith(workspace.model, setup.object, o.raw)) deleteRow(workspace, setup.object.tableId, rowIdOf(row), { source: 'view' })
    return { ok: true }
  })
}

/** Remove a group no object belongs to: its row — in its table, or its holding row. */
export function deleteGroup(workspace, { typeKey, groupId }) {
  const setup = objectSetup(workspace.model, typeKey)
  const g = setup?.groupRel && find(workspace, listGroups(workspace, { typeKey }), setup.group, groupId)
  if (!g) return { ok: false, error: 'No such group.' }
  if (listObjects(workspace, { typeKey }).some((o) => o.group === groupId)) {
    return { ok: false, error: `Objects still belong to "${g.label}" — move them elsewhere first.` }
  }
  if (!joined(setup.groupRel)) {
    return inGroup(workspace, () => {
      for (const row of rowsWith(workspace.model, setup.group, g.raw)) {
        if (cell(row, setup.object.idColumn) || !isHolding(setup, row)) set(workspace, setup.group.tableId, row, setup.group.idColumn, '')
        else deleteRow(workspace, setup.group.tableId, rowIdOf(row), { source: 'view' })
      }
      return { ok: true }
    })
  }
  return inGroup(workspace, () => {
    for (const row of rowsWith(workspace.model, setup.group, g.raw)) deleteRow(workspace, setup.group.tableId, rowIdOf(row), { source: 'view' })
    return { ok: true }
  })
}
