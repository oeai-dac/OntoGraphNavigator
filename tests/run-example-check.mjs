/**
 * The publishable example, the whole way round.
 *
 * 0_exampleData/GraphExplorer_Example.json is the GraphExplorer's example graph.
 * The Studio imported it — confirming AP11.1_has_type as the Dot-One property —
 * and saved the project file beside it (OntoCartographer_Projectfile.json).
 * Materialising that project must give the graph back exactly: every node id,
 * type key ("#as:" included), label, attribute value, outgoing edge
 * ("#as:" and "#dot1:" included), reverse edge, and the names of the types.
 *
 * Exactly, apart from what is known and named here rather than tolerated
 * silently:
 *
 *   - Nodes without any relation do not exist in the Studio's model: emission
 *     is edge-driven. Two unused vocabulary entries drop out.
 *   - A reverse side shown under an Explorer name of its own
 *     ("P46i_forms_part_of#as:was_found_in") cannot be rebuilt: the Studio
 *     names a reverse side after a property, so its import keeps the name as
 *     the connection's inverse and the key becomes "was found in".
 *   - The reverse reading of a stratigraphic relation sits in "o" here; the
 *     example's generator also lists it under "i". Only "o" is compared.
 *   - Type names in other languages are compared for display-named types only:
 *     for plain classes the Studio takes them from the ontology's
 *     rdfs:label@lang, and this tool loads no ontology.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

register('./resolve-extensionless.mjs', import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const data = path.join(root, '0_exampleData')

const { loadFile } = await import(pathToFileURL(path.join(root, 'src/lib/loadFile.js')))

let failures = 0
const fail = (headline, details = []) => {
  failures++
  console.log(`FAIL  ${headline}`)
  for (const line of details.slice(0, 8)) console.log(`        ${line}`)
  if (details.length > 8) console.log(`        … ${details.length - 8} more`)
}
const pass = (headline) => console.log(`ok    ${headline}`)

const text = fs.readFileSync(path.join(data, 'OntoCartographer_Projectfile.json'), 'utf8')
const original = JSON.parse(fs.readFileSync(path.join(data, 'GraphExplorer_Example.json'), 'utf8'))
const loaded = loadFile('OntoCartographer_Projectfile.json', text)
const ours = loaded.graph.nodes
const theirs = original.nodes

// The one reverse key the Studio cannot rebuild, and what it becomes.
const RENAMED_REVERSE = {
  'http://www.cidoc-crm.org/cidoc-crm/P46i_forms_part_of#as:was_found_in': 'was found in',
}

if (loaded.source === 'project' && !loaded.warnings.length) {
  pass(`loads as a project file: ${loaded.model.tables.size} tables, ${loaded.model.entities.size} entities, ` +
    `${loaded.model.dot1Relations.length} dot-one relation(s), no warnings`)
} else {
  fail('the example project did not load cleanly', loaded.warnings)
}

// ---- node set ----------------------------------------------------------------
const linked = (n) => Object.keys(n.o).length || Object.keys(n.i).length
const expected = Object.keys(theirs).filter((id) => linked(theirs[id]))
const unlinked = Object.keys(theirs).filter((id) => !linked(theirs[id]))
const missing = expected.filter((id) => !ours[id])
const extra = Object.keys(ours).filter((id) => !theirs[id])
if (!missing.length && !extra.length) {
  pass(`node set: all ${expected.length} linked nodes back; ${unlinked.length} without relations drop out as the Studio rule says (${unlinked.map((id) => theirs[id].l).join(', ')})`)
} else {
  fail('node set differs', [...missing.map((id) => `missing ${id}`), ...extra.map((id) => `extra ${id}`)])
}

// ---- per node ------------------------------------------------------------------
/** Edge lists as comparable text: keys renamed where known, targets sorted. */
const bag = (b, rename = {}) => {
  const out = {}
  for (const [key, list] of Object.entries(b)) out[rename[key] || key] = [...list].sort()
  return JSON.stringify(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}
const reverseOnly = (i) => Object.fromEntries(Object.entries(i).filter(([k]) => !k.includes('#dot1:')))
const problems = { type: [], label: [], attr: [], out: [], in: [] }
for (const id of expected) {
  const a = ours[id]
  const b = theirs[id]
  if (!a) continue
  if (a.t !== b.t) problems.type.push(`${id}: ${a.t} vs ${b.t}`)
  if (a.l !== b.l) problems.label.push(`${id}: ${a.l} vs ${b.l}`)
  const attrs = new Set([...Object.keys(a.a), ...Object.keys(b.a)])
  for (const k of attrs) if (a.a[k] !== (b.a[k] === undefined ? undefined : String(b.a[k]))) problems.attr.push(`${id} ${k}`)
  if (bag(a.o) !== bag(b.o)) problems.out.push(id)
  if (bag(a.i) !== bag(reverseOnly(b.i), RENAMED_REVERSE)) problems.in.push(id)
}
const report = (key, what) => {
  if (problems[key].length) fail(`${what}: ${problems[key].length} node(s) differ`, problems[key])
  else pass(`${what}: identical on all ${expected.length} nodes`)
}
report('type', 'type keys, "#as:" included')
report('label', 'labels')
report('attr', 'attributes, every value')
report('out', 'outgoing edges, "#as:" and "#dot1:" keys included')
report('in', `reverse edges (${Object.values(RENAMED_REVERSE).map((n) => `"${n}"`).join(', ')} as the Studio names it)`)

const dot1Lists = expected.reduce((n, id) => n + Object.keys(theirs[id].o).filter((k) => k.includes('#dot1:')).length, 0)
if (dot1Lists && !problems.out.length) pass(`the Harris matrix comes back: ${dot1Lists} stratigraphic edge lists`)

// ---- names of the types --------------------------------------------------------
const named = Object.entries(original.schema.typeLabels).filter(([k]) => k.includes('#as:'))
const wrongNames = named.filter(([k, v]) => loaded.graph.schema.typeLabels[k] !== v)
if (wrongNames.length) fail('type names differ', wrongNames.map(([k, v]) => `${k}: ${loaded.graph.schema.typeLabels[k]} vs ${v}`))
else pass(`type names: all ${named.length} display-named types carry their name`)

// ---- languages ----------------------------------------------------------------
const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null)
if (same(loaded.graph.languages, original.languages)) pass(`languages: ${JSON.stringify(original.languages)}`)
else fail('languages differ', [`${JSON.stringify(loaded.graph.languages)} vs ${JSON.stringify(original.languages)}`])

