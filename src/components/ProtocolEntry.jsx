import React, { useMemo, useState } from 'react'
import { protocolMatches, protocolUnitList, useStore } from '../store'
import { fieldKind, objectParts } from '../lib/protocols'
import { statementsOf } from '../views/lib/harrisMatrix'
import { t } from '../i18n/en'
import { download } from '../lib/download'

// A unit's recording protocol (lib/protocols.js): the form of its package,
// section by section, as the BDA prints it — the fields its binding to this
// project keeps (lib/protocolBinding.js); a field left out is not shown, nor
// a part of one.

const sectionTitle = (key) => key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

function Where({ res }) {
  if (!res) return null
  if (res.how === 'elsewhere') return <span className="pf-where elsewhere" title={t.protocols.elsewhereTitle}>{t.protocols.elsewhere}</span>
  return null
}

function ProtocolField({ f, res, value, onChange, unitLabel, neighbours }) {
  const kind = fieldKind(f.def)
  const title = f.def.beschreibung || ''
  const label = (
    <label title={title}>
      {f.def.label || f.key} <Where res={res} />
      {res?.scope === 'project' && <span className="pf-where project">{t.protocols.project}</span>}
    </label>
  )
  if (res?.how === 'unitLabel') {
    return <div className="field">{label}<div className="pf-readonly">{unitLabel}</div><div className="field-note">{t.protocols.fromMatrixLabel}</div></div>
  }
  if (kind === 'grid') {
    return (
      <div className="field">
        {label}
        <div className="pf-readonly">
          {neighbours.above.length ? <>{t.protocols.above}: {neighbours.above.join(', ')}</> : null}
          {neighbours.above.length && neighbours.below.length ? <br /> : null}
          {neighbours.below.length ? <>{t.protocols.below}: {neighbours.below.join(', ')}</> : null}
          {!neighbours.above.length && !neighbours.below.length && <span className="note">—</span>}
        </div>
        <div className="field-note">{t.protocols.fromMatrix}</div>
      </div>
    )
  }
  if (res?.how === 'elsewhere') {
    return <div className="field">{label}<div className="field-note">{t.protocols.elsewhereNote}</div></div>
  }
  switch (kind) {
    case 'boolean':
      return (
        <div className="field pf-check">
          <label title={title}>
            <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {f.def.label || f.key} <Where res={res} />
          </label>
        </div>
      )
    case 'single':
      return (
        <div className="field">
          {label}
          <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
            <option value="">—</option>
            {(f.def.optionen || []).map((o) => <option key={o} value={o}>{o}</option>)}
            {value && !(f.def.optionen || []).includes(value) && <option value={value}>{value}</option>}
          </select>
        </div>
      )
    case 'multi': {
      const chosen = Array.isArray(value) ? value : []
      const toggle = (o) => onChange(chosen.includes(o) ? chosen.filter((x) => x !== o) : [...chosen, o])
      return (
        <div className="field">
          {label}
          <div className="pf-options">
            {(f.def.optionen || []).map((o) => (
              <label key={o}><input type="checkbox" checked={chosen.includes(o)} onChange={() => toggle(o)} /> {o}</label>
            ))}
            {chosen.filter((o) => !(f.def.optionen || []).includes(o)).map((o) => (
              <label key={o} className="pf-foreign"><input type="checkbox" checked onChange={() => toggle(o)} /> {o}</label>
            ))}
          </div>
        </div>
      )
    }
    case 'qualified': {
      const v = value || {}
      const kept = (q) => res?.how !== 'parts' || !!res.storage.quals?.[q]
      return (
        <div className="field">
          {label}
          <div className="pf-qualified">
            {(res?.how !== 'parts' || res.storage.main) && <input type="text" value={v.wert || ''} onChange={(e) => onChange({ ...v, wert: e.target.value })} />}
            {Object.keys(f.def.qualifikatoren).filter(kept).map((q) => (
              <label key={q}><input type="checkbox" checked={!!v[q]} onChange={(e) => onChange({ ...v, [q]: e.target.checked })} /> {q}</label>
            ))}
          </div>
        </div>
      )
    }
    case 'object': {
      const v = value || {}
      return (
        <fieldset className="field-group pf-object">
          <legend title={title}>{f.def.label || f.key} <Where res={res} /></legend>
          {objectParts(f.def).map((sub) => ({ ...sub, parts: sub.parts.filter((part) => res?.how !== 'parts' || !!res.storage.parts?.[sub.key]?.[part.key]) })).filter((sub) => sub.parts.length).map((sub) => (
            <div className="pf-sub" key={sub.key}>
              <span className="pf-sub-name">{sub.key.replace(/_/g, ' ')}</span>
              {sub.parts.map((part) => {
                const pv = v[sub.key]?.[part.key]
                const set = (x) => onChange({ ...v, [sub.key]: { ...(v[sub.key] || {}), [part.key]: x } })
                return part.kind === 'boolean'
                  ? <label key={part.key}><input type="checkbox" checked={!!pv} onChange={(e) => set(e.target.checked)} />{part.key !== 'wert' ? ` ${part.key}` : ''}</label>
                  : <input key={part.key} type="text" placeholder={part.key !== 'wert' ? part.key : ''} value={pv || ''} onChange={(e) => set(e.target.value)} />
              })}
            </div>
          ))}
        </fieldset>
      )
    }
    case 'longtext':
    case 'drawing':
      return (
        <div className="field">
          {label}
          <textarea rows={kind === 'drawing' ? 2 : 4} value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={f.def.hinweis || ''} />
        </div>
      )
    default:
      return (
        <div className="field">
          {label}
          <input type={f.def.format === 'date' ? 'date' : 'text'} value={value || ''} onChange={(e) => onChange(e.target.value)} />
        </div>
      )
  }
}

