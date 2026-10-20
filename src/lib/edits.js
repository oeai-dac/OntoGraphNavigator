/**
 * The write layer.
 *
 * Edits go to table rows; the display graph is recomputed from them. That is the
 * whole reason the project file stays writable and `o`/`i` stay consistent — see
 * materialize.js. Nothing here ever touches a graph node.
 *
 * Rows need stable identity for the journal to refer to, and the project format
 * has no row identifier. One is attached as a *non-enumerable* property, so
 * `Object.keys`, `JSON.stringify` and every exporter step straight over it and
 * the written file is unchanged.
 */

import { append, canRedo, canUndo, inverseOf } from './journal'
import { compactUri, expandId } from './prefixes'
import { mintUnique, renderTemplate } from './uriTemplate'
import { createMaterializer } from './materialize'

const ROW_ID = '__ognRowId'

let counter = 0
const nextRowId = () => `r${(++counter).toString(36)}`

/** Give every row an invisible identifier. Idempotent. */
export function tagRows(model) {
  for (const table of model.tables.values()) {
    for (const row of table.rows) {
      if (!row[ROW_ID]) {
        Object.defineProperty(row, ROW_ID, { value: nextRowId(), enumerable: false, writable: false, configurable: true })
      }
    }
  }
  return model
}

export const rowIdOf = (row) => row?.[ROW_ID] || null

/**
 * The rows' identifiers, table by table in row order. They are made up per
 * load, and the journal names rows by them — so a journal kept beyond the
 * session (project zip, the copy in the browser) is kept with these.
 */
export function rowIdsOf(model) {
  const ids = {}
  for (const table of model.tables.values()) ids[table.id] = table.rows.map((row) => row[ROW_ID] || null)
  return ids
}

/**
 * Give the rows back the identifiers a kept journal names them by (rowIdsOf).
 * Rows are matched by table and position — the project file keeps both. New
 * identifiers made later do not collide with these.
 */
export function restoreRowIds(model, ids) {
  if (!ids) return model
  for (const table of model.tables.values()) {
    const list = ids[table.id]
    if (!Array.isArray(list)) continue
    table.rows.forEach((row, index) => {
      const id = list[index]
      if (typeof id !== 'string' || !id) return
      Object.defineProperty(row, ROW_ID, { value: id, enumerable: false, writable: false, configurable: true })
      const n = parseInt(id.slice(1), 36)
      if (id[0] === 'r' && Number.isFinite(n) && n > counter) counter = n
    })
  }
  return model
}

function findRow(model, tableId, rowId) {
  const table = model.tables.get(tableId)
  if (!table) return { table: null, index: -1, row: null }
  const index = table.rows.findIndex((row) => row[ROW_ID] === rowId)
  return { table, index, row: index >= 0 ? table.rows[index] : null }
}

/**
 * @param {object} options
 * @param {object} options.model    from readProjectFile, already tagged
 * @param {object} options.journal  from createJournal
 * @param {object} [options.config] sidecar settings
 * @param {object} [options.materializer] from createMaterializer over this very
 *        model, when the caller already built one; otherwise built on first use
 */
export function createWorkspace({ model, journal, config = {}, materializer = null }) {
  tagRows(model)
  return { model, journal, config, materializer, dirty: true, graph: null, diagnostics: null }
}

/**
 * Bring the display graph up to date with the tables.
 *
 * Only the nodes the edits since the last call touched are rebuilt — the
 * materializer has been told about every row change by applyEntry. A new graph
 * object comes back each time, so anything keyed on it re-renders; its `nodes`
 * are updated in place, since copying 300k entries per save would cost more
 * than the update itself.
 */
export function rematerialize(workspace) {
  if (!workspace.materializer) workspace.materializer = createMaterializer(workspace.model)
  const { graph, diagnostics } = workspace.materializer.result()
  workspace.graph = graph
  workspace.diagnostics = diagnostics
  workspace.dirty = false
  return graph
}

// ------------------------------------------------------------- applying ops

