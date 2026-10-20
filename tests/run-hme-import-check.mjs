/**
 * The Harris Matrix Editor's files and the "matrix first" template
 * (src/lib/hmeImport.js):
 *
 *   - an HME project (the HME's own test data, 60 units with protocols,
 *     geometries, phases and objects): without a protocol package added, on
 *     the BDA matrix mapping only — units, relations, phases, objects, unit
 *     type, geometry; with the BDA packages added, bound as the packages
 *     model their fields, and the graph agrees with the HME's own Studio
 *     export of the same data for everything that export carries, and has
 *     phases, unit types and geometries besides;
 *   - the template: the matrix mapping only, no unit; a first relation drawn
 *     in the matrix with two new units, a phase, an object — the project file
 *     written and read again.
 *
 *   node tests/run-hme-import-check.mjs
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
const { bdaPackages, havePackages, SKIP_PACKAGES } = await import(pathToFileURL(path.join(here, 'protocol-packages.mjs')))
// Columns of the SE-Protokoll that are no part of the matrix: they come with a protocol only.
const PROTOCOL_COLUMNS = ['Mnr', 'Mbez', 'KG', 'OG', 'SE_Bez', 'Schnitt_Flaeche', 'Profil', 'Probe_Art', 'Interpretation', 'Datierung', 'Beschreibung_SE', 'Protokoll']
const tableColumns = (model) => [...model.tables.values()].flatMap((t) => t.columns)
const { createJournal } = await load('src/lib/journal.js')
const { createWorkspace, rematerialize } = await load('src/lib/edits.js')
const { materialize } = await load('src/lib/materialize.js')
const { writeProjectFile } = await load('src/lib/projectFile.js')
const { isHmeProject, buildMatrixTemplate, geoJsonToWkt } = await load('src/lib/hmeImport.js')
const { addMatrixRelation, matrixRules } = await load('src/lib/matrixEditor.js')
const { describePhases, createPhase, listPhases, setUnitPhase } = await load('src/lib/phaseEditor.js')
const { describeObjects, setUnitObject } = await load('src/lib/objectEditor.js')
const { readPhases, defaultPhaseKey } = await load('src/views/lib/matrixPhases.js')
const { readObjects, defaultObjectKey } = await load('src/views/lib/matrixObjects.js')
const { buildSequence, detectDotOneProperties } = await load('src/views/lib/harrisMatrix.js')

let failures = 0
const check = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${!cond && detail ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

const HME = 'c:/CRM/HarrisMatrixEditor/data'
const hmeFile = path.join(HME, 'test-data.json')
const haveHme = fs.existsSync(hmeFile)

check(geoJsonToWkt({ type: 'Polygon', coordinates: [[[1, 2], [3, 4], [5, 6], [1, 2]]] }) === 'POLYGON ((1 2, 3 4, 5 6, 1 2))'
  && geoJsonToWkt({ type: 'Point', coordinates: [1, 2, 3] }) === 'POINT Z (1 2 3)', 'GeoJSON becomes WKT')

// ---- an HME project ---------------------------------------------------------------
if (!haveHme) {
  console.log('skip  the HME test data is not next to this repository (c:/CRM/HarrisMatrixEditor/data)')
} else if (!havePackages) {
  console.log(SKIP_PACKAGES)
} else {
  console.log('\nHME project (test-data.json)')
  const text = fs.readFileSync(hmeFile, 'utf8')
  const hme = JSON.parse(text)
  check(isHmeProject(hme) && !isHmeProject(JSON.parse(fs.readFileSync(path.join(root, '0_exampleData/OntoCartographer_Projectfile.json'), 'utf8'))),
    'an HME file is told apart from a Studio project')
  const bare = loadFile('test-data.json', text)
  const bareColumns = tableColumns(bare.model)
  check(!PROTOCOL_COLUMNS.some((c) => bareColumns.includes(c)) && bareColumns.includes('SU') && bareColumns.includes('Objno') && bareColumns.includes('wkt_geom'),
    'without a protocol package: the matrix mapping only — no column of the SE-Protokoll', bareColumns.join(', '))
  const loaded = loadFile('test-data.json', text, { packages: await bdaPackages() })
  const r = loaded.report.hme
  check(Object.keys(r.protocolBindings || {}).includes('bda-standard') && tableColumns(loaded.model).includes('Schnitt_Flaeche'),
    `with the packages added: bound as they model their fields (${Object.keys(r.protocolBindings || {}).join(', ')})`)
  check(loaded.source === 'project' && r.units === hme.nodes.length, `opened as a project: ${r.units} units, ${r.relations} relations, ${r.phases} phases, ${r.objects} objects, ${r.geometries} geometries`, JSON.stringify(r).slice(0, 400))
  check(r.relations === hme.edges.length, `every relation came along (${hme.edges.length})`)
  console.log(`      report: ${loaded.warnings.slice(0, 6).map((w) => w.slice(0, 160)).join('\n              ')}`)

  const g = loaded.graph
  const typeKey = loaded.model.entities.get(loaded.model.dot1Relations[0].source).typeKey
  const units = Object.keys(g.nodes).filter((id) => g.nodes[id].t === typeKey)
  check(units.length === hme.nodes.length, `${units.length} units in the graph`)
  const prop = detectDotOneProperties(g, units)[0]
  const seq = buildSequence(g, units, prop)
  check(seq.rankEdges.length === hme.edges.length, `the matrix has ${seq.rankEdges.length} relations`)

  // Phases, in the HME's order (phases[0] youngest).
  const phaseModel = readPhases(g, units, defaultPhaseKey(g, units))
  check(phaseModel.phases.map((p) => p.label).join() === hme.phases.map((p) => p.name).join() && phaseModel.ordered === 'P120',
    'phases in the HME\'s order, youngest first', phaseModel.phases.map((p) => p.label).join(' | '))
  const label = (n) => g.nodes[units.find((u) => g.nodes[u].l === n.label)]
  const withPhase = hme.nodes.filter((n) => n.phase)
  check(withPhase.every((n) => g.nodes[phaseModel.phaseOf.get(units.find((u) => g.nodes[u].l === n.label))]?.l === hme.phases.find((p) => p.id === n.phase).name),
    `each of ${withPhase.length} units in its phase`)

  // Objects: the protocol's own where it names one.
  const objectModel = readObjects(g, units, defaultObjectKey(g, units))
  const own = hme.nodes.filter((n) => n.se?.befunddaten?.Objnr)
  check(own.every((n) => g.nodes[objectModel.objectOf.get(units.find((u) => g.nodes[u].l === n.label))]?.l === n.se.befunddaten.Objnr),
    `${own.length} units keep the object their protocol names`)

  // Unit type and geometry.
  const typed = units.filter((u) => Object.keys(g.nodes[u].o || {}).some((k) => /P2_has_type/.test(k) && !k.includes('#dot1:')))
  check(typed.length === hme.nodes.filter((n) => n.type).length, `${typed.length} units carry their unit type`)
  const located = units.filter((u) => Object.entries(g.nodes[u].o || {}).some(([k, ts]) => /O32i_was_located_by/.test(k) && ts.some((t) => Object.values(g.nodes[t]?.a || {}).some((v) => /^POLYGON|^POINT|^LINESTRING|^MULTI/.test(String(v))))))
  check(located.length === hme.nodes.filter((n) => n.geometry).length, `${located.length} units located by a measurement with its WKT`)
  void label

  // Against the HME's own Studio export of the same data: every node and
  // statement that export makes is made here too.
  // The export is made here, by the HME's own code from its repository (read only).
  const hmeExport = 'c:/CRM/HarrisMatrixEditor/dev/src/io/ontoCartographer.js'
  if (fs.existsSync(hmeExport)) {
    const { buildOntoCartographerProject } = await import(pathToFileURL(hmeExport))
    const exported = buildOntoCartographerProject({ nodes: hme.nodes, edges: hme.edges, projectMeta: hme.projectMeta, ...(hme.rdfSettings || {}) })
    const theirs = loadFile('hme-export.json', exported).graph
    const sameData = Object.keys(theirs.nodes).length > 0
    // The units are SU here (English, 2026-10-19), SE in the HME's export; a
    // property is compared without the explorer name the key carries.
    const ours = (id) => id.replace(/\/SE(?=\d)/, '/SU').replace(/(\/SU\d+)_Bez$/, '$1_designation')
    const prop = (k) => k.replace(/#as:.*$/, '')
    const missingNodes = Object.keys(theirs.nodes).filter((id) => !g.nodes[ours(id)])
    const missingEdges = []
    for (const [id, n] of Object.entries(theirs.nodes)) {
      const mine = g.nodes[ours(id)]
      for (const [k, ts] of Object.entries(n.o || {})) {
        const have = new Set(Object.entries(mine?.o || {}).filter(([mk]) => prop(mk) === prop(k)).flatMap(([, mts]) => mts))
        for (const t of ts) if (!have.has(ours(t))) missingEdges.push(`${id} ${k.split('/').pop()} ${t}`)
      }
    }
    check(sameData && !missingNodes.length, `all ${Object.keys(theirs.nodes).length} nodes of the HME's own export are here`, missingNodes.slice(0, 5).join(', '))
    check(!missingEdges.length, 'and every statement it makes', `${missingEdges.length}: ${missingEdges.slice(0, 5).join(' | ')}`)
    const typeDiff = Object.keys(theirs.nodes).filter((id) => g.nodes[ours(id)] && g.nodes[ours(id)].t !== theirs.nodes[id].t)
    console.log(`      ${Object.keys(g.nodes).length - Object.keys(theirs.nodes).length} nodes more here (phases, unit types, measurements, objects from the HME); ${typeDiff.length} typed otherwise`)
  }
}

// ---- the template ------------------------------------------------------------------
console.log('\ntemplate')
const { json } = buildMatrixTemplate()
const loaded = loadFile('Harris-Matrix (BDA).json', JSON.stringify(json))
check(loaded.source === 'project' && Object.keys(loaded.graph.nodes).length === 0, 'an empty project, no node yet')
check(!PROTOCOL_COLUMNS.some((c) => tableColumns(loaded.model).includes(c)), `the matrix mapping only: ${tableColumns(loaded.model).join(', ')}`)
const ws = createWorkspace({ model: loaded.model, journal: createJournal({ author: 'test' }), materializer: loaded.materializer })
rematerialize(ws)
const rules = matrixRules(ws)
check(rules.length === 1, `the matrix is known before any unit: ${rules.map((r) => `${r.label} / ${r.baseProp.split('/').pop()}`).join()}`)
const [{ typeKey, baseProp }] = rules
check(describePhases(ws, { typeKey }).available && describeObjects(ws, { typeKey }).available && describeObjects(ws, { typeKey }).groups,
  'phases, objects and groups are there from the start')
const added = addMatrixRelation(ws, { baseProp, typeKey, a: null, b: null, kind: 'higher', word: 'above', newUnits: { a: { label: '1', identifier: 'SE1' }, b: { label: '2', identifier: 'SE2' } } })
rematerialize(ws)
// The lower unit is in the graph as the relation's partner (the BDA mapping's
// "SE (Relation)") until it has a value of its own — the matrix shows partners.
const units = [added.a, added.b].filter((id) => ws.graph.nodes[id])
const seq = units.length ? buildSequence(ws.graph, units, baseProp) : { rankEdges: [] }
check(added.ok && units.length === 2 && seq.rankEdges.length === 1, 'a first relation with two new units', JSON.stringify({ added, units }))
const p = createPhase(ws, { typeKey, label: 'Phase 1' })
const assigned = [setUnitPhase(ws, { typeKey, unitId: added.b, phaseId: p.id }), setUnitObject(ws, { typeKey, unitId: added.b, newLabel: 'Mauer 1' })]
rematerialize(ws)
check(assigned.every((r) => r.ok) && readPhases(ws.graph, units, defaultPhaseKey(ws.graph, units)).phaseOf.get(added.b) === p.id
  && readObjects(ws.graph, units, defaultObjectKey(ws.graph, units)).objectOf.has(added.b),
  'the new lower unit takes a phase and an object', JSON.stringify(assigned))
const fresh = materialize(ws.model).graph
check(JSON.stringify(Object.keys(fresh.nodes).sort()) === JSON.stringify(Object.keys(ws.graph.nodes).sort()), 'the incremental graph equals a fresh one')
const again = loadFile('again.json', JSON.stringify(writeProjectFile(ws.model)))
check(listPhases(createWorkspace({ model: again.model, journal: createJournal({}) }), { typeKey }).length === 1
  && Object.keys(again.graph.nodes).length === Object.keys(ws.graph.nodes).length,
  'written and read again: the same graph')

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — HME files and the template hold')
process.exit(failures ? 1 : 0)
