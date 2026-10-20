/**
 * The copy of the GraphExplorer's views is still the copy.
 *
 * src/views/ comes from the GraphExplorer (scripts/sync-views.mjs) and is
 * changed there only. A file edited here would be overwritten by the next
 * sync — silently, unless this check says so first. It also checks that every
 * npm package the views import is a dependency here, since the copy brings
 * the code but not the packages.
 *
 * Needs nothing beside this repository: the checksums are in
 * src/views/VENDORED.json.
 *
 *   node tests/run-views-check.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const views = path.join(root, 'src', 'views')

let failures = 0
const check = (cond, what, details = []) => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}`)
  for (const d of details.slice(0, 10)) console.log(`        ${d}`)
  if (!cond) failures++
}

const manifestPath = path.join(views, 'VENDORED.json')
if (!fs.existsSync(manifestPath)) {
  check(false, 'src/views/VENDORED.json exists — run `npm run sync-views`')
  process.exit(1)
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

const present = []
;(function walk(d) {
  for (const name of fs.readdirSync(d)) {
    const p = path.join(d, name)
    if (fs.statSync(p).isDirectory()) walk(p)
    else present.push(path.relative(views, p).split(path.sep).join('/'))
  }
})(views)

const listed = Object.keys(manifest.files)
const sha256 = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(views, rel))).digest('hex')
const edited = listed.filter((rel) => present.includes(rel) && sha256(rel) !== manifest.files[rel])
const missing = listed.filter((rel) => !present.includes(rel))
const added = present.filter((rel) => rel !== 'VENDORED.json' && !listed.includes(rel))

check(!edited.length && !missing.length && !added.length,
  `src/views is the GraphExplorer's, as synced: ${listed.length} files from ${manifest.source} ${manifest.version} (${manifest.commit})`,
  [
    ...edited.map((f) => `edited here: ${f} — make the change in the GraphExplorer and run npm run sync-views`),
    ...missing.map((f) => `missing: ${f}`),
    ...added.map((f) => `not from the GraphExplorer: ${f}`),
  ])

// ---- npm packages ------------------------------------------------------------------
const ownPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const imported = new Set()
const pattern = /^\s*import\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm
for (const rel of present.filter((f) => /\.(js|jsx|mjs)$/.test(f))) {
  for (const m of fs.readFileSync(path.join(views, rel), 'utf8').matchAll(pattern)) {
    const spec = m[1] || m[2]
    if (spec.startsWith('.')) continue
    imported.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
  }
}
const lacking = [...imported].filter((pkg) => !ownPackage.dependencies?.[pkg])
check(!lacking.length, `the ${imported.size} npm packages the views import are dependencies here (${[...imported].sort().join(', ')})`,
  lacking.map((pkg) => `missing: ${pkg} — see npm run sync-views for the GraphExplorer's range`))

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — the views are the GraphExplorer\'s')
process.exit(failures ? 1 : 0)
