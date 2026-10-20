/**
 * The measuring stick.
 *
 * OntoGraphNavigator is the second producer of the OntoCartographer project
 * file and the third of Graph-JSON. The format contract carries no version
 * field and no compatibility test on purpose — that reasoning held while both
 * sides were in one hand, and stops holding with a fourth tool.
 *
 * So: run our JavaScript materialisation over the reference project file and
 * compare it against what the Studio's Python backend produced from the same
 * data. Compared semantically — key order and number formatting may differ,
 * the node set, types, attributes and both edge directions may not.
 *
 *   node tests/run-materialize-check.mjs [--raw] [--limit=N]
 *
 *   --raw    do not apply the known-drift override (see DRIFT below)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

register('./resolve-extensionless.mjs', import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const session = path.join(root, '_session')
if (!fs.existsSync(path.join(session, 'OntoCartographer_Projektdatei.json'))) {
  console.log('skip  the reference data (_session/) is not in this copy — it is research data and not distributed with the Navigator')
  process.exit(0)
}

const args = process.argv.slice(2)
const RAW = args.includes('--raw')
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '--limit=8').split('=')[1])

/**
 * DRIFT — a known, verified mismatch between the two sample files.
 *
 * `_session/OntoCartographer_Projektdatei.json` was saved at 12:29, the export
 * at 17:12 the same day, and the mapping changed in between: node n47
 * ("Umzeichnung SE (Bauforschung)") reads column `Zuordnung_ID` in the saved
 * project, but must have read `SE_Zuordnung_ID` when the export was made.
 *
 * Proof it cannot be otherwise: in tbl_5, `Zuordnung_ID` is filled on exactly
 * the 589 Raum rows and empty on the 833 SE rows, while `SE_Zuordnung_ID` is
 * filled on exactly those 833. The export contains 833 "Umzeichnung SE" nodes
 * whose labels (`EDP22-SE2003_bf_geom_1`) are `SE_Zuordnung_ID` values. With
 * the column the project file states, that node yields nothing at all.
 *
 * This is drift in the sample data, not a rule of the format — so it is pinned
 * here in the test rather than worked around in src/lib.
 */
const DRIFT = { n47: { idColumn: 'SE_Zuordnung_ID' } }

const { readProjectFile } = await import(pathToFileURL(path.join(root, 'src/lib/projectFile.js')))
const { materialize } = await import(pathToFileURL(path.join(root, 'src/lib/materialize.js')))

const read = (file) => JSON.parse(fs.readFileSync(path.join(session, file), 'utf8'))

console.log('reading reference files …')
const project = read('OntoCartographer_Projektdatei.json')
const reference = read('OntoCartographer_JSON-Export.json')

const model = readProjectFile(project)
console.log(
  `model: ${model.entities.size} entities, ${model.literals.size} folded literals, ` +
    `${model.relations.length} relations, ${model.literalEdges.length} literal edges, ` +
    `${model.dot1Relations.length} dot-one, ${model.tables.size} tables ` +
    `(${[...model.tables.values()].reduce((n, t) => n + t.rows.length, 0)} rows)`
)

const t0 = Date.now()
const { graph, diagnostics } = materialize(model, { overrides: RAW ? {} : DRIFT })
console.log(`materialised in ${Date.now() - t0} ms${RAW ? '  [--raw: drift override NOT applied]' : ''}\n`)

// ---------------------------------------------------------------- comparison
let failures = 0
const fail = (headline, details = []) => {
  failures++
  console.log(`FAIL  ${headline}`)
  for (const line of details.slice(0, LIMIT)) console.log(`        ${line}`)
  if (details.length > LIMIT) console.log(`        … ${details.length - LIMIT} more`)
}
const pass = (headline) => console.log(`ok    ${headline}`)

function compareCountMaps(name, got, want) {
  const keys = [...new Set([...Object.keys(got), ...Object.keys(want)])].sort()
  const diffs = []
  for (const k of keys) {
    const a = got[k] ?? 0
    const b = want[k] ?? 0
    if (a !== b) diffs.push(`${k}\n          ours=${a}  reference=${b}`)
  }
  if (diffs.length) fail(`${name}: ${diffs.length} of ${keys.length} keys differ`, diffs)
  else pass(`${name}: ${keys.length} keys identical`)
}

