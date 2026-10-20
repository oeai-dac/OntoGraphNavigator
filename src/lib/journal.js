/**
 * The change journal.
 *
 * Every edit is one small operation on one table row, appended in order. That
 * single decision pays for four things at once: undo and redo, the log file,
 * a provenance trail, and — later — synchronisation with a server, because a
 * journal can be transmitted and merged while a 52 MB file cannot.
 *
 * This module is pure. Where the journal is *kept* is `journalStore.js`, which
 * is the only part that touches IndexedDB.
 */

export const OPERATIONS = ['setValue', 'addRow', 'deleteRow']

/**
 * @param {object} [meta]
 * @param {string} [meta.author]  a name typed at the start of the session; no accounts
 * @param {Array}  [meta.inputs]  which files were loaded, with size and checksum
 */
export function createJournal(meta = {}) {
  return {
    session: meta.session || `s-${Date.now().toString(36)}`,
    author: meta.author || '',
    startedAt: meta.startedAt || new Date().toISOString(),
    // Which files this journal is about. A log without a defined starting state
    // documents nothing — "column X became Y" is only meaningful against a known
    // input.
    inputs: meta.inputs || [],
    entries: [],
    // Index of the next entry to redo. Everything below it has been applied.
    cursor: 0,
  }
}

/** A short, stable checksum for the loaded text — enough to tell two files apart. */
export function checksum(text) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = ((h1 ^ c) * 0x01000193) >>> 0
    h2 = ((h2 + c) * 0x85ebca6b) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12)
}

/**
 * Append an operation.
 *
 * Anything that was undone and not redone is discarded first: a new edit made
 * after undoing rewrites that branch of history, as every editor does.
 */
export function append(journal, operation) {
  if (!OPERATIONS.includes(operation.op)) throw new Error(`Unknown operation "${operation.op}"`)
  if (journal.cursor < journal.entries.length) journal.entries.length = journal.cursor

  const entry = {
    seq: journal.entries.length + 1,
    at: operation.at || new Date().toISOString(),
    author: journal.author,
    op: operation.op,
    tableId: operation.tableId,
    rowId: operation.rowId,
    column: operation.column ?? null,
    before: operation.before ?? null,
    after: operation.after ?? null,
    // form | grid | import — the most useful column when tracing a value months later
    source: operation.source || 'form',
    note: operation.note || '',
    // Entries made by one action — a form saved, a value changed in a view that
    // stands in three rows — share a group, and are undone and redone together.
    group: operation.group || null,
  }
  journal.entries.push(entry)
  journal.cursor = journal.entries.length
  return entry
}

export const canUndo = (journal) => journal.cursor > 0
export const canRedo = (journal) => journal.cursor < journal.entries.length

/** The entry that undo would reverse, without reversing it. */
export function peekUndo(journal) {
  return canUndo(journal) ? journal.entries[journal.cursor - 1] : null
}
export function peekRedo(journal) {
  return canRedo(journal) ? journal.entries[journal.cursor] : null
}

/**
 * The operation that reverses an entry.
 * Undo does not append anything — it moves the cursor, so redo stays possible.
 */
export function inverseOf(entry) {
  switch (entry.op) {
    case 'setValue':
      return { ...entry, before: entry.after, after: entry.before }
    case 'addRow':
      return { ...entry, op: 'deleteRow' }
    case 'deleteRow':
      return { ...entry, op: 'addRow' }
    default:
      throw new Error(`Cannot invert "${entry.op}"`)
  }
}

/** Entries that have actually been applied, oldest first. */
export function appliedEntries(journal) {
  return journal.entries.slice(0, journal.cursor)
}

/** How much has changed, per table — for the export screen. */
export function summarise(journal) {
  const perTable = new Map()
  const rowsTouched = new Set()
  let added = 0
  let deleted = 0
  let changed = 0
  // What someone did, rather than how many cells it took: a form saved, a
  // relation drawn — each one action, as it is one undo.
  const actions = new Set()
  for (const entry of appliedEntries(journal)) {
    actions.add(entry.group || `#${entry.seq}`)
    perTable.set(entry.tableId, (perTable.get(entry.tableId) || 0) + 1)
    rowsTouched.add(`${entry.tableId}/${entry.rowId}`)
    if (entry.op === 'addRow') added++
    else if (entry.op === 'deleteRow') deleted++
    else changed++
  }
  return {
    entries: journal.cursor,
    actions: actions.size,
    rows: rowsTouched.size,
    added,
    deleted,
    changed,
    perTable: [...perTable.entries()].map(([tableId, count]) => ({ tableId, count })),
  }
}

/** JSON Lines — one entry per line, for machines and for appending. */
export function toJsonl(journal) {
  const header = {
    kind: 'ontographnavigator-log',
    version: 1,
    session: journal.session,
    author: journal.author,
    startedAt: journal.startedAt,
    inputs: journal.inputs,
  }
  return [header, ...appliedEntries(journal)].map((o) => JSON.stringify(o)).join('\n') + '\n'
}

/** A readable table, for the documentation folder. */
export function toReadableLog(journal) {
  const lines = [
    `# OntoGraphNavigator — change log`,
    ``,
    `Session   ${journal.session}`,
    `Author    ${journal.author || '(not stated)'}`,
    `Started   ${journal.startedAt}`,
    ...journal.inputs.map((i) => `Input     ${i.name}  ${i.bytes ?? '?'} bytes  checksum ${i.checksum ?? '?'}`),
    ``,
    ['Time', 'Author', 'Operation', 'Table', 'Row', 'Column', 'Before', 'After', 'Source'].join('\t'),
  ]
  const clean = (v) => (v === null || v === undefined ? '' : String(v).replace(/[\r\n\t]+/g, ' '))
  for (const e of appliedEntries(journal)) {
    lines.push([e.at, e.author, e.op, e.tableId, e.rowId, clean(e.column), clean(e.before), clean(e.after), e.source].join('\t'))
  }
  return lines.join('\n') + '\n'
}

/** Read a log back, for continuing a session or auditing one. */
export function fromJsonl(text) {
  const lines = String(text).split('\n').filter((l) => l.trim())
  if (!lines.length) throw new Error('The log file is empty')
  let header
  try {
    header = JSON.parse(lines[0])
  } catch {
    throw new Error('The first line of the log is not valid JSON')
  }
  if (header.kind !== 'ontographnavigator-log') throw new Error('This is not an OntoGraphNavigator log')
  const journal = createJournal(header)
  journal.entries = lines.slice(1).map((l) => JSON.parse(l))
  journal.cursor = journal.entries.length
  return journal
}