/** Apply one journal entry to the tables. Used by both editing and redo. */
export function applyEntry(workspace, entry) {
  const { model } = workspace
  const table = model.tables.get(entry.tableId)
  if (!table) throw new Error(`No such table "${entry.tableId}"`)

  if (entry.op === 'setValue') {
    const { row } = findRow(model, entry.tableId, entry.rowId)
    if (!row) throw new Error(`Row ${entry.rowId} no longer exists in ${entry.tableId}`)
    if (entry.after === null || entry.after === '') delete row[entry.column]
    else row[entry.column] = entry.after
    if (!table.columns.includes(entry.column)) table.columns.push(entry.column)
    workspace.materializer?.cellChanged(entry.tableId, row, entry.column)
  } else if (entry.op === 'addRow') {
    const payload = entry.after || {}
    const row = {}
    // Every column, so the table stays rectangular whatever the form filled in.
    for (const column of table.columns) row[column] = payload[column] ?? ''
    for (const [column, value] of Object.entries(payload)) {
      row[column] = value
      if (!table.columns.includes(column)) table.columns.push(column)
    }
    Object.defineProperty(row, ROW_ID, { value: entry.rowId, enumerable: false, writable: false, configurable: true })
    table.rows.push(row)
    workspace.materializer?.rowAdded(entry.tableId, row)
  } else if (entry.op === 'deleteRow') {
    const { index, row } = findRow(model, entry.tableId, entry.rowId)
    if (index >= 0) {
      table.rows.splice(index, 1)
      workspace.materializer?.rowRemoved(entry.tableId, row)
    }
  }
  workspace.dirty = true
  return workspace
}

function record(workspace, operation) {
  const entry = append(workspace.journal, { ...operation, group: workspace.group || null })
  applyEntry(workspace, entry)
  return entry
}

let groupCounter = 0

/**
 * Run `fn` as one action: every journal entry it makes shares a group, and
 * undo and redo take the group as a whole. A form saved is one step back, not
 * one per field. Nested calls join the outer group.
 */
export function inGroup(workspace, fn) {
  if (workspace.group) return fn()
  workspace.group = `g${(++groupCounter).toString(36)}-${Date.now().toString(36)}`
  try {
    return fn()
  } finally {
    workspace.group = null
  }
}

/** Change one cell. A no-op change is not recorded — a log of nothing is noise. */
export function setCell(workspace, tableId, rowId, column, value, options = {}) {
  const { row } = findRow(workspace.model, tableId, rowId)
  if (!row) throw new Error(`Row ${rowId} not found in ${tableId}`)
  const before = row[column] ?? ''
  const after = value ?? ''
  if (String(before) === String(after)) return null
  return record(workspace, { op: 'setValue', tableId, rowId, column, before, after, source: options.source })
}

export function addRow(workspace, tableId, values = {}, options = {}) {
  const rowId = options.rowId || nextRowId()
  record(workspace, { op: 'addRow', tableId, rowId, after: values, source: options.source, note: options.note })
  return rowId
}

export function deleteRow(workspace, tableId, rowId, options = {}) {
  const { row } = findRow(workspace.model, tableId, rowId)
  if (!row) return null
  const payload = { ...row }
  return record(workspace, { op: 'deleteRow', tableId, rowId, before: payload, after: payload, source: options.source })
}

/**
 * Undo moves the cursor back and applies the inverse; it appends nothing, so
 * redo remains available until the next real edit.
 */
export function undo(workspace) {
  const { journal } = workspace
  if (!canUndo(journal)) return null
  const entry = journal.entries[journal.cursor - 1]
  do {
    applyEntry(workspace, inverseOf(journal.entries[journal.cursor - 1]))
    journal.cursor--
  } while (entry.group && canUndo(journal) && journal.entries[journal.cursor - 1].group === entry.group)
  return entry
}

export function redo(workspace) {
  const { journal } = workspace
  if (!canRedo(journal)) return null
  const entry = journal.entries[journal.cursor]
  do {
    applyEntry(workspace, journal.entries[journal.cursor])
    journal.cursor++
  } while (entry.group && canRedo(journal) && journal.entries[journal.cursor].group === entry.group)
  return entry
}

