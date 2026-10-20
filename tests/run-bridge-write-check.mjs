/**
 * Values and records from QGIS (src/lib/bridgeWriter.js):
 *
 *   - a value written where the attribute was read; emptied, it is gone from
 *     the node, and written again into the column the mapping reads it from;
 *     unchanged ones left alone; one undo per transfer;
 *   - an HME unit's value written on all its rows;
 *   - new records from keys of a layer: a unit on the BDA template with its
 *     geometry, a node at once through its measurement; an existing key refused.
 *
 *   node tests/run-bridge-write-check.mjs
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
const { describeValue, writeValues, describeNewRecords, createRecords } = await load('src/lib/bridgeWriter.js')

let failures = 0
const check = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${!cond && detail ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}
const same = (ws) => {
  const fresh = materialize(ws.model).graph
  return Object.keys(fresh.nodes).every((id) => JSON.stringify(fresh.nodes[id]) === JSON.stringify(ws.graph.nodes[id]))
}

// ---- values on the example ------------------------------------------------------------
console.log('example project')
{
  const l = loadFile('p.json', fs.readFileSync(path.join(root, '0_exampleData/OntoCartographer_Projectfile.json'), 'utf8'))
  const ws = createWorkspace({ model: l.model, journal: createJournal({}), materializer: l.materializer })
  rematerialize(ws)
  const find = Object.keys(ws.graph.nodes).find((id) => /#as:find$/.test(ws.graph.nodes[id].t))
  const key = 'Weight (g)'
  const before = ws.graph.nodes[find].a[key]
  check(describeValue(ws, ws.graph, find, key).mode === 'attribute', `a find's "${key}": written where it was read`)
  let r = writeValues(ws, ws.graph, key, [{ nodeId: find, value: '12.5' }])
  rematerialize(ws)
  check(r.written === 1 && String(ws.graph.nodes[find].a[key]) === '12.5', 'written, the node carries it', JSON.stringify(r))
  check(writeValues(ws, ws.graph, key, [{ nodeId: find, value: '12.5' }]).unchanged === 1, 'the same value again: left alone')
  writeValues(ws, ws.graph, key, [{ nodeId: find, value: '' }])
  rematerialize(ws)
  const d = describeValue(ws, ws.graph, find, key)
  check(ws.graph.nodes[find].a[key] === undefined && d.writable && d.mode === 'create', 'emptied: gone from the node, and writable into its column', JSON.stringify(d))
  r = writeValues(ws, ws.graph, key, [{ nodeId: find, value: '7' }])
  rematerialize(ws)
  check(r.written === 1 && String(ws.graph.nodes[find].a[key]) === '7', 'written again into the column the mapping reads')
  check(same(ws), 'the incremental graph equals a fresh one')
  undo(ws); undo(ws); undo(ws)
  rematerialize(ws)
  check(String(ws.graph.nodes[find].a[key]) === String(before), 'three undos, three transfers: the value as it was')
}

// ---- values on an HME unit: every row ------------------------------------------------------
const hmeFile = 'c:/CRM/HarrisMatrixEditor/data/test-data.json'
if (fs.existsSync(hmeFile)) {
  console.log('\nHME project')
  // With the BDA packages added, as a project recording SE protocols has them (step 7d).
  const { bdaPackages } = await import(pathToFileURL(path.join(here, 'protocol-packages.mjs')))
  const l = loadFile('test-data.json', fs.readFileSync(hmeFile, 'utf8'), { packages: await bdaPackages() })
  const ws = createWorkspace({ model: l.model, journal: createJournal({}), materializer: l.materializer })
  rematerialize(ws)
  // A unit above several others: several rows, one per relation.
  const table0 = [...ws.model.tables.values()][0]
  const counts = {}
  for (const row of table0.rows) counts[row.SU_uri] = (counts[row.SU_uri] || 0) + 1
  const raw = Object.keys(counts).find((k) => counts[k] > 1)
  const unit = Object.keys(ws.graph.nodes).find((id) => id.endsWith('/' + raw))
  const key = Object.keys(ws.graph.nodes[unit].a).find((k) => /SU description/i.test(k))
  const r = writeValues(ws, ws.graph, key, [{ nodeId: unit, value: 'Lehm, braun, kompakt' }])
  rematerialize(ws)
  const table = [...ws.model.tables.values()][0]
  const rows = table.rows.filter((row) => row.SU_uri === raw)
  check(r.written === 1 && rows.length > 1 && rows.every((row) => row.SU_description === 'Lehm, braun, kompakt') && ws.graph.nodes[unit].a[key] === 'Lehm, braun, kompakt',
    `"${key}" of ${ws.graph.nodes[unit].l} written on all its ${rows.length} rows`)
  // New units from a layer keyed "SU …": named as the HME names them; one that is there refused.
  const { BDA_URI_RULES } = await load('src/lib/hmeImport.js')
  const typeKey = ws.graph.nodes[unit].t
  const [there, fresh] = describeNewRecords(ws, { uriRules: BDA_URI_RULES }, { nodeType: typeKey, nodeSource: 'label' }, ['SU 001', 'SU 099'])
  check(!there.creatable && fresh.creatable && fresh.identifier === 'SU099', '"SU 001" is there already; "SU 099" becomes SU099 by the matrix rule', JSON.stringify([there, fresh]))
}

// ---- new records ------------------------------------------------------------------------------
console.log('\nnew records (BDA template)')
{
  const l = loadFile('t.json', EMPTY_HME_PROJECT)
  const ws = createWorkspace({ model: l.model, journal: createJournal({}), materializer: l.materializer })
  rematerialize(ws)
  const [{ typeKey, baseProp }] = matrixRules(ws)
  addMatrixRelation(ws, { baseProp, typeKey, a: null, b: null, kind: 'higher', word: 'above', newUnits: { a: { label: '1001', identifier: 'SE1001' }, b: { label: '1002', identifier: 'SE1002' } } })
  rematerialize(ws)
  const spec = { nodeType: typeKey, nodeSource: 'label' }
  const config = { uriRules: BDA_URI_RULES }
  const [known, fresh] = describeNewRecords(ws, config, spec, ['1001', '1003'])
  check(!known.creatable && fresh.creatable && fresh.identifier === 'SU1003', 'an existing unit refused, a new one minted SU1003 by the matrix rule', JSON.stringify([known, fresh]))
  const r = createRecords(ws, ws.graph, config, spec, [{ key: '1003', wkt: 'POLYGON ((0 0, 2 0, 2 2, 0 0))' }, { key: '1001' }], () => { rematerialize(ws); return ws.graph })
  const created = r.created[0]
  check(r.created.length === 1 && created.visible && ws.graph.nodes[created.nodeId]?.l === '1003' && r.failed.length === 1,
    'SU 1003 entered with its geometry — a node at once, through its measurement', JSON.stringify(r))
  const measured = Object.entries(ws.graph.nodes[created.nodeId].o || {}).find(([k]) => /O32i/.test(k))?.[1] || []
  check(measured.some((t) => t.endsWith('SU1003_measurement')), 'its measurement SU1003_measurement')
  check(same(ws), 'the incremental graph equals a fresh one')
  undo(ws)
  rematerialize(ws)
  check(!ws.graph.nodes[created.nodeId], 'one undo takes the record and its geometry back')
  const bare = createRecords(ws, ws.graph, config, spec, [{ key: '1004' }], () => { rematerialize(ws); return ws.graph })
  check(bare.created.length === 1 && !bare.created[0].visible, 'a record with no geometry and no relation yet: entered, but no node — and said so', JSON.stringify(bare))
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — values and records from QGIS')
process.exit(failures ? 1 : 0)