export default function ProtocolEntry() {
  const state = useStore()
  const { protocol, savedNotice, revision, graph } = state
  const { openProtocol, setProtocolPackage, setProtocolValue, saveProtocol, discardProtocol } = state
  const [search, setSearch] = useState('')
  const [pdfNote, setPdfNote] = useState('')
  const matches = protocolMatches(state)
  const units = useMemo(() => protocolUnitList(state), [state.workspace, revision, state.packages]) // eslint-disable-line react-hooks/exhaustive-deps
  const match = matches.find((m) => m.pkg.id === protocol?.packageId) || null
  const shown = units.filter((u) => !search.trim() || u.label.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 500)
  const unit = units.find((u) => u.id === protocol?.unitId)

  // The neighbours in the matrix, for the stratigraphy field.
  const neighbours = useMemo(() => {
    const out = { above: [], below: [] }
    const baseProp = state.workspace && useStore.getState().matrixRules()[0]?.baseProp
    if (!graph || !protocol || !baseProp) return out
    for (const s of statementsOf(graph, baseProp, protocol.unitId)) {
      const name = graph.nodes[s.partner]?.l || s.partner
      if (s.kind === 'higher') out.below.push(name)
      else if (s.kind === 'lower') out.above.push(name)
    }
    return out
  }, [graph, protocol?.unitId, revision]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!matches.length) {
    return (
      <div className="card">
        <p className="note">{state.packages.length ? t.protocols.noneBound : t.protocols.noneAdded}</p>
        <div className="enter-actions">
          {state.packages.map((p) => <button key={p.id} onClick={() => useStore.getState().openBindingDialog(p.id)}>{t.protocols.bind(p.protocol.name)}</button>)}
          <button onClick={() => useStore.setState({ tab: 'settings' })}>{t.protocols.toSettings}</button>
        </div>
      </div>
    )
  }

  const sections = []
  if (match) {
    for (const f of match.pkg.fields) {
      if (match.fields.get(f.path)?.how === 'omit') continue
      let sec = sections.find((s) => s.key === f.section)
      if (!sec) sections.push((sec = { key: f.section, fields: [] }))
      sec.fields.push(f)
    }
  }

  return (
    <div className="enter">
      <div className="card enter-side">
        <label className="block-label">{t.protocols.units}</label>
        <div className="enter-actions">
          <input type="search" placeholder={t.enter.searchRecords} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <p className="note">{t.protocols.unitCount(units.length)}</p>
        <ul className="node-list">
          {shown.map((u) => (
            <li key={u.id}>
              <button aria-current={u.id === protocol?.unitId} onClick={() => openProtocol(u.id)}>
                <span className="label">{u.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="card pf">
        {!protocol || !match ? (
          <p className="note">{t.protocols.choose}</p>
        ) : (
          <>
            <div className="pf-head">
              <h2>{unit?.label || protocol.unitId}</h2>
              <select value={match.pkg.id} onChange={(e) => setProtocolPackage(e.target.value)} title={t.protocols.typeTitle}>
                {matches.map((m) => <option key={m.pkg.id} value={m.pkg.id}>{m.pkg.protocol.name}</option>)}
              </select>
              <span className="note">{match.pkg.protocol.publisher}</span>
            </div>
            {sections.map((sec) => (
              <fieldset className="pf-section" key={sec.key}>
                <legend>{sectionTitle(sec.key)}</legend>
                <div className="pf-grid">
                  {sec.fields.map((f) => (
                    <ProtocolField
                      key={f.path}
                      f={f}
                      res={match.fields.get(f.path)}
                      value={protocol.values?.[f.section]?.[f.key]}
                      onChange={(v) => setProtocolValue(f.section, f.key, v)}
                      unitLabel={unit?.label || ''}
                      neighbours={neighbours}
                    />
                  ))}
                </div>
              </fieldset>
            ))}
            <div className="enter-footer pf-footer">
              <button className="primary" onClick={saveProtocol} disabled={!protocol.dirty}>{t.enter.save}</button>
              <button onClick={discardProtocol} disabled={!protocol.dirty}>{t.protocols.cancel}</button>
              <button
                title={t.protocols.pdfTitle}
                onClick={async () => {
                  if (protocol.dirty) { setPdfNote(t.protocols.pdfSaveFirst); return }
                  try {
                    const r = await useStore.getState().protocolPdf(protocol.unitId)
                    download(r.name, 'application/pdf', r.bytes)
                    setPdfNote(r.missing.length ? t.protocols.pdfMissing(r.missing.length) : '')
                  } catch (error) { setPdfNote(error.message) }
                }}
              >{t.protocols.pdf}</button>
              {pdfNote && <span className="note">{pdfNote}</span>}
              {protocol.dirty ? <span className="note">{t.protocols.unsaved}</span> : savedNotice && <span className="saved">{savedNotice}</span>}
              <span className="note" style={{ marginLeft: 'auto' }}>{t.protocols.counts(match.counts)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
