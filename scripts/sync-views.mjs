#!/usr/bin/env node
/**
 * Bring the copy of the GraphExplorer's views up to date.
 *
 *   npm run sync-views                       # from ../GraphExplorer
 *   npm run sync-views -- --from D:/repos/GraphExplorer
 *
 * The views — Explorer, Graph, Harris matrix, Map, 3D, Timeline, Charts,
 * Dashboard — are written and checked in the GraphExplorer, in its
 * `src/views/` folder. This tool shows them over the graph it edits, from a
 * copy: whoever downloads the OntoGraphNavigator gets one repository and
 * nothing to place beside it. The price is this script, run by whoever
 * changes a view, and never an edit to the copy itself.
 *
 * What it does: replaces src/views/ with the GraphExplorer's, writes
 * src/views/VENDORED.json (source version and commit, a checksum per file),
 * and says which npm packages the views import that package.json here lacks
 * or pins differently. tests/run-views-check.mjs then reports any file of the
 * copy that no longer matches its checksum.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const fromArg = args.indexOf('--from')
const source = path.resolve(fromArg >= 0 ? args[fromArg + 1] : path.join(root, '..', 'GraphExplorer'))
const sourceViews = path.join(source, 'src', 'views')
const targetViews = path.join(root, 'src', 'views')

if (!fs.existsSync(path.join(sourceViews, 'index.js'))) {
  console.error(`No GraphExplorer views at ${sourceViews}. Pass --from <path to the GraphExplorer>.`)
  process.exit(2)
}

const listFiles = (dir) => {
  const out = []
  ;(function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name)
      if (fs.statSync(p).isDirectory()) walk(p)
      else out.push(path.relative(dir, p).split(path.sep).join('/'))
    }
  })(dir)
  return out.sort()
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (cmd) => {
  try {
    return execSync(`git ${cmd}`, { cwd: source, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

// ---- copy -------------------------------------------------------------------
fs.rmSync(targetViews, { recursive: true, force: true })
const files = listFiles(sourceViews)
const checksums = {}
for (const rel of files) {
  const from = path.join(sourceViews, rel)
  const to = path.join(targetViews, rel)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  checksums[rel] = sha256(to)
}

const sourcePackage = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
const commit = git('rev-parse --short HEAD')
const uncommitted = git('status --porcelain -- src/views')
const manifest = {
  note: 'A copy of the GraphExplorer\'s src/views. Do not edit — change the GraphExplorer and run `npm run sync-views`.',
  source: 'GraphExplorer',
  version: sourcePackage.version,
  commit: commit ? `${commit}${uncommitted ? ' + uncommitted changes' : ''}` : 'unknown',
  syncedAt: new Date().toISOString(),
  files: checksums,
}
fs.writeFileSync(path.join(targetViews, 'VENDORED.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`copied ${files.length} files from GraphExplorer ${manifest.version} (${manifest.commit})`)

// ---- packages the views import -------------------------------------------------
const ownPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const imported = new Set()
for (const rel of files.filter((f) => /\.(js|jsx|mjs)$/.test(f))) {
  const text = fs.readFileSync(path.join(targetViews, rel), 'utf8')
  // import … from 'x' / import 'x' at the start of a line, and import('x').
  const pattern = /^\s*import\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm
  for (const m of text.matchAll(pattern)) {
    const spec = m[1] || m[2]
    if (spec.startsWith('.')) continue
    imported.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
  }
}
const problems = []
for (const pkg of [...imported].sort()) {
  const theirs = sourcePackage.dependencies?.[pkg]
  const ours = ownPackage.dependencies?.[pkg]
  if (!ours) problems.push(`  missing here: ${pkg} ${theirs || ''}  →  npm install ${pkg}${theirs ? `@${theirs}` : ''}`)
  else if (theirs && theirs !== ours) problems.push(`  different range: ${pkg} — GraphExplorer ${theirs}, here ${ours}`)
}
if (problems.length) {
  console.log('\nnpm packages the views import:')
  for (const line of problems) console.log(line)
} else {
  console.log(`all ${imported.size} npm packages the views import are in package.json, at the GraphExplorer's ranges`)
}
