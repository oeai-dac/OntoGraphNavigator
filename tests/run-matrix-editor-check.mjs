/**
 * Editing the Harris matrix (src/lib/matrixEditor.js) on the three shapes a
 * mapping keeps relations in:
 *
 *   example project    the unit's own rows, joined to a role table   source-row
 *   reference project  a table of relations (tbl_2)                  relation-row
 *   HME project        both units side by side in one row            same-row
 *
 * For each: a relation drawn, its kind changed, removed; a new unit entered
 * with its first relation; one undo per action; the qualifier written in the
 * table's own spelling; and the incrementally kept graph still equal to a
 * fresh one afterwards.
 *
 *   node tests/run-matrix-editor-check.mjs
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
const { addMatrixRelation, setMatrixRelation, removeMatrixRelation, describeMatrix, suggestUnitIdentifier } = await load('src/lib/matrixEditor.js')
const { relationBetween, qualifierVocabulary, buildSequence, statementsOf } = await load('src/views/lib/harrisMatrix.js')
const { checkMatrix } = await load('src/views/lib/matrixChecks.js')

let failures = 0
const check = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${!cond && detail ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

function open(file) {
  const loaded = loadFile(path.basename(file), fs.readFileSync(path.join(root, file), 'utf8'))
  const workspace = createWorkspace({ model: loaded.model, journal: createJournal({ author: 'test' }), materializer: loaded.materializer })
  rematerialize(workspace)
  return workspace
}

const PROJECTS = [
  ['example project (source-row)', '0_exampleData/OntoCartographer_Projectfile.json'],
  ['reference project (relation-row)', '_session/OntoCartographer_Projektdatei.json'],
  ['HME project (same-row)', '_session/HarrisMatrixEditor_OntoCartographer-Projektdatei.json'],
]

for (const [name, file] of PROJECTS) {
  console.log(`\n${name}`)
  if (!fs.existsSync(path.join(root, file))) { console.log(`skip  the reference data (_session/) is not in this copy — it is research data and not distributed with the Navigator`); continue }
  const ws = open(file)
  const rel = ws.model.dot1Relations[0]
  const baseProp = rel.propertyUri
  const typeKey = ws.model.entities.get(rel.source).typeKey
  const graph = () => ws.graph
  const units = Object.keys(graph().nodes).filter((id) => graph().nodes[id].t === typeKey)
  const vocab = qualifierVocabulary(graph(), baseProp)
  const payload = { baseProp, typeKey }

  check(describeMatrix(ws, payload).editable, `editable: ${units.length} units, words ${JSON.stringify(vocab)}`)

  // Two units not related to each other, both already in the matrix.
  let a = null
  let b = null
  outer: for (const x of units) {
    for (const y of units) {
      if (x !== y && !relationBetween(graph(), baseProp, x, y)) { a = x; b = y; break outer }
    }
  }
  const before = ws.journal.cursor

  // ---- draw ---------------------------------------------------------------------
  let r = addMatrixRelation(ws, { ...payload, a, b, kind: 'higher', word: vocab.higher })
  rematerialize(ws)
  check(r.ok && relationBetween(graph(), baseProp, a, b) === 'higher' && relationBetween(graph(), baseProp, b, a) === 'lower',
    `drawn: ${graph().nodes[a].l} above ${graph().nodes[b].l}, and read back from both sides`, JSON.stringify(r))
  check(ws.journal.cursor - before >= 1 && new Set(ws.journal.entries.slice(before).map((e) => e.group)).size === 1, 'one journal group')
  const written = ws.journal.entries.slice(before).flatMap((e) => (e.op === 'addRow' ? Object.values(e.after) : [e.after]))
  const existingSpelling = (() => {
    const t = ws.model.tables.get(rel.valueTableId)
    return t.rows.map((row) => row[rel.valueColumn]).find((v) => v && v !== '' && !written.includes(v))
  })()
  const qual = written.find((v) => typeof v === 'string' && v.toLowerCase().includes(vocab.higher.replace(/ /g, '_').slice(0, 4)))
  check(!!qual, `the kind written as "${qual}" (the table already holds e.g. "${existingSpelling}")`)

  // ---- change ----------------------------------------------------------------------
  const cursor1 = ws.journal.cursor
  r = setMatrixRelation(ws, { ...payload, a, b, kind: 'same-rank', word: vocab['same-rank'] })
  rematerialize(ws)
  check(r.ok && relationBetween(graph(), baseProp, a, b) === 'same-rank', 'changed to contemporary', JSON.stringify(r))
  const seq = buildSequence(graph(), units, baseProp)
  const between = [...seq.rankEdges, ...seq.sameRankEdges].filter((e) => [e.source, e.target].sort().join() === [a, b].sort().join())
  check(between.length === 1, 'one relation between them, not the old one beside the new')
  undo(ws)
  rematerialize(ws)
  check(ws.journal.cursor === cursor1 && relationBetween(graph(), baseProp, a, b) === 'higher', 'one undo brings back "above"')

  // ---- remove -----------------------------------------------------------------------
  r = removeMatrixRelation(ws, { ...payload, a, b })
  rematerialize(ws)
  check(r.ok && relationBetween(graph(), baseProp, a, b) === null, 'removed', JSON.stringify(r))
  undo(ws)
  undo(ws)
  rematerialize(ws)
  check(ws.journal.cursor === before && relationBetween(graph(), baseProp, a, b) === null, 'two undos take back removing and drawing')

  // ---- a contradiction, and taking back just one side of it --------------------------------
  addMatrixRelation(ws, { ...payload, a, b, kind: 'higher', word: vocab.higher })
  addMatrixRelation(ws, { ...payload, a: b, b: a, kind: 'higher', word: vocab.higher })
  rematerialize(ws)
  const both = statementsOf(graph(), baseProp, a).filter((x) => x.partner === b).map((x) => x.kind).sort().join()
  check(both === 'higher,lower', `"A above B" and "B above A" both stand — A reads both (${both})`)
  r = removeMatrixRelation(ws, { ...payload, a, b, kind: 'lower' }) // "a lies below b", i.e. what b states
  rematerialize(ws)
  const left = statementsOf(graph(), baseProp, a).filter((x) => x.partner === b).map((x) => x.kind).join()
  check(r.ok && left === 'higher', 'removing "A below B" takes only that statement; "A above B" stays', `left: ${left}`)
  undo(ws)
  undo(ws)
  undo(ws)
  rematerialize(ws)
  check(ws.journal.cursor === before && relationBetween(graph(), baseProp, a, b) === null, 'and three undos clear it all again')

  // ---- a new unit with its first relation -----------------------------------------------
  const label = 'NEW-UNIT-1'
  const identifier = suggestUnitIdentifier(ws, {}, { ...payload, label })
  r = addMatrixRelation(ws, { ...payload, a, b: null, kind: 'lower', word: vocab.lower, newUnits: { b: { label, identifier } } })
  rematerialize(ws)
  const created = r.b && graph().nodes[r.b]
  check(r.ok && created && created.l === label && relationBetween(graph(), baseProp, a, r.b) === 'lower',
    `a new unit "${label}" (identifier ${identifier}) appears below ${graph().nodes[a].l}`, JSON.stringify({ r, created }))
  // In the matrix: of its type, or a partner of one of its units (the Matrix
  // view takes both). And a record of its own in the units' table, which the
  // form opens it by.
  const unitTable = ws.model.tables.get(ws.model.entities.get(rel.source).tableId)
  const idColumn = ws.model.entities.get(rel.source).idColumn
  check(created && (created.t === typeKey || relationBetween(graph(), baseProp, a, r.b)) &&
    unitTable.rows.some((row) => row[idColumn] === identifier),
    `and stands in the matrix (${created?.t === typeKey ? 'its type' : 'as a partner'}), with a row of its own in the units\' table`)

  // ---- consistency ----------------------------------------------------------------------------
  const fresh = materialize(ws.model).graph
  const keys = (g) => JSON.stringify(Object.keys(g.nodes).sort())
  const sameNodes = keys(fresh) === keys(graph()) && Object.keys(fresh.nodes).every((id) => JSON.stringify(fresh.nodes[id]) === JSON.stringify(graph().nodes[id]))
  check(sameNodes, 'the incrementally kept graph equals a fresh one after all of it')
  const findings = checkMatrix(units, (id) => graph().nodes[id]?.l, buildSequence(graph(), units, baseProp)).counts
  console.log(`        checks on this matrix: ${JSON.stringify(findings)}`)
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — the matrix edits where relations live')
process.exit(failures ? 1 : 0)
