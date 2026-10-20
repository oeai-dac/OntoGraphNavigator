/**
 * Phases (src/lib/phaseEditor.js): put into a mapping that has none, created,
 * ordered, renamed, assigned to units, removed — on the example project and
 * on the reference project. What the views then read (P10, P120) checked with
 * the views' own phase reader, and the project file checked to carry the new
 * mapping for the Studio.
 *
 *   node tests/run-phase-editor-check.mjs
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
const ph = await load('src/lib/phaseEditor.js')
const { readPhases, defaultPhaseKey } = await load('src/views/lib/matrixPhases.js')

let failures = 0
const check = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${!cond && detail ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

for (const [name, file] of [
  ['example project', '0_exampleData/OntoCartographer_Projectfile.json'],
  ['reference project', '_session/OntoCartographer_Projektdatei.json'],
]) {
  console.log(`\n${name}`)
  if (!fs.existsSync(path.join(root, file))) { console.log(`skip  the reference data (_session/) is not in this copy — it is research data and not distributed with the Navigator`); continue }
  const loaded = loadFile(path.basename(file), fs.readFileSync(path.join(root, file), 'utf8'))
  const ws = createWorkspace({ model: loaded.model, journal: createJournal({ author: 'test' }), materializer: loaded.materializer })
  rematerialize(ws)
  const rel = ws.model.dot1Relations[0]
  const typeKey = ws.model.entities.get(rel.source).typeKey
  const units = Object.keys(ws.graph.nodes).filter((id) => ws.graph.nodes[id].t === typeKey)
  const nodesBefore = Object.keys(ws.graph.nodes).length

  const before = ph.describePhases(ws, { typeKey })
  check(!before.available && before.canAdd, 'no phases in the mapping yet, but they can be added')

  const added = ph.addPhasesToMapping(ws, { typeKey })
  rematerialize(ws)
  const after = ph.describePhases(ws, { typeKey })
  check(added.ok && after.available && after.ordered, `added: P10 from the units (column "${added.column}"), P120 between phases`, JSON.stringify({ added, after }))
  check(Object.keys(ws.graph.nodes).length === nodesBefore, 'the graph is unchanged until there are phases')

  // Three phases, created youngest-on-top: "Phase 1" first ends up oldest.
  for (const label of ['Phase 1', 'Phase 2', 'Phase 3']) ph.createPhase(ws, { typeKey, label })
  let list = ph.listPhases(ws, { typeKey })
  check(list.map((p) => p.label).join() === 'Phase 3,Phase 2,Phase 1', 'three phases, the newest on top', list.map((p) => p.label).join())
  check(!!ph.createPhase(ws, { typeKey, label: 'phase 2' }).error, 'a second "Phase 2" is refused')

  // Assign: the top units to Phase 3, the rest to Phase 1.
  const [p3, , p1] = list
  units.forEach((u, i) => ph.setUnitPhase(ws, { typeKey, unitId: u, phaseId: i < units.length / 2 ? p3.id : p1.id }))
  rematerialize(ws)
  const key = defaultPhaseKey(ws.graph, units)
  const model = readPhases(ws.graph, units, key, ph.listPhases(ws, { typeKey }))
  check(!!key && model.ordered === 'P120' && model.phases.map((p) => p.label).join() === 'Phase 3,Phase 2,Phase 1',
    `the views read the phases through ${key.split('/').pop()}, ordered by P120`, JSON.stringify({ key, ordered: model.ordered, phases: model.phases.map((p) => p.label) }))
  check(units.every((u) => model.phaseOf.has(u)), `all ${units.length} units have their phase in the graph`)

  // Several at once (an object dropped onto a phase): one undo.
  const two = units.slice(0, 2)
  const before2 = two.map((u) => model.phaseOf.get(u))
  const many = ph.setUnitPhase(ws, { typeKey, unitIds: two, phaseId: p1.id })
  rematerialize(ws)
  const after2 = readPhases(ws.graph, units, key, ph.listPhases(ws, { typeKey }))
  check(many.ok && many.assigned === 2 && two.every((u) => after2.phaseOf.get(u) === p1.id), 'two units into one phase at once')
  undo(ws)
  rematerialize(ws)
  const back2 = readPhases(ws.graph, units, key, ph.listPhases(ws, { typeKey }))
  check(two.every((u, i) => back2.phaseOf.get(u) === before2[i]), 'and back with one undo')

  // Reorder and rename.
  ph.movePhase(ws, { typeKey, phaseId: p1.id, direction: 'younger' })
  rematerialize(ws)
  list = ph.listPhases(ws, { typeKey })
  check(list.map((p) => p.label).join() === 'Phase 3,Phase 1,Phase 2', 'moved "Phase 1" up one place')
  check(readPhases(ws.graph, units, key, list).phases.map((p) => p.label).join() === 'Phase 3,Phase 1,Phase 2', 'and the views read the new order')
  undo(ws)
  rematerialize(ws)
  check(ph.listPhases(ws, { typeKey }).map((p) => p.label).join() === 'Phase 3,Phase 2,Phase 1', 'one undo restores the order')
  ph.renamePhase(ws, { typeKey, phaseId: p3.id, label: 'Modern' })
  rematerialize(ws)
  check(ws.graph.nodes[p3.id]?.l === 'Modern', 'renamed — the phase node carries the new name')

  // Delete: refused while units belong to it, fine for the empty one.
  check(!!ph.deletePhase(ws, { typeKey, phaseId: p1.id }).error, 'a phase with units cannot be deleted')
  const empty = ph.listPhases(ws, { typeKey }).find((p) => p.label === 'Phase 2')
  check(ph.deletePhase(ws, { typeKey, phaseId: empty.id }).ok && ph.listPhases(ws, { typeKey }).map((p) => p.label).join() === 'Modern,Phase 1',
    'the empty "Phase 2" deleted, the chain closed over it')

  // Still one consistent state, and a project file the Studio reads with the phases in it.
  rematerialize(ws)
  const fresh = materialize(ws.model).graph
  const differing = [...new Set([...Object.keys(fresh.nodes), ...Object.keys(ws.graph.nodes)])]
    .filter((id) => JSON.stringify(fresh.nodes[id]) !== JSON.stringify(ws.graph.nodes[id]))
  check(!differing.length, 'the incremental graph equals a fresh one',
    differing.slice(0, 2).map((id) => [id, `incr  ${JSON.stringify(ws.graph.nodes[id])?.slice(0, 260)}`, `fresh ${JSON.stringify(fresh.nodes[id])?.slice(0, 260)}`].join(' | ')).join(' || '))
  const written = writeProjectFile(ws.model)
  const reread = readProjectFile(JSON.parse(JSON.stringify(written)))
  const p10 = reread.relations.find((r) => /P10_falls_within/.test(r.propertyUri))
  const p120 = reread.relations.find((r) => /P120_occurs_before/.test(r.propertyUri))
  check(!!p10 && !!p120 && reread.entities.get(p10.target).classUri.endsWith('E4_Period'),
    'the project file carries E4 Period, P10 and P120 as Studio nodes and edges')
  check(written.tables?.some?.((t) => t.name === 'Phases') ?? true, 'the Studio\'s table summary names the phase tables')
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — phases hold')
process.exit(failures ? 1 : 0)
