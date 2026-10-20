/**
 * The project as one file: `<name>.ognproj`.
 *
 * A zip, so that what belongs together travels together:
 *
 *   manifest.json            what this is, written by which version
 *   project.json             the Studio's project file, exactly as the Studio
 *                            reads it — mapping and tables
 *   ogn.json                 the Navigator's settings (lib/sidecar.js): identifier
 *                            rules, thesaurus bindings, field order, protocol
 *                            bindings, matrix positions
 *   protocols/<id>/<file>    the recording protocol packages the project uses
 *   thesauri/<n>.ttl         the vocabularies loaded, as read (file or online)
 *   journal.json             the changes made — undo, the log and the
 *                            provenance go on from where they were
 *   rowids.json              how the journal names the rows (lib/edits.js)
 *
 * The Studio's format has no slot for the Navigator's settings — a field put
 * into project.json would be dropped the next time the Studio saves it. So the
 * project file stays the Studio's, untouched, and the rest lies beside it in
 * the same zip. For the Studio, the project file is exported on its own.
 */

import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate'
import { writeProjectFile } from './projectFile'
import { readSidecar, writeSidecar } from './sidecar'
import { rowIdsOf } from './edits'

export const PROJECT_ZIP_EXTENSION = 'ognproj'
export const PROJECT_ZIP_KIND = 'ontographnavigator-project'
export const PROJECT_ZIP_VERSION = 1

/** Does this look like a zip (rather than JSON or RDF text)? */
export function isZip(bytes) {
  return bytes && bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

const safe = (s) => String(s || 'package').replace(/[^A-Za-z0-9._-]+/g, '_')

/**
 * The project, its settings and its packages as the bytes of a `.ognproj`.
 * `packages`: the protocol packages to keep with it — each with `files`
 * ({ name: text | bytes }), as they were imported.
 */
export function buildProjectZip({ model, config, packages = [], thesauri = [], journal = null, name = 'project' }) {
  const files = {}
  const included = []
  const vocabularies = []
  thesauri.filter((t) => t?.source).forEach((t, i) => {
    const file = `thesauri/${String(i + 1).padStart(2, '0')}_${safe(t.name).slice(0, 60)}.ttl`
    files[file] = strToU8(t.source)
    vocabularies.push({ id: t.id, name: t.name, origin: t.origin || null, file })
  })
  if (journal) {
    files['journal.json'] = strToU8(JSON.stringify(journal))
    files['rowids.json'] = strToU8(JSON.stringify(rowIdsOf(model)))
  }
  for (const pkg of packages) {
    if (!pkg?.files) continue
    const dir = `protocols/${safe(pkg.id)}/`
    for (const [file, content] of Object.entries(pkg.files)) {
      const base = file.split('/').pop()
      if (!base) continue
      files[dir + base] = typeof content === 'string' ? strToU8(content) : new Uint8Array(content)
    }
    included.push(pkg.id)
  }
  files['manifest.json'] = strToU8(JSON.stringify({
    kind: PROJECT_ZIP_KIND,
    version: PROJECT_ZIP_VERSION,
    name,
    savedAt: new Date().toISOString(),
    project: 'project.json',
    settings: 'ogn.json',
    protocols: included,
    thesauri: vocabularies,
    journal: journal ? 'journal.json' : null,
    rowIds: journal ? 'rowids.json' : null,
  }, null, 2))
  files['project.json'] = strToU8(JSON.stringify(writeProjectFile(model)))
  files['ogn.json'] = strToU8(writeSidecar(config))
  return zipSync(files, { level: 6 })
}

/**
 * A `.ognproj` taken apart.
 * @returns {{ projectText, config: object|null, packages: [{ id, files }],
 *   thesauri: [{ id, name, origin, text }], journal: object|null, rowIds, manifest }}
 */
export function readProjectZip(bytes) {
  let entries
  try {
    entries = unzipSync(new Uint8Array(bytes))
  } catch (error) {
    throw new Error(`Not a readable project zip: ${error.message}`)
  }
  const text = (name) => (entries[name] ? strFromU8(entries[name]) : null)
  let manifest = null
  try {
    manifest = JSON.parse(text('manifest.json') || 'null')
  } catch {
    manifest = null
  }
  if (manifest && manifest.kind !== PROJECT_ZIP_KIND) throw new Error('This zip is not an OntoGraphNavigator project.')
  const projectText = text(manifest?.project || 'project.json')
  if (!projectText) throw new Error('The project zip holds no project.json.')
  const settingsText = text(manifest?.settings || 'ogn.json')
  const config = settingsText ? readSidecar(JSON.parse(settingsText)) : null
  const byPackage = new Map()
  for (const [name, content] of Object.entries(entries)) {
    const m = name.match(/^protocols\/([^/]+)\/([^/]+)$/)
    if (!m) continue
    if (!byPackage.has(m[1])) byPackage.set(m[1], {})
    byPackage.get(m[1])[m[2]] = content
  }
  const thesauri = (manifest?.thesauri || [])
    .filter((t) => entries[t.file])
    .map((t) => ({ id: t.id, name: t.name, origin: t.origin, text: text(t.file) }))
  let journal = null
  let rowIds = null
  try {
    journal = JSON.parse(text(manifest?.journal || 'journal.json') || 'null')
    rowIds = JSON.parse(text(manifest?.rowIds || 'rowids.json') || 'null')
  } catch {
    journal = null
  }
  // A journal is of use only with the names it gives the rows.
  if (!rowIds) journal = null
  return {
    projectText,
    config,
    packages: [...byPackage.entries()].map(([id, files]) => ({ id, files })),
    thesauri,
    journal: journal && Array.isArray(journal.entries) ? journal : null,
    rowIds,
    manifest,
  }
}
