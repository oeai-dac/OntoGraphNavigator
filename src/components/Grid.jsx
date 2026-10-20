import React, { useMemo, useState } from 'react'
import { useStore } from '../store'
import { t } from '../i18n/en'
import { rowIdOf } from '../lib/edits'

const CHUNK = 100

/**
 * The whole table, editable in place.
 *
 * For "add a note to four hundred finds", a form one record at a time is the
 * slow way. Every cell change goes through the same journal as the form, so
 * undo, the log and the provenance trail behave identically — only the way in
 * differs.
 *
 * Rows are rendered in chunks rather than all at once: tbl_5 has 1422 rows of
 * ten columns, and a full render of every table would freeze the tab.
 */
export default function Grid() {
  const workspace = useStore((s) => s.workspace)
  const revision = useStore((s) => s.revision)
  const editCell = useStore((s) => s.editCell)
  const [tableId, setTableId] = useState('')
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(CHUNK)

  const tables = workspace ? [...workspace.model.tables.values()] : []
  const table = tables.find((x) => x.id === tableId) || tables[0]

  const rows = useMemo(() => {
    if (!table?.rows) return []
    const needle = filter.trim().toLowerCase()
    if (!needle) return table.rows
    return table.rows.filter((row) => Object.values(row).some((v) => String(v ?? '').toLowerCase().includes(needle)))
  }, [table, filter, revision])

  if (!workspace || !table) {
    return (
      <div className="card">
        <h2>{t.grid.title}</h2>
        <p className="note">{workspace ? t.grid.noTables : t.enter.needsProject}</p>
      </div>
    )
  }

  const shown = rows.slice(0, limit)

  return (
    <div className="card">
      <h2>{t.grid.title}</h2>
      <div className="browse controls" style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <select
          value={table?.id || ''}
          onChange={(e) => {
            setTableId(e.target.value)
            setLimit(CHUNK)
          }}
        >
          {tables.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name || x.id} — {x.rows.length.toLocaleString('en')} rows
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder={t.grid.filter}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            setLimit(CHUNK)
          }}
        />
        <span className="note" style={{ margin: 0, alignSelf: 'center' }}>
          {t.grid.rows(rows.length)} · {t.grid.showing(shown.length, rows.length)}
        </span>
      </div>
      <p className="note">{t.grid.note}</p>

      <div className="grid-wrap">
        <table>
          <thead>
            <tr>
              <th />
              {table.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={rowIdOf(row) || index}>
                <td className="grid-row-head">{index + 1}</td>
                {table.columns.map((column) => (
                  <td key={column}>
                    <input
                      type="text"
                      defaultValue={row[column] ?? ''}
                      // Written on blur, not per keystroke: one journal entry per
                      // edit, not one per letter.
                      onBlur={(e) => editCell(table.id, rowIdOf(row), column, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {shown.length < rows.length && (
        <div className="pager">
          <button onClick={() => setLimit(limit + 500)}>+ 500</button>
          <button onClick={() => setLimit(rows.length)}>{t.grid.rows(rows.length)}</button>
        </div>
      )}
    </div>
  )
}
