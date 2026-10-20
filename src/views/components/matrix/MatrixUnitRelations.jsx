import { useState } from 'react'
import { RELATION_KINDS } from '../../lib/harrisMatrix'
import { NEW_ENTRY, NameInput } from './MatrixObjectsPanel'

// Relations listed rather than clicked: in a dense matrix lines run on top of
// each other and units sit close, and the one relation that is wrong cannot be
// hit with the mouse. A list names each one, and takes each one back on its own.

const kindLabel = (kind) => RELATION_KINDS.find((k) => k.kind === kind)?.label || 'relates (unknown kind) to'

/**
 * One relation as a line of text with its tools: change the kind, remove it.
 * `statement` = { a, b, kind } reads "a <kind> b".
 */
export function StatementRow({ statement, labelOf, onChange, onRemove, busy, marked }) {
  const { a, b, kind } = statement
  return (
    <div className={'mx-stmt' + (marked ? ' marked' : '')}>
      <span className="mx-stmt-text">
        <b>{labelOf(a)}</b>{' '}
        {onChange && kind !== 'unknown' ? (
          <select className="mx-stmt-kind" value={kind} disabled={busy} onChange={(e) => onChange(e.target.value)}>
            {RELATION_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </select>
        ) : (
          <span className={kind === 'unknown' ? 'mx-stmt-kind-text unknown' : 'mx-stmt-kind-text'}>{kindLabel(kind)}</span>
        )}{' '}
        <b>{labelOf(b)}</b>
      </span>
      {onRemove && (
        <button type="button" className="mx-stmt-remove" disabled={busy} onClick={onRemove} title="Remove this relation">✕</button>
      )}
    </div>
  )
}

/**
 * All relations of the selected unit, in the edit mode -- and its phase, when
 * the matrix has phases the editor can assign (`phases` given).
 */
export function MatrixUnitRelations({ unitId, statements, labelOf, onChange, onRemove, onClose, busy, phases, phaseId, onAssign, objects, objectId, onAssignObject, onOpenProtocol, unitTypes, unitType, onAssignType }) {
  const [namingObject, setNamingObject] = useState(false)
  return (
    <div className="mx-unit-panel">
      <div className="mx-unit-hdr">
        <b>{labelOf(unitId)}</b> — {statements.length} relation{statements.length === 1 ? '' : 's'}
        {onOpenProtocol && (
          <button type="button" className="copy-btn mx-protocol-btn" onClick={onOpenProtocol} title="This unit's recording protocol">Protocol</button>
        )}
        <span className="mx-checks-close" onClick={onClose} title="Close">×</span>
      </div>
      {unitTypes && (
        <div className="mx-stmt">
          <span className="mx-stmt-text">Type{' '}
            <select className="mx-stmt-kind" value={unitType || ''} disabled={busy} onChange={(e) => onAssignType(e.target.value)}>
              <option value="">— none —</option>
              {unitTypes.map((v) => <option key={v} value={v}>{v}</option>)}
              {unitType && !unitTypes.includes(unitType) && <option value={unitType}>{unitType}</option>}
            </select>
          </span>
        </div>
      )}
      {phases && (
        <div className="mx-stmt">
          <span className="mx-stmt-text">Phase{' '}
            <select className="mx-stmt-kind" value={phaseId || ''} disabled={busy} onChange={(e) => onAssign(e.target.value || null)}>
              <option value="">— none —</option>
              {phases.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </span>
        </div>
      )}
      {objects && (
        <div className="mx-stmt">
          <span className="mx-stmt-text">Object{' '}
            {namingObject ? (
              <NameInput placeholder="New object" onDone={(name) => { onAssignObject(null, name); setNamingObject(false) }} onCancel={() => setNamingObject(false)} />
            ) : (
              <select className="mx-stmt-kind" value={objectId || ''} disabled={busy}
                onChange={(e) => (e.target.value === NEW_ENTRY ? setNamingObject(true) : onAssignObject(e.target.value || null, ''))}>
                <option value="">— none —</option>
                {objects.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                <option value={NEW_ENTRY}>＋ new object…</option>
              </select>
            )}
          </span>
        </div>
      )}
      {!statements.length && <div className="mx-checks-empty">No stratigraphic relation yet — drag from this unit to another.</div>}
      {statements.map((s) => (
        <StatementRow
          key={`${s.partner} ${s.kind}`}
          statement={{ a: unitId, b: s.partner, kind: s.kind }}
          labelOf={labelOf}
          busy={busy}
          onChange={(kind) => onChange(s, kind)}
          onRemove={() => onRemove(s)}
        />
      ))}
    </div>
  )
}
