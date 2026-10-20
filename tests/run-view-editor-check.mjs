/**
 * Editing from the GraphExplorer's views: an attribute written back to the
 * cells it was read from (src/lib/viewEditor.js), and the journal groups that
 * make one action one undo.
 *
 *   node tests/run-view-editor-check.mjs
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
const { createWorkspace, rematerialize, undo, redo, updateRecord, rowsForForm, valuesFromRow } = await load('src/lib/edits.js')
const { attributeCells, describeAttribute, writeAttribute } = await load('src/lib/viewEditor.js')
const { buildForms } = await load('src/lib/forms.js')
const { emptySidecar } = await load('src/lib/sidecar.js')
const { parseWktForEdit, writeWkt, moveVertex } = await load('src/views/lib/wktEdit.js')

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

// ---- the reference project: one cell, several equal cells, joined values --------------
if (!fs.existsSync(path.join(root, '_session/OntoCartographer_Projektdatei.json'))) console.log('skip  the reference data (_session/) is not in this copy — it is research data and not distributed with the Navigator')
else {
  const ws = open('_session/OntoCartographer_Projektdatei.json')
  const tally = { one: 0, same: 0, joined: 0, none: 0 }
  let sameExample = null
  let joinedExample = null
  for (const [id, n] of Object.entries(ws.graph.nodes)) {
    for (const key of Object.keys(n.a)) {
      const cells = attributeCells(ws, id, key)
      const verdict = describeAttribute(ws, id, key)
      if (!cells.length) tally.none++
      else if (!verdict.editable) {
        tally.joined++
        joinedExample ||= { id, key, verdict }
      } else if (cells.length > 1) {
        tally.same++
        sameExample ||= { id, key, cells: cells.length }
      } else tally.one++
    }
  }
  check(tally.none === 0, `every attribute is traced to its cells (${tally.one + tally.same + tally.joined} attributes)`)
  check(tally.joined === ws.diagnostics.attributeConflicts,
    `the ${tally.joined} attributes joined from different values are exactly the ${ws.diagnostics.attributeConflicts} the materialisation reports — and are not editable here`)
  check(/different values/.test(joinedExample.verdict.reason), `…saying why: "${joinedExample.verdict.reason}"`)

  // The same value in two rows: both change, as one step.
  const before = ws.graph.nodes[sameExample.id].a[sameExample.key]
  const result = writeAttribute(ws, sameExample.id, sameExample.key, 'CHANGED FROM A VIEW')
  rematerialize(ws)
  const after = ws.graph.nodes[sameExample.id].a[sameExample.key]
  check(result.ok && result.changed === sameExample.cells && after === 'CHANGED FROM A VIEW',
    `a value standing in ${sameExample.cells} rows changes in all of them — no "new; old" left behind`, JSON.stringify({ result, after }))
  check(ws.journal.entries.slice(-result.changed).every((e) => e.source === 'view' && e.group && e.group === ws.journal.entries[ws.journal.entries.length - 1].group),
    'the journal records it as one group, source "view"')
  undo(ws)
  rematerialize(ws)
  check(ws.graph.nodes[sameExample.id].a[sameExample.key] === before && ws.journal.cursor === 0, 'one undo takes all of it back')
  redo(ws)
  rematerialize(ws)
  check(ws.graph.nodes[sameExample.id].a[sameExample.key] === 'CHANGED FROM A VIEW', 'one redo puts all of it back')

  const refused = writeAttribute(ws, joinedExample.id, joinedExample.key, 'x')
  check(!refused.ok && refused.error, 'writing a joined value is refused, not guessed')
}

// ---- a geometry, edited the way the Map does it ------------------------------------------
{
  const ws = open('0_exampleData/OntoCartographer_Projectfile.json')
  const [id, node] = Object.entries(ws.graph.nodes).find(([, n]) => n.a.Geometry?.startsWith('POLYGON'))
  const model = parseWktForEdit(node.a.Geometry)
  const v = model.paths[0].vertices[1]
  const wkt = writeWkt(moveVertex(model, 0, 1, v.x + 0.0001, v.y))
  check(describeAttribute(ws, id, 'Geometry').editable, `${node.l}: its geometry is editable`)
  const result = writeAttribute(ws, id, 'Geometry', wkt)
  rematerialize(ws)
  check(result.ok && ws.graph.nodes[id].a.Geometry === wkt, 'the moved geometry is in the graph after saving')
  const changedChars = [...wkt].filter((c, i) => c !== node.a.Geometry[i]).length
  check(wkt.length === node.a.Geometry.length && changedChars <= 7,
    `only the moved coordinate differs from the source text (${changedChars} characters)`)
}

// ---- no tables, no editing -----------------------------------------------------------------
{
  const graphOnly = { model: null, materializer: null }
  check(!describeAttribute(graphOnly, 'x', 'y').editable && /project file/.test(describeAttribute(graphOnly, 'x', 'y').reason),
    'a graph loaded without its project is not editable, and says why')
}

// ---- a form saved is one undo ----------------------------------------------------------------
{
  const ws = open('0_exampleData/OntoCartographer_Projectfile.json')
  const forms = buildForms(ws.model, emptySidecar())
  const site = forms.forms.find((f) => f.label === 'E27 Site')
  const record = rowsForForm(ws, site)[0]
  const values = valuesFromRow(site, record.row)
  const description = site.fields.find((f) => f.kind === 'longtext' || f.label === 'Description')
  updateRecord(ws, site, record.rowId, { ...values, label: 'Renamed', 'label@de': 'Umbenannt', [description.key]: 'New description' })
  const made = ws.journal.cursor
  undo(ws)
  check(made >= 2 && ws.journal.cursor === 0, `a form saved with ${made} changed fields is undone in one step`)
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — views edit where values come from')
process.exit(failures ? 1 : 0)
