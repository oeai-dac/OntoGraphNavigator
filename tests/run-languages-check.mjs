/**
 * Languages, the whole way through: entry, graph, project file, saved copy.
 *
 * The example project (Studio 3.2) is English with German: `languages`,
 * `labelColumnI18n` on the vocabulary types, `explorerLabelI18n` on the
 * display-named ones. The reference project predates languages altogether.
 *
 *   node tests/run-languages-check.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

register('./resolve-extensionless.mjs', import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const load = (f) => import(pathToFileURL(path.join(root, 'src/lib', f)))

const { loadFile } = await load('loadFile.js')
const { readProjectFile, writeProjectFile } = await load('projectFile.js')
const { buildForms } = await load('forms.js')
const { createJournal } = await load('journal.js')
const { createWorkspace, rematerialize, updateRecord, addRow, rowsForForm, valuesFromRow } = await load('edits.js')
const { buildSnapshot, projectFromSnapshot } = await load('autosave.js')
const { emptySidecar } = await load('sidecar.js')

let failures = 0
const check = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${!cond && detail ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

const exampleText = fs.readFileSync(path.join(root, '0_exampleData/OntoCartographer_Projectfile.json'), 'utf8')

// ---- entering a label in the further language --------------------------------
{
  const loaded = loadFile('example.json', exampleText)
  const { model } = loaded
  const workspace = createWorkspace({ model, journal: createJournal({ author: 'test' }), materializer: loaded.materializer })
  rematerialize(workspace)
  const forms = buildForms(model, emptySidecar())

  // Sites have a German label column; vocabularies have one too, but are
  // filled through the concept pickers of other forms, not a form of their own.
  const site = forms.forms.find((f) => f.label === 'E27 Site')
  const fieldKeys = site?.fields.map((f) => f.key) || []
  check(fieldKeys.includes('label') && fieldKeys.includes('label@de'),
    'a type with a German label column gets a German label field', JSON.stringify(fieldKeys))
  check(site?.fields.find((f) => f.key === 'label')?.label === 'Label (en)',
    'the primary label field names its language')

  const find = forms.forms.find((f) => f.label === 'Find')
  check(find && !find.fields.some((f) => f.key === 'label@de'),
    'a type without a German column gets no German field — the column belongs to the mapping')

  const SITE = 'http://example.org/example-indy-style/the_secret_place'
  check(!loaded.graph.nodes[SITE]?.l_i18n, 'a site without a German label has no l_i18n')
  const meadow = rowsForForm(workspace, site).find((r) => r.row.label_de)
  check(valuesFromRow(site, meadow.row)['label@de'] === 'Schlangenau', 'the form reads the German label from its column')

  const record = rowsForForm(workspace, site).find((r) => r.row.uri === SITE)
  updateRecord(workspace, site, record.rowId, { ...valuesFromRow(site, record.row), 'label@de': 'Der geheime Ort' }, { source: 'test' })
  const graph = rematerialize(workspace)
  const node = graph.nodes[SITE]
  check(node?.l_i18n?.de === 'Der geheime Ort' && node.l === 'The Secret Place',
    'entering the German label gives the node l_i18n.de and leaves the primary label alone', JSON.stringify(node && { l: node.l, l_i18n: node.l_i18n }))

  // ---- writing it back -------------------------------------------------------
  addRow(workspace, site.tableId, { uri: 'http://example.org/example-indy-style/test', label: 'Test', label_de: 'Prüfung' })
  const written = writeProjectFile(model)
  const original = JSON.parse(exampleText)
  check(JSON.stringify(written.languages) === JSON.stringify(original.languages), 'the project file keeps its languages')
  const lost = Object.keys(original).filter((k) => !(k in written))
  check(!lost.length, `every top-level field of the Studio's file is written back (${Object.keys(original).join(', ')})`, `lost: ${lost}`)
  const meta = written.tables.find((e) => e.tableId === site.tableId)
  check(meta?.rowCount === model.tables.get(site.tableId).rows.length && meta.rowCount === 6,
    'the Studio\'s table summary counts the row added here', JSON.stringify(meta && { rowCount: meta.rowCount }))
  const node4 = written.nodes.find((n) => n.data?.explorerLabel === 'Object Type')
  check(JSON.stringify(node4?.data?.labelColumnI18n) === '{"de":"label_de"}' && node4?.data?.explorerLabelI18n?.de === 'Objekttyp',
    'the language maps on the canvas nodes are untouched')

  // ---- the saved copy in the browser -------------------------------------------
  const snapshot = buildSnapshot({ workspace, config: emptySidecar(), filename: 'example.json', author: 'test' })
  const restored = projectFromSnapshot(JSON.parse(JSON.stringify(snapshot)))
  check(JSON.stringify(restored.languages) === JSON.stringify(original.languages) && 'wideningAll' in restored,
    'the saved copy keeps the languages and the Studio\'s other fields')
  const again = loadFile('restored.json', JSON.stringify(restored))
  check(again.graph.nodes[SITE]?.l_i18n?.de === 'Der geheime Ort',
    'restoring it gives back the German label entered')
}

// ---- a project from before Studio 3.1 ---------------------------------------------
if (!fs.existsSync(path.join(root, '_session/OntoCartographer_Projektdatei.json'))) console.log('skip  the reference data (_session/) is not in this copy — it is research data and not distributed with the Navigator')
else {
  const text = fs.readFileSync(path.join(root, '_session/OntoCartographer_Projektdatei.json'), 'utf8')
  const loaded = loadFile('reference.json', text)
  check(loaded.model.languages === null && loaded.warnings.some((w) => w.includes('before the Studio named languages')),
    'a project naming no languages says so on loading')
  check(!loaded.graph.languages && !Object.values(loaded.graph.nodes).some((n) => n.l_i18n),
    'its graph keeps the monolingual shape: no languages, no l_i18n')
  check(!('languages' in writeProjectFile(loaded.model)), 'and it is written back without inventing languages')

  // Declaring them — what Settings → Languages does through the store.
  const model = readProjectFile(JSON.parse(text))
  model.languages = { primary: 'de', additional: ['en'] }
  const written = writeProjectFile(model)
  check(JSON.stringify(written.languages) === '{"primary":"de","additional":["en"]}',
    'languages declared here are written into the project file for the Studio')
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — languages hold')
process.exit(failures ? 1 : 0)