// -------------------------------------------------------------- records

/**
 * The identifier for a concept typed by hand rather than picked.
 *
 * A concept field writes two columns: the identifier and the label. Picking from
 * a vocabulary supplies both. Typing supplies only the label — and without an
 * identifier the concept never becomes a node, so the relation to it silently
 * fails to exist.
 *
 * The reference data shows the convention it expects: `OBJEKT` "Fragment" beside
 * `Object_ID` `oeai:fragment`, `Material` "Ausgerissen" beside `oeai:ausgerissen`,
 * and the relation type "über" stored as `ueber`. So: umlauts transliterated,
 * lower case, anything else to an underscore, under the project's own prefix.
 */
const CONCEPT_UMLAUTS = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'ae', 'Ö': 'oe', 'Ü': 'ue', 'ß': 'ss' }

export function conceptIdFromLabel(label, idPrefix) {
  const slug = String(label ?? '')
    .replace(/[äöüÄÖÜß]/g, (c) => CONCEPT_UMLAUTS[c])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!slug) return ''
  return idPrefix ? `${idPrefix}:${slug}` : slug
}

/** Values already used in an identifier column — for the uniqueness check. */
export function takenIdentifiers(workspace, tableId, column) {
  const table = workspace.model.tables.get(tableId)
  const taken = new Set()
  if (!table || !column) return taken
  for (const row of table.rows) {
    const value = String(row[column] ?? '').trim()
    if (value) taken.add(value)
  }
  return taken
}

/**
 * Turn form values into the cells of one row.
 *
 * `values` is keyed by field key. A concept field carries `{uri, label}`, every
 * other field a plain value. Only fields the form actually shows are written:
 * a row is shared by several entities, and clearing a neighbour's column just
 * because this form does not display it would lose data silently.
 */
/** The identifier a value already has in its table — an object chosen by its name is that object. */
function existingIdFor(workspace, field, label) {
  if (!field.labelColumn) return ''
  const rows = workspace.model.tables.get(field.tableId)?.rows || []
  const row = rows.find((r) => String(r[field.labelColumn] ?? '').trim() === label && String(r[field.column] ?? '').trim())
  return row ? String(row[field.column]).trim() : ''
}

export function cellsForRecord(workspace, form, values, options = {}) {
  const { prefixMap } = workspace.model
  const cells = {}
  const warnings = []

  const identifier = String(values.identifier ?? '').trim()
  if (identifier) cells[form.idColumn] = identifier
  else warnings.push('No identifier — the record would not become a node.')
  const named = [] // name fields: their identifiers, once all cells are known

  const walk = (fields, container) => {
    for (const field of fields) {
      if (field.readOnly) continue
      const value = container[field.key]

      if (field.kind === 'group') {
        const sub = value && typeof value === 'object' ? value : {}
        const anyFilled = field.fields.some((f) => String(sub[f.key] ?? '').trim())
        if (!anyFilled) continue
        // A partner on the same table has its identifier among the subfields;
        // only a folded satellite gets one from a rule.
        if (field.partner) {
          walk(field.fields, sub)
          continue
        }
        // The satellite's identifier is derived, never typed.
        if (field.uriRule) {
          const { value: minted, missing } = renderTemplate(field.uriRule, { ...cells, ...options.row }, {})
          if (minted) cells[field.column] = minted
          if (missing.length) warnings.push(`"${field.label}": the rule could not fill ${missing.join(', ')}.`)
        } else if (!cells[field.column]) {
          warnings.push(`"${field.label}" has no identifier rule, so its node cannot be created.`)
        }
        walk(field.fields, sub)
        continue
      }

      if (field.kind === 'concept') {
        if (!value) continue
        const uri = typeof value === 'object' ? value.uri : value
        const label = typeof value === 'object' ? value.label : ''
        // Stored in the table the way the table stores them: prefix-compacted.
        if (uri) cells[field.column] = compactUri(uri, prefixMap)
        else if (label) cells[field.column] = existingIdFor(workspace, field, label) ||
          (field.idRule && renderTemplate(field.idRule, { [field.labelColumn || field.column]: label }, {}).value) ||
          conceptIdFromLabel(label, workspace.model.idPrefix)
        if (field.labelColumn && label) cells[field.labelColumn] = label
        continue
      }

      if (value === undefined || value === null) continue
      const text = String(value)
      if (!text.trim() && !container[field.key]) continue
      cells[field.column] = text
      if (field.idColumn) named.push({ field, text: text.trim() })
    }
  }
  walk(form.fields, values)
  // A name typed (a designation): its node's identifier by its rule — or gone with it.
  for (const { field, text } of named) {
    if (!text) { cells[field.idColumn] = ''; continue }
    const { value: minted } = field.idRule ? renderTemplate(field.idRule, { ...options.row, ...cells }, {}) : { value: '' }
    cells[field.idColumn] = minted || `${cells[form.idColumn] || String(options.row?.[form.idColumn] ?? '')}_${text}`.replace(/[^A-Za-z0-9_-]+/g, '_')
  }

  return { cells, warnings }
}

