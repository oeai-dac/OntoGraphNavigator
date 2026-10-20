/**
 * How the materialisation behaves on large graphs.
 *
 *   node --max-old-space-size=8192 tests/run-scale-bench.mjs [--factors=1,10,30]
 *
 * Not part of `npm run check`: it measures, it does not decide pass or fail.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

register('./resolve-extensionless.mjs', import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const args = process.argv.slice(2)
const factors = (args.find((a) => a.startsWith('--factors=')) || '--factors=1,10,30')
  .split('=')[1].split(',').map(Number)

const { readProjectFile } = await import(pathToFileURL(path.join(root, 'src/lib/projectFile.js')))
const { materialize } = await import(pathToFileURL(path.join(root, 'src/lib/materialize.js')))
const { scaleModel } = await import(pathToFileURL(path.join(here, 'fixtures/make-large-model.mjs')))

if (!fs.existsSync(path.join(root, '_session/OntoCartographer_Projektdatei.json'))) {
  console.log('skip  the reference data (_session/) is not in this copy — it is research data and not distributed with the Navigator')
  process.exit(0)
}
const project = JSON.parse(fs.readFileSync(path.join(root, '_session/OntoCartographer_Projektdatei.json'), 'utf8'))
const base = readProjectFile(project)
const DRIFT = { n47: { idColumn: 'SE_Zuordnung_ID' } }

const mb = (n) => `${Math.round(n / 1048576)} MB`

for (const f of factors) {
  const model = scaleModel(base, f)
  const rows = [...model.tables.values()].reduce((n, t) => n + t.rows.length, 0)
  global.gc?.()
  const heap0 = process.memoryUsage().heapUsed
  const times = []
  let graph
  for (let run = 0; run < 3; run++) {
    const t0 = performance.now()
    graph = materialize(model, { overrides: DRIFT }).graph
    times.push(performance.now() - t0)
  }
  const heap1 = process.memoryUsage().heapUsed
  const nodes = Object.keys(graph.nodes).length
  let maxIn = 0
  for (const n of Object.values(graph.nodes)) for (const list of Object.values(n.i)) maxIn = Math.max(maxIn, list.length)
  console.log(
    `x${String(f).padEnd(3)} rows ${String(rows).padStart(8)}  nodes ${String(nodes).padStart(8)}  ` +
      `materialize ${times.map((t) => `${Math.round(t)}`).join(' / ')} ms  ` +
      `heap +${mb(heap1 - heap0)}  longest incoming list ${maxIn}`
  )
}
