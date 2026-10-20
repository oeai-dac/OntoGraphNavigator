/**
 * Keeping work safe between one reload and the next.
 *
 * A browser cannot write the project file to disk on its own, so "save the
 * project file every x minutes" is not available — that needs a click, and on
 * most browsers a fresh one each time. What *is* available is a copy in the
 * browser's own storage, which is what this does: the tables, the journal and the
 * settings, written every half minute while there is anything unsaved, and
 * offered back on the next start.
 *
 * The copy is deduplicated. `writeProjectFile` repeats the tables on every node
 * that sits on them — 46 MB for the reference project — and writing that every
 * thirty seconds would be absurd. Stored here: one copy of each table, plus the
 * canvas without its rows. Restoring puts them back together.
 *
 * It is *not* a substitute for saving the project file. Browser storage is per
 * browser and per profile, and a cleared cache takes it with it. Same caveat HME
 * carries, and worth repeating in the interface.
 */

import { MIDPOINT_TYPE, writeProjectFile } from './projectFile'
import { rowIdsOf } from './edits'

export const SNAPSHOT_VERSION = 1
export const AUTOSAVE_INTERVAL_MS = 30_000

/**
 * @param {object} state  { workspace, config, filename, author, source }
 * @returns {object|null} null when there is nothing worth keeping
 */
export function buildSnapshot({ workspace, config, filename, author }) {
  if (!workspace?.model) return null
  const { model, journal } = workspace
  // Nothing changed — neither the data nor where units were placed by hand.
  if (!journal?.cursor && !Object.keys(config?.matrixPositions || {}).length) return null

  const tables = []
  for (const table of model.tables.values()) {
    tables.push({ id: table.id, name: table.name, columns: table.columns, rows: table.rows })
  }

  // The canvas without rows — the rows are in `tables`, once each.
  const nodes = model.canvas.nodes.map((node) => {
    if (!node.data) return node
    const { tableRows, ...data } = node.data
    return { ...node, data }
  })

  return {
    version: SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    filename: filename || 'project.json',
    author: author || '',
    changes: journal.cursor,
    config,
    journal,
    // How the journal names the rows; they are made up per load (lib/edits.js).
    rowIds: rowIdsOf(model),
    // The same head as a written project file — languages and every field the
    // Studio added included — without writing the rows out once per node.
    project: { ...projectHead(model), nodes, edges: model.canvas.edges },
    tables,
  }
}

/**
 * Reassemble the project file a snapshot describes.
 * The result goes through the ordinary load path, so nothing about restoring is
 * a second code route that could drift from the first.
 */
function projectHead(model) {
  const { nodes: _nodes, edges: _edges, ...head } = writeProjectFile({ ...model, canvas: { nodes: [], edges: [] } })
  return head
}

export function projectFromSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== SNAPSHOT_VERSION) {
    throw new Error('This saved copy was written by a different version and cannot be read.')
  }
  const byId = new Map(snapshot.tables.map((table) => [table.id, table]))
  const nodes = snapshot.project.nodes.map((node) => {
    if (node.type === MIDPOINT_TYPE || !node.data?.tableId) return node
    const table = byId.get(node.data.tableId)
    if (!table) return node
    return { ...node, data: { ...node.data, tableRows: table.rows } }
  })
  return { ...snapshot.project, nodes }
}

/** How old a snapshot is, in words. */
export function describeAge(savedAt, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - new Date(savedAt).getTime()) / 1000))
  if (seconds < 60) return `${seconds} seconds ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${Math.round(hours / 24)} days ago`
}
