/**
 * The PDF protocols (src/lib/protocolPdf.js):
 *
 *   - every PDF field the four BDA packages name exists in their forms;
 *   - an HME project's units filled in, and compared field by field with the
 *     PDFs the Harris Matrix Editor itself makes of the same data (when its
 *     repository is next to this one): every text the HME writes, written here;
 *   - every kind of field of every protocol filled without a missing PDF field;
 *   - text too long for its box continues on a Beiblatt, over as many pages as
 *     it takes; the stratigraphy grid from the matrix.
 *
 *   node tests/run-protocol-pdf-check.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'
import { PDFDocument } from 'pdf-lib'

register('./resolve-extensionless.mjs', import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const load = (f) => import(pathToFileURL(path.join(root, f)))

const { loadFile } = await load('src/lib/loadFile.js')
const { createJournal } = await load('src/lib/journal.js')
const { createWorkspace, rematerialize } = await load('src/lib/edits.js')
const P = await load('src/lib/protocols.js')
const { fillProtocolPdf, checkPdfFields, combinedProtocols, zippedProtocols } = await load('src/lib/protocolPdf.js')
const { unitForPdf } = await load('src/lib/protocolExport.js')
const { bdaPackages, havePackages, SKIP_PACKAGES } = await import(pathToFileURL(path.join(here, 'protocol-packages.mjs')))
if (!havePackages) { console.log(SKIP_PACKAGES); process.exit(0) }

let failures = 0
const check = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${!cond && detail ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

const packages = await bdaPackages()
const byKey = Object.fromEntries(packages.map((p) => [p.protocol.key, p]))
for (const pkg of packages) {
  const problems = await checkPdfFields(pkg, pkg.template)
  check(!problems.length, `${pkg.id}: every PDF field it names is in its form`, problems.map((p) => p.message).join(' | '))
}

const texts = async (bytes) => {
  const form = (await PDFDocument.load(bytes)).getForm()
  const out = {}
  for (const f of form.getFields()) {
    try { const v = form.getTextField(f.getName()).getText(); if (v) out[f.getName()] = v } catch { /* not a text field */ }
  }
  return out
}

// ---- an HME project, against the HME's own PDFs ---------------------------------------
const hmeFile = 'c:/CRM/HarrisMatrixEditor/data/test-data.json'
if (fs.existsSync(hmeFile)) {
  console.log('\nHME project')
  const text = fs.readFileSync(hmeFile, 'utf8')
  const hme = JSON.parse(text)
  const loaded = loadFile('test-data.json', text, { packages })
  const ws = createWorkspace({ model: loaded.model, journal: createJournal({}), materializer: loaded.materializer })
  rematerialize(ws)
  const matches = packages.map((p) => P.matchPackage(ws.model, p, loaded.report.hme.protocolBindings?.[p.id])).filter((m) => !m.error)
  const units = P.protocolUnits(ws.model, matches[0])
  const theirs = 'c:/CRM/HarrisMatrixEditor/dev/src/io/pdfExport.js'
  const hmePdf = fs.existsSync(theirs) ? await import(pathToFileURL(theirs)) : null
  let same = 0
  const diffs = []
  let missingAll = 0
  for (const node of hme.nodes) {
    const u = units.find((x) => x.label === node.label)
    const unit = unitForPdf(ws, ws.graph, matches, u.id)
    const ours = await fillProtocolPdf(unit.match.pkg, unit.match.pkg.template, unit, { flatten: false })
    missingAll += ours.missing.length
    if (!hmePdf) continue
    const ref = await hmePdf.fillProtocolPdf(node, { projectMeta: hme.projectMeta, nodes: hme.nodes, edges: hme.edges, phases: hme.phases, objects: hme.objects }, { flatten: false })
    const a = await texts(ref.bytes)
    const b = await texts(ours.bytes)
    // Decided in step 4d: an HME object becomes the BDA object of its units —
    // its name is their object number here, where the HME writes no number.
    const inHmeObject = !node.se?.befunddaten?.Objnr && hme.objects.some((o) => o.nodeIds.includes(node.id))
    // The HME's own description joins the protocol's where both were taken (hmeImport.js) — more here, never less.
    const joined = (k) => /Beschreibung/.test(k) && !!a[k] && String(b[k] || '').startsWith(a[k])
    const differ = Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k] && !(inHmeObject && k === 'Objektnummer' && !a[k]) && !joined(k))
    if (!differ.length) same++
    else diffs.push(`${node.label}: ${differ.slice(0, 3).map((k) => `${k}: HME ${JSON.stringify(a[k])} / here ${JSON.stringify(b[k])}`).join('; ')}`)
  }
  check(missingAll === 0, `${hme.nodes.length} units filled, no PDF field missing`)
  if (hmePdf) check(same === hme.nodes.length, `${same} of ${hme.nodes.length} filled exactly as the HME fills them, text field by text field (an HME object's name as the object number, as decided)`, diffs.slice(0, 4).join(' || '))
  else console.log('skip  the HME is not next to this repository — not compared')

  // The grid: the unit in the middle, its neighbours above and below.
  const withBoth = units.map((u) => unitForPdf(ws, ws.graph, matches, u.id)).find((x) => x.above.length && x.below.length)
  const grid = await texts((await fillProtocolPdf(withBoth.match.pkg, withBoth.match.pkg.template, withBoth, { flatten: false })).bytes)
  const cells = Object.entries(grid).filter(([k]) => k.startsWith(withBoth.match.pkg.pdfFields.gridPrefix)).map(([, v]) => v)
  check(cells.includes(withBoth.label.replace(/^SU\s*/i, '')) && withBoth.above.every((l) => cells.includes(l.replace(/^SU\s*/i, ''))),
    `the grid of ${withBoth.label}: it in the middle, ${withBoth.above.length} above, ${withBoth.below.length} below`, JSON.stringify(cells))

  // Several at once.
  const items = units.slice(0, 5).map((u) => { const unit = unitForPdf(ws, ws.graph, matches, u.id); return { pkg: unit.match.pkg, template: unit.match.pkg.template, unit } })
  const all = await combinedProtocols(items)
  const zip = await zippedProtocols(items)
  check((await PDFDocument.load(all.bytes)).getPageCount() >= 5 && zip.bytes.length > 1000, `five units as one PDF (${(await PDFDocument.load(all.bytes)).getPageCount()} pages) and as a zip`)
}

