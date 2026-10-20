/**
 * Objects and object groups (src/lib/objectEditor.js), on the three ways a
 * project can come:
 *
 *   example project     no objects at all — both added to the mapping, own tables
 *   reference project   objects on the units' rows ("Raum"), no groups — groups added
 *   HME export          objects and groups on the units' rows — nothing to add
 *
 * Each time: objects and groups created or named, units and objects assigned,
 * renamed, removed, undone; what the views then read checked with the views'
 * own reader, the incremental graph against a fresh one, and the project file
 * against the Studio's reader.
 *
 *   node tests/run-object-editor-check.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

register('./resolve-extensionless.mjs', import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const load = (f) => import(pathToFileURL(path.join(root, f)))

const { loadFile } = await load('src/lib/loadFile.js')
const { createJournal } = await load('src/lib/journal.js')
const { createWorkspace, rematerialize, undo } = await load('src/lib/edits.js')
const { materialize } = await load('src/lib/materialize.js')
const { readProjectFile, writeProjectFile } = await load('src/lib/projectFile.js')
const ob = await load('src/lib/objectEditor.js')
const { readObjects, defaultObjectKey } = await load('src/views/lib/matrixObjects.js')
const { layoutHarrisMatrix } = await load('src/views/lib/dagreLayout.js')
const { buildSequence, detectDotOneProperties } = await load('src/views/lib/harrisMatrix.js')

let failures = 0
const check = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${!cond && detail ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}
const same = (ws) => {
  rematerialize(ws)
  const fresh = materialize(ws.model).graph
  const differing = [...new Set([...Object.keys(fresh.nodes), ...Object.keys(ws.graph.nodes)])]
    .filter((id) => JSON.stringify(fresh.nodes[id]) !== JSON.stringify(ws.graph.nodes[id]))
  return { ok: !differing.length, detail: differing.slice(0, 2).map((id) => `${id}: incr ${JSON.stringify(ws.graph.nodes[id])?.slice(0, 200)} | fresh ${JSON.stringify(fresh.nodes[id])?.slice(0, 200)}`).join(' || ') }
}

for (const [name, file, expect] of [
  ['example project', '0_exampleData/OntoCartographer_Projectfile.json', 'none'],
  ['reference project', '_session/OntoCartographer_Projektdatei.json', 'objects'],
  ['HME export', '_session/HarrisMatrixEditor_OntoCartographer-Projektdatei.json', 'both'],
]) {
  console.log(`\n${name}`)
  if (!fs.existsSync(path.join(root, file))) { console.log(`skip  the reference data (_session/) is not in this copy — it is research data and not distributed with the Navigator`); continue }
  const loaded = loadFile(path.basename(file), fs.readFileSync(path.join(root, file), 'utf8'))
  const ws = createWorkspace({ model: loaded.model, journal: createJournal({ author: 'test' }), materializer: loaded.materializer })
  rematerialize(ws)
  const rel = ws.model.dot1Relations[0]
  const typeKey = ws.model.entities.get(rel.source).typeKey
  const units = Object.keys(ws.graph.nodes).filter((id) => ws.graph.nodes[id].t === typeKey)
  const before = ob.describeObjects(ws, { typeKey })

  if (expect === 'none') check(!before.available && before.canAdd, 'no objects in the mapping, they can be added')
  if (expect === 'objects') check(before.available && before.canAddGroups && before.standalone, 'objects on the units’ rows, no groups yet — made on their own all the same', JSON.stringify(before))
  if (expect === 'both') check(before.available && before.groups && !before.canAddGroups, 'objects and groups on the units\' rows', JSON.stringify(before))

  if (expect !== 'both') {
    const nodesBefore = Object.keys(ws.graph.nodes).length
    const added = ob.addObjectsToMapping(ws, { typeKey })
    rematerialize(ws)
    check(added.ok && ob.describeObjects(ws, { typeKey }).groups, `added to the mapping: ${added.added?.join(' and ')}`, JSON.stringify(added))
    check(Object.keys(ws.graph.nodes).length === nodesBefore, 'the graph is unchanged by that')
  }
  const info = ob.describeObjects(ws, { typeKey })
  const [u1, u2, u3, u4] = units

  // Units into objects — new ones by name, the way the unit panel does it.
  ob.setUnitObject(ws, { typeKey, unitId: u1, newLabel: 'Wall 1' })
  ob.setUnitObject(ws, { typeKey, unitId: u2, newLabel: 'wall 1' }) // the same, by name
  ob.setUnitObject(ws, { typeKey, unitId: u3, newLabel: 'Room 2' })
  let objects = ob.listObjects(ws, { typeKey })
  const wall = objects.find((o) => o.label === 'Wall 1')
  const room = objects.find((o) => o.label === 'Room 2')
  check(!!wall && !!room && !objects.some((o) => o.label === 'wall 1'), 'new objects by name, a second "wall 1" is the first', objects.map((o) => o.label).join())

  // Groups — on objects.
  ob.setObjectGroup(ws, { typeKey, objectId: wall.id, newLabel: 'Building A' })
  const building = ob.listGroups(ws, { typeKey }).find((g) => g.label === 'Building A')
  ob.setObjectGroup(ws, { typeKey, objectId: room.id, groupId: building.id })
  objects = ob.listObjects(ws, { typeKey })
  check(objects.filter((o) => o.group === building.id).length === 2, 'both objects in "Building A"')

  // A unit joining an object on one row brings the object's group along.
  ob.setUnitObject(ws, { typeKey, unitId: u4, objectId: room.id })
  const s = same(ws)
  check(s.ok, 'the incremental graph equals a fresh one', s.detail)

  // What the views read.
  const key = defaultObjectKey(ws.graph, units)
  const model = readObjects(ws.graph, units, key)
  check(key === info.edgeKey, `the views read objects through ${key.split('/').pop()}`, `${key} vs ${info.edgeKey}`)
  check(model.objectOf.get(u1) === wall.id && model.objectOf.get(u2) === wall.id && model.objectOf.get(u3) === room.id && model.objectOf.get(u4) === room.id,
    'each unit in its object', JSON.stringify([...model.objectOf].slice(0, 6)))
  check(model.groupOf.get(wall.id) === building.id && model.groupOf.get(room.id) === building.id, 'each object in its group', JSON.stringify([...model.groupOf]))

  // Kept together in the layout, with a box around each.
  const prop = detectDotOneProperties(ws.graph, units)[0]
  const seq = buildSequence(ws.graph, units, prop)
  const lay = layoutHarrisMatrix(units, seq.rankEdges, seq.sameRankEdges, seq.equalsEdges, { objectOf: model.objectOf, groupOf: model.groupOf })
  const boxOf = (id, kind) => lay.boxes.find((b) => b.id === id && b.kind === kind)
  const inside = (u, b) => b && lay.positions[u].x >= b.x && lay.positions[u].x + lay.width <= b.x + b.w && lay.positions[u].y >= b.y && lay.positions[u].y + lay.height <= b.y + b.h
  check(inside(u1, boxOf(wall.id, 'object')) && inside(u3, boxOf(room.id, 'object')) && inside(u1, boxOf(building.id, 'group')) && inside(u4, boxOf(building.id, 'group')),
    'the layout keeps each object\'s units inside its box, and the objects inside the group\'s')
  const strangers = units.filter((u) => ![u1, u2].includes(u) && inside(u, boxOf(wall.id, 'object')))
  check(!strangers.length, 'no other unit inside the box of "Wall 1"', strangers.join())

  // Rename, take a unit out, undo.
  ob.renameObject(ws, { typeKey, objectId: wall.id, label: 'Wall 1 (north)' })
  ob.renameGroup(ws, { typeKey, groupId: building.id, label: 'Building A1' })
  rematerialize(ws)
  check(ws.graph.nodes[wall.id]?.l === 'Wall 1 (north)' && ws.graph.nodes[building.id]?.l === 'Building A1', 'renamed — the nodes carry the new names',
    JSON.stringify([ws.graph.nodes[wall.id]?.l, ws.graph.nodes[building.id]?.l]))
  ob.setUnitObject(ws, { typeKey, unitId: u2, objectId: null })
  rematerialize(ws)
  check(!readObjects(ws.graph, units, key).objectOf.has(u2), 'a unit taken out of its object')
  undo(ws)
  rematerialize(ws)
  check(readObjects(ws.graph, units, key).objectOf.get(u2) === wall.id, 'one undo puts it back')

  // Made on their own, removed while empty — in their tables, or on holding rows of the units' table.
  check(!!ob.deleteObject(ws, { typeKey, objectId: wall.id }).error, 'an object with units cannot be removed')
  const made = ob.createObject(ws, { typeKey, label: 'Pit 3' })
  check(made.ok && ob.deleteObject(ws, { typeKey, objectId: made.id }).ok && !ob.listObjects(ws, { typeKey }).some((o) => o.label === 'Pit 3'),
    'an empty object created and removed')
  check(!!ob.deleteGroup(ws, { typeKey, groupId: building.id }).error, 'a group with objects cannot be removed')
  // Made before any unit, in a group made before any object; then a unit takes it.
  const unitTable = ws.model.tables.get(ob.objectSetup(ws.model, typeKey).unit.tableId)
  const rowsBefore = unitTable.rows.length
  const yard = ob.createGroup(ws, { typeKey, label: 'Yard' })
  const well = ob.createObject(ws, { typeKey, label: 'Well', groupId: yard.id })
  check(yard.ok && well.ok && ob.listObjects(ws, { typeKey }).some((o) => o.label === 'Well' && o.group === yard.id) && ob.listGroups(ws, { typeKey }).some((g) => g.label === 'Yard'),
    'an object made before any unit, in a group made before any object', JSON.stringify({ yard, well }))
  ob.setUnitObject(ws, { typeKey, unitId: u2, objectId: well.id })
  rematerialize(ws)
  const shared = ob.objectSetup(ws.model, typeKey).object.tableId === unitTable.id
  check(readObjects(ws.graph, units, key).objectOf.get(u2) === well.id && (!shared || unitTable.rows.length === rowsBefore),
    'a unit takes it, with its group — where objects are kept on the units’ rows, the holding rows are gone', `${unitTable.rows.length} rows, ${rowsBefore} before`)
  const s1 = same(ws)
  check(s1.ok, 'the incremental graph equals a fresh one', s1.detail)

  const s2 = same(ws)
  check(s2.ok, 'still: the incremental graph equals a fresh one', s2.detail)
  const reread = readProjectFile(JSON.parse(JSON.stringify(writeProjectFile(ws.model))))
  const partOf = reread.relations.filter((r) => /P46i_forms_part_of/.test(r.propertyUri))
  check(partOf.length >= 2, `the project file carries both "forms part of" relations (${partOf.length})`)
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — objects hold')
process.exit(failures ? 1 : 0)
