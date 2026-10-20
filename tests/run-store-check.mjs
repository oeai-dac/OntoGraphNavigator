/**
 * The store, driven the way the interface drives it.
 *
 * Why this exists: every other suite tests `src/lib/`, and Vite's build does not
 * complain about an identifier that is used but never imported — that is a
 * runtime `ReferenceError`. Exactly that slipped through once (`graphIdFor is not
 * defined`, raised on every save and shown as a form warning, because saveDraft
 * catches its own errors). No amount of library testing would have caught it.
 *
 * So this walks the real path: load a file, open a form, fill it, save, undo,
 * redo — through `src/store.js`, with no browser. Anything unimported blows up
 * here.
 *
 *   node tests/run-store-check.mjs
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

const { useStore, editState } = await import(pathToFileURL(path.join(root, 'src/store.js')))

let failures = 0
const fail = (headline, details = []) => {
  failures++
  console.log(`FAIL  ${headline}`)
  for (const line of details.slice(0, 8)) console.log(`        ${line}`)
}
const pass = (headline) => console.log(`ok    ${headline}`)

/** A warning that names a missing identifier is a bug, not a data problem. */
function assertNoCodeErrors(where, warnings) {
  const bugs = (warnings || []).filter((w) => /is not defined|is not a function|undefined \(reading/.test(String(w)))
  if (bugs.length) fail(`${where}: the code itself failed`, bugs)
  return bugs.length === 0
}

const fileFrom = (name) => new File([fs.readFileSync(path.join(session, name), 'utf8')], name)

for (const filename of ['ontocartographer-project_empty.json', 'OntoCartographer_Projektdatei.json']) {
  console.log(`\n=== ${filename}`)
  const store = useStore.getState()
  store.reset()
  await useStore.getState().load(fileFrom(filename))

  let state = useStore.getState()
  if (state.status !== 'ready') {
    fail(`loading failed: ${state.error}`)
    continue
  }
  console.log(
    `  ${Object.keys(state.graph.nodes).length} nodes, ${state.forms?.forms.length ?? 0} forms, ` +
      `${state.report.tables} tables, ${state.ruleProposals.length} rule proposals`
  )
  if (!state.forms?.forms.length) {
    fail('no forms after loading a project file')
    continue
  }
  pass(`loaded: ${state.forms.forms.length} forms, ${state.report.tables} tables`)

  // Pick the find form if this project has one; otherwise the first.
  const findForm = state.forms.forms.find((f) => /Fund \(human-made\)/.test(f.label)) || state.forms.forms[0]
  useStore.getState().chooseForm(findForm.nodeId)
  useStore.getState().openRecord(null)

  state = useStore.getState()
  if (!state.draft) {
    fail('openRecord(null) did not start a draft')
    continue
  }
  pass(`started a new "${findForm.label}"`)

  // Fill the identifier, a concept if there is one, and a scalar if there is one.
  useStore.getState().setDraftValue('identifier', 'STORE-TEST-1')
  const concept = findForm.fields.find((f) => f.kind === 'concept')
  if (concept) useStore.getState().setDraftValue(concept.key, { uri: '', label: 'Fragment' })
  const scalar = findForm.fields.find((f) => ['text', 'longtext'].includes(f.kind) && !f.readOnly)
  if (scalar) useStore.getState().setDraftValue(scalar.key, 'entered by the store check')
  const group = findForm.fields.find((f) => f.kind === 'group' && f.fields.some((s) => !s.readOnly))
  if (group) {
    const sub = group.fields.find((s) => !s.readOnly)
    useStore.getState().setDraftGroupValue(group.key, sub.key, '150')
  }

  const before = useStore.getState().revision
  useStore.getState().saveDraft()
  state = useStore.getState()

  const clean = assertNoCodeErrors('saveDraft', state.draftWarnings)
  if (state.draftWarnings.length) {
    console.log('  warnings:')
    for (const w of state.draftWarnings) console.log(`    ${w}`)
  }
  if (clean && state.rowId && state.revision > before) {
    pass(`saved: row created, revision ${before} -> ${state.revision}, notice "${state.savedNotice}"`)
  } else if (clean) {
    fail(`save produced no row (rowId=${state.rowId}, revision ${before} -> ${state.revision})`)
  }

  // Editing the record we just made.
  useStore.getState().openRecord(state.rowId)
  if (scalar) useStore.getState().setDraftValue(scalar.key, 'changed again')
  useStore.getState().saveDraft()
  state = useStore.getState()
  if (assertNoCodeErrors('saveDraft (update)', state.draftWarnings)) pass('saved a change to the same record')

  // A single cell, the way the grid does it.
  const table = state.workspace.model.tables.get(findForm.tableId)
  const row = table.rows.at(-1)
  const rowId = Object.getOwnPropertyNames(row).length >= 0 ? state.rowId : null
  try {
    useStore.getState().editCell(findForm.tableId, rowId, findForm.idColumn, 'STORE-TEST-1b')
    pass('editCell went through')
  } catch (error) {
    fail(`editCell threw: ${error.message}`)
  }

  // Undo and redo, which is where the header buttons lead.
  const beforeUndo = editState(useStore.getState())
  try {
    useStore.getState().undo()
    const afterUndo = editState(useStore.getState())
    useStore.getState().redo()
    const afterRedo = editState(useStore.getState())
    if (afterUndo.changes === beforeUndo.changes - 1 && afterRedo.changes === beforeUndo.changes) {
      pass(`undo/redo: ${beforeUndo.changes} -> ${afterUndo.changes} -> ${afterRedo.changes} changes`)
    } else {
      fail(`undo/redo: ${beforeUndo.changes} -> ${afterUndo.changes} -> ${afterRedo.changes} changes`)
    }
  } catch (error) {
    fail(`undo/redo threw: ${error.message}`)
  }

  // Settings actions the Settings tab calls.
  try {
    useStore.getState().setUriRule(findForm.nodeId, '{X}_test')
    useStore.getState().setUriRule(findForm.nodeId, '')
    useStore.getState().setThesaurusBinding('n52', '')
    pass('the settings actions run')
  } catch (error) {
    fail(`a settings action threw: ${error.message}`)
  }

  // Reading a thesaurus from a file, as the Settings tab does.
  const thesaurusFile = fs
    .readdirSync(path.join(session, 'thesauri'))
    .find((f) => /\.(ttl|txt)$/i.test(f))
  if (thesaurusFile) {
    const file = new File([fs.readFileSync(path.join(session, 'thesauri', thesaurusFile), 'utf8')], thesaurusFile)
    await useStore.getState().addThesaurusFile(file)
    state = useStore.getState()
    if (state.thesauri.size > 0) {
      const first = [...state.thesauri.values()][0]
      pass(`a thesaurus file loads through the store (${first.report.concepts} concepts)`)
    } else {
      fail(`the thesaurus did not register: ${state.error || 'no error given'}`)
    }
  }

  // And the export paths the Export tab uses.
  const { writeGraphJson } = await import(pathToFileURL(path.join(root, 'src/lib/graphJson.js')))
  const { writeProjectFile } = await import(pathToFileURL(path.join(root, 'src/lib/projectFile.js')))
  const { toJsonl, toReadableLog } = await import(pathToFileURL(path.join(root, 'src/lib/journal.js')))
  const { writeSidecar } = await import(pathToFileURL(path.join(root, 'src/lib/sidecar.js')))
  state = useStore.getState()
  try {
    const sizes = [
      writeGraphJson(state.graph).length,
      JSON.stringify(writeProjectFile(state.model)).length,
      toJsonl(state.workspace.journal).length,
      toReadableLog(state.workspace.journal).length,
      writeSidecar(state.config).length,
    ]
    pass(`all five exports produce output (${sizes.map((n) => `${(n / 1024).toFixed(0)} kB`).join(', ')})`)
  } catch (error) {
    fail(`an export threw: ${error.message}`)
  }

  // Declaring the languages of a project that names none, as Settings does —
  // only possible while it names none.
  try {
    const before = useStore.getState()
    const hadWarning = before.warnings.some((w) => w.includes('before the Studio named languages'))
    before.setLanguages({ primary: 'de', additional: ['en'] })
    state = useStore.getState()
    const declared = JSON.stringify(state.model.languages) === '{"primary":"de","additional":["en"]}'
    const graphHas = JSON.stringify(state.graph.languages) === '{"primary":"de","additional":["en"]}'
    const warningGone = !state.warnings.some((w) => w.includes('before the Studio named languages'))
    state.setLanguages({ primary: 'fr' })
    const unchanged = useStore.getState().model.languages.primary === 'de'
    if (hadWarning && declared && graphHas && warningGone && unchanged) {
      pass('languages declared through the store: model, graph and notice follow; declared once, they stay')
    } else {
      fail(`setLanguages: warning ${hadWarning}, model ${declared}, graph ${graphHas}, notice gone ${warningGone}, kept ${unchanged}`)
    }
  } catch (error) {
    fail(`setLanguages threw: ${error.message}`)
  }
}

console.log(failures === 0 ? '\nPASS — the store holds\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
