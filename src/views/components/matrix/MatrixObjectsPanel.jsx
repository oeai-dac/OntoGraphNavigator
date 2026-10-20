import { useState } from 'react'

// Objects and object groups, in the edit mode: groups with their objects,
// objects without a group last. What is done here goes to the host's editor
// (README.md, "Editing": editor.matrix.objects).

const NEW = '⁣new' // the "new group…" entry of a select; no id looks like it

function NameInput({ initial = '', placeholder, onDone, onCancel }) {
  const [value, setValue] = useState(initial)
  return (
    <input className="mx-phase-input" value={value} placeholder={placeholder} autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCancel?.()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim()) onDone(value.trim())
        if (e.key === 'Escape') onCancel?.()
      }} />
  )
}

/** A select of the groups, with "none" and "new group…". */
function GroupPicker({ groups, value, busy, onPick }) {
  const [naming, setNaming] = useState(false)
  if (naming) {
    return <NameInput placeholder="New group" onDone={(name) => { onPick(null, name); setNaming(false) }} onCancel={() => setNaming(false)} />
  }
  return (
    <select className="mx-stmt-kind" value={value || ''} disabled={busy}
      onChange={(e) => (e.target.value === NEW ? setNaming(true) : onPick(e.target.value || null, ''))}>
      <option value="">— no group —</option>
      {groups.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
      <option value={NEW}>＋ new group…</option>
    </select>
  )
}

export function MatrixObjectsPanel({ info, objects, groups, groupOf, counts, colorOf, busy, onAddToMapping, onCreateObject, onCreateGroup, onRenameObject, onRenameGroup, onRemoveObject, onRemoveGroup, onSetGroup, onClose }) {
  const [renaming, setRenaming] = useState(null) // { kind, id }
  const [confirmAdd, setConfirmAdd] = useState(false)
  const [newObject, setNewObject] = useState(false)
  const [newGroup, setNewGroup] = useState(false)

  const addNote = !info?.available
    ? <>This adds an <b>E26 Physical Feature</b> for objects and one for object groups, each with a table, and <b>P46i forms part of</b> from the units (a column “Object”) and from the objects (a column “Object_group”)</>
    : <>This adds an <b>E26 Physical Feature</b> for object groups with a table, and <b>P46i forms part of</b> from the objects (a column “Object_group” where the objects are kept)</>
  const offerAdd = (!info?.available && info?.canAdd) || (info?.available && info.canAddGroups)

  const objectRow = (o) => {
    const n = counts.get(o.id) || 0
    return (
      <div key={o.id} className="mx-stmt">
        {renaming?.kind === 'object' && renaming.id === o.id ? (
          <NameInput initial={o.label} onDone={(name) => { onRenameObject(o.id, name); setRenaming(null) }} onCancel={() => setRenaming(null)} />
        ) : (
          <span className="mx-stmt-text">
            <span className="tl-leg-dot" style={{ background: colorOf(o.id) }} /> <b>{o.label}</b>{' '}
            <em className="mx-phase-count">{n} unit{n === 1 ? '' : 's'}</em>
          </span>
        )}
        {info.groups && <GroupPicker groups={groups} value={groupOf.get(o.id)} busy={busy} onPick={(groupId, newLabel) => onSetGroup(o.id, groupId, newLabel)} />}
        <button type="button" className="mx-stmt-remove" disabled={busy} onClick={() => setRenaming({ kind: 'object', id: o.id })} title="Rename">✎</button>
        {info.standalone && (
          <button type="button" className="mx-stmt-remove" disabled={busy || n > 0} onClick={() => onRemoveObject(o.id)}
            title={n > 0 ? 'Units belong to it — assign them elsewhere first' : 'Remove this object'}>✕</button>
        )}
      </div>
    )
  }

  const ungrouped = objects.filter((o) => !groupOf.get(o.id))
  return (
    <div className="mx-unit-panel mx-phase-panel mx-objects-panel">
      <div className="mx-unit-hdr">
        <b>Objects</b> {info?.available && <>— {objects.length}{info.groups ? `, ${groups.length} group${groups.length === 1 ? '' : 's'}` : ''}</>}
        <span className="mx-checks-close" onClick={onClose} title="Close">×</span>
      </div>

      {offerAdd && (
        <div className="mx-phase-add">
          {!info?.available && <p>{info.reason}</p>}
          {!confirmAdd ? (
            <button type="button" className={info?.available ? 'copy-btn' : 'attr-edit-save'} onClick={() => setConfirmAdd(true)}>
              ＋ Add {info?.available ? 'object groups' : 'objects and groups'} to the mapping
            </button>
          ) : (
            <>
              <p>{addNote} — ordinary mapping nodes, which the Studio shows afterwards. It changes the mapping and cannot be undone with Undo.</p>
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <button type="button" className="attr-edit-save" disabled={busy} onClick={() => { onAddToMapping(); setConfirmAdd(false) }}>Add them</button>
                <button type="button" className="copy-btn" onClick={() => setConfirmAdd(false)}>Cancel</button>
              </span>
            </>
          )}
        </div>
      )}
      {!info?.available && !info?.canAdd && <div className="mx-checks-empty">{info?.reason}</div>}

      {info?.available && (
        <>
          {!info.standalone && (
            <div className="mx-checks-empty">Here an object exists through its units: select a unit and give it an object — a new one by name.</div>
          )}
          {!objects.length && info.standalone && <div className="mx-checks-empty">No objects yet.</div>}
          {info.groups && groups.map((g) => {
            const members = objects.filter((o) => groupOf.get(o.id) === g.id)
            return (
              <div key={g.id}>
                <div className="mx-stmt mx-group-row">
                  {renaming?.kind === 'group' && renaming.id === g.id ? (
                    <NameInput initial={g.label} onDone={(name) => { onRenameGroup(g.id, name); setRenaming(null) }} onCancel={() => setRenaming(null)} />
                  ) : (
                    <span className="mx-stmt-text"><b>{g.label}</b> <em className="mx-phase-count">group · {members.length} object{members.length === 1 ? '' : 's'}</em></span>
                  )}
                  <button type="button" className="mx-stmt-remove" disabled={busy} onClick={() => setRenaming({ kind: 'group', id: g.id })} title="Rename">✎</button>
                  {info.groupsStandalone && (
                    <button type="button" className="mx-stmt-remove" disabled={busy || members.length > 0} onClick={() => onRemoveGroup(g.id)}
                      title={members.length ? 'Objects belong to it — move them elsewhere first' : 'Remove this group'}>✕</button>
                  )}
                </div>
                {members.map(objectRow)}
              </div>
            )
          })}
          {info.groups && ungrouped.length > 0 && groups.length > 0 && (
            <div className="mx-stmt mx-group-row"><span className="mx-stmt-text"><em className="mx-phase-count">without a group</em></span></div>
          )}
          {ungrouped.map(objectRow)}
          <div className="mx-stmt">
            {info.standalone && (newObject
              ? <NameInput placeholder="New object" onDone={(name) => { onCreateObject(name); setNewObject(false) }} onCancel={() => setNewObject(false)} />
              : <button type="button" className="copy-btn" disabled={busy} onClick={() => setNewObject(true)}>＋ Object</button>)}
            {info.groupsStandalone && (newGroup
              ? <NameInput placeholder="New group" onDone={(name) => { onCreateGroup(name); setNewGroup(false) }} onCancel={() => setNewGroup(false)} />
              : <button type="button" className="copy-btn" disabled={busy} onClick={() => setNewGroup(true)}>＋ Group</button>)}
          </div>
        </>
      )}
    </div>
  )
}

export { NEW as NEW_ENTRY, NameInput }
