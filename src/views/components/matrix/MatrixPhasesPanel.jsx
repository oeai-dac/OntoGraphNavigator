import { useState } from 'react'

// The phases, in the edit mode: youngest on top, as in the matrix. What is
// done here goes to the host's editor (README.md, "Editing": editor.matrix.phases).

export function MatrixPhasesPanel({ info, phases, counts, busy, onAddToMapping, onCreate, onRename, onMove, onRemove, onClose }) {
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState(null) // { id, label }
  const [confirmAdd, setConfirmAdd] = useState(false)

  return (
    <div className="mx-unit-panel mx-phase-panel">
      <div className="mx-unit-hdr">
        <b>Phases</b> {info?.available && <>— {phases.length}, youngest on top</>}
        <span className="mx-checks-close" onClick={onClose} title="Close">×</span>
      </div>

      {!info?.available && info?.canAdd && (
        <div className="mx-phase-add">
          <p>{info.reason}</p>
          {!confirmAdd ? (
            <button type="button" className="attr-edit-save" onClick={() => setConfirmAdd(true)}>＋ Add phases to the mapping</button>
          ) : (
            <>
              <p>
                This adds an <b>E4 Period</b> with a table of phases, <b>P10 falls within</b> from the units
                (a column “Phase” in their table) and <b>P120 occurs before</b> between phases — ordinary mapping
                nodes, which the Studio shows afterwards. It changes the mapping and cannot be undone with Undo.
              </p>
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <button type="button" className="attr-edit-save" disabled={busy} onClick={onAddToMapping}>Add them</button>
                <button type="button" className="copy-btn" onClick={() => setConfirmAdd(false)}>Cancel</button>
              </span>
            </>
          )}
        </div>
      )}
      {!info?.available && !info?.canAdd && <div className="mx-checks-empty">{info?.reason}</div>}

      {info?.available && (
        <>
          {!phases.length && <div className="mx-checks-empty">No phases yet — name the first one below.</div>}
          {phases.map((p, i) => (
            <div key={p.id} className="mx-stmt">
              {renaming?.id === p.id ? (
                <input className="mx-phase-input" value={renaming.label} autoFocus
                  onChange={(e) => setRenaming({ id: p.id, label: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && renaming.label.trim()) { onRename(p.id, renaming.label.trim()); setRenaming(null) }
                    if (e.key === 'Escape') setRenaming(null)
                  }} />
              ) : (
                <span className="mx-stmt-text">
                  <span className="tl-leg-dot" style={{ background: p.color }} /> <b>{p.label}</b>{' '}
                  <em className="mx-phase-count">{counts.get(p.id) || 0} units</em>
                </span>
              )}
              <span style={{ display: 'inline-flex', gap: 2 }}>
                <button type="button" className="mx-stmt-remove" disabled={busy || i === 0} onClick={() => onMove(p.id, 'younger')} title="Younger (up)">↑</button>
                <button type="button" className="mx-stmt-remove" disabled={busy || i === phases.length - 1} onClick={() => onMove(p.id, 'older')} title="Older (down)">↓</button>
                <button type="button" className="mx-stmt-remove" disabled={busy} onClick={() => setRenaming({ id: p.id, label: p.label })} title="Rename">✎</button>
                <button type="button" className="mx-stmt-remove" disabled={busy || (counts.get(p.id) || 0) > 0} onClick={() => onRemove(p.id)}
                  title={(counts.get(p.id) || 0) > 0 ? 'Units belong to it — assign them elsewhere first' : 'Remove this phase'}>✕</button>
              </span>
            </div>
          ))}
          <div className="mx-stmt">
            <input className="mx-phase-input" placeholder="New phase — added as the youngest, reorder with ↑ ↓" value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { onCreate(name.trim()); setName('') } }} />
            <button type="button" className="copy-btn" disabled={busy || !name.trim()} onClick={() => { onCreate(name.trim()); setName('') }}>Add</button>
          </div>
        </>
      )}
    </div>
  )
}
