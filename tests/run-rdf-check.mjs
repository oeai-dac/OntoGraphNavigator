/**
 * The second measuring stick: RDF.
 *
 * Compares our quads against `_session/OntoCartographer_RDF-Export.trig`, which
 * rdflib produced from the same project. Compared as a *set of quads*, never as
 * text — prefix names, ordering and indentation are rdflib's business.
 *
 * RDF-star needs canonicalising first. N3.js reads `<< s p o >> q v` as the
 * RDF 1.2 form (`_:r rdf:reifies <<(s p o)>> . _:r q v`), so the blank node
 * label differs between any two parses. Both sides are folded back into one
 * comparable tuple before anything is compared.
 *
 *   node tests/run-rdf-check.mjs [--drift] [--limit=N]
 *
 * Note the difference to the Graph-JSON check: that one needs the n47 override
 * to match, this one matches the project file *exactly as saved*. The two
 * reference exports were therefore made from two different states of the
 * mapping — see the note on DRIFT below.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'
import N3 from 'n3'

register('./resolve-extensionless.mjs', import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const session = path.join(root, '_session')
if (!fs.existsSync(path.join(session, 'OntoCartographer_Projektdatei.json'))) {
  console.log('skip  the reference data (_session/) is not in this copy — it is research data and not distributed with the Navigator')
  process.exit(0)
}

const args = process.argv.slice(2)
const APPLY_DRIFT = args.includes('--drift')
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '--limit=10').split('=')[1])

/**
 * DRIFT — off by default here, on by default in the Graph-JSON check.
 *
 * The saved project file reproduces the TriG export byte-for-byte in quads. It
 * reproduces the *Graph-JSON* export only when n47 is switched to
 * `SE_Zuordnung_ID`. So the two reference exports were produced from different
 * states of the mapping, and the saved state is the one behind the TriG.
 *
 * Consequence worth knowing: in the saved mapping, n47 ("Umzeichnung SE") and
 * n38 ("Umzeichnung Raum") read the same column, so the TriG carries no SE
 * drawings at all — the older Graph-JSON export does.
 */
const DRIFT = { n47: { idColumn: 'SE_Zuordnung_ID' } }

const { readProjectFile } = await import(pathToFileURL(path.join(root, 'src/lib/projectFile.js')))
const { toQuads } = await import(pathToFileURL(path.join(root, 'src/lib/rdfExport.js')))
const { materialize } = await import(pathToFileURL(path.join(root, 'src/lib/materialize.js')))

const RDF_REIFIES = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies'

/** One comparable string per quad, with reification folded into the subject. */
function canonicalise(quads) {
  const term = (t) => {
    if (t.termType === 'Literal') {
      const suffix = t.language ? `@${t.language}` : `^^${t.datatype.value}`
      return `"${t.value}"${suffix}`
    }
    if (t.termType === 'Quad') return `<<${term(t.subject)} ${term(t.predicate)} ${term(t.object)}>>`
    return t.value
  }

  // blank node -> the triple it reifies
  const reified = new Map()
  for (const q of quads) {
    if (q.predicate.value === RDF_REIFIES) reified.set(q.subject.value, term(q.object))
  }

  const out = new Set()
  for (const q of quads) {
    if (q.predicate.value === RDF_REIFIES) continue
    const subject = reified.get(q.subject.value) ?? term(q.subject)
    out.add(`${subject} ${q.predicate.value} ${term(q.object)} ${q.graph.value || ''}`)
  }
  return out
}

/** Our plain-object quads, in exactly the same shape. */
function canonicaliseOurs(quads) {
  const object = (o) =>
    o.type === 'literal'
      ? `"${o.value}"${o.language ? `@${o.language}` : `^^${o.datatype}`}`
      : o.value
  const out = new Set()
  for (const q of quads) {
    const subject =
      q.subject.type === 'triple'
        ? `<<${q.subject.subject} ${q.subject.predicate} ${q.subject.object}>>`
        : q.subject
    out.add(`${subject} ${q.predicate} ${object(q.object)} ${q.graph}`)
  }
  return out
}

console.log('reading reference files …')
const project = JSON.parse(fs.readFileSync(path.join(session, 'OntoCartographer_Projektdatei.json'), 'utf8'))
const model = readProjectFile(project)
// The reference TriG was written by a Studio before 3.1, which tagged every
// label @en whatever its language. The project names no languages, so it would
// now be read as the Studio's default (de) — pinned to en here, to compare
// like with like. That labels follow the project's languages is checked
// separately below.
model.languages = { primary: 'en', additional: [] }

const t0 = Date.now()
const { quads, diagnostics } = toQuads(model, { overrides: APPLY_DRIFT ? DRIFT : {} })
console.log(`generated ${quads.length} quads in ${Date.now() - t0} ms${APPLY_DRIFT ? '  [--drift applied]' : ''}`)

