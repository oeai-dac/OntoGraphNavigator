import React, { useState } from 'react'
import { useStore } from '../store'
import { t } from '../i18n/en'
import { writeGraphJson } from '../lib/graphJson'
import { writeProjectFile } from '../lib/projectFile'
import { toQuads } from '../lib/rdfExport'
import { serializeRdf, RDF_FORMATS } from '../lib/rdfSerialize'
import { tablesToFiles, graphToFiles, TABLE_FORMATS } from '../lib/tableExport'
import { toJsonl, toReadableLog, summarise } from '../lib/journal'
import { writeSidecar } from '../lib/sidecar'

import { download } from '../lib/download'
import { protocolMatches } from '../store'

function Card({ title, note, unavailable, children }) {
  return (
    <div className={`card${unavailable ? ' unavailable' : ''}`}>
      <h2>{title}</h2>
      <p className="note">{note}</p>
      <div className="actions">{children}</div>
    </div>
  )
}

export default function ExportPanel() {
  const graph = useStore((s) => s.graph)
  const model = useStore((s) => s.model)
  const derived = useStore((s) => s.derived)
  const filename = useStore((s) => s.filename)
  const [rdfFormat, setRdfFormat] = useState('trig')
  const [tableFormat, setTableFormat] = useState('tsv')
  const [busy, setBusy] = useState('')
  const workspace = useStore((s) => s.workspace)
  const config = useStore((s) => s.config)
  const journal = workspace?.journal || null
  const changes = journal ? summarise(journal) : null

  const stem = filename.replace(/\.[^.]+$/, '') || 'graph'
  const hasProtocols = useStore((s) => protocolMatches(s).length > 0)
  const [pdfState, setPdfState] = useState('')
  async function exportProtocols(format) {
    try {
      setPdfState('…')
      const r = await useStore.getState().protocolPdfs(format, (i, n) => setPdfState(t.protocols.exporting(i, n)))
      download(r.name, format === 'zip' ? 'application/zip' : 'application/pdf', r.bytes)
      setPdfState(t.protocols.exported(r.units, r.name) + (r.missing.length ? ` · ${t.protocols.pdfMissing(r.missing.length)}` : ''))
    } catch (error) {
      setPdfState(error.message)
    }
  }
  const hasModel = Boolean(model)

  const exportRdf = async () => {
    setBusy('rdf')
    try {
      const { quads } = toQuads(model)
      const text = await serializeRdf(quads, { format: rdfFormat, prefixes: model.prefixMap })
      download(`${stem}.${RDF_FORMATS[rdfFormat].extension}`, RDF_FORMATS[rdfFormat].mime, text)
    } finally {
      setBusy('')
    }
  }

  const exportTables = () => {
    const files = hasModel ? tablesToFiles(model, tableFormat) : graphToFiles(graph, derived, tableFormat)
    // One download per file rather than a zip: no extra dependency, and the
    // browser puts them all in the same folder anyway.
    for (const file of files) download(file.name, file.mime, file.content)
  }

  const tableFileCount = hasModel ? model.tables.size : derived.types.length

  return (
    <div className="export-grid">
      <Card title={t.exportPanel.graphJson} note={t.exportPanel.graphJsonNote}>
        <button
          className="primary"
          onClick={() => download(`${stem}.json`, 'application/json', writeGraphJson(graph))}
        >
          {t.exportPanel.download}
        </button>
      </Card>

      <Card title={t.exportPanel.project} note={t.exportPanel.projectNote} unavailable={!hasModel}>
        <button
          className="primary"
          disabled={!hasModel}
          onClick={() => {
            const { bytes, name } = useStore.getState().saveProject()
            download(name, 'application/zip', bytes)
          }}
        >
          {t.exportPanel.download}
        </button>
      </Card>

      <Card
        title={t.exportPanel.projectFile}
        note={hasModel ? t.exportPanel.projectFileNote : t.exportPanel.projectFileUnavailable}
        unavailable={!hasModel}
      >
        <button
          className="primary"
          disabled={!hasModel}
          onClick={() =>
            download(`${stem}.project.json`, 'application/json', JSON.stringify(writeProjectFile(model)))
          }
        >
          {t.exportPanel.download}
        </button>
      </Card>

      <Card
        title={t.exportPanel.rdf}
        note={hasModel ? t.exportPanel.rdfNote : t.exportPanel.rdfUnavailable}
        unavailable={!hasModel}
      >
        <label>
          {t.exportPanel.format}{' '}
          <select value={rdfFormat} onChange={(e) => setRdfFormat(e.target.value)} disabled={!hasModel}>
            {Object.entries(RDF_FORMATS).map(([key, spec]) => (
              <option key={key} value={key}>
                {spec.label}
                {spec.graphs ? '' : ' — graphs merged'}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={!hasModel || busy === 'rdf'} onClick={exportRdf}>
          {busy === 'rdf' ? t.exportPanel.working : t.exportPanel.download}
        </button>
      </Card>

      <Card
        title={t.log.title}
        note={
          changes
            ? `${t.log.note} ${changes.entries} entries, ${changes.rows} row(s) touched, ${changes.added} added.`
            : t.log.note
        }
        unavailable={!journal}
      >
        <button
          className="primary"
          disabled={!journal || !changes?.entries}
          onClick={() => download(`${stem}.ogn-log.jsonl`, 'application/x-ndjson', toJsonl(journal))}
        >
          {t.log.downloadJsonl}
        </button>
        <button
          disabled={!journal || !changes?.entries}
          onClick={() => download(`${stem}.ogn-log.tsv`, 'text/tab-separated-values', toReadableLog(journal))}
        >
          {t.log.downloadReadable}
        </button>
      </Card>

      {hasProtocols && (
        <Card title={t.protocols.exportTitle} note={t.protocols.exportNote}>
          <button className="primary" disabled={pdfState.endsWith('…')} onClick={() => exportProtocols('pdf')}>{t.protocols.exportOne}</button>
          <button disabled={pdfState.endsWith('…')} onClick={() => exportProtocols('zip')}>{t.protocols.exportZip}</button>
          {pdfState && <span className="note">{pdfState}</span>}
        </Card>
      )}

      <Card title={t.log.settings} note={t.log.settingsNote} unavailable={!hasModel}>
        <button
          className="primary"
          disabled={!hasModel}
          onClick={() => download(`${stem}.ogn.json`, 'application/json', writeSidecar(config))}
        >
          {t.exportPanel.download}
        </button>
      </Card>

      <Card
        title={t.exportPanel.tables}
        note={hasModel ? t.exportPanel.tablesNote : t.exportPanel.tablesFromGraph}
      >
        <label>
          {t.exportPanel.format}{' '}
          <select value={tableFormat} onChange={(e) => setTableFormat(e.target.value)}>
            {Object.entries(TABLE_FORMATS).map(([key, spec]) => (
              <option key={key} value={key}>
                {spec.label}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" onClick={exportTables}>
          {t.exportPanel.download} ({t.exportPanel.files(tableFileCount)})
        </button>
      </Card>
    </div>
  )
}
