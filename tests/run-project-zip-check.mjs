/**
 * The project zip, `.ognproj` (src/lib/projectZip.js):
 *
 *   - project, settings (identifier rules, matrix positions) and a protocol
 *     package written and read back the same — the project file inside exactly
 *     the one the Studio gets on its own;
 *   - an edit carried through, with the journal (undo goes on);
 *   - a loaded vocabulary kept as read, bound again without a fetch;
 *   - opened through the store as the application opens it: the settings and
 *     the package come back instead of a fresh guess.
 *
 *   node tests/run-project-zip-check.mjs
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
const { writeProjectFile } = await load('src/lib/projectFile.js')
const { createJournal } = await load('src/lib/journal.js')
const { createWorkspace, setCell, rowIdOf } = await load('src/lib/edits.js')
const { emptySidecar } = await load('src/lib/sidecar.js')
const { readKeptThesaurus } = await load('src/lib/thesaurusSources.js')
const Z = await load('src/lib/projectZip.js')

let failures = 0
const check = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${!cond && detail ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

const text = fs.readFileSync(path.join(root, '0_exampleData/OntoCartographer_Projectfile.json'), 'utf8')
const loaded = loadFile('p.json', text)
const ws = createWorkspace({ model: loaded.model, journal: createJournal({}), materializer: loaded.materializer })
const config = {
  ...emptySidecar(),
  uriRules: { n3: 'TSP-{SU~num}' },
  matrixPositions: { 'unit|rel||': { 'http://x/SU1001': { x: 120, y: 340 } } },
  protocolBindings: { 'bda-holz': { unitNodeId: 'n3', fields: { 'befunddaten.Profil': { use: 'omit' } } } },
  author: 'B. D.',
}
// The package part needs the BDA packages, which are kept on this machine only.
const holzDir = path.join(root, 'protocols/source/bda-holz')
const havePackage = fs.existsSync(holzDir)
if (!havePackage) console.log('skip  the BDA protocol packages (protocols/) are not in this copy — the project zip is checked without one')
const holz = {}
if (havePackage) for (const f of fs.readdirSync(holzDir)) holz[f] = new Uint8Array(fs.readFileSync(path.join(holzDir, f)))
const pkgs = havePackage ? [{ id: 'test-holz', files: holz }] : []

// An edit, carried through.
const table = [...ws.model.tables.values()].find((t) => t.rows.length)
const column = table.columns.find((c) => typeof table.rows[0][c] === 'string')
setCell(ws, table.id, rowIdOf(table.rows[0]), column, 'changed in the Navigator')

// A vocabulary, as it was loaded from a file.
const skos = `@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
<http://x/voc> a skos:ConceptScheme .
<http://x/voc/holz> a skos:Concept ; skos:inScheme <http://x/voc> ; skos:prefLabel "Holz"@de, "wood"@en .
<http://x/voc/stein> a skos:Concept ; skos:inScheme <http://x/voc> ; skos:prefLabel "Stein"@de .`
const voc = readKeptThesaurus({ text: skos, name: 'Materialien', origin: { kind: 'file', filename: 'Materialien.ttl' } })
config.thesaurusBindings = { n3: { thesaurusId: voc.id, languages: ['de', 'en'] } }

const bytes = Z.buildProjectZip({ model: ws.model, config, packages: pkgs, thesauri: [voc], journal: ws.journal, name: 'Grabung' })
check(Z.isZip(bytes) && !Z.isZip(new TextEncoder().encode(text)), `written: a zip of ${Math.round(bytes.length / 1024)} KB, told apart from a project file`)
const back = Z.readProjectZip(bytes)
check(back.manifest?.kind === Z.PROJECT_ZIP_KIND && back.manifest.protocols.join() === pkgs.map((x) => x.id).join(), 'the manifest names what is inside')
check(back.projectText === JSON.stringify(writeProjectFile(ws.model)), 'project.json is exactly the project file the Studio gets on its own')
check(JSON.stringify(back.config.uriRules) === JSON.stringify(config.uriRules) && JSON.stringify(back.config.matrixPositions) === JSON.stringify(config.matrixPositions) && back.config.author === 'B. D.',
  'the settings come back: identifier rules, matrix positions, author')
const p = back.packages[0]
if (havePackage) check(back.packages.length === 1 && Object.keys(holz).every((f) => Buffer.compare(Buffer.from(p.files[f]), Buffer.from(holz[f])) === 0), 'the protocol package comes back, byte for byte')
check(back.thesauri.length === 1 && back.thesauri[0].text === skos && back.thesauri[0].origin?.filename === 'Materialien.ttl', 'the vocabulary comes back as it was read, with where it came from')
check(back.journal?.cursor === ws.journal.cursor && back.journal.entries.length === ws.journal.entries.length && ws.journal.cursor > 0, 'the journal comes back', `${back.journal?.cursor} / ${ws.journal.cursor}`)
const reread = loadFile('project.json', back.projectText)
check(String(reread.model.tables.get(table.id).rows[0][column]) === 'changed in the Navigator', 'the edit is in it')
let refused = false
try { Z.readProjectZip(new TextEncoder().encode('not a zip')) } catch { refused = true }
check(refused, 'anything else is refused with a reason')

// Through the store, as the application opens it.
const { useStore } = await load('src/store.js')
await useStore.getState().load(new File([bytes], 'Grabung.ognproj'))
const s = useStore.getState()
check(s.status === 'ready' && s.source === 'project' && s.filename === 'Grabung.ognproj', 'opened through the store', s.error || '')
check(s.config.uriRules.n3 === 'TSP-{SU~num}' && s.matrixPositions('unit|rel||')['http://x/SU1001']?.x === 120 && s.config.protocolBindings['bda-holz']?.fields['befunddaten.Profil']?.use === 'omit', 'the decided settings, not a fresh guess — protocol bindings too')
if (havePackage) check(s.packages.some((x) => x.id === 'bda-holz' && x.fromProject), 'the package is offered again')
check(s.thesauri.get(voc.id)?.concepts.size === 2 && s.config.thesaurusBindings.n3?.thesaurusId === voc.id, 'the vocabulary is there and bound, without a fetch')
check(s.workspace.journal.cursor === ws.journal.cursor, 'the changes are in the journal, undo goes on')
s.undo()
const afterUndo = useStore.getState()
check(String(afterUndo.workspace.model.tables.get(table.id).rows[0][column]) !== 'changed in the Navigator', 'undo after reopening takes the edit back')
afterUndo.redo()
const again = useStore.getState().saveProject()
check(again.name === 'Grabung.ognproj' && Z.readProjectZip(again.bytes).projectText === back.projectText, 'saved again under its name, the same project')

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — the project zip holds')
process.exit(failures ? 1 : 0)