const i18nWrong = expected.filter((id) => ours[id] && !same(ours[id].l_i18n, theirs[id].l_i18n))
const i18nCount = expected.filter((id) => theirs[id].l_i18n).length
if (i18nWrong.length) fail(`labels in other languages: ${i18nWrong.length} node(s) differ`,
  i18nWrong.map((id) => `${id}: ${JSON.stringify(ours[id].l_i18n)} vs ${JSON.stringify(theirs[id].l_i18n)}`))
else pass(`labels in other languages: identical on all ${expected.length} nodes (${i18nCount} carry one)`)

// Type names in other languages: those of display-named types, which the
// project carries as Explorer names. For plain classes the Studio takes them
// from the ontology's rdfs:label@lang, which this tool does not load.
const namedI18n = []
for (const [lang, labels] of Object.entries(original.schema.typeLabelsI18n || {})) {
  for (const [key, text] of Object.entries(labels)) if (key.includes('#as:')) namedI18n.push([lang, key, text])
}
const namedI18nWrong = namedI18n.filter(([lang, key, text]) => loaded.graph.schema.typeLabelsI18n?.[lang]?.[key] !== text)
if (namedI18nWrong.length) fail('type names in other languages differ', namedI18nWrong.map(([l, k, t]) => `${l} ${k}: ${loaded.graph.schema.typeLabelsI18n?.[l]?.[k]} vs ${t}`))
else pass(`type names in other languages: all ${namedI18n.length} of the display-named types`)

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — the example comes back from the project file')
process.exit(failures ? 1 : 0)
