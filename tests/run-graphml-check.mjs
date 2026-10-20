/**
 * The Harris matrix as GraphML (views/lib/matrixGraphml.js, lib/graphmlImport.js):
 *
 *   - the XML reader: entities, CDATA, comments, namespaces;
 *   - written and read back: units, unit types, every kind of relation, phases
 *     in their order, objects and their groups;
 *   - the HME's test data, opened here, written as GraphML and opened again as
 *     a new project: the same matrix — every unit, relation, phase and object;
 *   - a file the Harris Matrix Editor writes itself (when it is next to this
 *     repository): its units, relations, phases and objects all arrive.
 *
 *   node tests/run-graphml-check.mjs
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
const G = await load('src/views/lib/matrixGraphml.js')
const { buildSequence, detectDotOneProperties } = await load('src/views/lib/harrisMatrix.js')
const { readPhases, defaultPhaseKey, layoutByPhase } = await load('src/views/lib/matrixPhases.js')
const { readObjects, defaultObjectKey } = await load('src/views/lib/matrixObjects.js')
const { bdaPackages } = await import(pathToFileURL(path.join(here, 'protocol-packages.mjs')))

let failures = 0
const check = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${!cond && detail ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

// ---- the reader ---------------------------------------------------------------------------
const x = G.parseXml('<?xml version="1.0"?><!-- c --><a xmlns:y="u"><y:b k="1 &amp; 2">x &lt; y<![CDATA[ <z> ]]></y:b><c/></a>')
check(x.tag === 'a' && x.children[0].attrs.k === '1 & 2' && x.children[0].text === 'x < y <z> ' && x.children[1].tag === 'c', 'the XML reader: entities, CDATA, comments, namespaces')

// ---- written and read back ------------------------------------------------------------------
const units = [
  { id: 'u1', label: 'SE 1', type: 'layer' }, { id: 'u2', label: 'SE 2', type: 'fill' },
  { id: 'u3', label: 'SE 3', type: 'interface' }, { id: 'u4', label: 'SE 4 & <5>' }, { id: 'u5', label: 'SE 5' },
]
const relations = [{ a: 'u1', b: 'u2', kind: 'higher' }, { a: 'u2', b: 'u3', kind: 'same-rank' }, { a: 'u3', b: 'u4', kind: 'equals' }, { a: 'u4', b: 'u5', kind: 'higher' }]
const xml = G.writeMatrixGraphML({
  units, relations,
  phases: [{ id: 'p2', label: 'Phase 2', color: '#ef4444' }, { id: 'p1', label: 'Phase 1', color: '#3b82f6' }],
  phaseOf: new Map([['u1', 'p2'], ['u2', 'p2'], ['u3', 'p1'], ['u4', 'p1']]),
  objects: [{ id: 'o1', label: 'Mauer 1', color: '#8b5cf6', group: 'Gebäude A' }],
  objectOf: new Map([['u2', 'o1'], ['u3', 'o1']]),
})
const back = G.readMatrixGraphML(xml)
const lab = new Map(back.units.map((u) => [u.gid, u.label]))
check(back.units.map((u) => `${u.label}:${u.type}`).sort().join() === units.map((u) => `${u.label}:${u.type || ''}`).sort().join(), 'units and their types come back', back.units.map((u) => `${u.label}:${u.type}`).join())
check(back.relations.map((r) => `${lab.get(r.a)} ${r.kind} ${lab.get(r.b)}`).join('|') === 'SE 1 higher SE 2|SE 2 same-rank SE 3|SE 3 equals SE 4 & <5>|SE 4 & <5> higher SE 5', 'every kind of relation comes back', back.relations.map((r) => `${lab.get(r.a)} ${r.kind} ${lab.get(r.b)}`).join('|'))
check(back.phases.map((p) => p.label).join() === 'Phase 2,Phase 1' && back.units.find((u) => u.label === 'SE 3').phase === back.phases[1].gid && !back.units.find((u) => u.label === 'SE 5').phase, 'phases in their order, each unit in its phase')
const objs = back.objects.filter((o) => o.label === 'Mauer 1')
check(objs.length === 2 && objs.every((o) => o.group === 'Gebäude A') && objs.flatMap((o) => o.units).map((g) => lab.get(g)).sort().join() === 'SE 2,SE 3', 'an object across two phases: in each, with its group', JSON.stringify(objs))

// ---- the HME's data: here, as GraphML, and back -----------------------------------------------
const packages = await bdaPackages()
const hmeFile = 'c:/CRM/HarrisMatrixEditor/data/test-data.json'
const signature = (graph) => {
  const rel = detectDotOneProperties(graph, Object.keys(graph.nodes))[0]
  const unitIds = [...new Set(Object.keys(graph.nodes).filter((id) => Object.keys(graph.nodes[id].o || {}).some((k) => k.startsWith(rel + '#dot1:')) || Object.keys(graph.nodes[id].i || {}).some((k) => k.startsWith(rel + '#dot1:'))))]
  const seq = buildSequence(graph, unitIds, rel)
  const l = (id) => graph.nodes[id].l
  const phases = readPhases(graph, unitIds, defaultPhaseKey(graph, unitIds))
  const objects = readObjects(graph, unitIds, defaultObjectKey(graph, unitIds))
  return {
    unitIds, rel, seq, phases, objects,
    units: unitIds.map(l).sort(),
    relations: [
      ...seq.rankEdges.map((e) => `${l(e.target)} above ${l(e.source)}`),
      ...seq.sameRankEdges.map((e) => `${[l(e.source), l(e.target)].sort().join(' = ')}`),
      ...seq.equalsEdges.map((e) => `${[l(e.source), l(e.target)].sort().join(' == ')}`),
    ].sort(),
    phaseOf: unitIds.map((u) => `${l(u)}:${graph.nodes[phases.phaseOf.get(u)]?.l || ''}`).sort(),
    phaseOrder: phases.phases.map((p) => p.label),
    objectOf: unitIds.map((u) => `${l(u)}:${graph.nodes[objects.objectOf.get(u)]?.l || ''}`).sort(),
  }
}
// Every kind of relation, opened as a project on the BDA mapping.
{
  const small = loadFile('small.graphml', xml, { packages })
  const sig = signature(small.graph)
  check(sig.relations.join('|') === ['SE 1 above SE 2', 'SE 2 = SE 3', 'SE 3 == SE 4 & <5>', 'SE 4 & <5> above SE 5'].sort().join('|'),
    'opened as a project: above, contemporary and equal as the matrix reads them', sig.relations.join(' | '))
}

if (fs.existsSync(hmeFile)) {
  console.log('\nthe HME\'s test data, out and in again')
  const first = loadFile('test-data.json', fs.readFileSync(hmeFile, 'utf8'), { packages })
  const a = signature(first.graph)
  const lay = layoutByPhase(a.unitIds, a.phases, a.seq.rankEdges, a.seq.sameRankEdges, a.seq.equalsEdges)
  const out = G.writeMatrixGraphML({
    units: a.unitIds.map((id) => ({ id, label: first.graph.nodes[id].l, type: G.unitTypeOf(first.graph, id) })),
    relations: [
      ...a.seq.rankEdges.map((e) => ({ a: e.target, b: e.source, kind: 'higher' })),
      ...a.seq.sameRankEdges.map((e) => ({ a: e.source, b: e.target, kind: 'same-rank' })),
      ...a.seq.equalsEdges.map((e) => ({ a: e.source, b: e.target, kind: 'equals' })),
    ],
    phases: a.phases.phases, phaseOf: a.phases.phaseOf,
    objects: a.objects.objects, objectOf: a.objects.objectOf,
    positions: lay.positions, width: lay.width, height: lay.height,
  })
  const second = loadFile('matrix.graphml', out, { packages })
  const b = signature(second.graph)
  check(second.report.hme?.source === 'GraphML' && a.units.join() === b.units.join(), `opened as a new project: the same ${b.units.length} units`)
  check(a.relations.join() === b.relations.join(), `the same ${b.relations.length} relations`, a.relations.filter((r) => !b.relations.includes(r)).slice(0, 4).join(' | '))
  check(a.phaseOf.join() === b.phaseOf.join() && a.phaseOrder.join() === b.phaseOrder.join(), 'the same phases, in the same order, each unit in its phase')
  check(a.objectOf.join() === b.objectOf.join(), 'each unit in the same object', a.objectOf.filter((r) => !b.objectOf.includes(r)).slice(0, 4).join(' | '))
  const types = (g, s) => s.unitIds.map((id) => `${g.nodes[id].l}:${G.unitTypeOf(g, id)}`).sort().join()
  check(types(first.graph, a) === types(second.graph, b), 'each unit with its unit type')

  // ---- a file the HME writes itself -----------------------------------------------------------
  const hmeGraphml = 'c:/CRM/HarrisMatrixEditor/dev/src/io/graphml.js'
  if (fs.existsSync(hmeGraphml)) {
    console.log('\na GraphML file written by the HME')
    const hme = JSON.parse(fs.readFileSync(hmeFile, 'utf8'))
    const { buildGraphML } = await import(pathToFileURL(hmeGraphml))
    const third = loadFile('hme.graphml', buildGraphML(hme), { packages })
    const c = signature(third.graph)
    const hmeLabel = (id) => hme.nodes.find((n) => n.id === id).label
    check(c.units.join() === hme.nodes.map((n) => n.label).sort().join(), `all ${hme.nodes.length} units`)
    check(c.relations.join() === hme.edges.map((e) => `${hmeLabel(e.source)} above ${hmeLabel(e.target)}`).sort().join(), `all ${hme.edges.length} relations, the upper unit as the source`)
    check(c.phaseOrder.join() === hme.phases.map((p) => p.name).join(), 'the phases, youngest first', c.phaseOrder.join(' | '))
    const inObject = hme.nodes.filter((n) => n.phase && hme.objects.some((o) => o.nodeIds.includes(n.id)) && !n.se?.befunddaten?.Objnr)
    check(inObject.every((n) => c.objectOf.includes(`${n.label}:${hme.objects.find((o) => o.nodeIds.includes(n.id)).name}`)), `${inObject.length} units in their HME object`)
  } else console.log('skip  the HME is not next to this repository')
} else console.log('skip  the HME test data is not next to this repository')

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — GraphML holds')
process.exit(failures ? 1 : 0)
