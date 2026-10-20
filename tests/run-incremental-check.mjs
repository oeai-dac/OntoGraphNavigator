/**
 * The incrementally maintained graph against a fresh one.
 *
 * Random edits go through the real write layer — cells, join keys, dot-one
 * values, labels, new rows, deleted rows, undo and redo — and after each one
 * the graph the materializer kept up to date must equal what a full run over
 * the same tables produces. Equal means: the same node ids, and per node the
 * same type, label, attributes and both edge lists *in the same order*; the
 * same counts, schema and diagnostics.
 *
 *   node tests/run-incremental-check.mjs [--ops=N] [--seed=N] [--bench=F]
 *
 *   --bench=F  additionally time single edits on the reference project scaled
 *              F times (see fixtures/make-large-model.mjs) — default 30
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

const args = process.argv.slice(2)
const arg = (name, dflt) => Number((args.find((a) => a.startsWith(`--${name}=`)) || `=${dflt}`).split('=')[1])
const OPS = arg('ops', 1500)
const SEED = arg('seed', 7)
const BENCH = arg('bench', 30)

const { readProjectFile } = await load('projectFile.js')
const { createMaterializer, materialize } = await load('materialize.js')
const { createJournal } = await load('journal.js')
const { createWorkspace, rematerialize, setCell, addRow, deleteRow, undo, redo, rowIdOf } = await load('edits.js')
const { scaleModel } = await import(pathToFileURL(path.join(here, 'fixtures/make-large-model.mjs')))

let failures = 0
const fail = (headline, details = []) => {
  failures++
  console.log(`FAIL  ${headline}`)
  for (const line of details.slice(0, 8)) console.log(`        ${line}`)
}
const pass = (headline) => console.log(`ok    ${headline}`)

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Columns any rule reads, per table — the ones worth editing. */
function interestingColumns(model) {
  const byTable = new Map()
  const note = (t, c) => {
    if (!t || !c) return
    if (!byTable.has(t)) byTable.set(t, new Set())
    byTable.get(t).add(c)
  }
  const ent = (id) => model.entities.get(id)
  for (const e of model.entities.values()) {
    note(e.tableId, e.idColumn)
    note(e.tableId, e.labelColumn)
  }
  for (const r of [...model.relations, ...model.dot1Relations]) {
    note(ent(r.source)?.tableId, r.joinSource)
    note(ent(r.target)?.tableId, r.joinTarget)
  }
  for (const r of model.dot1Relations) note(r.valueTableId, r.valueColumn)
  for (const le of model.literalEdges) {
    const lit = model.literals.get(le.literalNodeId)
    note(ent(le.source)?.tableId, le.joinSource)
    note(lit?.tableId, le.joinTarget)
    note(lit?.tableId, lit?.valueColumn)
  }
  return byTable
}

/** What differs between two materialisation results; empty when equal. */
function differences(a, b) {
  const out = []
  const ka = Object.keys(a.graph.nodes)
  const kb = new Set(Object.keys(b.graph.nodes))
  if (ka.length !== kb.size) out.push(`node count ${ka.length} vs ${kb.size}`)
  for (const id of ka) {
    if (!kb.has(id)) {
      out.push(`only incremental: ${id}`)
      continue
    }
    const x = JSON.stringify(a.graph.nodes[id])
    const y = JSON.stringify(b.graph.nodes[id])
    if (x !== y) out.push(`node ${id}\n          incr  ${x.slice(0, 300)}\n          fresh ${y.slice(0, 300)}`)
  }
  for (const id of kb) if (!(id in a.graph.nodes)) out.push(`only fresh: ${id}`)
  const sorted = (o) => JSON.stringify(Object.entries(o).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0)))
  for (const k of ['node_types', 'edge_types', 'meta']) {
    if (sorted(a.graph[k]) !== sorted(b.graph[k])) out.push(`${k}: ${sorted(a.graph[k]).slice(0, 200)} vs ${sorted(b.graph[k]).slice(0, 200)}`)
  }
  for (const k of ['typeColors', 'typeLabels', 'edgeLabels']) {
    if (sorted(a.graph.schema[k]) !== sorted(b.graph.schema[k])) out.push(`schema.${k} differs`)
  }
  const da = a.diagnostics
  const db = b.diagnostics
  if (da.attributeConflicts !== db.attributeConflicts) out.push(`attributeConflicts ${da.attributeConflicts} vs ${db.attributeConflicts}`)
  if (da.typeCollisions.length !== db.typeCollisions.length) out.push(`typeCollisions ${da.typeCollisions.length} vs ${db.typeCollisions.length}`)
  if ([...da.unmirroredDot1].sort().join() !== [...db.unmirroredDot1].sort().join()) out.push('unmirroredDot1 differs')
  return out
}

