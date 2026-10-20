import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { looksLikeWkt } from '../../lib/wkt'

/**
 * An attribute value in the Explorer's detail view -- and, when the host
 * offers an editor (README.md, "Editing"), the way to change it.
 *
 * Without an editor this is exactly the value as before: the GraphExplorer
 * shows, it does not edit. With one, a pencil asks the editor first whether
 * the value can be changed at all. The answer may be no, with a reason (a
 * value joined from several rows has no single place to go) -- that is said
 * rather than offering a field that cannot be saved.
 */
export function AttrValue({ nodeId, attrKey, value, long, children }) {
  const editor = useStore((s) => s.editor)
  const startGeometryEdit = useStore((s) => s.startGeometryEdit)
  const [draft, setDraft] = useState(null) // string while editing
  const [note, setNote] = useState('') // why not, or what went wrong

  // Another node, another key, or a value changed underneath: start fresh.
  useEffect(() => {
    setDraft(null)
    setNote('')
  }, [nodeId, attrKey, value])

  if (!editor) return children

  const text = String(value ?? '')
  const geometry = looksLikeWkt(text)

  const ask = () => {
    const verdict = editor.describeAttribute(nodeId, attrKey)
    if (!verdict?.editable) {
      setNote(verdict?.reason || 'This value cannot be changed here.')
      return false
    }
    setNote('')
    return true
  }
  const save = () => {
    const result = editor.setAttribute(nodeId, attrKey, draft)
    if (result?.ok) setDraft(null)
    else setNote(result?.error || 'Could not save.')
  }
  const cancel = () => {
    setDraft(null)
    setNote('')
  }

  if (draft !== null) {
    const multiline = long || geometry || text.includes('\n')
    const onKeyDown = (e) => {
      if (e.key === 'Escape') cancel()
      else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (draft !== text) save()
      }
    }
    return (
      <div className="attr-edit-box">
        {multiline ? (
          <textarea className="attr-edit-input" rows={geometry ? 5 : 4} value={draft} autoFocus
            onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} />
        ) : (
          <input className="attr-edit-input" value={draft} autoFocus
            onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} />
        )}
        <div className="attr-edit-actions">
          <button type="button" className="attr-edit-save" disabled={draft === text} onClick={save}>Save</button>
          <button type="button" className="copy-btn" onClick={cancel}>Cancel</button>
          <span className="attr-edit-hint">{multiline ? 'Ctrl+Enter saves' : 'Enter saves'} · Esc cancels</span>
        </div>
        {note && <div className="attr-edit-note">{note}</div>}
      </div>
    )
  }

  return (
    <>
      {children}
      <span className="attr-edit-tools">
        <button type="button" className="attr-edit-btn" title="Change this value" onClick={() => ask() && setDraft(text)}>✎</button>
        {geometry && (
          <button type="button" className="attr-edit-btn" title="Move, add and remove its points on the map"
            onClick={() => ask() && startGeometryEdit(nodeId, attrKey)}>
            ⚑ edit on map
          </button>
        )}
      </span>
      {note && (
        <div className="attr-edit-note">
          {note} <span className="attr-edit-dismiss" onClick={() => setNote('')}>×</span>
        </div>
      )}
    </>
  )
}