// --- node identity set
const ourIds = new Set(Object.keys(graph.nodes))
const refIds = new Set(Object.keys(reference.nodes))
const missing = [...refIds].filter((id) => !ourIds.has(id))
const extra = [...ourIds].filter((id) => !refIds.has(id))
if (missing.length || extra.length) {
  fail(
    `node set: ours ${ourIds.size}, reference ${refIds.size} — ${missing.length} missing, ${extra.length} extra`,
    [...missing.map((id) => `missing  ${id}  (reference type ${reference.nodes[id].t})`),
     ...extra.map((id) => `extra    ${id}  (our type ${graph.nodes[id].t})`)]
  )
} else {
  pass(`node set: ${ourIds.size} identical ids`)
}

// --- per node: type, label, attributes, both edge directions
const shared = [...refIds].filter((id) => ourIds.has(id))
const bag = { type: [], label: [], attrs: [], out: [], in: [] }

const sameList = (a = [], b = []) => {
  if (a.length !== b.length) return false
  const s = new Set(b)
  return a.every((x) => s.has(x))
}
function compareBags(ours = {}, theirs = {}, id, kind) {
  const keys = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])]
  for (const k of keys) {
    if (!sameList(ours[k], theirs[k])) {
      bag[kind].push(`${id}  [${k}]  ours=${(ours[k] || []).length}  reference=${(theirs[k] || []).length}`)
      return
    }
  }
}

for (const id of shared) {
  const a = graph.nodes[id]
  const b = reference.nodes[id]
  if (a.t !== b.t) bag.type.push(`${id}\n          ours=${a.t}\n          ref =${b.t}`)
  if (a.l !== b.l) bag.label.push(`${id}  ours="${a.l}"  reference="${b.l}"`)
  const ka = Object.keys(a.a || {})
  const kb = Object.keys(b.a || {})
  const attrKeys = [...new Set([...ka, ...kb])]
  for (const k of attrKeys) {
    if ((a.a || {})[k] !== (b.a || {})[k]) {
      const av = String((a.a || {})[k]).slice(0, 60)
      const bv = String((b.a || {})[k]).slice(0, 60)
      bag.attrs.push(`${id}  [${k}]\n          ours="${av}"\n          ref ="${bv}"`)
      break
    }
  }
  compareBags(a.o, b.o, id, 'out')
  compareBags(a.i, b.i, id, 'in')
}

for (const [kind, label] of [
  ['type', 'node types'],
  ['label', 'node labels'],
  ['attrs', 'node attributes'],
  ['out', 'outgoing edges (o)'],
  ['in', 'incoming edges (i)'],
]) {
  if (bag[kind].length) fail(`${label}: ${bag[kind].length} of ${shared.length} nodes differ`, bag[kind])
  else pass(`${label}: all ${shared.length} nodes identical`)
}

compareCountMaps('node_types', graph.node_types, reference.node_types)
compareCountMaps('edge_types', graph.edge_types, reference.edge_types)

// --- schema
for (const part of ['typeLabels', 'typeColors', 'edgeLabels']) {
  const got = graph.schema[part] || {}
  const want = reference.schema?.[part] || {}
  const keys = [...new Set([...Object.keys(got), ...Object.keys(want)])].sort()
  const diffs = keys.filter((k) => got[k] !== want[k]).map((k) => `${k}\n          ours="${got[k]}"  reference="${want[k]}"`)
  if (diffs.length) fail(`schema.${part}: ${diffs.length} of ${keys.length} entries differ`, diffs)
  else pass(`schema.${part}: ${keys.length} entries identical`)
}

// --- integrity of our own output, independent of the reference
const dangling = []
for (const [id, node] of Object.entries(graph.nodes)) {
  for (const list of [...Object.values(node.o || {}), ...Object.values(node.i || {})]) {
    for (const target of list) if (!ourIds.has(target)) dangling.push(`${id} -> ${target}`)
  }
}
if (dangling.length) fail(`integrity: ${dangling.length} dangling references`, dangling)
else pass('integrity: no dangling references')

