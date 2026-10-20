import React, { useEffect, useMemo } from 'react'
import { download } from './lib/download'
import { useStore, editState, AUTOSAVE_INTERVAL_MS, describeAge, storageAvailable } from './store'
import { t } from './i18n/en'
import { allLanguages } from './lib/languages'
import Landing from './components/Landing'
import Overview from './components/Overview'
import Enter from './components/Enter'
import Grid from './components/Grid'
import Settings from './components/Settings'
import ProtocolBinding from './components/ProtocolBinding'
import ExportPanel from './components/ExportPanel'
import ViewsHost, { isViewTab, viewTabsFor } from './components/ViewsHost'

export default function App() {
  const status = useStore((s) => s.status)
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  const reset = useStore((s) => s.reset)
  const filename = useStore((s) => s.filename)
  const source = useStore((s) => s.source)
  const model = useStore((s) => s.model)
  const graph = useStore((s) => s.graph)
  const graphLanguages = graph?.languages
  // Whether the graph has geometries, dates, stratigraphy — asked once per graph.
  // The matrix is offered as soon as the mapping has one — also before its first unit.
  const workspace = useStore((s) => s.workspace)
  const viewTabs = useMemo(
    () => viewTabsFor(graph, workspace && useStore.getState().matrixRules().length ? ['matrix'] : []),
    [graph, workspace]
  )
  const displayLang = useStore((s) => s.displayLang)
  const setDisplayLang = useStore((s) => s.setDisplayLang)
  const revision = useStore((s) => s.revision)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const edits = useStore(editState)
  const autoSave = useStore((s) => s.autoSave)
  const autoSaveStatus = useStore((s) => s.autoSaveStatus)
  const autoSaveNow = useStore((s) => s.autoSaveNow)
  const findRestorable = useStore((s) => s.findRestorable)
  const setAutoSave = useStore((s) => s.setAutoSave)

  const ready = status === 'ready'
  /** The project as one .ognproj file (lib/projectZip.js), handed to the browser as a download. */
  const saveProject = () => {
    try {
      const { bytes, name } = useStore.getState().saveProject()
      download(name, 'application/zip', bytes)
    } catch (error) {
      useStore.setState({ error: error.message })
    }
  }
  const canEdit = ready && Boolean(model)

  // Ctrl+Z / Ctrl+Y, unless a text field has focus and something is selected.
  useEffect(() => {
    const onKey = (event) => {
      if (!canEdit || !(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        saveProject()
      } else if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        undo()
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canEdit, undo, redo, revision])

  // Editing lives in memory until a file is written; leaving would lose it.
  useEffect(() => {
    if (!edits.changes) return undefined
    const warn = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [edits.changes])

  // A copy into browser storage, on a timer and once more on the way out. Not a
  // substitute for the project file — see src/lib/autosave.js — but it means a
  // reload or a crash costs at most half a minute.
  useEffect(() => {
    if (!canEdit || !autoSave) return undefined
    const timer = setInterval(() => autoSaveNow(), AUTOSAVE_INTERVAL_MS)
    const onHide = () => autoSaveNow()
    window.addEventListener('pagehide', onHide)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', onHide)
      autoSaveNow()
    }
  }, [canEdit, autoSave, autoSaveNow])

  // Recording protocols imported in an earlier session.
  useEffect(() => {
    useStore.getState().loadImportedPackages()
  }, [])

  // Is there a copy from an earlier session to offer?
  useEffect(() => {
    if (status === 'empty' && storageAvailable()) findRestorable()
  }, [status, findRestorable])

  const tabs = [
    ['overview', t.tabs.overview, true],
    ['enter', t.enter.title, canEdit],
    ['grid', t.grid.title, canEdit],
    // The GraphExplorer's views, as far as this graph has the data for them.
    ...viewTabs.map((v) => [v.key, v.label, true]),
    ['settings', t.settings.title, canEdit],
    ['export', t.tabs.export, true],
  ].filter(([, , show]) => show)

  return (
    <div className={'app' + (ready && isViewTab(tab) ? ' views-mode' : '')}>
      <header className="header">
        <h1>{t.appName}</h1>
        <span className="tagline">{t.tagline}</span>
        <span className="spacer" />
        {ready && (
          <>
            {canEdit && (
              <>
                <span className="changes">
                  {edits.changes ? t.edits.changes(edits.changes) : t.edits.noChanges}
                </span>
                <label className="autosave" title={t.autosave.explain}>
                  <input type="checkbox" checked={autoSave} onChange={(e) => setAutoSave(e.target.checked)} />
                  {autoSaveStatus.error
                    ? `${t.autosave.failed}: ${autoSaveStatus.error}`
                    : autoSaveStatus.at
                      ? `${t.autosave.saved} ${describeAge(autoSaveStatus.at)}`
                      : t.autosave.label}
                </label>
                <span className="edit-buttons">
                  <button onClick={saveProject} title={t.edits.saveTitle}>
                    {t.edits.save}
                  </button>
                  <button disabled={!edits.canUndo} onClick={undo} title="Ctrl+Z">
                    ↶ {t.edits.undo}
                  </button>
                  <button disabled={!edits.canRedo} onClick={redo} title="Ctrl+Y">
                    ↷ {t.edits.redo}
                  </button>
                </span>
              </>
            )}
            {graphLanguages && (
              <label className="display-lang" title={t.display.language}>
                {t.display.language}{' '}
                <select value={displayLang || graphLanguages.primary} onChange={(e) =>
                  setDisplayLang(e.target.value === graphLanguages.primary ? null : e.target.value)}>
                  {allLanguages(graphLanguages).map((lang) => <option key={lang} value={lang}>{lang}</option>)}
                </select>
              </label>
            )}
            <span className="filename">{filename}</span>
            <span className="type-tag">{source === 'project' ? t.source.project : t.source.graph}</span>
            <button onClick={reset}>{t.common.reset}</button>
          </>
        )}
      </header>

      {ready && (
        <nav className="tabs" role="tablist">
          {tabs.map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </nav>
      )}

      <main className="main">
        {!ready && <Landing />}
        {ready && tab === 'overview' && <Overview />}
        {ready && tab === 'enter' && <Enter />}
        {ready && tab === 'grid' && <Grid />}
        {ready && tab === 'settings' && <Settings />}
        {ready && tab === 'export' && <ExportPanel />}
        {ready && <ViewsHost tab={tab} />}
      </main>
      {ready && <ProtocolBinding />}
    </div>
  )
}
