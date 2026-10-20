/**
 * Editing: the journal, the write layer, and the companion file.
 *
 * The check that guards everything else: attaching row identifiers and editing
 * must not disturb what Phase 1 verified. So the first thing tested is that a
 * tagged, untouched project still materialises to the same graph and still
 * writes the same project file.
 *
 *   node tests/run-edit-check.mjs
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

const { readProjectFile, writeProjectFile } = await load('projectFile.js')
const { materialize } = await load('materialize.js')
const { buildForms } = await load('forms.js')
const { createJournal, checksum, summarise, toJsonl, toReadableLog, fromJsonl } = await load('journal.js')
const {
  createWorkspace, rematerialize, setCell, undo, redo,
  createRecord, updateRecord, rowsForForm, valuesFromRow, rowIdOf,
} = await load('edits.js')
const { proposeSidecar, readSidecar, writeSidecar, proposeThesaurusBindings } = await load('sidecar.js')
const { readSkos } = await load('thesaurus.js')

let failures = 0
const fail = (headline, details = []) => {
  failures++
  console.log(`FAIL  ${headline}`)
  for (const line of details.slice(0, 8)) console.log(`        ${line}`)
}
const pass = (headline) => console.log(`ok    ${headline}`)

const DRIFT = { n47: { idColumn: 'SE_Zuordnung_ID' } }
const raw = fs.readFileSync(path.join(session, 'OntoCartographer_Projektdatei.json'), 'utf8')
const project = JSON.parse(raw)
const reference = JSON.parse(fs.readFileSync(path.join(session, 'OntoCartographer_JSON-Export.json'), 'utf8'))

// ------------------------------------------- tagging must change nothing
{
  const model = readProjectFile(project)
  const before = writeProjectFile(model)
  const journal = createJournal({
    author: 'test',
    inputs: [{ name: 'OntoCartographer_Projektdatei.json', bytes: raw.length, checksum: checksum(raw) }],
  })
  const workspace = createWorkspace({ model, journal })

  const after = writeProjectFile(workspace.model)
  if (JSON.stringify(before) === JSON.stringify(after)) pass('row identifiers are invisible to the project file writer')
  else fail('the project file changed merely by tagging rows')

  const { graph } = materialize(workspace.model, { overrides: DRIFT })
  const sameNodes = Object.keys(graph.nodes).length === Object.keys(reference.nodes).length
  const sameTypes = Object.keys(graph.node_types).length === Object.keys(reference.node_types).length
  if (sameNodes && sameTypes) pass(`a tagged project still materialises to ${Object.keys(graph.nodes).length} nodes`)
  else fail(`materialisation changed after tagging: ${Object.keys(graph.nodes).length} nodes`)

  const tableRow = workspace.model.tables.get('tbl_11').rows[0]
  if (rowIdOf(tableRow) && !Object.keys(tableRow).includes('__ognRowId') && !JSON.stringify(tableRow).includes('__ognRowId')) {
    pass('the row identifier exists but appears in no key list and no serialisation')
  } else {
    fail('the row identifier leaked into the row data')
  }
}

// ------------------------------------------------- creating a find record
const model = readProjectFile(project)
const journal = createJournal({ author: 'B. Danthine', inputs: [{ name: 'project', bytes: raw.length, checksum: checksum(raw) }] })
const { config: proposed, proposals } = proposeSidecar(model)
const workspace = createWorkspace({ model, journal, config: proposed })
const { byNode } = buildForms(model, proposed)
const findForm = byNode.get('n59')

console.log(`\nproposed ${proposals.length} identifier rules, ${Object.keys(proposed.uriRules).length} of them confident:`)
for (const p of proposals.slice(0, 8)) {
  console.log(`  ${p.confident ? 'use ' : 'ask '} ${p.label} (${p.column}) -> ${p.template}   ${(p.coverage * 100).toFixed(0)}%`)
}

{
  const before = rowsForForm(workspace, findForm).length
  const result = createRecord(workspace, findForm, {
    identifier: 'EDP22-2001-9001',
    'rel:e_n59_n51_1785424389613': { uri: 'https://www.oeaw.ac.at/oeai/fragment', label: 'Fragment' },
    'rel:e_n59_n52_1785424476597': { uri: 'https://vocabs.acdh.oeaw.ac.at/oeai-materials/concept23836', label: 'Marmor' },
    'ref:e_n20_n59_1785402305512:in': 'EDP22-SE2001',
    'grp:e_n59_n67_1785425345160': { 'lit:n69': '150', 'lit:n73': '250' },
  }, { source: 'form' })

  console.log(`\ncreated record ${result.identifier}${result.warnings.length ? ` — ${result.warnings.join(' ')}` : ''}`)
  const after = rowsForForm(workspace, findForm).length
  if (after === before + 1) pass(`the find form added one row (${before} -> ${after})`)
  else fail(`row count went ${before} -> ${after}`)

  const row = workspace.model.tables.get('tbl_11').rows.at(-1)
  const expected = {
    HMO_INVENTARNUMMER: 'EDP22-2001-9001',
    Object_ID: 'oeai:fragment',
    OBJEKT: 'Fragment',
    Material_ID: 'vocabs:concept23836',
    MATERIAL: 'Marmor',
    SE: 'EDP22-SE2001',
    Datierung_Beginn: '150',
    Datierung_Ende: '250',
    Datierung_ID: 'EDP22-2001-9001_ProdDate',
  }
  const wrong = Object.entries(expected).filter(([column, value]) => String(row[column] ?? '') !== value)
  if (!wrong.length) pass('every column was written as expected, concept URIs prefix-compacted')
  else fail(`${wrong.length} column(s) wrong`, wrong.map(([c, v]) => `${c}: got "${row[c]}", expected "${v}"`))

  const columns = workspace.model.tables.get('tbl_11').columns
  const keys = Object.keys(row)
  if (keys.length === columns.length) pass(`the new row is rectangular (${keys.length} columns)`)
  else fail(`the new row has ${keys.length} columns, the table has ${columns.length}`)

  const graph = rematerialize(workspace)
  const id = 'https://www.oeaw.ac.at/oeai/EDP22-2001-9001'
  const node = graph.nodes[id]
  if (!node) {
    fail('the new find did not appear in the graph')
  } else {
    const problems = []
    if (node.t !== findForm.typeKey) problems.push(`type is ${node.t}`)
    if (node.l !== 'EDP22-2001-9001') problems.push(`label is "${node.l}"`)
    const inSe = Object.values(node.i).some((list) => list.includes('https://www.oeaw.ac.at/oeai/EDP22-SE2001'))
    if (!inSe) problems.push('not attached to SE 2001')
    const dating = Object.values(node.o).flat().find((t) => t.endsWith('_ProdDate'))
    if (!dating) problems.push('no dating node')
    else if (graph.nodes[dating]?.a?.AP24_starts !== '150') problems.push(`dating start is ${graph.nodes[dating]?.a?.AP24_starts}`)
    if (problems.length) fail('the new find is in the graph but wrong', problems)
    else pass('the new find is in the graph: typed, attached to SE 2001, dating unfolded into its own node')
  }

  const dangling = []
  const ids = new Set(Object.keys(graph.nodes))
  for (const [nodeId, n] of Object.entries(graph.nodes)) {
    for (const list of [...Object.values(n.o), ...Object.values(n.i)]) {
      for (const t of list) if (!ids.has(t)) dangling.push(`${nodeId} -> ${t}`)
    }
  }
  if (!dangling.length) pass('the graph has no dangling references after the edit')
  else fail(`${dangling.length} dangling references after the edit`, dangling)
}

// ------------------------------------------------------------ undo / redo
{
  // One form filled in produced *two* graph nodes: the find and the dating that
  // was folded into its form. Undo must take both, so the nodes are checked by
  // name rather than counted.
  const find = 'https://www.oeaw.ac.at/oeai/EDP22-2001-9001'
  const dating = `${find}_ProdDate`
  const present = (graph) => [find, dating].filter((id) => graph.nodes[id])

  const graphBefore = Object.keys(workspace.graph.nodes).length
  if (present(workspace.graph).length !== 2) fail('the find and its dating are not both in the graph before undo')

  // Read each state as it stands: the graph's `nodes` are updated in place by
  // the next rematerialize, so a graph object kept from before shows the present.
  undo(workspace)
  const afterUndoGraph = rematerialize(workspace)
  const goneAfterUndo = present(afterUndoGraph).length === 0
  const afterUndoCount = Object.keys(afterUndoGraph.nodes).length
  redo(workspace)
  const afterRedoGraph = rematerialize(workspace)
  const backAfterRedo = present(afterRedoGraph).length === 2

  const counts = `${graphBefore} -> ${afterUndoCount} -> ${Object.keys(afterRedoGraph.nodes).length}`
  if (goneAfterUndo && backAfterRedo) {
    pass(`undo removed the find and its dating node, redo restored both (${counts} nodes)`)
  } else {
    fail(`undo/redo did not restore the record exactly (${counts} nodes)`)
  }

  undo(workspace)
  const rowId = rowsForForm(workspace, byNode.get('n20'))[0].rowId
  setCell(workspace, 'tbl_3', rowId, 'BEFUNDBESCHREIBUNG', 'edited by the test', { source: 'grid' })
  if (workspace.journal.entries.length === workspace.journal.cursor) {
    pass('editing after an undo discards the abandoned branch')
  } else {
    fail(`journal has ${workspace.journal.entries.length} entries but cursor is at ${workspace.journal.cursor}`)
  }
}

// --------------------------------------------------- editing an existing row
{
  const seForm = byNode.get('n20')
  const first = rowsForForm(workspace, seForm)[0]
  const values = valuesFromRow(seForm, first.row)
  const descriptionField = seForm.fields.find((f) => f.label === 'Befundbeschreibung')
  values[descriptionField.key] = 'A revised description'
  const { changed } = updateRecord(workspace, seForm, first.rowId, values, { source: 'form' })
  if (changed.includes('BEFUNDBESCHREIBUNG') && first.row.BEFUNDBESCHREIBUNG === 'A revised description') {
    pass(`updating a record changed ${changed.length} column(s)`)
  } else {
    fail(`update wrote ${JSON.stringify(changed)}`)
  }

  const unchanged = updateRecord(workspace, seForm, first.rowId, values, { source: 'form' })
  if (unchanged.changed.length === 0) pass('writing the same values again records nothing')
  else fail(`a no-op update recorded ${unchanged.changed.length} change(s)`)
}

// ---------------------------------------------------------------- the log
{
  const summary = summarise(journal)
  console.log(
    `\njournal: ${summary.entries} entries, ${summary.rows} row(s) touched, ` +
      `${summary.added} added, ${summary.changed} changed, ${summary.deleted} deleted`
  )
  const jsonl = toJsonl(journal)
  const lines = jsonl.trim().split('\n')
  if (lines.length === summary.entries + 1) pass(`log as JSON Lines: 1 header + ${summary.entries} entries`)
  else fail(`log has ${lines.length} lines for ${summary.entries} entries`)

  const reread = fromJsonl(jsonl)
  if (reread.entries.length === summary.entries && reread.inputs[0]?.checksum === checksum(raw)) {
    pass('the log reads back, carrying the checksum of the file it describes')
  } else {
    fail('the log did not read back correctly')
  }

  const readable = toReadableLog(journal)
  const all = readable.split('\n')
  const headerAt = all.findIndex((l) => l.startsWith('Time'))
  const width = all[headerAt].split('\t').length
  const ragged = all.slice(headerAt + 1).filter((l) => l.trim()).filter((l) => l.split('\t').length !== width).length
  if (!ragged) pass(`readable log is rectangular (${width} columns)`)
  else fail(`${ragged} line(s) of the readable log have the wrong field count`)
}

// ------------------------------------------------------- the companion file
{
  const text = writeSidecar({ ...proposed, author: 'B. Danthine' })
  const reread = readSidecar(JSON.parse(text))
  if (JSON.stringify(reread.uriRules) === JSON.stringify(proposed.uriRules) && reread.author === 'B. Danthine') {
    pass(`companion file round-trips ${Object.keys(reread.uriRules).length} identifier rules`)
  } else {
    fail('the companion file did not round-trip')
  }
  try {
    readSidecar({ kind: 'something-else' })
    fail('a foreign settings file was accepted')
  } catch {
    pass('a foreign settings file is refused')
  }

  const thesauri = fs
    .readdirSync(path.join(session, 'thesauri'))
    .filter((f) => /\.(ttl|txt|nt)$/i.test(f))
    .map((f) => readSkos(fs.readFileSync(path.join(session, 'thesauri', f), 'utf8'), { name: f }))
  const { bindings, proposals: bindingProposals } = proposeThesaurusBindings(model, thesauri)
  console.log(`\nproposed ${bindingProposals.length} thesaurus binding(s):`)
  for (const p of bindingProposals) {
    console.log(`  ${p.label} (${p.column}) -> ${p.thesaurusName}   ${p.hits}/${p.values} values (${(p.ratio * 100).toFixed(0)}%)`)
  }
  if (bindingProposals.length && Object.keys(bindings).length) {
    pass(`${bindingProposals.length} field(s) bound to a vocabulary from the values already stored`)
  } else {
    fail('no thesaurus binding was proposed, though Material_ID holds concept URIs')
  }
}

// ------------------------------------------------- the auto-saved copy
// A reload must not cost the session, so the snapshot has to carry the edits and
// come back through the ordinary load path. The storage layer itself is the
// browser's; what is checked here is that nothing is lost on the way in and out.
{
  const { buildSnapshot, projectFromSnapshot, describeAge } = await load('autosave.js')
  const { loadFile } = await load('loadFile.js')

  const snapshot = buildSnapshot({ workspace, config: proposed, filename: 'project.json', author: 'B. Danthine' })
  if (!snapshot) {
    fail('no snapshot was built even though there are changes')
  } else {
    const bytes = JSON.stringify(snapshot).length
    const duplicated = JSON.stringify(writeProjectFile(workspace.model)).length
    console.log(
      `\nsnapshot: ${(bytes / 1e6).toFixed(1)} MB against ${(duplicated / 1e6).toFixed(1)} MB for the ` +
        `project file, ${snapshot.changes} changes, ${snapshot.tables.length} tables`
    )
    if (bytes < duplicated) pass(`the snapshot is deduplicated (${(duplicated / bytes).toFixed(1)}× smaller than the project file)`)
    else fail('the snapshot is no smaller than the duplicated project file')

    const restoredProject = projectFromSnapshot(snapshot)
    const reloaded = loadFile(snapshot.filename, JSON.stringify(restoredProject))

    const rowsBefore = [...workspace.model.tables.values()].reduce((n, t) => n + t.rows.length, 0)
    const rowsAfter = [...reloaded.model.tables.values()].reduce((n, t) => n + t.rows.length, 0)
    const nodesBefore = Object.keys(rematerialize(workspace).nodes).length
    const nodesAfter = Object.keys(reloaded.graph.nodes).length

    if (rowsBefore === rowsAfter && nodesBefore === nodesAfter) {
      pass(`restoring gives back the same data (${rowsAfter} rows, ${nodesAfter} nodes)`)
    } else {
      fail(`restoring changed the data: ${rowsBefore} -> ${rowsAfter} rows, ${nodesBefore} -> ${nodesAfter} nodes`)
    }

    // What the data actually holds at this point has to come back. The find
    // created earlier was undone and its branch discarded, so it is *correctly*
    // gone; the description edited afterwards is what remains.
    const description = reloaded.model.tables
      .get('tbl_3')
      ?.rows.some((r) => r.BEFUNDBESCHREIBUNG === 'A revised description')
    const undoneFind = reloaded.model.tables
      .get('tbl_11')
      ?.rows.some((r) => r.HMO_INVENTARNUMMER === 'EDP22-2001-9001')

    if (description && !undoneFind) {
      pass('the snapshot carries the edits that stand, and not the ones undone')
    } else {
      fail(
        `the snapshot does not match the current state (edited description present: ${Boolean(description)}, ` +
          `undone find present: ${Boolean(undoneFind)})`
      )
    }

    if (snapshot.journal.cursor === workspace.journal.cursor) pass(`the journal travels with it (${snapshot.journal.cursor} entries)`)
    else fail(`the journal did not travel: ${snapshot.journal.cursor} against ${workspace.journal.cursor}`)

    // A snapshot from a future version must be refused, not half-read.
    try {
      projectFromSnapshot({ ...snapshot, version: 99 })
      fail('a snapshot from another version was accepted')
    } catch {
      pass('a snapshot from another version is refused')
    }

    const ages = [describeAge(Date.now() - 5000), describeAge(Date.now() - 120000), describeAge(Date.now() - 7200000)]
    console.log(`  ages read as: ${ages.join(', ')}`)
  }
}

console.log(failures === 0 ? '\nPASS — editing holds\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