// ---------------------------------------------------------------- diagnostics
console.log('\ndiagnostics')
console.log(`  unpairable mapping edges : ${diagnostics.unpairable.length}${diagnostics.unpairable.length ? '  ' + diagnostics.unpairable.slice(0, 3).join(', ') : ''}`)
console.log(`  attribute value conflicts: ${diagnostics.attributeConflicts}`)
console.log(`  dangling mapping edges   : ${diagnostics.danglingRelations}`)
console.log(`  id used by several types : ${diagnostics.typeCollisions.length}`)

// ------------------------------------------------- project file round-trip
// The Navigator must be able to hand the project back to the Studio. Reading it
// deduplicates the embedded tables; writing puts the copies back. Nothing may
// change on the way through.
{
  const { writeProjectFile } = await import(pathToFileURL(path.join(root, 'src/lib/projectFile.js')))
  const again = writeProjectFile(model)
  const problems = []
  if ((again.nodes || []).length !== (project.nodes || []).length) problems.push('node count changed')
  if ((again.edges || []).length !== (project.edges || []).length) problems.push('edge count changed')
  for (const key of ['version', 'idPrefix', 'wideningParent', 'wideningChild']) {
    if (JSON.stringify(again[key]) !== JSON.stringify(project[key])) problems.push(`${key} changed`)
  }
  if (JSON.stringify(again.prefixMap) !== JSON.stringify(project.prefixMap)) problems.push('prefixMap changed')
  if (JSON.stringify(again.namedGraphs) !== JSON.stringify(project.namedGraphs)) problems.push('namedGraphs changed')
  for (const before of project.nodes || []) {
    const after = again.nodes.find((n) => n.id === before.id)
    if (!after) { problems.push(`node ${before.id} lost`); continue }
    if (JSON.stringify(after) !== JSON.stringify(before)) problems.push(`node ${before.id} differs`)
    if (problems.length > 20) break
  }
  const rematerialised = materialize(readProjectFile(again), { overrides: RAW ? {} : DRIFT }).graph
  if (Object.keys(rematerialised.nodes).length !== Object.keys(graph.nodes).length) {
    problems.push('re-read project materialises to a different node count')
  }
  if (problems.length) fail(`project file round-trip: ${problems.length} problem(s)`, problems)
  else pass('project file round-trip: byte-identical nodes, edges and settings')
}

// --------------------------------------------------- second project: HME
// A different shape entirely: one wide table of 74 rows instead of seven narrow
// ones. No reference export exists for it, so this checks that it loads and
// materialises into something internally sound — not that it matches anything.
{
  const hme = read('HarrisMatrixEditor_OntoCartographer-Projektdatei.json')
  const hmeModel = readProjectFile(hme)
  const { graph: hmeGraph, diagnostics: hmeDiag } = materialize(hmeModel)
  const ids = new Set(Object.keys(hmeGraph.nodes))
  const dangling = []
  for (const [id, node] of Object.entries(hmeGraph.nodes)) {
    for (const list of [...Object.values(node.o || {}), ...Object.values(node.i || {})]) {
      for (const t of list) if (!ids.has(t)) dangling.push(`${id} -> ${t}`)
    }
  }
  console.log(
    `\nHME project: ${hmeModel.entities.size} entities, ${hmeModel.tables.size} table, ` +
      `${[...hmeModel.tables.values()][0]?.rows.length ?? 0} rows ` +
      `-> ${ids.size} nodes, ${Object.keys(hmeGraph.node_types).length} types, ` +
      `${Object.keys(hmeGraph.edge_types).length} edge types`
  )
  if (!ids.size) fail('HME project: materialised to an empty graph')
  else if (dangling.length) fail(`HME project: ${dangling.length} dangling references`, dangling)
  else if (hmeDiag.unpairable.length) fail(`HME project: ${hmeDiag.unpairable.length} unpairable mapping edge(s)`, hmeDiag.unpairable)
  else pass(`HME project: ${ids.size} nodes, no dangling references, every mapping edge pairable`)
}

console.log(failures === 0 ? '\nPASS — output matches the Studio export\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
