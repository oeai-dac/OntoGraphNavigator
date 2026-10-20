import React, { useEffect, useMemo, useRef, useState } from 'react'
import { protocolMatches, useStore } from '../store'
import ProtocolEntry from './ProtocolEntry'
import { t } from '../i18n/en'
import { rowsForForm } from '../lib/edits'
import { searchConcepts, pathOf } from '../lib/thesaurus'
import { previewTemplate } from '../lib/uriTemplate'
import { textOnColor } from '../lib/schema'
import { conceptIdFromLabel } from '../lib/edits'
import { distinctValues } from '../lib/forms'

/**
 * A value that may come from a controlled vocabulary.
 *
 * Two sources in one list, deliberately: the values already in the column, and
 * the concepts of the bound vocabulary. Existing values are what most entries
 * will reuse; the vocabulary is what keeps new ones from drifting. A value from
 * neither is allowed and marked as new — refusing it would only push people into
 * writing it somewhere else.
 */
function ConceptPicker({ field, value, onChange }) {
  const thesauri = useStore((s) => s.thesauri)
  const idPrefix = useStore((s) => s.model?.idPrefix || '')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  const thesaurus = field.thesaurus ? thesauri.get(field.thesaurus.thesaurusId) : null
  const current = value?.label || value?.uri || ''
  const options = useLiveOptions(field)

  const suggestions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const fromColumn = options
      .filter((o) => !needle || o.value.toLowerCase().includes(needle))
      .slice(0, 12)
      .map((o) => ({ kind: 'existing', label: o.value, count: o.count, uri: '' }))
    const fromThesaurus = thesaurus
      ? searchConcepts(thesaurus, query, { limit: 12 }).map((hit) => ({
          kind: 'concept',
          label: hit.label,
          uri: hit.concept.uri,
          path: pathOf(thesaurus, hit.concept.uri).slice(0, -1).join(' › '),
        }))
      : []
    // Vocabulary first when there is one: it is the answer we would rather have.
    return [...fromThesaurus, ...fromColumn]
  }, [query, options, thesaurus])

  const isNew = current && !suggestions.some((s) => s.label === current) && !value?.uri

  return (
    <div className="picker">
      <input
        type="text"
        value={open ? query : current}
        placeholder={thesaurus ? `${t.enter.searchIn} ${thesaurus.name}` : t.enter.typeOrChoose}
        onFocus={() => {
          setQuery('')
          setOpen(true)
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          // Typing is itself a value: a term outside the vocabulary is allowed.
          onChange({ uri: '', label: e.target.value })
        }}
      />
      {value?.uri ? (
        <div className="picker-uri" title={value.uri}>
          {value.uri}
        </div>
      ) : value?.label ? (
        // A typed term still needs an identifier, or the relation to it cannot
        // exist. Show the one that will be written.
        <div className="picker-uri">
          {t.enter.willGet} <strong>{conceptIdFromLabel(value.label, idPrefix)}</strong>
        </div>
      ) : null}
      {isNew && <div className="picker-new">{t.enter.newValue}</div>}
      {open && suggestions.length > 0 && (
        <ul className="picker-list">
          {suggestions.map((s, i) => (
            <li key={`${s.kind}-${s.uri || s.label}-${i}`}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange({ uri: s.uri, label: s.label })
                  setOpen(false)
                }}
              >
                <span className={`picker-kind ${s.kind}`}>{s.kind === 'concept' ? t.enter.vocabulary : s.count ? t.enter.inUse : t.enter.offered}</span>
                <span className="picker-label">{s.label}</span>
                {s.path && <span className="picker-path">{s.path}</span>}
                {s.count ? <span className="picker-count">{s.count}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The identifier: rule-filled, always visible, always editable. */
function IdentifierField({ form, value, onChange, isNew }) {
  const workspace = useStore((s) => s.workspace)
  const rule = form.uriRule
  const preview = useMemo(() => {
    if (!rule || !workspace) return null
    const table = workspace.model.tables.get(form.tableId)
    return previewTemplate(rule, table.rows.slice(0, 200), { columns: table.columns, limit: 2 })
  }, [rule, workspace, form.tableId])

  return (
    <div className="field">
      <label>
        {t.enter.identifier} <span className="required">*</span>
      </label>
      <input type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      <div className="field-note">
        <code>{form.idColumn}</code>
        {rule ? (
          <>
            {' · '}
            {t.enter.rule}: <code>{rule}</code>
            {isNew && !value && ` · ${t.enter.willBeFilled}`}
            {preview?.samples?.length ? ` · ${t.enter.forExample} ${preview.samples[0].value}` : ''}
          </>
        ) : (
          <> · {t.enter.noRule}</>
        )}
      </div>
    </div>
  )
}

function ScalarInput({ field, value, onChange }) {
  const common = {
    value: value ?? '',
    onChange: (e) => onChange(e.target.value),
    disabled: field.readOnly,
  }
  if (field.kind === 'longtext' || field.kind === 'geometry') {
    return <textarea rows={field.kind === 'geometry' ? 2 : 4} spellCheck={false} {...common} />
  }
  if (field.kind === 'year') return <input type="text" inputMode="numeric" placeholder="1989" {...common} />
  if (field.kind === 'date') return <input type="text" placeholder="1989-07-14" {...common} />
  if (field.kind === 'number') return <input type="text" inputMode="decimal" {...common} />
  if (field.kind === 'url') return <input type="url" spellCheck={false} {...common} />
  if (field.kind === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={String(value ?? '').toLowerCase() === 'true'}
        disabled={field.readOnly}
        onChange={(e) => onChange(e.target.checked ? 'true' : '')}
      />
    )
  }
  return <input type="text" {...common} />
}

/**
 * Choose an existing value, or type a new one.
 *
 * A `datalist` was here before and is the wrong tool: browsers only reveal it
 * once you start typing, so an empty field looks like it offers nothing. This
 * opens on focus and shows what exists — which is the whole question being asked
 * ("is there already an Ephesos?").
 */
function ReferenceInput({ field, value, onChange }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const current = value ?? ''
  const options = useLiveOptions(field)

  const suggestions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return options.filter((o) => !needle || o.value.toLowerCase().includes(needle)).slice(0, 15)
  }, [query, options])

  const exists = options.some((o) => o.value === current)

  if (field.readOnly) return <input type="text" value={current} disabled />

  return (
    <div className="picker">
      <input
        type="text"
        value={open ? query : current}
        placeholder={options.length ? t.enter.chooseOrType : t.enter.typeNew}
        onFocus={() => {
          setQuery('')
          setOpen(true)
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          onChange(e.target.value)
        }}
      />
      {current && (
        <div className={exists ? 'picker-uri' : 'picker-new'}>
          {exists ? t.enter.linksToExisting : t.enter.willBeCreated}
        </div>
      )}
      {open && (
        <ul className="picker-list">
          {suggestions.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange(o.value)
                  setOpen(false)
                }}
              >
                <span className="picker-kind">{t.enter.inUse}</span>
                <span className="picker-label">{o.value}</span>
                <span className="picker-count">{o.count}</span>
              </button>
            </li>
          ))}
          {query.trim() && !options.some((o) => o.value === query.trim()) && (
            <li>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange(query.trim())
                  setOpen(false)
                }}
              >
                <span className="picker-kind concept">{t.enter.newEntry}</span>
                <span className="picker-label">{query.trim()}</span>
              </button>
            </li>
          )}
          {!suggestions.length && !query.trim() && (
            <li>
              <span className="picker-empty">{t.enter.nothingYet}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/**
 * The values a picker should offer, read from the tables as they stand now.
 *
 * `revision` is in the dependencies on purpose: it is what tells us a record was
 * saved. Without it the list would still be the one from the moment the file was
 * loaded.
 */
function useLiveOptions(field) {
  const workspace = useStore((s) => s.workspace)
  const revision = useStore((s) => s.revision)
  return useMemo(() => {
    if (!workspace || !['reference', 'concept'].includes(field.kind)) return field.options || []

    // Where to read from is not always where the field writes to. A cross-table
    // reference writes a join key into *this* record's table but must offer the
    // values of the *other* one — the units that exist, not the unit numbers
    // other finds happen to have been given.
    const tableId = field.matchTableId || field.tableId
    const column =
      field.matchColumn || (field.kind === 'concept' ? field.labelColumn || field.column : field.column)
    if (!tableId || !column) return field.options || []
    const table = workspace.model.tables.get(tableId)
    if (!table) return field.options || []
    const present = distinctValues(table.rows, column, 2000)
    const have = new Set(present.map((o) => o.value))
    return [...present, ...(field.suggested || []).filter((v) => !have.has(v)).map((value) => ({ value, count: 0 }))]
  }, [workspace, revision, field.kind, field.tableId, field.column, field.labelColumn, field.matchTableId, field.matchColumn, field.suggested])
}

/** One input, chosen by the field's kind. Used for top-level fields and subfields alike. */
function Input({ field, value, onChange }) {
  if (field.kind === 'concept') return <ConceptPicker field={field} value={value} onChange={onChange} />
  if (field.kind === 'reference') return <ReferenceInput field={field} value={value} onChange={onChange} />
  return <ScalarInput field={field} value={value} onChange={onChange} />
}

function FieldNote({ field }) {
  const options = useLiveOptions(field)
  return (
    <div className="field-note">
      <code>{field.column}</code>
      {field.labelColumn ? (
        <>
          {' + '}
          <code>{field.labelColumn}</code>
        </>
      ) : null}
      {field.conflictWith ? ` · ${t.enter.conflictWith(field.conflictWith)}` : field.readOnly ? ` · ${t.enter.carriedOnly}` : ''}
      {field.kind === 'reference' && !field.readOnly && options.length
        ? ` · ${options.length} ${t.enter.knownValues}`
        : ''}
    </div>
  )
}

function Field({ field }) {
  const draft = useStore((s) => s.draft)
  const setDraftValue = useStore((s) => s.setDraftValue)
  const setDraftGroupValue = useStore((s) => s.setDraftGroupValue)
  const workspace = useStore((s) => s.workspace)
  const value = draft?.[field.key]

  /** Look the chosen partner up in the rows and copy its label across. */
  const fillSibling = (group, idField, chosen) => {
    const sibling = group.fields.find((f) => f !== idField && f.column && f.column !== idField.column)
    if (!sibling || !chosen) return
    const table = workspace?.model.tables.get(idField.tableId)
    if (!table) return
    const match = table.rows.find((row) => String(row[idField.column] ?? '').trim() === chosen)
    if (!match) return
    const label = String(match[sibling.column] ?? '').trim()
    if (label) setDraftGroupValue(group.key, sibling.key, label)
  }

  if (field.kind === 'group') {
    return (
      <fieldset className={`field-group${field.partner ? ' partner' : ''}`}>
        <legend>{field.label}</legend>
        {field.partner && <p className="field-note partner-note">{t.enter.sameRow}</p>}
        {field.fields.map((sub) => (
          <div className="field" key={sub.key}>
            <label>{sub.label}</label>
            <Input
              field={sub}
              value={(value || {})[sub.key]}
              onChange={(v) => {
                setDraftGroupValue(field.key, sub.key, v)
                // Choosing a partner that already exists brings its label along.
                // Leaving the two to be typed separately is how one ends up with
                // "POI1" labelled two different ways.
                if (field.partner && sub.kind === 'reference') fillSibling(field, sub, v)
              }}
            />
            <FieldNote field={sub} />
          </div>
        ))}
        {!field.partner && (
          <div className="field-note">
            {field.uriRule ? (
              <>
                {t.enter.identifierFrom} <code>{field.uriRule}</code>
              </>
            ) : (
              t.enter.groupNeedsRule
            )}
          </div>
        )}
      </fieldset>
    )
  }

  return (
    <div className="field">
      <label>{field.label}</label>
      <Input field={field} value={value} onChange={(v) => setDraftValue(field.key, v)} />
      <FieldNote field={field} />
    </div>
  )
}

/**
 * Records from the mapping's forms, or recording protocols — offered where one
 * is bound, a package has been added, or the project has a matrix (whose units
 * a protocol is for); without a binding the protocols side says how to get one.
 */
export default function Enter() {
  const enterMode = useStore((s) => s.enterMode)
  const setEnterMode = useStore((s) => s.setEnterMode)
  const hasProtocols = useStore((s) => protocolMatches(s).length > 0 || s.packages.length > 0 || (!!s.workspace && s.matrixRules().length > 0))
  const mode = hasProtocols ? enterMode : 'records'
  return (
    <>
      {hasProtocols && (
        <div className="enter-mode" role="tablist">
          <button role="tab" aria-selected={mode === 'records'} onClick={() => setEnterMode('records')}>{t.protocols.records}</button>
          <button role="tab" aria-selected={mode === 'protocols'} onClick={() => setEnterMode('protocols')}>{t.protocols.protocols}</button>
        </div>
      )}
      {mode === 'protocols' ? <ProtocolEntry /> : <RecordEntry />}
    </>
  )
}

function RecordEntry() {
  const state = useStore()
  const { workspace, forms, formNodeId, rowId, draft, draftWarnings, savedNotice, graph, revision } = state
  const { chooseForm, openRecord, saveDraft, deleteCurrentRecord } = state
  const [search, setSearch] = useState('')
  // The record open — also one opened from the map or the matrix beside this
  // form in the Dashboard — is scrolled into sight in the list.
  const listRef = useRef(null)
  useEffect(() => {
    listRef.current?.querySelector('button[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [rowId, formNodeId])

  // Hooks must run on every render, so the guard comes after them, not before.
  const form = forms?.byNode.get(formNodeId) || null

  /**
   * One entry per identifier, not per row.
   *
   * A thing that carries several values of one relation occupies several rows —
   * a site with two points of interest is two rows of the same site, and that is
   * the correct storage, not a duplicate. Listing rows made it look like one, so
   * the rows of an identifier are grouped and counted.
   */
  const records = useMemo(() => {
    if (!workspace || !form) return []
    const needle = search.trim().toLowerCase()
    const groups = new Map()
    for (const entry of rowsForForm(workspace, form)) {
      if (needle && !Object.values(entry.row).some((v) => String(v ?? '').toLowerCase().includes(needle))) continue
      const identifier = String(entry.row[form.idColumn] ?? '').trim()
      if (!groups.has(identifier)) {
        groups.set(identifier, {
          identifier,
          label: form.labelColumn ? String(entry.row[form.labelColumn] ?? '').trim() : '',
          rows: [],
        })
      }
      groups.get(identifier).rows.push(entry)
    }
    return [...groups.values()].slice(0, 300)
  }, [form, workspace, search, revision])

  /** The rows the open record spans, so each can be reached. */
  const openGroup = useMemo(
    () => (rowId ? records.find((g) => g.rows.some((r) => r.rowId === rowId)) : null),
    [records, rowId]
  )

  if (!workspace || !forms || !form) {
    return (
      <div className="card">
        <h2>{t.enter.title}</h2>
        <p className="note">{t.enter.needsProject}</p>
      </div>
    )
  }

  const color = form.color

  return (
    <div className="enter">
      <div className="card enter-side">
        <label className="block-label">{t.enter.recordType}</label>
        <select value={formNodeId || ''} onChange={(e) => chooseForm(e.target.value)}>
          {forms.forms.map((f) => (
            <option key={f.nodeId} value={f.nodeId}>
              {f.label}
            </option>
          ))}
        </select>

        <div className="enter-actions">
          <button className="primary" onClick={() => openRecord(null)}>
            {t.enter.newRecord}
          </button>
          <input
            type="search"
            placeholder={t.enter.searchRecords}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <p className="note">{t.enter.recordCount(records.length)}</p>
        <ul className="node-list" ref={listRef}>
          {records.map((group) => (
            <li key={group.identifier}>
              <button
                aria-current={group.rows.some((r) => r.rowId === rowId)}
                onClick={() => openRecord(group.rows[0].rowId)}
              >
                <span className="swatch" style={{ background: color || 'var(--border)' }} />
                {/* The name first — an identifier is often a whole URI, which says
                    little at a glance; it stays below, for telling twins apart. */}
                <span className="label">{group.label || group.identifier}</span>
                {group.rows.length > 1 && <span className="row-badge">{t.enter.rowCount(group.rows.length)}</span>}
                {group.label && group.label !== group.identifier && <span className="subline id-subline">{group.identifier}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        {!draft ? (
          <p className="note">{t.enter.chooseOrCreate}</p>
        ) : (
          <>
            <h2 style={{ marginBottom: 2 }}>
              {rowId ? t.enter.editing : t.enter.creating}{' '}
              <span className="type-tag" style={{ background: color, color: textOnColor(color) }}>
                {form.label}
              </span>
            </h2>
            <p className="note">
              {t.enter.writesTo} <code>{form.tableId}</code>
            </p>

            {openGroup && openGroup.rows.length > 1 && (
              <div className="row-switch">
                <span className="note" style={{ margin: 0 }}>{t.enter.spansRows(openGroup.rows.length)}</span>
                {openGroup.rows.map((entry, index) => (
                  <button
                    key={entry.rowId}
                    aria-current={entry.rowId === rowId}
                    onClick={() => openRecord(entry.rowId)}
                  >
                    {index + 1}
                  </button>
                ))}
                <button className="primary" onClick={() => state.addRowToRecord()}>
                  {t.enter.anotherRow}
                </button>
              </div>
            )}

            {draftWarnings.length > 0 && (
              <div className="notice">
                <h3>{t.enter.attention}</h3>
                <ul>
                  {draftWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <IdentifierField
              form={form}
              value={draft.identifier}
              isNew={!rowId}
              onChange={(v) => state.setDraftValue('identifier', v)}
            />

            {form.fields.filter((f) => f.kind !== 'identifier').map((field) => (
              <Field key={field.key} field={field} />
            ))}

            {form.implied?.length > 0 && (
              <p className="field-note implied">
                {t.enter.implied}: {form.implied.map((f) => f.label).join(', ')}
              </p>
            )}

            <div className="enter-footer">
              <button className="primary" onClick={saveDraft}>
                {rowId ? t.enter.save : t.enter.create}
              </button>
              {rowId && <button onClick={deleteCurrentRecord}>{t.enter.delete}</button>}
              {savedNotice && <span className="saved">{savedNotice}</span>}
              {graph && (
                <span className="note" style={{ marginLeft: 'auto' }}>
                  {Object.keys(graph.nodes).length.toLocaleString('en')} {t.overview.nodes}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
