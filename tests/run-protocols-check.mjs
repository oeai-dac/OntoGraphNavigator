/**
 * Protocol packages and their binding to a project (src/lib/protocols.js,
 * src/lib/protocolBinding.js, protocols/*.zip):
 *
 *   - the four BDA packages read without errors, the zips as their sources are;
 *   - bound to the matrix template as proposed, every field of the standard
 *     protocol is put into the mapping as the package models it (its path,
 *     the BDA mapping); the other protocols' fields the package has no path
 *     for become fields of the mapping — text
 *     as a literal via P3 has note, a single choice as an E55 Type via P2 has
 *     type, a qualified or object field part by part — and in the graph;
 *     a field left out is out of the protocol;
 *   - a protocol written and read back the same, for every protocol and every
 *     kind of field; one undo takes it back; the graph carries the mapped
 *     values (SE_Bez, Datierung through the genesis, the date through the
 *     observation), identifiers by the HME's rules;
 *   - an HME project without a package: the matrix only, bound afterwards the
 *     structure is there, the values stay in the HME file; with the packages
 *     added, its protocols read back as the HME file has them, a unit on
 *     another protocol bound as it comes in;
 *   - through the store: a package added opens its binding, a binding changed
 *     carries the recorded protocols over, as an edit;
 *   - proposed for the reference project: what is found, what is not.
 *
 *   node tests/run-protocols-check.mjs
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
const { EMPTY_HME_PROJECT } = await load('src/lib/hmeImport.js')
const { addMatrixRelation, matrixRules } = await load('src/lib/matrixEditor.js')
const P = await load('src/lib/protocols.js')
const B = await load('src/lib/protocolBinding.js')
const { zipPackage } = await import(pathToFileURL(path.join(root, 'scripts/zip-protocols.mjs')))
const { bdaPackages, havePackages, SKIP_PACKAGES } = await import(pathToFileURL(path.join(here, 'protocol-packages.mjs')))
if (!havePackages) { console.log(SKIP_PACKAGES); process.exit(0) }

let failures = 0
const check = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${!cond && detail ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

// ---- the packages ---------------------------------------------------------------------
const packages = {}
for (const pkg of await bdaPackages()) {
  packages[pkg.protocol.key] = pkg
  const errors = pkg.problems.filter((p) => p.severity === 'error')
  check(!errors.length && pkg.template?.length > 1000, `${pkg.id}: ${pkg.fields.length} fields, ${pkg.problems.length} warnings, template ${Math.round(pkg.template.length / 1024)} KB`, pkg.problems.map((p) => p.message).slice(0, 4).join(' | '))
  const zipped = fs.readFileSync(path.join(root, 'protocols', `${pkg.id}.zip`))
  check(Buffer.compare(Buffer.from(zipPackage(path.join(root, 'protocols/source', pkg.id))), zipped) === 0, `protocols/${pkg.id}.zip is its source (npm run protocols)`)
}
check(!fs.readdirSync(path.join(root, 'src/lib')).includes('builtinProtocols.js'), 'no protocol comes with the Navigator')

const fieldOf0 = (prop, p) => prop.fields.find((f) => f.path === p)

// ---- the BDA template -------------------------------------------------------------------
console.log('\nBDA template')
const loaded = loadFile('t.json', EMPTY_HME_PROJECT)
const ws = createWorkspace({ model: loaded.model, journal: createJournal({ author: 'test' }), materializer: loaded.materializer })
rematerialize(ws)
const [{ typeKey, baseProp }] = matrixRules(ws)
const made = addMatrixRelation(ws, { baseProp, typeKey, a: null, b: null, kind: 'higher', word: 'above', newUnits: { a: { label: '1001', identifier: 'SE1001' }, b: { label: '1002', identifier: 'SE1002' } } })
rematerialize(ws)

check(P.matchPackage(ws.model, packages.standard).unbound, 'a package not bound is not used')

// The proposal for the standard protocol: the package's paths, all of them.
const propStd = B.proposeBinding(ws.model, packages.standard)
const useOf = (prop) => prop.fields.reduce((o, f) => { const k = f.choice.create ? 'modelled' : f.choice.use; return { ...o, [k]: (o[k] || 0) + 1 } }, {})
check(!propStd.error && !useOf(propStd).parts && useOf(propStd).modelled + (useOf(propStd).package || 0) === 22 && useOf(propStd).modelled > 15,
  `standard proposed on the matrix template — as the package models it: ${JSON.stringify(useOf(propStd))}`, JSON.stringify(propStd.fields.filter((f) => f.choice.use === 'parts').map((f) => f.path)))
check(fieldOf0(propStd, 'befunddaten.Schnitt_Flaeche')?.packageModel === 'P89 falls within → S20 Rigid Physical Feature' && fieldOf0(propStd, 'befunddaten.SE_Bez')?.packageModel === '', 'the dialog says how the package models a field; SE (Bez.) is in the template already (SU designation)', fieldOf0(propStd, 'befunddaten.Schnitt_Flaeche')?.packageModel)

// What the mapping has no place for, proposed new by kind.
const fieldOf = (prop, p) => prop.fields.find((f) => f.path === p)
const propHolz = B.proposeBinding(ws.model, packages.holz)
const laenge = fieldOf(propHolz, 'abmessungen.Laenge')
check(laenge?.choice.use === 'parts' && Object.keys(laenge.choice.parts).join() === 'main,erhalten,original,sichtbar'
  && laenge.choice.parts.main.use === 'new' && laenge.choice.parts.main.as === 'literal' && laenge.choice.parts.erhalten.name === 'Länge – erhalten',
  'a qualified field proposed part by part: its value and a yes/no per qualifier, new literals named after it', JSON.stringify(laenge?.choice))
const propBau = B.proposeBinding(ws.model, packages.bau)
const zustand = fieldOf(propBau, 'bindung.Zustand')
const bauart = fieldOf(propBau, 'bauart_mauerwerk_struktur.Bauart')
check(zustand?.choice.parts?.main.as === 'type' && bauart?.choice.parts?.main.as === 'literal', 'a single choice proposed as a type, a multiple choice as a literal (text)', JSON.stringify({ z: zustand?.choice, b: bauart?.choice }))
const names = propBau.fields.flatMap((f) => Object.values(f.choice?.parts || {}).filter((x) => x.use === 'new').map((x) => x.name.toLowerCase()))
check(new Set(names).size === names.length, `new names are unique — they are the attributes' keys (${names.length})`)

// Bind all four, one after the other, as proposed — and leave one field of Holz out.
const bindings = {}
const nodesBefore = ws.model.canvas.nodes.length
for (const k of ['standard', 'holz', 'bau', 'mensch']) {
  const choices = B.choicesOf(B.proposeBinding(ws.model, packages[k]))
  if (k === 'holz') choices.fields['befunddaten.Profil'] = { use: 'omit' }
  const r = B.applyBinding(ws, packages[k], choices)
  check(r.ok, `${k} bound: ${r.created} new field(s) in the mapping`, r.error)
  bindings[k] = r.binding
}
rematerialize(ws)
check(ws.model.canvas.nodes.length > nodesBefore, `the mapping grew by ${ws.model.canvas.nodes.length - nodesBefore} nodes — fields the protocols share share them`)

const matches = Object.fromEntries(Object.entries(packages).map(([k, pkg]) => [k, P.matchPackage(ws.model, pkg, bindings[k])]))
const std = matches.standard
check(!std.error && std.counts.mapped === 22 && !std.counts.omitted && !std.counts.lost, `standard: ${JSON.stringify(std.counts)} — every path of the package now in the mapping`)
check(B.proposeBinding(ws.model, packages.standard).fields.every((f) => f.derived || (f.choice.use === 'package' && !f.choice.create)), 'proposed again: the paths are found, nothing to make')
for (const k of ['bau', 'holz', 'mensch']) check(!matches[k].error && !matches[k].counts.lost, `${k}: ${JSON.stringify(matches[k].counts)}`)
check(matches.holz.fields.get('befunddaten.Profil')?.how === 'omit' && matches.holz.counts.omitted >= 1, 'a field left out is out')

const units = P.protocolUnits(ws.model, std)
check(units.length === 2 && units.map((u) => u.label).join() === '1001,1002', 'both units can take a protocol', JSON.stringify(units))
const unitId = made.a

// Every kind of field, on every protocol: written, read back the same.
const sample = (pkg, m) => {
  const v = P.emptyProtocol(pkg)
  let i = 0
  for (const f of pkg.fields) {
    const kind = P.fieldKind(f.def)
    const res = m.fields.get(f.path)
    if (!res || res.how === 'derived' || res.how === 'unitLabel' || res.how === 'elsewhere' || res.how === 'omit') { if (v[f.section]) delete v[f.section][f.key]; continue }
    i++
    if (kind === 'boolean') v[f.section][f.key] = true
    else if (kind === 'multi') v[f.section][f.key] = f.def.optionen.slice(0, 2)
    else if (kind === 'single') v[f.section][f.key] = f.def.optionen[1]
    else if (kind === 'qualified') v[f.section][f.key] = { ...v[f.section][f.key], wert: `${i} cm`, erhalten: true }
    else if (kind === 'object') {
      for (const [sub, parts] of Object.entries(v[f.section][f.key])) for (const part of Object.keys(parts)) parts[part] = typeof parts[part] === 'boolean' ? true : `${sub} ${part}`
    } else if (f.path === 'abschluss.Datum') v[f.section][f.key] = '2026-10-14'
    else v[f.section][f.key] = `${f.key} ${i} ä`
  }
  return v
}
for (const [k, pkg] of Object.entries(packages)) {
  const m = matches[k]
  const values = sample(pkg, m)
  const res = P.writeProtocol(ws, m, unitId, values, { protocol: pkg.id })
  const back = P.readProtocol(ws, m, unitId)
  const diffs = []
  for (const [s, fields] of Object.entries(values)) for (const [f, v] of Object.entries(fields)) if (JSON.stringify(back.values[s]?.[f]) !== JSON.stringify(v)) diffs.push(`${s}.${f}: ${JSON.stringify(v)} -> ${JSON.stringify(back.values[s]?.[f])}`)
  check(res.ok && !diffs.length && back.protocol === pkg.id, `${pkg.id}: every field written and read back the same (${res.written} cells)`, diffs.slice(0, 4).join(' | '))
}

// The new fields are in the graph: Bau's multiple choice, a qualifier, a type.
P.writeProtocol(ws, matches.bau, unitId, sample(packages.bau, matches.bau), { protocol: 'bda-bau' })
rematerialize(ws)
{
  const g = ws.graph
  const n = g.nodes[unitId]
  const flat = Object.entries(n.a || {}).map(([k, v]) => `${k}=${[].concat(v).join('|')}`)
  check(flat.some((x) => /^Bauart/.test(x) && /;/.test(x)), 'a multiple choice: one literal with the choices as text', flat.filter((x) => /Bauart/.test(x)).join(' ') || flat.slice(0, 8).join(' '))
  check(flat.some((x) => /^Länge – erhalten/.test(x) && /true/.test(x)), 'a qualifier: a yes/no literal of its own', flat.filter((x) => /Länge/.test(x)).join(' '))
  const typeTargets = Object.entries(n.o || {}).filter(([k]) => k.includes('P2_has_type')).flatMap(([, t]) => t)
  const want = packages.bau.fields.find((f) => f.path === 'bindung.Zustand').def.optionen[1]
  check(typeTargets.some((t) => g.nodes[t]?.l === want), 'a single choice: an E55 Type, named by its value, via P2 has type', JSON.stringify(typeTargets.map((t) => [t, g.nodes[t]?.l])))
}

// Standard once more, then look at the graph.
P.writeProtocol(ws, std, unitId, sample(packages.standard, std), { protocol: 'bda-standard' })
rematerialize(ws)
const g = ws.graph
const n = g.nodes[unitId]
const outs = (key) => Object.entries(n.o || {}).filter(([k]) => k.split('#')[0].endsWith(key)).flatMap(([, t]) => t)
const bez = outs('P1_is_identified_by').map((t) => g.nodes[t])
check(bez.some((x) => x?.l?.startsWith('SE_Bez')) && outs('P1_is_identified_by').some((t) => t.endsWith('SE1001_designation')), 'SE (Bez.) as an appellation with the HME\'s identifier', JSON.stringify(outs('P1_is_identified_by')))
const gen = outs('AP7i_was_produced_by')
check(gen.length === 1 && gen[0].endsWith('SE1001_gen') && Object.keys(g.nodes[gen[0]].o || {}).some((k) => k.includes('P2_has_type')), 'the dating hangs off the genesis SE1001_gen', JSON.stringify(gen))
const protocolNode = Object.entries(g.nodes).find(([id]) => id.endsWith('SE1001_Protokoll'))
check(!!protocolNode && Object.values(protocolNode[1].a || {}).flat().includes('2026-10-14'), 'the date on the observation SE1001_Protokoll')
const fresh = materialize(ws.model).graph
check(JSON.stringify(Object.keys(fresh.nodes).sort()) === JSON.stringify(Object.keys(g.nodes).sort()), 'the incremental graph equals a fresh one')

// Clearing a field takes the node on the way with it, one undo brings it back.
const cleared = P.readProtocol(ws, std, unitId).values
cleared.interpretation.vorlaeufige_Datierung = ''
P.writeProtocol(ws, std, unitId, cleared)
rematerialize(ws)
check(!Object.keys(ws.graph.nodes).some((id) => id.endsWith('SE1001_gen')), 'the dating cleared, the genesis goes with it')
undo(ws)
rematerialize(ws)
check(Object.keys(ws.graph.nodes).some((id) => id.endsWith('SE1001_gen')), 'one undo brings both back')

// The project's header in every row.
const kopf = P.readProtocol(ws, std, made.b).values.kopfdaten
check(kopf?.Mnr === P.readProtocol(ws, std, unitId).values.kopfdaten.Mnr && !!kopf?.Mnr, 'the Kopfdaten are the project\'s: the other unit has them too', JSON.stringify(kopf))

// ---- an HME project: the protocols as the HME has them ------------------------------------
const hmeFile = 'c:/CRM/HarrisMatrixEditor/data/test-data.json'
if (fs.existsSync(hmeFile)) {
  console.log('\nHME project')
  const hme = JSON.parse(fs.readFileSync(hmeFile, 'utf8'))
  const l1 = loadFile('test-data.json', fs.readFileSync(hmeFile, 'utf8'))
  const waiting = Object.values(l1.report.hme.protocolsWaiting || {}).reduce((a, b) => a + b, 0)
  check(!Object.keys(l1.report.hme.protocolBindings || {}).length && waiting > 0 && l1.warnings.some((w) => /no protocol package for it has been added/.test(w)),
    `without a package the import binds nothing, and says which package would take the ${waiting} protocols`, JSON.stringify(l1.report.hme.protocolsWaiting))
  const ws1 = createWorkspace({ model: l1.model, journal: createJournal({}), materializer: l1.materializer })
  const bound1 = B.bindAsProposed(ws1, packages.standard)
  const m1 = P.matchPackage(ws1.model, packages.standard, bound1.binding)
  const u1 = P.protocolUnits(ws1.model, m1).find((x) => x.label === 'SU 001')
  const back1 = P.readProtocol(ws1, m1, u1.id).values
  check(bound1.ok && bound1.created > 15 && !m1.counts.lost && back1.befunddaten.SE_Bez === 'Humus' && !back1.befunddaten.Schnitt_Flaeche,
    `bound afterwards: the structure is put into the mapping (${bound1.created} nodes); designation and description were there already, the other values stay in the HME file`, bound1.error || JSON.stringify(back1.befunddaten))
  // With the packages added before: the import binds them, the protocols come along.
  const l2 = loadFile('test-data.json', fs.readFileSync(hmeFile, 'utf8'), { packages: Object.values(packages) })
  const ws2 = createWorkspace({ model: l2.model, journal: createJournal({}), materializer: l2.materializer })
  const m2 = P.matchPackage(ws2.model, packages.standard, l2.report.hme.protocolBindings['bda-standard'])
  let same = 0
  const diffs = []
  for (const node of hme.nodes) {
    const u = P.protocolUnits(ws2.model, m2).find((x) => x.label === node.label)
    if (!u) { diffs.push(`${node.label}: no unit`); continue }
    const back = P.readProtocol(ws2, m2, u.id).values
    let ok = true
    for (const [s, fields] of Object.entries(node.se || {})) {
      for (const [f, v] of Object.entries(fields)) {
        if (s === 'befunddaten' && f === 'SE') continue
        const want = typeof v === 'boolean' ? v : String(v ?? '').trim()
        // The HME's own description joins the protocol's where both were taken (hmeImport.js).
        if (s === 'beschreibungen' && f === 'Beschreibung_SE' && String(back[s]?.[f] || '').startsWith(want)) continue
        if (JSON.stringify(back[s]?.[f]) !== JSON.stringify(want)) { ok = false; diffs.push(`${node.label} ${s}.${f}: ${JSON.stringify(want)} -> ${JSON.stringify(back[s]?.[f])}`) }
      }
    }
    if (ok) same++
  }
  check(same === hme.nodes.length, `${same} of ${hme.nodes.length} protocols read back as the HME has them`, diffs.slice(0, 5).join(' | '))
  const first = P.protocolUnits(ws2.model, m2)[0]
  const kopf2 = P.readProtocol(ws2, m2, first.id).values.kopfdaten
  check(JSON.stringify(kopf2) === JSON.stringify(hme.projectMeta), 'and the project’s Kopfdaten as the HME has them', JSON.stringify(kopf2))

  // A unit on another protocol, with its package added: bound as it comes in.
  const hme4 = JSON.parse(fs.readFileSync(hmeFile, 'utf8'))
  const node = hme4.nodes.find((x) => x.se?.befunddaten?.SE_Bez)
  node.protocol = 'bau'
  node.se.bauart_mauerwerk_struktur = { Bauart: ['Schalenmauer', 'Gussmauerwerk'] }
  node.se.abmessungen = { Laenge: { wert: '2,4 m', erhalten: true, original: false, sichtbar: true } }
  const l4 = loadFile('test-data.json', JSON.stringify(hme4), { packages: Object.values(packages) })
  const ws4 = createWorkspace({ model: l4.model, journal: createJournal({}), materializer: l4.materializer })
  const b4 = l4.report.hme.protocolBindings || {}
  check(!!b4['bda-bau'] && !!b4['bda-standard'], `the import binds the packages its units are on: ${Object.keys(b4).join(', ')}`)
  const m4 = P.matchPackage(ws4.model, packages.bau, b4['bda-bau'])
  const u = P.protocolUnits(ws4.model, m4).find((x) => x.label === node.label)
  const back = P.readProtocol(ws4, m4, u.id)
  check(back.protocol === 'bda-bau' && back.values.bauart_mauerwerk_struktur.Bauart.join() === 'Schalenmauer,Gussmauerwerk' && back.values.abmessungen.Laenge.wert === '2,4 m' && back.values.abmessungen.Laenge.sichtbar
    && back.values.befunddaten.SE_Bez === node.se.befunddaten.SE_Bez,
    `an HME unit on "Baulicher Bestand" keeps its own fields — in fields of the mapping (${l4.report.hme.protocolsKept} protocols kept)`, JSON.stringify({ p: back.protocol, b: back.values.bauart_mauerwerk_struktur, a: back.values.abmessungen }))
  const lit = [...ws4.model.literals.values()].find((l) => l.valueColumn === 'Bauart')
  check(!!lit && ws4.model.literalEdges.some((le) => le.literalNodeId === lit.nodeId && le.propertyUri.endsWith('P3_has_note')), 'Bauart is a literal of the mapping via P3 has note, in the column it had')
}

// ---- through the store: added, bound, bound anew ------------------------------------------
console.log('\nthrough the store')
{
  const { useStore, protocolMatches } = await load('src/store.js')
  const S = () => useStore.getState()
  await S().load(new File([EMPTY_HME_PROJECT], 'template.json'))
  check(S().packages.length === 0 && protocolMatches(S()).length === 0, 'a new project has no protocol')
  const zip = fs.readFileSync(path.join(root, 'protocols/bda-holz.zip'))
  const r = await S().importPackage(new File([zip], 'bda-holz.zip'))
  check(r.ok && S().bindingDialog === 'bda-holz', 'a package added opens its binding', r.error)
  const prop = S().proposeProtocolBinding('bda-holz')
  const applied = S().applyProtocolBinding('bda-holz', B.choicesOf(prop))
  check(applied.ok && S().bindingDialog === null && protocolMatches(S()).length === 1 && !!S().config.protocolBindings['bda-holz'], `bound: ${applied.created} new field(s); kept in the settings`, applied.error)
  // Two units, a protocol recorded on one.
  const ws5 = S().workspace
  const [{ typeKey: tk, baseProp: bp }] = matrixRules(ws5)
  addMatrixRelation(ws5, { baseProp: bp, typeKey: tk, a: null, b: null, kind: 'higher', word: 'above', newUnits: { a: { label: '7', identifier: 'SE7' }, b: { label: '8', identifier: 'SE8' } } })
  const m5 = protocolMatches(S())[0]
  const u5 = P.protocolUnits(ws5.model, m5).find((x) => x.label === '7')
  const v5 = P.emptyProtocol(packages.holz)
  v5.befunddaten.Profil = 'P-12'
  v5.abmessungen.Laenge = { wert: '80 cm', erhalten: true, original: false, sichtbar: false }
  P.writeProtocol(ws5, m5, u5.id, v5, { protocol: 'bda-holz' })
  // Bound anew: Profil now as a type — what was recorded comes along.
  const again = S().proposeProtocolBinding('bda-holz')
  check(fieldOf(again, 'befunddaten.Profil').choice.use === 'package' && !fieldOf(again, 'befunddaten.Profil').choice.create, 'the dialog opens on the binding kept — the package’s path, in the mapping now', JSON.stringify(fieldOf(again, 'befunddaten.Profil').choice))
  const ch = B.choicesOf(again)
  ch.fields['befunddaten.Profil'] = { use: 'parts', parts: { main: { use: 'new', as: 'type', name: 'Profil (Typ)' } } }
  const cursor = S().workspace.journal.cursor
  const re = S().applyProtocolBinding('bda-holz', ch)
  const m6 = protocolMatches(S())[0]
  const back6 = P.readProtocol(S().workspace, m6, u5.id).values
  check(re.ok && re.carried === 1 && back6.befunddaten.Profil === 'P-12' && back6.abmessungen.Laenge.wert === '80 cm' && !!m6.fields.get('befunddaten.Profil').storage?.main?.idColumn,
    'bound anew: the recorded protocol carried over to where its fields live now', JSON.stringify({ re: re.carried, err: re.error, p: back6.befunddaten.Profil, how: m6.fields.get('befunddaten.Profil') }))
  check(S().workspace.journal.cursor > cursor, 'carrying over is an edit — undoable')
}

// ---- the reference project ------------------------------------------------------------------
console.log('\nreference project')
if (!fs.existsSync(path.join(root, '_session/OntoCartographer_Projektdatei.json'))) console.log('skip  the reference data (_session/) is not in this copy — it is research data and not distributed with the Navigator')
else {
  const l3 = loadFile('ref.json', fs.readFileSync(path.join(root, '_session/OntoCartographer_Projektdatei.json'), 'utf8'))
  const p3 = B.proposeBinding(l3.model, packages.standard)
  check(!!p3.error === !P.unitEntityFor(l3.model, 'A8_Stratigraphic_Unit'), `standard proposed on the reference mapping: ${p3.error || JSON.stringify(useOf(p3))}`)
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — protocols hold')
process.exit(failures ? 1 : 0)
