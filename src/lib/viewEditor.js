/**
 * Editing from the GraphExplorer's views: "this node, this attribute" back to
 * the table cells it was read from.
 *
 * The views show the materialised graph; the truth is the tables. The
 * materializer's provenance index knows which rows each statement came from
 * (provenanceOf), and for an attribute that is a folded literal: its row, and
 * the literal's value column. So an attribute can be written where it was
 * read — through the write layer, as journal entries, undoable like any other.
 *
 * When it can:
 *   - one cell holds it                       → that cell
 *   - several cells hold the same value       → all of them, as one step
 *     (a unit spanning three rows repeats its description on each; changing
 *     one would show "new; old" afterwards)
 *   - several cells hold different values     → not here: the view shows
 *     them joined ("a; b"), and which part goes where is not knowable
 *   - no cell (a graph without its project)   → not here at all
 */

import { inGroup, rowIdOf, setCell } from './edits'

/** How the materializer reads a literal cell — it has to match to compare. */
const normalise = (v) => (v === null || v === undefined ? '' : String(v).replace(/[\r\n\t]+/g, ' ').trim())

/** The cells an attribute of a node was read from: [{ tableId, rowId, column, value }]. */
export function attributeCells(workspace, nodeId, key) {
  const materializer = workspace?.materializer
  if (!materializer) return []
  const out = []
  const seen = new Set()
  for (const p of materializer.provenanceOf(nodeId)) {
    if (p.kind !== 'literal' || p.role !== 'source' || p.rule.attrKey !== key) continue
    const column = workspace.model.literals.get(p.rule.literalNodeId)?.valueColumn
    if (!column) continue
    const rowId = rowIdOf(p.tgtRow)
    const id = `${p.tgtTable}\u0000${rowId}\u0000${column}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ tableId: p.tgtTable, rowId, column, value: normalise(p.tgtRow[column]) })
  }
  return out
}

/**
 * Whether a view may edit this attribute, and why not if it may not.
 * @returns {{editable: true, cells: number} | {editable: false, reason: string}}
 */
export function describeAttribute(workspace, nodeId, key) {
  if (!workspace?.materializer) return { editable: false, reason: 'Only a project file can be edited — this graph came without its tables.' }
  const cells = attributeCells(workspace, nodeId, key)
  if (!cells.length) return { editable: false, reason: 'This value does not come from a table column.' }
  const values = new Set(cells.map((c) => c.value))
  if (values.size > 1) {
    return {
      editable: false,
      reason: `Joined from ${values.size} different values in ${cells.length} rows — change them in the form or the table.`,
    }
  }
  return { editable: true, cells: cells.length }
}

/**
 * Write an attribute where it was read. One journal group, so one undo.
 * @returns {{ok: true, changed: number} | {ok: false, error: string}}
 */
export function writeAttribute(workspace, nodeId, key, value) {
  const verdict = describeAttribute(workspace, nodeId, key)
  if (!verdict.editable) return { ok: false, error: verdict.reason }
  const cells = attributeCells(workspace, nodeId, key)
  let changed = 0
  inGroup(workspace, () => {
    for (const c of cells) {
      if (setCell(workspace, c.tableId, c.rowId, c.column, value, { source: 'view' })) changed++
    }
  })
  return { ok: true, changed }
}
