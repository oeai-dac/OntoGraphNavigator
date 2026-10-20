import { useMemo, useState } from 'react'
import { RELATION_KINDS } from '../../lib/harrisMatrix'

// The small dialogs of the Matrix tab's edit mode (MatrixTab.jsx). What they
// decide goes to the host's editor (README.md, "Editing": editor.matrix);
// nothing here writes anything itself.

const kindLabel = (kind) => RELATION_KINDS.find((k) => k.kind === kind)?.label || 'relates to'

/** Two units joined by dragging: which relation is it? Also used to change one. */
export function RelationDialog({ aLabel, bLabel, current, onPick, onRemove, onCancel, busy }) {
  return (
    <div className="mx-dialog">
      <div className="mx-dialog-title">
        {current ? <>Relation between <b>{aLabel}</b> and <b>{bLabel}</b></> : <>New relation</>}
      </div>
      <div className="mx-dialog-kinds">
        {RELATION_KINDS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            className={'mx-kind' + (current === kind ? ' on' : '')}
            disabled={busy || current === kind}
            onClick={() => onPick(kind)}
          >
            <b>{aLabel}</b> {label} <b>{bLabel}</b>
          </button>
        ))}
      </div>
      <div className="mx-dialog-actions">
        {onRemove && (
          <button type="button" className="mx-remove" disabled={busy} onClick={onRemove}>Remove relation</button>
        )}
        <button type="button" className="copy-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/**
 * A relation typed in rather than drawn -- which also brings a unit into the
 * matrix that is not in it yet: a unit appears through its relations, so a
 * new one is entered together with its first.
 */
export function NewRelationDialog({ units, suggestIdentifier, onSave, onCancel, busy }) {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [kind, setKind] = useState('higher')
  const [ids, setIds] = useState({ a: '', b: '' }) // identifiers for new units, as typed
  const byLabel = useMemo(() => {
    const m = new Map()
    for (const u of units) if (!m.has(u.label)) m.set(u.label, u.id)
    return m
  }, [units])

  const side = (label, key) => {
    const text = label.trim()
    if (!text) return { ok: false }
    const id = byLabel.get(text)
    if (id) return { ok: true, id }
    const identifier = ids[key] || suggestIdentifier?.(text) || ''
    return { ok: !!identifier.trim(), id: null, label: text, identifier }
  }
  const sa = side(a, 'a')
  const sb = side(b, 'b')
  const same = sa.id && sa.id === sb.id
  const ready = sa.ok && sb.ok && !same && !busy

  const unitField = (value, setValue, key, info) => (
    <span className="mx-unit-field">
      <input list="mx-units" value={value} placeholder="Unit — pick or type a new one" onChange={(e) => setValue(e.target.value)} />
      {value.trim() && !info.id && (
        <span className="mx-new-unit">
          new unit · identifier{' '}
          <input value={ids[key] || info.identifier || ''} onChange={(e) => setIds((m) => ({ ...m, [key]: e.target.value }))} />
        </span>
      )}
    </span>
  )

  return (
    <div className="mx-dialog">
      <div className="mx-dialog-title">New relation</div>
      <datalist id="mx-units">
        {units.map((u) => <option key={u.id} value={u.label} />)}
      </datalist>
      <div className="mx-new-row">
        {unitField(a, setA, 'a', sa)}
        <select className="sl" value={kind} onChange={(e) => setKind(e.target.value)}>
          {RELATION_KINDS.map((k) => <option key={k.kind} value={k.kind}>{kindLabel(k.kind)}</option>)}
        </select>
        {unitField(b, setB, 'b', sb)}
      </div>
      {same && <div className="attr-edit-note">A unit cannot relate to itself.</div>}
      <div className="mx-dialog-actions">
        <button type="button" className="attr-edit-save" disabled={!ready}
          onClick={() => onSave({
            a: sa.id, b: sb.id, kind,
            newUnits: {
              ...(sa.id ? {} : { a: { label: sa.label, identifier: sa.identifier.trim() } }),
              ...(sb.id ? {} : { b: { label: sb.label, identifier: sb.identifier.trim() } }),
            },
          })}>
          Save
        </button>
        <button type="button" className="copy-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