/**
 * Make sure the records a cross-table reference points at actually exist.
 *
 * A relation between two tables is an equi-join: the find's row carries the unit
 * number, and the join finds the unit's row by it. Writing only the find's side
 * leaves the join with nothing to match — no unit node, no relation, and a find
 * that appears to be linked to something that is not there.
 *
 * So a referenced value with no counterpart gets one: a row in the other table
 * carrying that identifier. Only when the matched column *is* that table's
 * identifier column; where it is a bare join key, a row built from it would be a
 * record nobody described, and that is reported instead of invented.
 *
 * @returns {{created: Array, unmatched: Array}}
 */
export function ensureReferencedRows(workspace, form, values, options = {}) {
  const created = []
  const unmatched = []

  for (const field of form.fields) {
    if (field.kind !== 'reference' || field.readOnly) continue
    if (!field.matchTableId || !field.matchColumn) continue

    const value = String(values[field.key] ?? '').trim()
    if (!value) continue

    const table = workspace.model.tables.get(field.matchTableId)
    if (!table) continue
    const exists = table.rows.some((row) => String(row[field.matchColumn] ?? '').trim() === value)
    if (exists) continue

    if (!field.matchIsIdentifier) {
      unmatched.push({ label: field.label, value, column: field.matchColumn, tableId: field.matchTableId })
      continue
    }

    addRow(workspace, field.matchTableId, { [field.matchColumn]: value }, {
      source: options.source || 'form',
      note: `implied by ${form.label} ${values.identifier || ''}`.trim(),
    })
    created.push({ label: field.label, value, tableId: field.matchTableId, targetTypeKey: field.targetTypeKey })
  }

  return { created, unmatched }
}

/**
 * Create a record: mint the identifier if a rule is set, then write one row.
 * @returns {{rowId: string|null, identifier: string, warnings: string[], created: Array}}
 */
export function createRecord(workspace, form, values, options = {}) {
  return inGroup(workspace, () => createRecordNow(workspace, form, values, options))
}

