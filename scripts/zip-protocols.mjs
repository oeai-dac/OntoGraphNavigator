#!/usr/bin/env node
/**
 * The recording protocol packages as the .zip files the Navigator takes
 * (Settings → Recording protocols → "Add a protocol"). None comes with the Navigator itself: a project adds the ones it
 * uses and binds their fields to its mapping.
 *
 *   protocols/source/<id>/   protocol.json, schema.json, bindings.json,
 *                            pdf-fields.json, template.pdf — edited here
 *   protocols/<id>.zip       built from it — handed on, added in the Navigator
 *
 *   npm run protocols
 *
 * The zips are written the same way each time (sorted, fixed dates), so an
 * unchanged package gives the same bytes; tests/run-protocols-check.mjs reports
 * a zip that is behind its source.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const here = path.dirname(fileURLToPath(import.meta.url))
export const PROTOCOLS = path.join(here, '..', 'protocols')
const FIXED = new Date('2026-01-01T00:00:00Z')

/** The bytes of one package's zip, from its source folder. */
export function zipPackage(dir) {
  const files = {}
  for (const name of fs.readdirSync(dir).sort()) files[name] = [new Uint8Array(fs.readFileSync(path.join(dir, name))), { mtime: FIXED }]
  return zipSync(files, { level: 9, mtime: FIXED })
}

/** Every package under protocols/source, as protocols/<id>.zip. */
export function zipProtocols() {
  const out = []
  for (const id of fs.readdirSync(path.join(PROTOCOLS, 'source')).sort()) {
    const dir = path.join(PROTOCOLS, 'source', id)
    if (!fs.statSync(dir).isDirectory()) continue
    const bytes = zipPackage(dir)
    fs.writeFileSync(path.join(PROTOCOLS, `${id}.zip`), bytes)
    out.push({ id, bytes: bytes.length })
  }
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const { id, bytes } of zipProtocols()) console.log(`protocols/${id}.zip  ${Math.round(bytes / 1024)} KB`)
}