const referenceText = fs.readFileSync(path.join(session, 'OntoCartographer_RDF-Export.trig'), 'utf8')
const referenceQuads = new N3.Parser({ format: 'application/trig-star' }).parse(referenceText)
console.log(`reference: ${referenceQuads.length} quads parsed`)

const ours = canonicaliseOurs(quads)
const theirs = canonicalise(referenceQuads)

const missing = [...theirs].filter((q) => !ours.has(q))
const extra = [...ours].filter((q) => !theirs.has(q))

let failures = 0
const short = (q) => q.replace(/https?:\/\/[^\s>"]*[/#]/g, '')

if (missing.length || extra.length) {
  failures++
  console.log(`\nFAIL  quad sets differ — ours ${ours.size}, reference ${theirs.size}`)
  console.log(`        ${missing.length} missing, ${extra.length} extra`)
  const byPredicate = (list) => {
    const m = {}
    for (const q of list) {
      const p = q.split(' ')[q.startsWith('<<') ? 3 : 1] || '?'
      m[p] = (m[p] || 0) + 1
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }
  if (missing.length) {
    console.log('\n      missing, by predicate:')
    for (const [p, n] of byPredicate(missing).slice(0, LIMIT)) console.log(`        ${n}\t${short(p)}`)
    console.log('      examples:')
    for (const q of missing.slice(0, 3)) console.log(`        ${short(q)}`)
  }
  if (extra.length) {
    console.log('\n      extra, by predicate:')
    for (const [p, n] of byPredicate(extra).slice(0, LIMIT)) console.log(`        ${n}\t${short(p)}`)
    console.log('      examples:')
    for (const q of extra.slice(0, 3)) console.log(`        ${short(q)}`)
  }
} else {
  console.log(`\nok    quad sets identical: ${ours.size} quads`)
}

// Named graph distribution is worth seeing even when everything matches.
const perGraph = (set) => {
  const m = {}
  for (const q of set) {
    const g = q.slice(q.lastIndexOf(' ') + 1) || '(default)'
    m[g] = (m[g] || 0) + 1
  }
  return m
}
const og = perGraph(ours)
const tg = perGraph(theirs)
console.log('\nquads per named graph:')
for (const g of new Set([...Object.keys(og), ...Object.keys(tg)])) {
  const mark = (og[g] || 0) === (tg[g] || 0) ? 'ok  ' : 'DIFF'
  console.log(`  ${mark} ours=${String(og[g] || 0).padStart(6)}  reference=${String(tg[g] || 0).padStart(6)}  ${g}`)
}

console.log(`\ndiagnostics: ${diagnostics.skippedRelations} skipped relations, ${diagnostics.skippedLiterals} skipped literal edges`)

// ---- labels carry their language ------------------------------------------------
// The example project (Studio 3.2, en + de): every label in the primary
// language is tagged @en, every German one @de, exactly as the materialised
// graph has them — and the Studio wrote 37 @de labels for this very project.
{
  const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label'
  const example = readProjectFile(JSON.parse(fs.readFileSync(path.join(root, '0_exampleData/OntoCartographer_Projectfile.json'), 'utf8')))
  const { graph } = materialize(example)
  const labels = toQuads(example).quads.filter((q) => q.predicate === RDFS_LABEL)
  const tagged = (lang) => new Set(labels.filter((q) => q.object.language === lang).map((q) => `${q.subject} ${q.object.value}`))
  const de = tagged('de')
  const en = tagged('en')
  const expectDe = new Set(Object.entries(graph.nodes).filter(([, n]) => n.l_i18n?.de).map(([id, n]) => `${id} ${n.l_i18n.de}`))
  const untagged = labels.filter((q) => !q.object.language).length
  const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x))
  if (sameSet(de, expectDe) && de.size === 37 && en.size > 0 && !untagged) {
    console.log(`ok    example project: ${en.size} labels @en, ${de.size} @de — each in the language it is written in`)
  } else {
    failures++
    console.log(`FAIL  example project labels: ${en.size} @en, ${de.size} @de (expected ${expectDe.size}, Studio 37), ${untagged} untagged`)
  }

  // A project from before Studio 3.1 names no languages: the Studio's default.
  const legacy = readProjectFile(project)
  const legacyTags = new Set(toQuads(legacy).quads.filter((q) => q.predicate === RDFS_LABEL).map((q) => q.object.language))
  if (legacyTags.size === 1 && legacyTags.has('de')) console.log('ok    a project naming no languages is labelled in the Studio\'s default, @de')
  else {
    failures++
    console.log(`FAIL  a project naming no languages: tags ${[...legacyTags].join(', ')}`)
  }
}

console.log(failures === 0 ? '\nPASS — RDF matches the Studio export\n' : '\nRDF check failed\n')
process.exit(failures === 0 ? 0 : 1)