function createRecordNow(workspace, form, values, options) {
  const provisional = { ...values }
  const warnings = []

  if (!String(provisional.identifier ?? '').trim() && form.uriRule) {
    const taken = takenIdentifiers(workspace, form.tableId, form.idColumn)
    // Render against the values already given, so a rule may refer to them.
    const context = {}
    const draft = cellsForRecord(workspace, { ...form, uriRule: null }, { ...provisional, identifier: '_' }).cells
    const minted = mintUnique(form.uriRule, draft, taken, context)
    if (minted.collision) warnings.push('The identifier rule produced a value that is already taken.')
    if (minted.missing?.length) warnings.push(`The identifier rule could not fill ${minted.missing.join(', ')}.`)
    if (minted.value) provisional.identifier = minted.value
  }

  const { cells, warnings: cellWarnings } = cellsForRecord(workspace, form, provisional)
  warnings.push(...cellWarnings)

  const identifier = String(provisional.identifier ?? '').trim()
  if (!identifier) return { rowId: null, identifier: '', warnings }

  const taken = takenIdentifiers(workspace, form.tableId, form.idColumn)
  if (taken.has(identifier)) warnings.push(`The identifier "${identifier}" is already used in ${form.idColumn}.`)

  const rowId = addRow(workspace, form.tableId, cells, {
    source: options.source || 'form',
    note: `new ${form.label}`,
  })

  const { created, unmatched } = ensureReferencedRows(workspace, form, provisional, options)
  for (const item of unmatched) {
    warnings.push(
      `"${item.label}": nothing in ${item.tableId} carries "${item.value}" in ${item.column}, and that column is ` +
        `not an identifier — the relation will stay empty until a matching record exists.`
    )
  }

  return { rowId, identifier, warnings, created }
}

/** Change an existing record: one journal entry per changed cell, undone together. */
export function updateRecord(workspace, form, rowId, values, options = {}) {
  return inGroup(workspace, () => updateRecordNow(workspace, form, rowId, values, options))
}

function updateRecordNow(workspace, form, rowId, values, options) {
  const { row } = findRow(workspace.model, form.tableId, rowId)
  if (!row) throw new Error(`Row ${rowId} not found in ${form.tableId}`)
  const { cells, warnings } = cellsForRecord(workspace, form, values, { row })
  const changed = []
  for (const [column, value] of Object.entries(cells)) {
    const entry = setCell(workspace, form.tableId, rowId, column, value, { source: options.source || 'form' })
    if (entry) changed.push(column)
  }

  const { created, unmatched } = ensureReferencedRows(workspace, form, values, options)
  for (const item of unmatched) {
    warnings.push(
      `"${item.label}": nothing in ${item.tableId} carries "${item.value}" in ${item.column}, and that column is ` +
        `not an identifier — the relation will stay empty until a matching record exists.`
    )
  }

  return { changed, warnings, created }
}

/**
 * The rows a form covers: those where its identifier column is filled.
 * A row of tbl_11 is a find *and* a material *and* a dating; only the identifier
 * column says whether this particular form has a record there.
 */
export function rowsForForm(workspace, form) {
  const table = workspace.model.tables.get(form.tableId)
  if (!table) return []
  return table.rows
    .filter((row) => String(row[form.idColumn] ?? '').trim())
    .map((row) => ({ rowId: rowIdOf(row), row }))
}

/**
 * The identifier a record will carry in the graph.
 *
 * Needed to answer a question the interface must not dodge: a record with no
 * relation to anything produces no graph node. The materialisation is
 * edge-driven — a mapped node exists where an edge pairs it with a partner —
 * and that is the Studio's rule, verified against its output. So the record is
 * saved and kept, but it stays invisible in the graph views until it is linked,
 * and saying so is better than letting someone wonder.
 */
export function graphIdFor(workspace, form, identifier) {
  const entity = workspace.model.entities.get(form.nodeId)
  if (!entity || !identifier) return ''
  return expandId(identifier, workspace.model.prefixMap, workspace.model.idPrefix, entity.noPrefix)
}

/** Fill a form from an existing row, ready to be edited. */
export function valuesFromRow(form, row) {
  const values = {}
  const read = (fields, container) => {
    for (const field of fields) {
      if (field.kind === 'group') {
        const sub = {}
        read(field.fields, sub)
        container[field.key] = sub
        continue
      }
      if (field.kind === 'concept') {
        const uri = String(row[field.column] ?? '').trim()
        const label = field.labelColumn ? String(row[field.labelColumn] ?? '').trim() : ''
        container[field.key] = uri || label ? { uri, label } : null
        continue
      }
      container[field.key] = row[field.column] ?? ''
    }
  }
  read(form.fields, values)
  values.identifier = row[form.idColumn] ?? ''
  return values
}
