import React, { useRef, useState } from 'react'
import { protocolMatches, useStore } from '../store'
import { t } from '../i18n/en'
import { KNOWN_THESAURI, directUrl, proxyAvailable } from '../lib/thesaurusSources'
import { DEFAULT_PRIMARY, isValidLangTag, languagesOf } from '../lib/languages'

/**
 * Identifier rules, vocabularies and who is entering.
 *
 * Rules are shown with the share of existing identifiers they reproduce, and
 * adopted by hand. A rule at 95 % is not wrong — the reference project builds 18
 * of 397 geometry ids from a different column — but it is worth seeing before it
 * mints anything.
 */
export default function Settings() {
  const state = useStore()
  const { model, forms, config, ruleProposals, thesauri, thesaurusStatus, author } = state
  const fileRef = useRef(null)
  const settingsRef = useRef(null)

  if (!model) {
    return (
      <div className="card">
        <h2>{t.settings.title}</h2>
        <p className="note">{t.enter.needsProject}</p>
      </div>
    )
  }

  const conceptFields = []
  for (const form of forms?.forms || []) {
    for (const field of form.fields) {
      if (field.kind === 'concept' && field.targetNodeId) {
        conceptFields.push({ form, field })
      }
    }
  }

  return (
    <>
      <Languages model={model} forms={forms} setLanguages={state.setLanguages} />
      <Protocols />

      <div className="card">
        <h2>{t.settings.author}</h2>
        <input type="text" value={author} onChange={(e) => state.setAuthor(e.target.value)} style={{ width: 260 }} />
        <div className="actions" style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button onClick={() => settingsRef.current?.click()}>{t.settings.loadSettings}</button>
          <input
            ref={settingsRef}
            type="file"
            accept=".json"
            hidden
            onChange={(e) => e.target.files?.[0] && state.loadSidecar(e.target.files[0])}
          />
        </div>
      </div>

      <div className="card">
        <h2>{t.settings.identifierRules}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Record</th>
                <th>Column</th>
                <th>{t.settings.ruleFor}</th>
                <th className="num">{t.settings.coverage}</th>
              </tr>
            </thead>
            <tbody>
              {[
                ...(forms?.forms || []),
                // Nodes inside a record (a group, a type, a measurement, the partner of a relation)
                // whose identifier is made by a rule too: listed so their rule can be seen and changed.
                ...[...(state.workspace?.model?.entities?.values() || [])]
                  // (not a role of a record listed already — the phases' order takes the phase's identifier)
                  .filter((e) => e.idColumn && !(forms?.forms || []).some((f) => f.nodeId === e.nodeId || (f.idColumn === e.idColumn && f.label === (e.explorerLabel || e.classLabel)))
                    && (config.uriRules[e.nodeId] || ruleProposals.some((p) => p.nodeId === e.nodeId)))
                  .map((e) => ({ nodeId: e.nodeId, label: `${e.explorerLabel || e.classLabel} ${t.settings.withinRecord}`, idColumn: e.idColumn })),
              ].map((form) => {
                const proposal = ruleProposals.find((p) => p.nodeId === form.nodeId)
                const active = config.uriRules[form.nodeId] || ''
                return (
                  <tr key={form.nodeId}>
                    <td>{form.label}</td>
                    <td><code style={{ fontSize: 12 }}>{form.idColumn}</code></td>
                    <td>
                      <input
                        type="text"
                        value={active}
                        placeholder={proposal ? proposal.template : '{Column}_suffix'}
                        onChange={(e) => state.setUriRule(form.nodeId, e.target.value)}
                        style={{ width: '100%', minWidth: 200, fontFamily: 'var(--mono)', fontSize: 12 }}
                      />
                    </td>
                    <td className="num">
                      {proposal ? (
                        active === proposal.template ? (
                          `${(proposal.coverage * 100).toFixed(0)}%`
                        ) : (
                          <button onClick={() => state.setUriRule(form.nodeId, proposal.template)}>
                            {t.settings.apply} {(proposal.coverage * 100).toFixed(0)}%
                          </button>
                        )
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>{t.settings.thesauri}</h2>
        <p className="note">{t.settings.proxyNote}</p>
        <div className="actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <button onClick={() => fileRef.current?.click()}>{t.settings.addFile}</button>
          <input
            ref={fileRef}
            type="file"
            accept=".ttl,.trig,.nt,.nq,.txt"
            hidden
            onChange={(e) => e.target.files?.[0] && state.addThesaurusFile(e.target.files[0])}
          />
          {KNOWN_THESAURI.map((entry) => {
            const status = thesaurusStatus[entry.id]
            const loaded = thesauri.has(entry.conceptNamespace) || [...thesauri.values()].some((x) => x.id.includes(entry.id))
            return (
              <button
                key={entry.id}
                disabled={status === 'loading'}
                onClick={() => state.addKnownThesaurus(entry.id)}
                title={directUrl(entry)}
              >
                {status === 'loading' ? '…' : loaded ? '↻' : '↓'} {entry.name}
              </button>
            )
          })}
          {!proxyAvailable() && <span className="note" style={{ margin: 0 }}>({t.settings.online} — build has no proxy)</span>}
        </div>

        {Object.entries(thesaurusStatus)
          .filter(([, v]) => v && v !== 'ready' && v !== 'loading')
          .map(([id, message]) => (
            <div className="notice" key={id}>
              <h3>{id}</h3>
              <ul><li>{message}</li></ul>
            </div>
          ))}

        {thesauri.size > 0 && (
          <ul style={{ margin: '0 0 12px', paddingLeft: 20 }}>
            {[...thesauri.values()].map((x) => (
              <li key={x.id}>
                <strong>{x.name}</strong> — {x.report.concepts} {t.settings.concepts}, {x.report.languages.join('/')}
                {x.report.repaired ? `, ${x.report.repaired} characters repaired` : ''}
                {x.origin?.kind === 'online' ? ` · ${t.settings.online}` : ''}
              </li>
            ))}
          </ul>
        )}

        {conceptFields.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Column</th>
                  <th>{t.settings.boundTo}</th>
                </tr>
              </thead>
              <tbody>
                {conceptFields.map(({ form, field }) => (
                  <tr key={`${form.nodeId}-${field.key}`}>
                    <td>
                      {form.label} › {field.label}
                    </td>
                    <td><code style={{ fontSize: 12 }}>{field.column}</code></td>
                    <td>
                      <select
                        value={config.thesaurusBindings[field.targetNodeId]?.thesaurusId || ''}
                        onChange={(e) => state.setThesaurusBinding(field.targetNodeId, e.target.value)}
                      >
                        <option value="">{t.settings.none}</option>
                        {[...thesauri.values()].map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

/**
 * The project's languages. Shown for every project; declared here only for a
 * project from before Studio 3.1, which names none — changing the languages of
 * one that does is the Studio's job, since its labels move with them.
 */
function Languages({ model, forms, setLanguages }) {
  const langs = languagesOf(model)
  const [primary, setPrimary] = useState(DEFAULT_PRIMARY)
  const [further, setFurther] = useState('')
  const furtherTags = further.split(',').map((s) => s.trim()).filter(Boolean)
  const valid = isValidLangTag(primary) && furtherTags.every(isValidLangTag)

  // Types whose label has no column in a further language: nothing to enter
  // into until the Studio maps one.
  const missing = []
  for (const lang of langs.additional) {
    const names = (forms?.forms || [])
      .filter((form) => form.fields.some((f) => f.key === 'label') && !form.fields.some((f) => f.key === `label@${lang}`))
      .map((form) => form.label)
    if (names.length) missing.push([lang, names])
  }

  return (
    <div className="card">
      <h2>{t.settings.languages}</h2>
      <p>
        {t.settings.primary}: <strong>{langs.primary}</strong> · {t.settings.further}:{' '}
        <strong>{langs.additional.join(', ') || t.settings.noFurther}</strong>
      </p>
      {model.languages ? (
        <p className="note">{t.settings.languagesFromStudio}</p>
      ) : (
        <>
          <p className="note">{t.settings.languagesUndeclared}</p>
          <div className="actions" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label>
              {t.settings.primaryTag}{' '}
              <input type="text" value={primary} onChange={(e) => setPrimary(e.target.value)} style={{ width: 60 }} />
            </label>
            <label>
              {t.settings.furtherTags}{' '}
              <input type="text" value={further} onChange={(e) => setFurther(e.target.value)} style={{ width: 120 }} />
            </label>
            <button disabled={!valid} onClick={() => setLanguages({ primary, additional: furtherTags })}>
              {t.settings.applyLanguages}
            </button>
          </div>
        </>
      )}
      {missing.map(([lang, names]) => (
        <p key={lang} className="note">
          <strong>{lang}</strong> — {t.settings.missingColumns} {names.join(', ')}
        </p>
      ))}
    </div>
  )
}

/** The recording protocol packages: which there are, whether each is bound to this project, adding, binding, removal. */
function Protocols() {
  const packages = useStore((s) => s.packages)
  const matches = useStore((s) => protocolMatches(s))
  const bindings = useStore((s) => s.config?.protocolBindings || {})
  const hasModel = useStore((s) => !!s.workspace?.model)
  const importPackage = useStore((s) => s.importPackage)
  const removePackage = useStore((s) => s.removePackage)
  const openBindingDialog = useStore((s) => s.openBindingDialog)
  const fileRef = useRef(null)
  const [note, setNote] = useState('')

  return (
    <div className="card">
      <h2>{t.protocols.settingsTitle}</h2>
      <p className="note">{t.protocols.settingsNote}</p>
      <table className="protocol-table">
        <tbody>
          {packages.map((pkg) => {
            const m = matches.find((x) => x.pkg.id === pkg.id)
            return (
              <React.Fragment key={pkg.id}>
                <tr>
                  <td><b>{pkg.protocol?.name}</b><div className="note">{pkg.protocol?.publisher} · {pkg.protocol?.version}</div></td>
                  <td className="note">{m ? t.protocols.counts(m.counts) : bindings[pkg.id] ? t.protocols.counts({ mapped: 0, omitted: 0, lost: 1 }) : t.protocols.notBound}</td>
                  <td>
                    {hasModel
                      ? <button onClick={() => openBindingDialog(pkg.id)}>{bindings[pkg.id] ? t.protocols.rebind : t.protocols.bindNow}</button>
                      : <span className="note">{t.protocols.needsProject}</span>}
                    <button onClick={() => removePackage(pkg.id)}>{t.protocols.remove}</button>
                  </td>
                </tr>
                {pkg.problems?.filter((p) => p.severity === 'warning').length > 0 && (
                  <tr><td colSpan={3} className="note">{pkg.problems.map((p) => p.message).join(' ')}</td></tr>
                )}
              </React.Fragment>
            )
          })}
        </tbody>
      </table>
      <input ref={fileRef} type="file" accept=".zip" hidden onChange={async (e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file) return
        const r = await importPackage(file)
        setNote(r.ok ? `${r.pkg.protocol.name} — ${r.pkg.fields.length} fields` : r.error)
      }} />
      <button onClick={() => fileRef.current?.click()}>{t.protocols.importZip}</button>
      {note && <span className="note" style={{ marginLeft: 10 }}>{note}</span>}
    </div>
  )
}
