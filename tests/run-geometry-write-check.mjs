/**
 * Geometries written back from QGIS (src/lib/geometryWriter.js), on the three
 * ways a project keeps them:
 *
 *   example project     WKT on the unit itself ("Geometry")
 *   reference project   WKT on the unit's measurement (S23, a table of its own)
 *   BDA template        no geometry yet: the measurement created on the unit's rows
 *
 * Each: where it goes, written, the graph carrying it, unchanged ones left
 * alone, one undo for the whole transfer.
 *
 *   node tests/run-geometry-write-check.mjs
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
const { EMPTY_HME_PROJECT, BDA_URI_RULES } = await load('src/lib/hmeImport.js')
const { addMatrixRelation, matrixRules } = await load('src/lib/matrixEditor.js')
const { describeGeometry, writeGeometries } = await load('src/lib/geometryWriter.js')

let failures = 0
const check = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${!cond && detail ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}
const wktOn = (graph, id) => {
  const nd = graph.nodes[id]
  const own = Object.values(nd.a || {}).flat().find((v) => /^(MULTI)?(POINT|POLYGON|LINESTRING)/i.test(String(v)))
  if (own) return own
  for (const [k, ts] of Object.entries(nd.o || {})) for (const t of ts) {
    const v = Object.values(graph.nodes[t]?.a || {}).flat().find((x) => /^(MULTI)?(POINT|POLYGON|LINESTRING)/i.test(String(x)))
    if (v) return v
  }
  return ''
}
const same = (ws) => {
  const fresh = materialize(ws.model).graph
  return Object.keys(fresh.nodes).every((id) => JSON.stringify(fresh.nodes[id]) === JSON.stringify(ws.graph.nodes[id]))
}

for (const [name, file, pick] of [
  ['example project', '0_exampleData/OntoCartographer_Projectfile.json', (g) => Object.keys(g.nodes).find((id) => /SU1001$/.test(id))],
  ['reference project', '_session/OntoCartographer_Projektdatei.json', (g) => Object.keys(g.nodes).find((id) => wktOn(g, id) && /#as:se$/.test(g.nodes[id].t))],
]) {
  console.log(`\n${name}`)
  if (!fs.existsSync(path.join(root, file))) { console.log(`skip  the reference data (_session/) is not in this copy — it is research data and not distributed with the Navigator`); continue }
  const l = loadFile(path.basename(file), fs.readFileSync(path.join(root, file), 'utf8'))
  const ws = createWorkspace({ model: l.model, journal: createJournal({ author: 'test' }), materializer: l.materializer })
  rematerialize(ws)
  const id = pick(ws.graph)
  const d = describeGeometry(ws, ws.graph, id)
  check(d.writable && d.mode === 'attribute' && d.current, `${ws.graph.nodes[id].l}: its geometry at "${d.where}"`, JSON.stringify(d))
  const before = d.current
  const moved = 'POLYGON ((1 1, 2 1, 2 2, 1 2, 1 1))'
  const r = writeGeometries(ws, ws.graph, [{ nodeId: id, wkt: moved }])
  rematerialize(ws)
  check(r.written === 1 && !r.failed.length && wktOn(ws.graph, id) === moved, 'written, and the graph carries it', JSON.stringify(r))
  const again = writeGeometries(ws, ws.graph, [{ nodeId: id, wkt: moved }])
  check(again.unchanged === 1 && again.written === 0, 'the same geometry again: left alone')
  check(same(ws), 'the incremental graph equals a fresh one')
  undo(ws)
  rematerialize(ws)
  check(wktOn(ws.graph, id) === before, 'one undo brings the old geometry back')
  const bad = writeGeometries(ws, ws.graph, [{ nodeId: id, wkt: 'not a geometry' }, { nodeId: 'nope', wkt: moved }])
  check(bad.failed.length === 2 && bad.written === 0, 'no WKT, no node: refused with a reason', JSON.stringify(bad.failed))
}

console.log('\nBDA template (no geometry yet)')
const l = loadFile('t.json', EMPTY_HME_PROJECT)
const ws = createWorkspace({ model: l.model, journal: createJournal({}), materializer: l.materializer })
rematerialize(ws)
const [{ typeKey, baseProp }] = matrixRules(ws)
const made = addMatrixRelation(ws, { baseProp, typeKey, a: null, b: null, kind: 'higher', word: 'above', newUnits: { a: { label: '1001', identifier: 'SE1001' }, b: { label: '1002', identifier: 'SE1002' } } })
rematerialize(ws)
const d = describeGeometry(ws, ws.graph, made.a)
check(d.writable && d.mode === 'create' && /Measurement/.test(d.where), `a new geometry goes to "${d.where}"`, JSON.stringify(d))
const geom = 'POLYGON ((348500 5340200, 348530 5340200, 348530 5340220, 348500 5340220, 348500 5340200))'
const r = writeGeometries(ws, ws.graph, [{ nodeId: made.a, wkt: geom }, { nodeId: made.b, wkt: 'POINT (348510 5340210)' }], { uriRules: BDA_URI_RULES })
rematerialize(ws)
const via = (ws.graph.nodes[made.a].o && Object.entries(ws.graph.nodes[made.a].o).find(([k]) => /O32i/.test(k))?.[1]) || []
check(r.written === 2 && wktOn(ws.graph, made.a) === geom && via.some((t) => t.endsWith('SE1001_measurement')), 'written: the measurement SE1001_measurement carries the WKT', JSON.stringify({ r, via }))
check(describeGeometry(ws, ws.graph, made.a).mode === 'attribute', 'from now on it is changed where it is')
check(same(ws), 'the incremental graph equals a fresh one')
undo(ws)
rematerialize(ws)
check(!wktOn(ws.graph, made.a) && !wktOn(ws.graph, made.b), 'one undo takes both back')

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — geometries are written where they live')
process.exit(failures ? 1 : 0)
