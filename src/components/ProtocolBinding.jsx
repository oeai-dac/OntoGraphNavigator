import React, { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { summarizeChoices } from '../lib/protocolBinding'
import { t } from '../i18n/en'

// Where a protocol's fields live in this project (lib/protocolBinding.js).
// Opens when a package is added, and from
// Settings → Recording protocols to change a binding. Field by field: the
// package's own path (found in the mapping, or put there as the package models
// it), a field the units already have, a new field of the mapping, or left out.

const sectionTitle = (key) => key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** A part's choice as the value of its <select>, and back. */
const encode = (c) => (!c || c.use === 'omit' ? 'omit' : c.use === 'node' ? `node:${c.nodeId}` : `new:${c.as}`)
const decode = (value, previous, label) => {
  if (value === 'omit') return { use: 'omit' }
  if (value.startsWith('node:')) return { use: 'node', nodeId: value.slice(5) }
  return { use: 'new', as: value.slice(4), name: previous?.use === 'new' ? previous.name : label }
}

function PartChoice({ part, choice, candidates, onChange, packageOption = null, onPackage = null }) {
  const value = packageOption && onPackage && (choice === 'package' || choice === 'model') ? choice : encode(choice)
  return (
    <span className="pb-choice">
      <select
        value={value}
        onChange={(e) => (e.target.value === 'package' || e.target.value === 'model' ? onPackage(e.target.value === 'model') : onChange(decode(e.target.value, choice, part.label)))}
      >
        {packageOption}
        {candidates.length > 0 && (
          <optgroup label={t.binding.existing}>
            {candidates.map((c) => <option key={c.nodeId} value={`node:${c.nodeId}`}>{c.name} ({c.column})</option>)}
          </optgroup>
        )}
        <optgroup label={t.binding.newGroup}>
          <option value="new:literal">{part.kind === 'boolean' ? t.binding.newYesNo : t.binding.newLiteral}</option>
          {part.kind !== 'boolean' && <option value="new:type">{t.binding.newType}</option>}
        </optgroup>
        <option value="omit">{t.binding.omit}</option>
      </select>
      {choice?.use === 'new' && (
        <input type="text" value={choice.name} title={t.binding.nameTitle} onChange={(e) => onChange({ ...choice, name: e.target.value })} />
      )}
    </span>
  )
}

function FieldRow({ field, candidates, setChoice }) {
  const { choice, parts } = field
  if (field.derived) {
    return (
      <tr>
        <td>{field.label}</td>
        <td className="note">{t.binding.kind[field.kind] || field.kind}</td>
        <td className="note">{t.binding.auto}</td>
      </tr>
    )
  }
  const packageOption = field.packagePath ? (
    <option value="package">{t.binding.packagePath(field.packagePath.name, field.packagePath.how === 'elsewhere')}</option>
  ) : field.packageModel ? (
    <option value="model">{t.binding.packageModel(field.packageModel)}</option>
  ) : null
  const packageChoice = choice.use === 'package' ? (choice.create ? 'model' : 'package') : null
  const partsChoice = choice.use === 'parts' ? choice.parts : Object.fromEntries(parts.map((p) => [p.key, { use: 'omit' }]))
  const setPart = (key, c) => setChoice({ use: 'parts', parts: { ...partsChoice, [key]: c } })

  // One part: one choice.
  if (parts.length === 1) {
    const part = parts[0]
    return (
      <tr>
        <td>{field.label}</td>
        <td className="note">{t.binding.kind[part.kind] || part.kind}</td>
        <td>
          <PartChoice
            part={part}
            choice={packageChoice || (choice.use === 'omit' ? { use: 'omit' } : partsChoice[part.key])}
            candidates={candidates}
            packageOption={packageOption}
            onPackage={(create) => setChoice(create ? { use: 'package', create: true } : { use: 'package' })}
            onChange={(c) => (c.use === 'omit' ? setChoice({ use: 'omit' }) : setPart(part.key, c))}
          />
        </td>
      </tr>
    )
  }
  // Several parts: the field as a whole, then part by part.
  return (
    <>
      <tr>
        <td>{field.label}</td>
        <td className="note">{t.binding.kind[field.kind] || field.kind}</td>
        <td>
          <select
            value={packageChoice || choice.use}
            onChange={(e) => {
              const use = e.target.value
              if (use === 'model') setChoice({ use: 'package', create: true })
              else if (use === 'parts') setChoice({ use: 'parts', parts: Object.fromEntries(parts.map((p) => [p.key, partsChoice[p.key]?.use && partsChoice[p.key].use !== 'omit' ? partsChoice[p.key] : { use: 'new', as: p.kind === 'single' ? 'type' : 'literal', name: p.label }])) })
              else setChoice({ use })
            }}
          >
            {packageOption}
            <option value="parts">{t.binding.byParts(parts.length)}</option>
            <option value="omit">{t.binding.omit}</option>
          </select>
        </td>
      </tr>
      {choice.use === 'parts' && parts.map((part) => (
        <tr key={part.key} className="pb-part">
          <td>{part.label}</td>
          <td className="note">{t.binding.kind[part.kind] || part.kind}</td>
          <td><PartChoice part={part} choice={partsChoice[part.key]} candidates={candidates} onChange={(c) => setPart(part.key, c)} /></td>
        </tr>
      ))}
    </>
  )
}

export default function ProtocolBinding() {
  const packageId = useStore((s) => s.bindingDialog)
  const pkg = useStore((s) => s.packages.find((p) => p.id === s.bindingDialog))
  const bound = useStore((s) => !!s.config?.protocolBindings?.[s.bindingDialog])
  const { proposeProtocolBinding, applyProtocolBinding, closeBindingDialog } = useStore.getState()
  const [unitNodeId, setUnitNodeId] = useState(null)
  const [proposal, setProposal] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!packageId) return
    setError('')
    setProposal(proposeProtocolBinding(packageId, unitNodeId))
  }, [packageId, unitNodeId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setUnitNodeId(null) }, [packageId])

  const summary = useMemo(() => (proposal?.fields ? summarizeChoices(proposal.fields) : null), [proposal])
  if (!packageId || !pkg) return null

  const sections = []
  for (const f of proposal?.fields || []) {
    let sec = sections.find((s) => s.key === f.section)
    if (!sec) sections.push((sec = { key: f.section, fields: [] }))
    sec.fields.push(f)
  }
  const setChoice = (path, choice) => setProposal((p) => ({ ...p, fields: p.fields.map((f) => (f.path === path ? { ...f, choice } : f)) }))

  const apply = () => {
    const choices = { unitNodeId: proposal.unitNodeId, fields: Object.fromEntries(proposal.fields.map((f) => [f.path, f.choice])) }
    const r = applyProtocolBinding(packageId, choices)
    if (!r.ok) setError(r.error)
  }

  return (
    <div className="pb-backdrop" role="dialog" aria-modal="true" aria-label={t.binding.title(pkg.protocol.name)}>
      <div className="pb-dialog card">
        <h2>{t.binding.title(pkg.protocol.name)}</h2>
        <p className="note">{t.binding.intro}</p>
        <label className="pb-units">
          {t.binding.units}{' '}
          <select value={proposal?.unitNodeId || ''} onChange={(e) => setUnitNodeId(e.target.value || null)}>
            {!proposal?.unitNodeId && <option value="">—</option>}
            {(proposal?.units || []).map((u) => <option key={u.nodeId} value={u.nodeId}>{u.label} · {u.className}</option>)}
          </select>
        </label>
        {proposal?.error && <p className="note error">{proposal.error}</p>}
        {proposal?.fields && (
          <div className="pb-body">
            {sections.map((sec) => (
              <table className="pb-table" key={sec.key}>
                <caption>{sectionTitle(sec.key)}</caption>
                <tbody>
                  {sec.fields.map((f) => <FieldRow key={f.path} field={f} candidates={proposal.candidates} setChoice={(c) => setChoice(f.path, c)} />)}
                </tbody>
              </table>
            ))}
          </div>
        )}
        <div className="pb-footer">
          {summary && <span className="note">{t.binding.summary(summary)}</span>}
          <span className="note">{t.binding.mappingNote(bound)}</span>
          {error && <span className="note error">{error}</span>}
          <span className="pb-buttons">
            <button onClick={closeBindingDialog}>{t.protocols.cancel}</button>
            <button className="primary" disabled={!proposal?.fields} onClick={apply}>{bound ? t.binding.applyAgain : t.binding.apply}</button>
          </span>
        </div>
      </div>
    </div>
  )
}