/** Random edits through the write layer; compare after every one. */
function fuzz(name, project, overrides) {
  const model = readProjectFile(project)
  const materializer = createMaterializer(model, { overrides })
  const workspace = createWorkspace({ model, journal: createJournal({ author: 'test' }), materializer })
  rematerialize(workspace)

  const random = rng(SEED)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const columns = interestingColumns(model)
  const tables = [...columns.keys()].filter((t) => model.tables.get(t)?.rows.length)
  const dot1Words = ['über', 'unter', 'gleichzeitig', 'entspricht', 'schneidet', 'above', '']
  const counts = { setValue: 0, addRow: 0, deleteRow: 0, undo: 0, redo: 0 }
  let compared = 0

  for (let op = 0; op < OPS; op++) {
    const tableId = pick(tables)
    const table = model.tables.get(tableId)
    const roll = random()
    if (roll < 0.62 && table.rows.length) {
      const row = pick(table.rows)
      const column = pick([...columns.get(tableId)])
      const isDot1 = model.dot1Relations.some((r) => r.valueTableId === tableId && r.valueColumn === column)
      const r = random()
      // Values from the same column elsewhere make and break real links;
      // empty values remove them; fresh values create nodes nobody refers to.
      const value = isDot1 ? pick(dot1Words)
        : r < 0.6 ? pick(table.rows)[column] ?? ''
          : r < 0.8 ? ''
            : `FUZZ-${op}`
      if (setCell(workspace, tableId, rowIdOf(row), column, value)) counts.setValue++
    } else if (roll < 0.74) {
      const template = table.rows.length ? pick(table.rows) : {}
      const values = { ...template }
      // Half of the new rows are copies — a second value of a relation — and
      // half carry a new identifier in one column.
      if (random() < 0.5) {
        const column = pick([...columns.get(tableId)])
        values[column] = `NEW-${op}`
      }
      addRow(workspace, tableId, values)
      counts.addRow++
    } else if (roll < 0.84 && table.rows.length) {
      deleteRow(workspace, tableId, rowIdOf(pick(table.rows)))
      counts.deleteRow++
    } else if (roll < 0.94) {
      if (undo(workspace)) counts.undo++
    } else if (redo(workspace)) counts.redo++

    // Batches of one to three edits per comparison, like a form save.
    if (random() < 0.5 || op === OPS - 1) {
      rematerialize(workspace)
      const incremental = { graph: workspace.graph, diagnostics: workspace.diagnostics }
      const fresh = materialize(model, { overrides })
      const diff = differences(incremental, fresh)
      compared++
      if (diff.length) {
        fail(`${name}: after edit ${op + 1} the incremental graph differs from a fresh one`, diff)
        return
      }
    }
  }
  pass(
    `${name}: ${OPS} random edits (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}), ` +
      `${compared} comparisons — incremental equals fresh every time`
  )

  // Provenance: every node names rows that exist, and its rows name it back.
  const ids = Object.keys(workspace.graph.nodes)
  let bad = 0
  for (let k = 0; k < 300; k++) {
    const id = pick(ids)
    const prov = materializer.provenanceOf(id)
    if (!prov.length) bad++
    for (const p of prov) {
      if (!model.tables.get(p.srcTable).rows.includes(p.srcRow)) bad++
      if (!materializer.nodesOfRow(p.srcRow).includes(id) && !materializer.nodesOfRow(p.tgtRow).includes(id)) bad++
    }
  }
  if (bad) fail(`${name}: provenance inconsistent in ${bad} case(s)`)
  else pass(`${name}: provenance — 300 nodes traced to their rows and back`)
}

const read = (file) => JSON.parse(fs.readFileSync(path.join(session, file), 'utf8'))
const DRIFT = { n47: { idColumn: 'SE_Zuordnung_ID' } }
// readProjectFile adopts the file's row arrays, so every run reads its own copy.
fuzz('reference project', read('OntoCartographer_Projektdatei.json'), DRIFT)
fuzz('HME project', read('HarrisMatrixEditor_OntoCartographer-Projektdatei.json'), {})
fuzz('example project', JSON.parse(fs.readFileSync(path.join(root, '0_exampleData/OntoCartographer_Projectfile.json'), 'utf8')), {})

// ------------------------------------------------------------- timing
if (BENCH > 0) {
  const model = scaleModel(readProjectFile(read('OntoCartographer_Projektdatei.json')), BENCH)
  let t0 = performance.now()
  const materializer = createMaterializer(model, { overrides: DRIFT })
  const workspace = createWorkspace({ model, journal: createJournal({ author: 'bench' }), materializer })
  rematerialize(workspace)
  const full = performance.now() - t0
  const nodes = Object.keys(workspace.graph.nodes).length

  // Edits that matter: a find moved to another unit, a material changed, a label.
  const random = rng(1)
  const columns = interestingColumns(model)
  const tables = [...columns.keys()].filter((t) => model.tables.get(t)?.rows.length)
  const times = []
  for (let k = 0; k < 200; k++) {
    const tableId = tables[Math.floor(random() * tables.length)]
    const table = model.tables.get(tableId)
    const cols = [...columns.get(tableId)]
    const column = cols[Math.floor(random() * cols.length)]
    const row = table.rows[Math.floor(random() * table.rows.length)]
    const value = table.rows[Math.floor(random() * table.rows.length)][column] ?? ''
    t0 = performance.now()
    setCell(workspace, tableId, rowIdOf(row), column, value)
    rematerialize(workspace)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(1)
  console.log(
    `\ntiming x${BENCH}: ${nodes} nodes — full run ${Math.round(full)} ms; ` +
      `one edit: median ${q(0.5)} ms, 95% ${q(0.95)} ms, max ${q(1)} ms`
  )
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — the incremental graph equals a fresh one')
process.exit(failures ? 1 : 0)
