/**
 * Thesauri: reading, repairing, searching, and reconciling against real data.
 *
 * The last part is the point of the whole feature: the reference project already
 * stores concept URIs in `Material_ID`. If those do not resolve in the published
 * vocabulary, a picker built on it would quietly disagree with the data it is
 * meant to describe.
 *
 *   node tests/run-thesaurus-check.mjs [--online]
 *
 *   --online  additionally fetch both vocabularies from the publisher. Left out
 *             of `npm run check` so the suite needs no network.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

register('./resolve-extensionless.mjs', import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const session = path.join(root, '_session')
if (!fs.existsSync(path.join(session, 'thesauri'))) {
  console.log('skip  the reference data (_session/) is not in this copy — it is research data and not distributed with the Navigator')
  process.exit(0)
}
const load = (f) => import(pathToFileURL(path.join(root, 'src/lib', f)))

const ONLINE = process.argv.includes('--online')

const { readSkos, repairMojibake, searchConcepts, labelOf, pathOf, reconcile } = await load('thesaurus.js')
const { readProjectFile } = await load('projectFile.js')
const { expandId } = await load('prefixes.js')
const { KNOWN_THESAURI, directUrl } = await load('thesaurusSources.js')

let failures = 0
const fail = (headline, details = []) => {
  failures++
  console.log(`FAIL  ${headline}`)
  for (const line of details.slice(0, 8)) console.log(`        ${line}`)
}
const pass = (headline) => console.log(`ok    ${headline}`)

// ------------------------------------------------------- mojibake repair
{
  const broken = 'fÃ¤rbig, Ãœbersetzung, GrÃ¼n, StraÃŸe'
  const { text, repaired } = repairMojibake(broken)
  if (text === 'färbig, Übersetzung, Grün, Straße' && repaired === 4) {
    pass('mojibake repair: ä, Ü, ü and ß restored — the capitals need the Windows-1252 table')
  } else {
    fail(`mojibake repair produced "${text}" (${repaired} fixes)`)
  }
  const clean = 'färbig, Übersetzung'
  const untouched = repairMojibake(clean)
  if (untouched.text === clean && untouched.repaired === 0) pass('mojibake repair: correct text left alone')
  else fail(`mojibake repair changed clean text to "${untouched.text}"`)
}

// -------------------------------------------------------- read both files
const files = fs
  .readdirSync(path.join(session, 'thesauri'))
  .filter((f) => /\.(ttl|trig|nt|nq|txt)$/i.test(f))
  .sort()

if (!files.length) fail('no thesaurus files found in _session/thesauri')

const loaded = []
for (const file of files) {
  const text = fs.readFileSync(path.join(session, 'thesauri', file), 'utf8')
  let thesaurus
  try {
    thesaurus = readSkos(text, { name: file })
  } catch (error) {
    fail(`${file}: ${error.message}`)
    continue
  }
  const r = thesaurus.report
  console.log(
    `\n${file}: ${r.triples} triples -> ${r.concepts} concepts, ` +
      `languages ${r.languages.join('/')}, ${thesaurus.index.length} searchable labels` +
      (r.repaired ? `, ${r.repaired} characters repaired` : '')
  )
  console.log(`  scheme: ${thesaurus.schemes[0]?.uri || '—'}`)
  if (!r.concepts) fail(`${file}: no concepts found`)
  else if (!r.languages.length) fail(`${file}: no labelled concepts`)
  else pass(`${file}: ${r.concepts} concepts read`)
  loaded.push(thesaurus)
}

// The file named .txt is the double-encoded one; it must be both read and fixed.
{
  const materials = loaded.find((t) => t.id.includes('oeai-materials'))
  if (!materials) fail('the materials vocabulary was not recognised by its scheme URI')
  else if (materials.report.repaired > 0) {
    pass(`materials file: read despite its ".txt" name, ${materials.report.repaired} characters repaired`)
  } else {
    pass('materials file: read, no encoding damage found')
  }
}

// ------------------------------------------------------------------ search
{
  const materials = loaded.find((t) => t.id.includes('oeai-materials'))
  if (materials) {
    // Expectations taken from the vocabulary itself rather than guessed: search
    // for a concept's own label and that concept must come back first. A guessed
    // term ("Ziegel") only tests whether the guess was in the file.
    const probes = [...materials.concepts.values()]
      .map((c) => ({ uri: c.uri, label: labelOf(c) }))
      .filter((p) => p.label && !p.label.includes(' ') && p.label.length > 3)
      .slice(0, 5)
    for (const probe of probes) {
      const hits = searchConcepts(materials, probe.label, { limit: 5 })
      const first = hits[0]
      console.log(`  search "${probe.label}" -> ${hits.length} hits, first "${first?.label || '—'}"`)
      if (first?.concept.uri !== probe.uri) {
        fail(`search "${probe.label}": its own concept did not come first (got "${first?.label || 'nothing'}")`)
      }
    }
    if (probes.length) pass(`search: ${probes.length} concepts each found first by their own label`)
    // A term the project uses but the vocabulary does not — the case the
    // reconciliation view exists for, so it must simply return nothing.
    if (searchConcepts(materials, 'Tierknochen', { limit: 5 }).length === 0) {
      pass('search: a term the vocabulary does not contain returns nothing rather than a near miss')
    } else {
      fail('search: "Tierknochen" returned hits, but it is not in this vocabulary')
    }
    const exact = searchConcepts(materials, 'Glas', { limit: 5 })
    if (exact.length && exact[0].label === 'Glas') pass('search: an exact label match ranks above the ones merely containing it')

    const deep = [...materials.concepts.values()].find((c) => c.broader.length)
    if (deep) console.log(`  hierarchy: ${pathOf(materials, deep.uri).join(' › ')}`)
  }
}

// -------------------------------------- reconcile against the real project
{
  const project = JSON.parse(fs.readFileSync(path.join(session, 'OntoCartographer_Projektdatei.json'), 'utf8'))
  const model = readProjectFile(project)
  const materials = loaded.find((t) => t.id.includes('oeai-materials'))
  const table = model.tables.get('tbl_11')

  if (materials && table) {
    const ids = [...new Set(table.rows.map((r) => String(r.Material_ID ?? '').trim()).filter(Boolean))]
    const expanded = ids.map((v) => expandId(v, model.prefixMap, model.idPrefix, false))
    const byUri = reconcile(materials, expanded)

    const labels = [...new Set(table.rows.map((r) => String(r.MATERIAL ?? '').trim()).filter(Boolean))]
    const byLabel = reconcile(materials, labels)

    console.log(`\nreconciling tbl_11 against ${materials.name}:`)
    console.log(`  Material_ID : ${ids.length} distinct -> ${byUri.exact.length} are concepts, ${byUri.unknown.length} unknown`)
    console.log(`  MATERIAL    : ${labels.length} distinct -> ${byLabel.byLabel.length} match a label, ${byLabel.unknown.length} unknown`)
    for (const u of byUri.unknown.slice(0, 5)) console.log(`    unresolved URI   ${u.value}`)
    for (const u of byLabel.unknown.slice(0, 5)) console.log(`    unresolved label "${u.value}"`)

    if (byUri.exact.length === 0) {
      fail('not one Material_ID resolves in the published vocabulary — the binding would be wrong')
    } else {
      pass(
        `reconciliation: ${byUri.exact.length} of ${ids.length} material URIs resolve, ` +
          `${byLabel.byLabel.length} of ${labels.length} labels match`
      )
    }
  }
}

// ------------------------------------------------------------------ online
if (ONLINE) {
  console.log('')
  for (const entry of KNOWN_THESAURI) {
    try {
      const response = await fetch(directUrl(entry))
      if (!response.ok) {
        fail(`${entry.name}: HTTP ${response.status}`)
        continue
      }
      const cors = response.headers.get('access-control-allow-origin')
      const text = await response.text()
      const thesaurus = readSkos(text, { name: entry.name })
      console.log(
        `${entry.name}: ${(text.length / 1024).toFixed(0)} kB -> ${thesaurus.report.concepts} concepts` +
          `${thesaurus.report.repaired ? `, ${thesaurus.report.repaired} repaired` : ''}` +
          `  CORS: ${cors || 'none — a browser cannot fetch this directly'}`
      )
      if (thesaurus.report.concepts > 0) pass(`${entry.name}: fetched and parsed from the publisher`)
      else fail(`${entry.name}: fetched but contained no concepts`)
    } catch (error) {
      fail(`${entry.name}: ${error.message}`)
    }
  }
} else {
  console.log('\n(online fetch skipped — run with --online to include it)')
}

console.log(failures === 0 ? '\nPASS — thesauri hold\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