// ---- every field of every protocol; a Beiblatt --------------------------------------------
console.log('\nevery protocol')
const longText = Array.from({ length: 700 }, (_, i) => `Wort${i} Schicht mit Holzkohle, Ziegelbruch und Mörtel;`).join(' ')
for (const pkg of packages) {
  const v = P.emptyProtocol(pkg)
  let i = 0
  for (const f of pkg.fields) {
    const kind = P.fieldKind(f.def)
    if (!v[f.section] || !(f.key in v[f.section])) continue
    i++
    if (kind === 'boolean') v[f.section][f.key] = true
    else if (kind === 'multi') v[f.section][f.key] = [...f.def.optionen]
    else if (kind === 'single') v[f.section][f.key] = f.def.optionen[f.def.optionen.length - 1]
    else if (kind === 'qualified') v[f.section][f.key] = { wert: `${i} cm`, erhalten: true, original: true, sichtbar: true }
    else if (kind === 'object') { for (const parts of Object.values(v[f.section][f.key])) for (const k of Object.keys(parts)) parts[k] = typeof parts[k] === 'boolean' ? true : 'x' }
    else v[f.section][f.key] = `${f.key} ${i} – „Grün“ äöüß`
  }
  const firstLong = pkg.pdfFields.descFallback
  if (firstLong) { const [s, k] = firstLong.split('.'); if (v[s]) v[s][k] = longText }
  const base = (await PDFDocument.load(pkg.template)).getPageCount()
  const filled = await fillProtocolPdf(pkg, pkg.template, { label: 'SU 4711', values: v, above: ['SU 1', 'SU 2'], below: ['SU 3'] })
  const unmapped = new Set(pkg.pdfFields.unmapped || [])
  const missing = filled.missing.filter((m) => !unmapped.has(m))
  check(!missing.length && filled.pages >= base + 2, `${pkg.id}: every field filled (${i}), no PDF field missing; the long description continues on ${filled.pages - base} Beiblatt page(s)`, `${missing.slice(0, 5).join(', ')} pages ${filled.pages} vs ${base}`)
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — PDF protocols hold')
process.exit(failures ? 1 : 0)
