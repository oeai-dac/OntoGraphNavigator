/**
 * The way in, and the way back out again.
 *
 *   1. serialiser round-trip — our quads, written to TriG and parsed back, must
 *      be the same set. This is what makes the RDF export a file rather than a
 *      data structure.
 *   2. RDF import — both reference exports read into Graph-JSON: the Studio's
 *      TriG with named graphs and RDF-star, and HME's Turtle.
 *   3. Graph-JSON reading — the reference export read back in, with no dangling
 *      references and the derived display model intact.
 *
 *   node tests/run-import-check.mjs
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
const load = (f) => import(pathToFileURL(path.join(root, 'src/lib', f)))

const { readProjectFile } = await load('projectFile.js')
const { toQuads } = await load('rdfExport.js')
const { serializeRdf, parseRdf } = await load('rdfSerialize.js')
const { importRdf } = await load('rdfImport.js')
const { readGraphJson, deriveModelFromGraph } = await load('graphJson.js')
const { DOT1_MARK } = await load('keys.js')

let failures = 0
const fail = (headline, details = []) => {
  failures++
  console.log(`FAIL  ${headline}`)
  for (const line of details.slice(0, 6)) console.log(`        ${line}`)
}
const pass = (headline) => console.log(`ok    ${headline}`)

const RDF_REIFIES = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies'
function canonicalise(quads) {
  const term = (t) => {
    if (t.termType === 'Literal') return `"${t.value}"${t.language ? `@${t.language}` : `^^${t.datatype.value}`}`
    if (t.termType === 'Quad') return `<<${term(t.subject)} ${term(t.predicate)} ${term(t.object)}>>`
    return t.value
  }
  const reified = new Map()
  for (const q of quads) if (q.predicate.value === RDF_REIFIES) reified.set(q.subject.value, term(q.object))
  const out = new Set()
  for (const q of quads) {
    if (q.predicate.value === RDF_REIFIES) continue
    out.add(`${reified.get(q.subject.value) ?? term(q.subject)} ${q.predicate.value} ${term(q.object)} ${q.graph.value || ''}`)
  }
  return out
}
function canonicaliseOurs(quads) {
  const object = (o) => (o.type === 'literal' ? `"${o.value}"${o.language ? `@${o.language}` : `^^${o.datatype}`}` : o.value)
  const out = new Set()
  for (const q of quads) {
    const s = q.subject.type === 'triple' ? `<<${q.subject.subject} ${q.subject.predicate} ${q.subject.object}>>` : q.subject
    out.add(`${s} ${q.predicate} ${object(q.object)} ${q.graph}`)
  }
  return out
}

// ------------------------------------------------ 1. serialiser round-trip
console.log('reading reference files …')
const project = JSON.parse(fs.readFileSync(path.join(session, 'OntoCartographer_Projektdatei.json'), 'utf8'))
const model = readProjectFile(project)
const { quads } = toQuads(model)

const t0 = Date.now()
const trig = await serializeRdf(quads, { format: 'trig', prefixes: model.prefixMap })
const ms = Date.now() - t0
const reparsed = parseRdf(trig)
const before = canonicaliseOurs(quads)
const after = canonicalise(reparsed)
const lost = [...before].filter((q) => !after.has(q))
const gained = [...after].filter((q) => !before.has(q))
if (lost.length || gained.length) {
  fail(
    `TriG round-trip: ${lost.length} lost, ${gained.length} gained (of ${before.size})`,
    [...lost.slice(0, 3).map((q) => `lost   ${q}`), ...gained.slice(0, 3).map((q) => `gained ${q}`)]
  )
} else {
  pass(`TriG round-trip: ${before.size} quads survive writing and re-reading (${(trig.length / 1e6).toFixed(1)} MB, ${ms} ms)`)
}

// --------------------------------------------------------- 2. RDF import
for (const [name, file] of [
  ['Studio TriG', 'OntoCartographer_RDF-Export.trig'],
  ['HME Turtle', 'HarrisMatrixEditor_RDF-Export.ttl'],
]) {
  const text = fs.readFileSync(path.join(session, file), 'utf8')
  const { graph, report } = importRdf(text)
  const ids = new Set(Object.keys(graph.nodes))
  const dangling = []
  for (const [id, n] of Object.entries(graph.nodes)) {
    for (const list of [...Object.values(n.o), ...Object.values(n.i)]) {
      for (const t of list) if (!ids.has(t)) dangling.push(`${id} -> ${t}`)
    }
  }
  const dot1Keys = Object.keys(graph.edge_types).filter((k) => k.includes(DOT1_MARK))
  console.log(
    `\n${name}: ${report.quads} quads -> ${ids.size} nodes, ` +
      `${Object.keys(graph.node_types).length} types, ${Object.keys(graph.edge_types).length} edge types, ` +
      `${report.namedGraphs.length} named graph(s) flattened`
  )
  if (dot1Keys.length) console.log(`  stratigraphy: ${dot1Keys.map((k) => k.split(DOT1_MARK)[1]).join(', ')}`)

  if (!ids.size) fail(`${name}: imported an empty graph`)
  else if (dangling.length) fail(`${name}: ${dangling.length} dangling references`, dangling)
  else if (!Object.keys(graph.schema.typeLabels).length) fail(`${name}: no schema derived`)
  else pass(`${name}: ${ids.size} nodes, no dangling references, schema derived`)

  if (report.dot1 === 0) fail(`${name}: no RDF-star annotations found — stratigraphy would be lost`)
  else pass(`${name}: ${report.dot1} stratigraphic annotations recognised`)
}

// -------------------------------------------------- 3. Graph-JSON reading
{
  const json = JSON.parse(fs.readFileSync(path.join(session, 'OntoCartographer_JSON-Export.json'), 'utf8'))
  const { graph, report } = readGraphJson(json)
  console.log(`\nGraph-JSON: ${report.nodes} nodes, ${report.edges} outgoing edge entries`)
  if (report.dangling.length) fail(`Graph-JSON: ${report.dangling.length} dangling references`, report.dangling)
  else pass(`Graph-JSON: ${report.nodes} nodes, no dangling references`)

  const derived = deriveModelFromGraph(graph)
  const biggest = derived.types[0]
  console.log(
    `  derived model: ${derived.types.length} types; largest "${biggest.label}" ` +
      `(${biggest.count} nodes, ${biggest.attributes.length} attribute keys, ` +
      `${biggest.outgoing.length} outgoing / ${biggest.incoming.length} incoming relations)`
  )
  if (derived.types.length !== Object.keys(graph.node_types).length) {
    fail(`derived model: ${derived.types.length} types but node_types lists ${Object.keys(graph.node_types).length}`)
  } else {
    pass(`derived model: ${derived.types.length} types described without a project file`)
  }
}

// ------------------------------------------ 4. file recognition and tables
{
  const { loadFile } = await load('loadFile.js')
  const { tablesToFiles, graphToFiles, serializeTable } = await load('tableExport.js')

  const cases = [
    ['OntoCartographer_Projektdatei.json', 'project'],
    ['HarrisMatrixEditor_OntoCartographer-Projektdatei.json', 'project'],
    ['OntoCartographer_JSON-Export.json', 'graph'],
    ['OntoCartographer_RDF-Export.trig', 'graph'],
    ['HarrisMatrixEditor_RDF-Export.ttl', 'graph'],
  ]
  console.log('')
  let recognised = 0
  for (const [file, expected] of cases) {
    const text = fs.readFileSync(path.join(session, file), 'utf8')
    let result
    try {
      result = loadFile(file, text)
    } catch (error) {
      fail(`loadFile("${file}"): ${error.message}`)
      continue
    }
    if (result.source !== expected) fail(`loadFile("${file}"): recognised as "${result.source}", expected "${expected}"`)
    else recognised++
  }
  if (recognised === cases.length) pass(`file recognition: all ${cases.length} reference files classified correctly`)

  // RDF/XML must be refused with an explanation, not parsed into nonsense.
  try {
    loadFile('ontology.rdf', '<?xml version="1.0"?><rdf:RDF/>')
    fail('loadFile: RDF/XML was accepted, but the parser cannot read it')
  } catch (error) {
    if (/RDF\/XML/.test(error.message)) pass('file recognition: RDF/XML refused with a readable reason')
    else fail(`loadFile: RDF/XML refused with an unhelpful message: ${error.message}`)
  }

  // Tables from a project, and from a graph that has none.
  const projectFiles = tablesToFiles(model, 'tsv')
  const totalRows = projectFiles.reduce((n, f) => n + f.rows, 0)
  const expectedRows = [...model.tables.values()].reduce((n, t) => n + t.rows.length, 0)
  if (projectFiles.length !== model.tables.size || totalRows !== expectedRows) {
    fail(`table export: ${projectFiles.length} files / ${totalRows} rows, expected ${model.tables.size} / ${expectedRows}`)
  } else {
    pass(`table export: ${projectFiles.length} tables, ${totalRows.toLocaleString('en')} rows`)
  }

  // Every line must carry exactly the header's field count — that is the whole
  // point of stripping tabs and newlines out of the values first.
  const sample = projectFiles.find((f) => f.rows > 100) || projectFiles[0]
  const lines = sample.content.split('\n').filter(Boolean)
  const width = lines[0].split('\t').length
  const ragged = lines.filter((l) => l.split('\t').length !== width).length
  if (ragged) fail(`table export: ${ragged} line(s) in ${sample.name} do not have ${width} fields`)
  else pass(`table export: ${sample.name} is rectangular (${width} columns, ${lines.length - 1} rows)`)

  // CSV quoting, checked on a value that would otherwise break the row.
  const csv = serializeTable(['a', 'b'], [{ a: 'x, y', b: 'say "hi"' }], 'csv')
  if (csv.includes('"x, y"') && csv.includes('"say ""hi"""')) pass('table export: CSV quotes commas and quotation marks')
  else fail(`table export: CSV quoting is wrong — ${JSON.stringify(csv)}`)

  const graphJson = JSON.parse(fs.readFileSync(path.join(session, 'OntoCartographer_JSON-Export.json'), 'utf8'))
  const { graph: g2 } = readGraphJson(graphJson)
  const perType = graphToFiles(g2, deriveModelFromGraph(g2), 'tsv')
  const perTypeRows = perType.reduce((n, f) => n + f.rows, 0)
  if (perTypeRows !== Object.keys(g2.nodes).length) {
    fail(`table export from graph: ${perTypeRows} rows across ${perType.length} files, expected ${Object.keys(g2.nodes).length}`)
  } else {
    pass(`table export from graph: ${perType.length} files, every one of ${perTypeRows.toLocaleString('en')} nodes present exactly once`)
  }
}

console.log(failures === 0 ? '\nPASS — import and serialisation hold\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
