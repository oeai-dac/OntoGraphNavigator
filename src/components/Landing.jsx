import React, { useCallback, useRef, useState } from 'react'
import { useStore, describeAge } from '../store'
import { t } from '../i18n/en'

export default function Landing() {
  const load = useStore((s) => s.load)
  const newMatrix = useStore((s) => s.newMatrix)
  const status = useStore((s) => s.status)
  const error = useStore((s) => s.error)
  const restorable = useStore((s) => s.restorable)
  const restore = useStore((s) => s.restore)
  const discardRestorable = useStore((s) => s.discardRestorable)
  const inputRef = useRef(null)
  const [over, setOver] = useState(false)

  const take = useCallback(
    (fileList) => {
      const file = fileList?.[0]
      if (file) load(file)
    },
    [load]
  )

  return (
    <div className="landing">
      {restorable && (
        <div className="restore">
          <h3>{t.autosave.restoreTitle}</h3>
          <p>
            {t.autosave.restoreBody(
              restorable.changes,
              describeAge(restorable.savedAt),
              restorable.filename
            )}
          </p>
          <div className="actions">
            <button className="primary" onClick={restore}>
              {t.autosave.restore}
            </button>
            <button onClick={discardRestorable}>{t.autosave.discard}</button>
          </div>
        </div>
      )}

      <div
        className={`dropzone${over ? ' over' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          take(e.dataTransfer.files)
        }}
      >
        <strong>{status === 'loading' ? t.landing.reading : t.landing.dropHere}</strong>
        <span className="accepted">{t.landing.accepted}</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".ognproj,.json,.graphml,.ttl,.trig,.nt,.nq,.n3"
        hidden
        onChange={(e) => take(e.target.files)}
      />

      <div className="landing-new">
        <span className="or">{t.landing.or}</span>
        <button type="button" onClick={newMatrix} disabled={status === 'loading'}>
          {t.landing.newMatrix}
        </button>
        <p>{t.landing.newMatrixNote}</p>
      </div>

      <p className="hint">{t.landing.hint}</p>

      {error && (
        <div className="error">
          <strong>{t.landing.failed}</strong>
          <br />
          {error}
        </div>
      )}
    </div>
  )
}
