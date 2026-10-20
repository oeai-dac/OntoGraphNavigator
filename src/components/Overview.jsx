import { openTypeInExplorer } from './ViewsHost'
import React from 'react'
import { useStore } from '../store'
import { t } from '../i18n/en'
import { readableTextColor } from '../lib/schema'

const n = (value) => Number(value || 0).toLocaleString('en')

function Tile({ value, label }) {
  return (
    <div className="tile">
      <div className="value">{n(value)}</div>
      <div className="label">{label}</div>
    </div>
  )
}

export default function Overview() {
  const graph = useStore((s) => s.graph)
  const derived = useStore((s) => s.derived)
  const report = useStore((s) => s.report)
  const source = useStore((s) => s.source)
  const warnings = useStore((s) => s.warnings)
  // A type opens in the Explorer, filtered to it (the Browse tab is gone, step 7e).
  const openType = (typeKey) => openTypeInExplorer(typeKey)

  return (
    <>
      <div className="tiles">
        <Tile value={Object.keys(graph.nodes).length} label={t.overview.nodes} />
        <Tile value={derived.types.length} label={t.overview.types} />
        <Tile value={Object.keys(graph.edge_types).length} label={t.overview.edgeTypes} />
        {source === 'project' && <Tile value={report.tables} label={t.overview.tables} />}
        {source === 'project' && <Tile value={report.rows} label={t.overview.rows} />}
      </div>

      {warnings.length > 0 && (
        <div className="notice">
          <h3>{t.overview.warnings}</h3>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>{t.overview.typeTable}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t.overview.typeName}</th>
                <th className="num">{t.overview.count}</th>
                <th className="num">{t.overview.attributes}</th>
                <th className="num">{t.overview.relations}</th>
              </tr>
            </thead>
            <tbody>
              {derived.types.map((type) => (
                <tr key={type.typeKey}>
                  <td>
                    <button
                      style={{ border: 'none', background: 'none', padding: 0, textAlign: 'left' }}
                      onClick={() => openType(type.typeKey)}
                    >
                      <span className="swatch" style={{ background: type.color || 'var(--border)' }} />
                      <span style={{ color: readableTextColor(type.color) }}>{type.label}</span>
                    </button>
                  </td>
                  <td className="num">{n(type.count)}</td>
                  <td className="num">{type.attributes.length}</td>
                  <td className="num">{type.outgoing.length + type.incoming.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
