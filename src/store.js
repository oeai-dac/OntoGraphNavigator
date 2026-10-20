import { create } from 'zustand'
import { loadFile } from './lib/loadFile'
import { BDA_URI_RULES, EMPTY_HME_PROJECT, HME_UNIT_TYPES, PHASE_RULE } from './lib/hmeImport'
import { describeUnitTypes, setUnitType } from './lib/unitTypeEditor'
import { emptyProtocol, matchPackage, packageFromFiles, protocolUnits, readProtocol, unitProtocol, writeProtocol } from './lib/protocols'
import { applyBinding, proposeBinding } from './lib/protocolBinding'
import { forgetPackage, loadPackageFiles, savePackageFiles } from './lib/journalStore'
import { unzipSync } from 'fflate'
import { combinedProtocols, fillProtocolPdf, protocolFilename, zippedProtocols } from './lib/protocolPdf'
import { unitForPdf } from './lib/protocolExport'
import { buildProjectZip, isZip, PROJECT_ZIP_EXTENSION, readProjectZip } from './lib/projectZip'
import { describeGeometry, writeGeometries } from './lib/geometryWriter'
import { createRecords, describeNewRecords, describeValue, writeValues } from './lib/bridgeWriter'
import { deriveModelFromGraph } from './lib/graphJson'
import { buildForms } from './lib/forms'
import { proposeSidecar, proposeThesaurusBindings, emptySidecar, readSidecar } from './lib/sidecar'
import { checksum, createJournal, canRedo, canUndo, summarise } from './lib/journal'
import {
  createWorkspace, rematerialize, createRecord, updateRecord, setCell, graphIdFor,
  addRow, deleteRow, undo as undoEdit, redo as redoEdit, rowsForForm, valuesFromRow,
  restoreRowIds, inGroup,
} from './lib/edits'
import { readThesaurusFile, fetchKnownThesaurus, knownThesaurusById, readKeptThesaurus } from './lib/thesaurusSources'
import { buildSnapshot, projectFromSnapshot, describeAge, AUTOSAVE_INTERVAL_MS } from './lib/autosave'
import { saveSnapshot, loadSnapshot, saveSession, appendEntries, forgetSession, available as storageAvailable } from './lib/journalStore'
import { appliedEntries } from './lib/journal'
import { t } from './i18n/en'
import { normalizeLanguages } from './lib/languages'
import { describeAttribute, writeAttribute } from './lib/viewEditor'
import { addMatrixRelation, describeMatrix, matrixRules, removeMatrixRelation, setMatrixRelation, suggestUnitIdentifier } from './lib/matrixEditor'
import { addPhasesToMapping, createPhase, deletePhase, describePhases, listPhases, movePhase, phaseSetup, renamePhase, setUnitPhase } from './lib/phaseEditor'
import {
  addObjectsToMapping, createGroup, createObject, deleteGroup, deleteObject, describeObjects, objectSetup,
  listGroups, listObjects, renameGroup, renameObject, setObjectGroup, setUnitObject,
} from './lib/objectEditor'

/** One slot: the tool holds one project at a time. */
const SNAPSHOT_KEY = 'current'

/**
 * Records brought into being by a reference are not a side effect to hide.
 * Pointing a find at a unit that does not exist yet creates that unit — the
 * relation cannot exist otherwise — and the person entering should be told, not
 * surprised by an extra record later.
 */
const describeCreated = (created) =>
  (created || []).map((item) => t.enter.alsoCreated(item.value, item.label))

export { AUTOSAVE_INTERVAL_MS, describeAge, storageAvailable }

/**
 * Everything the interface reads.
 *
 * One thing to know about the shape: `model.tables` is mutated in place by the
 * write layer, so a reference comparison cannot detect an edit. `revision` is
 * bumped on every change and is what components subscribe to. The alternative —
 * copying eleven megabytes of rows per keystroke — is not one.
 */
export const useStore = create((set, get) => ({
  status: 'empty', // empty | loading | ready | error
  error: null,
  filename: '',
  source: null, // 'project' | 'graph'
  graph: null,
  model: null,
  derived: null,
  report: null,
  warnings: [],

  // editing
  workspace: null,
  forms: null,
  config: emptySidecar(),
  ruleProposals: [],
  thesauri: new Map(),
  thesaurusStatus: {}, // id -> 'loading' | 'ready' | error message
  revision: 0,
  author: '',
  autoSave: true,
  autoSaveStatus: { at: null, changes: 0, error: null },
  restorable: null,

  tab: 'overview',

  // recording protocols (lib/protocols.js): the packages added (none comes with
  // the Navigator); each is used in a project once bound to it (config.protocolBindings)
  packages: [],
  // the package whose binding dialog is open (components/ProtocolBinding.jsx), or null
  bindingDialog: null,
  // entry tab: 'records' (forms from the mapping) or 'protocols' (a unit's recording protocol)
  enterMode: 'records',
  protocol: null, // { unitId, packageId, values, dirty }

  // entry tab
  formNodeId: null,
  rowId: null,
  draft: null,
  draftDirty: false, // the open record has changes not saved yet
  draftWarnings: [],
  savedNotice: '',

  setTab: (tab) => set({ tab }),
  // The language the views show labels and type names in (the GraphExplorer's
  // setDisplayLang, fed by ViewsHost); null = the primary.
  displayLang: null,
  setDisplayLang: (displayLang) => set({ displayLang }),

  /**
   * Declare the languages of a project that names none (saved before Studio
   * 3.1). Its labels are re-read in the language given; the project file
   * written afterwards carries it. A project that names its languages changes
   * them in the Studio, which moves the labels along.
   */
  setLanguages(next) {
    const { workspace, model, config, revision, warnings } = get()
    if (!workspace || !model || model.languages) return
    model.languages = normalizeLanguages(next)
    workspace.materializer = null // languages are part of the mapping: build anew
    rematerialize(workspace)
    set({
      graph: workspace.graph,
      forms: buildForms(model, config),
      revision: revision + 1,
      displayLang: null,
      warnings: warnings.filter((w) => !w.startsWith('This project was saved before the Studio named languages')),
      savedNotice: `Languages: ${model.languages.primary}` +
        (model.languages.additional.length ? ` + ${model.languages.additional.join(', ')}` : ''),
    })
  },

  setAuthor: (author) => {
    const { workspace } = get()
    if (workspace) workspace.journal.author = author
    set({ author })
  },

  // ------------------------------------------------- recording protocols

  /** Packages imported earlier, from the browser's storage — called once at start. */
  async loadImportedPackages() {
    try {
      const kept = await loadPackageFiles()
      const imported = kept.map((k) => ({ ...packageFromFiles(k.files), imported: true, files: k.files }))
      if (imported.length) set({ packages: mergePackages(get().packages, imported) })
    } catch {
      // No storage: packages are added again from their .zip.
    }
  },

  /** A package from a .zip: checked, kept in the browser, offered from now on. */
  async importPackage(file) {
    try {
      const files = unzipSync(new Uint8Array(await file.arrayBuffer()))
      const pkg = packageFromFiles(files)
      const errors = pkg.problems.filter((p) => p.severity === 'error')
      if (errors.length) return { ok: false, error: errors.map((e) => e.message).join(' ') }
      try {
        await savePackageFiles(pkg.id, files)
      } catch {
        // Kept for this session only.
      }
      set({
        packages: mergePackages(get().packages, [{ ...pkg, imported: true, files }]),
        savedNotice: `Protocol "${pkg.protocol.name}" imported`,
        // Added to a project: where its fields go is decided now.
        bindingDialog: get().workspace?.model ? pkg.id : null,
      })
      return { ok: true, pkg }
    } catch (error) {
      return { ok: false, error: `Not a protocol package: ${error.message}` }
    }
  },

  async removePackage(id) {
    try { await forgetPackage(id) } catch { /* nothing kept */ }
    set({ packages: get().packages.filter((p) => !(p.id === id && p.imported)), savedNotice: 'Protocol removed' })
  },

  // ------------------------------------------- binding a protocol (lib/protocolBinding.js)

  openBindingDialog: (packageId) => set({ bindingDialog: packageId }),
  closeBindingDialog: () => set({ bindingDialog: null }),

  /** What the binding dialog starts from: the binding kept so far, else a proposal. */
  proposeProtocolBinding(packageId, unitNodeId = null) {
    const { workspace, packages, config } = get()
    const pkg = packages.find((p) => p.id === packageId)
    if (!workspace?.model || !pkg) return { error: 'No project or no such protocol.' }
    return proposeBinding(workspace.model, pkg, { unitNodeId, previous: unitNodeId ? null : config.protocolBindings?.[packageId] })
  },

  /**
   * Bind a protocol as chosen in the dialog: new fields into the mapping, the
   * binding into the settings. Protocols recorded on the binding before are
   * carried over to where their fields live now — one undoable edit; the old
   * places keep what they hold.
   */
  applyProtocolBinding(packageId, choices) {
    const { workspace, packages, config, revision } = get()
    const pkg = packages.find((p) => p.id === packageId)
    if (!workspace?.model || !pkg) return { ok: false, error: 'No project or no such protocol.' }
    const before = config.protocolBindings?.[packageId]
    const carried = []
    if (before) {
      const old = matchPackage(workspace.model, pkg, before)
      if (!old.error) {
        for (const u of protocolUnits(workspace.model, old)) {
          if (unitProtocol(workspace.model, old, u.id) === pkg.id) carried.push({ id: u.id, values: readProtocol(workspace, old, u.id).values })
        }
      }
    }
    let result
    try {
      result = applyBinding(workspace, pkg, choices)
    } catch (error) {
      result = { ok: false, error: error.message }
    }
    if (!result.ok) return result
    const nextConfig = { ...config, protocolBindings: { ...(config.protocolBindings || {}), [packageId]: result.binding } }
    if (carried.length) {
      const now = matchPackage(workspace.model, pkg, result.binding)
      if (!now.error) inGroup(workspace, () => { for (const c of carried) writeProtocol(workspace, now, c.id, c.values) })
    }
    rematerialize(workspace)
    set({
      config: nextConfig,
      forms: buildForms(workspace.model, nextConfig),
      revision: revision + 1,
      graph: workspace.graph,
      bindingDialog: null,
      savedNotice: `${pkg.protocol.name} bound${result.created ? ` — ${result.created} new field(s) in the mapping` : ''}${carried.length ? `, ${carried.length} protocol(s) carried over` : ''}`,
    })
    return { ok: true, ...result, carried: carried.length }
  },

  setEnterMode: (enterMode) => set({ enterMode }),

  /** Open a unit's protocol — on the package it is recorded on, else the first that fits. */
  openProtocol(unitId, packageId = null, { keepTab = false } = {}) {
    const { workspace } = get()
    const matches = protocolMatches(get())
    if (!workspace || !matches.length) return
    const recorded = unitId ? unitProtocol(workspace.model, matches[0], unitId) : ''
    const match = matches.find((m) => m.pkg.id === (packageId || recorded)) || bestFit(matches)
    const values = unitId ? mergeValues(emptyProtocol(match.pkg), readProtocol(workspace, match, unitId).values) : null
    set({ ...(keepTab ? {} : { tab: 'enter' }), enterMode: 'protocols', protocol: unitId ? { unitId, packageId: match.pkg.id, values, dirty: false } : null, savedNotice: '' })
  },

  /**
   * A node chosen in a view beside the entry form (the Dashboard's Enter
   * pane): its protocol opens, or its record — unless something unsaved is
   * open, which is never thrown away for a click elsewhere. The tab stays.
   * @returns {boolean} whether something was opened
   */
  openForNode(nodeId) {
    const s = get()
    if (!s.workspace || !nodeId) return false
    if (s.enterMode === 'protocols') {
      if (s.protocol?.dirty || s.protocol?.unitId === nodeId) return false
      if (!protocolUnitList(s).some((u) => u.id === nodeId)) return false
      s.openProtocol(nodeId, null, { keepTab: true })
      return true
    }
    if (s.draftDirty) return false
    const type = s.graph?.nodes?.[nodeId]?.t
    for (const form of s.forms?.forms || []) {
      if (s.workspace.model.entities.get(form.nodeId)?.typeKey !== type) continue
      const hit = rowsForForm(s.workspace, form).find(({ row }) => graphIdFor(s.workspace, form, String(row[form.idColumn] ?? '').trim()) === nodeId)
      if (!hit) continue
      if (s.formNodeId === form.nodeId && s.rowId === hit.rowId) return false
      set({ formNodeId: form.nodeId })
      get().openRecord(hit.rowId)
      return true
    }
    return false
  },

  /** Another protocol type for the open unit: what both share is kept. */
  setProtocolPackage(packageId) {
    const { protocol } = get()
    const match = protocolMatches(get()).find((m) => m.pkg.id === packageId)
    if (!protocol || !match) return
    set({ protocol: { ...protocol, packageId, values: mergeValues(emptyProtocol(match.pkg), protocol.values), dirty: true } })
  },

  setProtocolValue(section, key, value) {
    const { protocol } = get()
    if (!protocol) return
    set({ protocol: { ...protocol, values: { ...protocol.values, [section]: { ...(protocol.values[section] || {}), [key]: value } }, dirty: true } })
  },

  saveProtocol() {
    const { workspace, protocol, revision } = get()
    const match = protocolMatches(get()).find((m) => m.pkg.id === protocol?.packageId)
    if (!workspace || !protocol || !match) return
    const result = writeProtocol(workspace, match, protocol.unitId, protocol.values, { protocol: match.pkg.id })
    if (!result.ok) {
      set({ savedNotice: result.error })
      return
    }
    rematerialize(workspace)
    const values = mergeValues(emptyProtocol(match.pkg), readProtocol(workspace, match, protocol.unitId).values)
    set({ revision: revision + 1, graph: workspace.graph, protocol: { ...protocol, values, dirty: false }, savedNotice: 'Saved' })
  },

  /** The open protocol read again from the tables — after Cancel, Undo or Redo; the tab stays. */
  discardProtocol() {
    const { protocol, workspace } = get()
    const matches = protocolMatches(get())
    if (!protocol || !workspace || !matches.length) return
    // The type too, as the tables have it now — an undo may have taken a change of type back.
    const recorded = unitProtocol(workspace.model, matches[0], protocol.unitId)
    const match = matches.find((m) => m.pkg.id === recorded) || matches.find((m) => m.pkg.id === protocol.packageId)
    if (!match) return
    const values = mergeValues(emptyProtocol(match.pkg), readProtocol(workspace, match, protocol.unitId).values)
    set({ protocol: { ...protocol, packageId: match.pkg.id, values, dirty: false } })
  },

  // ------------------------------------------------- geometries from QGIS (lib/geometryWriter.js)

  /** Where each node's geometry is or would go: [{ nodeId, writable, current, where, reason? }] */
  describeGeometries(nodeIds) {
    const { workspace, graph } = get()
    return (nodeIds || []).map((nodeId) => ({ nodeId, ...describeGeometry(workspace, graph, nodeId) }))
  },

  /** Geometries from QGIS, written where they live — one undo for all. */
  writeGeometries(items) {
    const { workspace, graph, config, revision } = get()
    if (!workspace) return { ok: false, error: 'Only a project file can be edited.' }
    const result = writeGeometries(workspace, graph, items || [], config)
    if (result.written) {
      rematerialize(workspace)
      set({ revision: revision + 1, graph: workspace.graph, savedNotice: `${result.written} geometr${result.written === 1 ? 'y' : 'ies'} from QGIS` })
    }
    return result
  },

  // ------------------------------------------------- values and records from QGIS (lib/bridgeWriter.js)

  describeValues(nodeIds, attrKey) {
    const { workspace, graph } = get()
    return (nodeIds || []).map((nodeId) => ({ nodeId, ...describeValue(workspace, graph, nodeId, attrKey) }))
  },

  writeValues(attrKey, items) {
    const { workspace, graph, revision } = get()
    if (!workspace) return { ok: false, error: 'Only a project file can be edited.' }
    const result = writeValues(workspace, graph, attrKey, items)
    if (result.written) {
      rematerialize(workspace)
      set({ revision: revision + 1, graph: workspace.graph, savedNotice: `${result.written} value(s) of “${attrKey}” from QGIS` })
    }
    return result
  },

  describeNewRecords(spec, keys) {
    const { workspace, config } = get()
    return describeNewRecords(workspace, config, spec, keys)
  },

  createRecords(spec, items) {
    const { workspace, graph, config, revision } = get()
    if (!workspace) return { ok: false, error: 'Only a project file can be edited.' }
    const result = createRecords(workspace, graph, config, spec, items, () => {
      rematerialize(workspace)
      return workspace.graph
    })
    if (result.created.length) {
      set({ revision: revision + 1, graph: workspace.graph, savedNotice: `${result.created.length} new record(s) from QGIS` })
    }
    return result
  },

  // ------------------------------------------------- protocols as PDF (lib/protocolPdf.js)

  /** One unit's protocol as its filled-in form: { bytes, name, missing }. */
  async protocolPdf(unitId) {
    const { workspace, graph } = get()
    const matches = protocolMatches(get())
    if (!workspace || !matches.length) throw new Error('No recording protocol fits this project.')
    const [item] = await pdfItems(workspace, graph, matches, [unitId])
    const filled = await fillProtocolPdf(item.pkg, item.template, item.unit)
    return { bytes: filled.bytes, name: protocolFilename(item.unit.label, item.pkg), missing: filled.missing }
  },

  /** Every unit's protocol: one PDF, or a zip of one PDF each. */
  async protocolPdfs(format, onProgress) {
    const { workspace, graph, filename } = get()
    const matches = protocolMatches(get())
    if (!workspace || !matches.length) throw new Error('No recording protocol fits this project.')
    const ids = protocolUnits(workspace.model, matches[0]).map((u) => u.id)
    const items = await pdfItems(workspace, graph, matches, ids)
    const stem = (filename.replace(/\.[^.]+$/, '') || 'project').replace(/[^\w.-]+/g, '_')
    const out = format === 'zip' ? await zippedProtocols(items, onProgress) : await combinedProtocols(items, onProgress)
    return { ...out, name: `${stem}_SE-Protokolle.${format === 'zip' ? 'zip' : 'pdf'}`, units: items.length }
  },

  // ------------------------------------------------- the project zip (lib/projectZip.js)

  /** The project, its settings and its packages as a .ognproj: { bytes, name }. */
  saveProject() {
    const { workspace, config, packages, thesauri, filename } = get()
    if (!workspace?.model) throw new Error('Only a project file can be saved as a project.')
    const stem = (filename || 'project').replace(/\.(ognproj|json|graphml)$/i, '').replace(/\.project$/i, '') || 'project'
    const bytes = buildProjectZip({
      model: workspace.model,
      config,
      packages: packages.filter((p) => p.files),
      thesauri: [...thesauri.values()],
      journal: workspace.journal,
      name: stem,
    })
    set({ savedNotice: `Saved as ${stem}.${PROJECT_ZIP_EXTENSION}` })
    return { bytes, name: `${stem}.${PROJECT_ZIP_EXTENSION}` }
  },

  /** Units placed by hand in a matrix view (the Matrix tab), kept with the settings. */
  matrixPositions(key) {
    return get().config?.matrixPositions?.[key] || {}
  },

  setMatrixPositions(key, positions) {
    const { config } = get()
    const rounded = {}
    for (const [id, p] of Object.entries(positions || {})) rounded[id] = { x: Math.round(p.x), y: Math.round(p.y) }
    const all = { ...(config.matrixPositions || {}) }
    if (Object.keys(rounded).length) all[key] = rounded
    else delete all[key]
    set({ config: { ...config, matrixPositions: all } })
  },

  /** The "matrix first" template (lib/hmeImport.js), opened like a file. */
  async newMatrix() {
    await get().load({ name: 'Harris matrix.json', text: async () => EMPTY_HME_PROJECT })
    if (get().status === 'ready') set({ tab: 'matrix' })
  },

  async load(file) {
    set({ status: 'loading', error: null, filename: file.name })
    try {
      // A project zip (.ognproj): the project file, its settings and packages together.
      const bytes = file.arrayBuffer ? new Uint8Array(await file.arrayBuffer()) : null
      let text
      let loadName = file.name
      let saved = null
      if (bytes && (new RegExp(`\\.${PROJECT_ZIP_EXTENSION}$`, 'i').test(file.name) || isZip(bytes))) {
        saved = readProjectZip(bytes)
        text = saved.projectText
        loadName = 'project.json'
        const kept = saved.packages.map((p) => ({ ...packageFromFiles(p.files), imported: true, files: p.files, fromProject: true }))
        if (kept.length) set({ packages: mergePackages(get().packages, kept) })
      } else {
        text = bytes ? new TextDecoder().decode(bytes) : await file.text()
      }
      const result = loadFile(loadName, text, { packages: get().packages })

      let workspace = null
      let forms = null
      let config = emptySidecar()
      let ruleProposals = []

      if (result.model) {
        const journal = createJournal({
          author: get().author,
          inputs: [{ name: file.name, bytes: text.length, checksum: checksum(text) }],
        })
        const proposal = proposeSidecar(result.model)
        config = { ...proposal.config, author: get().author }
        // Settings decided before — in the project zip — win over a fresh guess.
        if (saved?.config) config = { ...saved.config, author: saved.config.author || get().author }
        // The BDA mapping's units are named as the HME names them, where the
        // data has no rule of its own to offer (and always in the template).
        if (result.report?.hme?.protocolBindings && !saved?.config) {
          config.protocolBindings = { ...(config.protocolBindings || {}), ...result.report.hme.protocolBindings }
        }
        // The matrix template and an HME project offer the HME's unit types.
        if (result.report?.hme && result.model.entities.has('nUnitType')) {
          config.valueLists = { ...(config.valueLists || {}), nUnitType: config.valueLists?.nUnitType || HME_UNIT_TYPES }
        }
        if (result.report?.hme) {
          for (const [nodeId, template] of Object.entries(BDA_URI_RULES)) {
            const proposed = proposal.proposals.find((p) => p.nodeId === nodeId)
            if (!result.model.entities.has(nodeId)) continue
            if (result.report.hme.template || !config.uriRules[nodeId] || proposed?.fromDefault) config.uriRules[nodeId] = template
          }
        }
        ruleProposals = proposal.proposals
        // The changes made so far, kept in the project zip: undo and the log go on.
        if (saved?.journal) restoreRowIds(result.model, saved.rowIds)
        workspace = createWorkspace({ model: result.model, journal: saved?.journal || journal, config, materializer: result.materializer })
        workspace.graph = result.graph
        forms = buildForms(result.model, config)
      }

      set({
        status: 'ready',
        source: result.source,
        graph: result.graph,
        model: result.model,
        derived: result.derived || deriveModelFromGraph(result.graph),
        report: result.report,
        warnings: result.warnings,
        workspace,
        forms,
        config,
        ruleProposals,
        revision: 0,
        displayLang: null,
        tab: 'overview',
        formNodeId: forms?.forms[0]?.nodeId || null,
        enterMode: 'records',
        protocol: null,
        rowId: null,
        draft: null,
        draftDirty: false,
        draftWarnings: [],
        autoSaveStatus: { at: null, changes: 0, error: null },
      })
      if (saved?.thesauri?.length && result.model) {
        const kept = new Map(get().thesauri)
        const failed = []
        for (const t of saved.thesauri) {
          try {
            const thesaurus = readKeptThesaurus(t)
            kept.set(thesaurus.id, thesaurus)
          } catch (error) {
            failed.push(`${t.name}: ${error.message}`)
          }
        }
        set({ thesauri: kept, forms: buildForms(result.model, get().config), ...(failed.length ? { error: `Thesaurus in the project: ${failed.join('; ')}` } : {}) })
      }
    } catch (error) {
      set({ status: 'error', error: error.message || String(error) })
    }
  },

  // ------------------------------------------------------------ autosave

  /**
   * Write a copy into the browser's own storage.
   *
   * Called on a timer and after every edit batch. Silent on success; a failure is
   * shown, because a save that quietly did not happen is worse than none.
   */
  async autoSaveNow() {
    const { workspace, config, filename, author, autoSave } = get()
    if (!autoSave || !workspace) return
    const snapshot = buildSnapshot({ workspace, config, filename, author })
    if (!snapshot) return
    try {
      await saveSnapshot(SNAPSHOT_KEY, snapshot)
      await saveSession(workspace.journal)
      await appendEntries(workspace.journal.session, appliedEntries(workspace.journal))
      set({ autoSaveStatus: { at: snapshot.savedAt, changes: snapshot.changes, error: null } })
    } catch (error) {
      set({ autoSaveStatus: { at: null, changes: 0, error: error.message } })
    }
  },

  setAutoSave(autoSave) {
    set({ autoSave })
    if (autoSave) get().autoSaveNow()
  },

  /** Look for a copy from an earlier session, for the start screen to offer. */
  async findRestorable() {
    try {
      const record = await loadSnapshot(SNAPSHOT_KEY)
      set({ restorable: record?.payload || null })
      return record?.payload || null
    } catch {
      set({ restorable: null })
      return null
    }
  },

  /** Take the copy back up, through the ordinary load path. */
  async restore() {
    const snapshot = get().restorable
    if (!snapshot) return
    set({ status: 'loading', error: null })
    try {
      const project = projectFromSnapshot(snapshot)
      const file = new File([JSON.stringify(project)], snapshot.filename, { type: 'application/json' })
      await get().load(file)
      // The journal and the settings come from the copy, not from a fresh guess:
      // restoring must not lose the history or re-propose rules already decided.
      const { workspace } = get()
      if (workspace && snapshot.journal) {
        restoreRowIds(workspace.model, snapshot.rowIds)
        workspace.journal = snapshot.journal
      }
      set({
        config: snapshot.config || get().config,
        author: snapshot.author || get().author,
        forms: get().model ? buildForms(get().model, snapshot.config || get().config) : null,
        restorable: null,
        savedNotice: `Restored ${snapshot.changes} change(s) from ${describeAge(snapshot.savedAt)}`,
      })
    } catch (error) {
      set({ status: 'error', error: `Could not restore: ${error.message}` })
    }
  },

  async discardRestorable() {
    try {
      await forgetSession(SNAPSHOT_KEY)
    } catch {
      /* nothing to forget */
    }
    set({ restorable: null })
  },

  /** Load the companion file, replacing the proposed settings. */
  async loadSidecar(file) {
    try {
      const config = readSidecar(JSON.parse(await file.text()))
      const { model } = get()
      set({
        config,
        author: config.author || get().author,
        forms: model ? buildForms(model, config) : null,
        savedNotice: 'Settings loaded',
      })
    } catch (error) {
      set({ error: `Settings file: ${error.message}` })
    }
  },

  // ---------------------------------------------------------- thesauri

  async addThesaurusFile(file) {
    try {
      const thesaurus = await readThesaurusFile(file)
      get().registerThesaurus(thesaurus)
    } catch (error) {
      set({ error: error.message })
    }
  },

  async addKnownThesaurus(id) {
    const entry = knownThesaurusById(id)
    if (!entry) return
    set({ thesaurusStatus: { ...get().thesaurusStatus, [id]: 'loading' } })
    try {
      const thesaurus = await fetchKnownThesaurus(entry)
      get().registerThesaurus(thesaurus)
      set({ thesaurusStatus: { ...get().thesaurusStatus, [id]: 'ready' } })
    } catch (error) {
      set({ thesaurusStatus: { ...get().thesaurusStatus, [id]: error.message } })
    }
  },

  /** Add a vocabulary and, if the stored values say so, bind it to a field. */
  registerThesaurus(thesaurus) {
    const { thesauri, model, config } = get()
    const next = new Map(thesauri)
    next.set(thesaurus.id, thesaurus)
    let nextConfig = config
    if (model) {
      const { bindings } = proposeThesaurusBindings(model, [...next.values()])
      nextConfig = { ...config, thesaurusBindings: { ...bindings, ...config.thesaurusBindings } }
    }
    set({
      thesauri: next,
      config: nextConfig,
      forms: model ? buildForms(model, nextConfig) : null,
      savedNotice: `${thesaurus.name}: ${thesaurus.report.concepts} concepts` +
        (thesaurus.report.repaired ? `, ${thesaurus.report.repaired} characters repaired` : ''),
    })
  },

  setThesaurusBinding(nodeId, thesaurusId) {
    const { config, model } = get()
    const bindings = { ...config.thesaurusBindings }
    if (thesaurusId) bindings[nodeId] = { thesaurusId, languages: ['de', 'en'] }
    else delete bindings[nodeId]
    const nextConfig = { ...config, thesaurusBindings: bindings }
    set({ config: nextConfig, forms: model ? buildForms(model, nextConfig) : null })
  },

  setUriRule(nodeId, template) {
    const { config, model } = get()
    const uriRules = { ...config.uriRules }
    if (template) uriRules[nodeId] = template
    else delete uriRules[nodeId]
    const nextConfig = { ...config, uriRules }
    set({ config: nextConfig, forms: model ? buildForms(model, nextConfig) : null })
  },

  // ------------------------------------------------------------ entry

  chooseForm(formNodeId) {
    set({ formNodeId, rowId: null, draft: null, draftDirty: false, draftWarnings: [], savedNotice: '' })
  },

  /** Open an existing record for editing, or start a new one. */
  openRecord(rowId) {
    const { workspace, forms, formNodeId } = get()
    const form = forms?.byNode.get(formNodeId)
    if (!form || !workspace) return
    if (!rowId) {
      set({ rowId: null, draft: {}, draftDirty: false, draftWarnings: [], savedNotice: '' })
      return
    }
    const entry = rowsForForm(workspace, form).find((r) => r.rowId === rowId)
    if (!entry) return
    set({ rowId, draft: valuesFromRow(form, entry.row), draftDirty: false, draftWarnings: [], savedNotice: '' })
  },

  setDraftValue(key, value) {
    set({ draft: { ...(get().draft || {}), [key]: value }, draftDirty: true })
  },

  setDraftGroupValue(groupKey, key, value) {
    const draft = get().draft || {}
    const group = { ...(draft[groupKey] || {}), [key]: value }
    set({ draft: { ...draft, [groupKey]: group }, draftDirty: true })
  },

  saveDraft() {
    const { workspace, forms, formNodeId, rowId, draft, revision } = get()
    const form = forms?.byNode.get(formNodeId)
    if (!form || !workspace || !draft) return
    try {
      if (rowId) {
        const { warnings, created } = updateRecord(workspace, form, rowId, draft, { source: 'form' })
        rematerialize(workspace)
        set({
          revision: revision + 1,
          graph: workspace.graph,
          draftWarnings: [...warnings, ...describeCreated(created)],
          draftDirty: false,
          savedNotice: 'Saved',
        })
      } else {
        const result = createRecord(workspace, form, draft, { source: 'form' })
        if (!result.rowId) {
          set({ draftWarnings: result.warnings })
          return
        }
        rematerialize(workspace)
        // A record with no relation yet produces no graph node. Say it plainly
        // instead of leaving an apparently empty result.
        const warnings = [...result.warnings, ...describeCreated(result.created)]
        const nodeId = graphIdFor(workspace, form, result.identifier)
        if (nodeId && !workspace.graph.nodes[nodeId]) warnings.push(t.enter.notInGraphYet)
        set({
          revision: revision + 1,
          graph: workspace.graph,
          rowId: result.rowId,
          draftWarnings: warnings,
          draftDirty: false,
          savedNotice: `Created ${result.identifier}`,
        })
      }
    } catch (error) {
      set({ draftWarnings: [error.message] })
    }
  },

  deleteCurrentRecord() {
    const { workspace, forms, formNodeId, rowId, revision } = get()
    const form = forms?.byNode.get(formNodeId)
    if (!form || !workspace || !rowId) return
    deleteRow(workspace, form.tableId, rowId, { source: 'form' })
    rematerialize(workspace)
    set({ revision: revision + 1, graph: workspace.graph, rowId: null, draft: null, draftDirty: false, savedNotice: 'Deleted' })
  },

  /**
   * Another row for the record that is open.
   *
   * This is how a second value of one relation is stored — a site with two
   * points of interest is two rows of the same site, merged back into one node
   * on materialisation. The identifier and label are carried over so only the
   * new value has to be typed; everything else starts empty, because that is
   * what the extra row is for.
   */
  addRowToRecord() {
    const { workspace, forms, formNodeId, rowId, revision } = get()
    const form = forms?.byNode.get(formNodeId)
    if (!form || !workspace || !rowId) return
    const entry = rowsForForm(workspace, form).find((r) => r.rowId === rowId)
    if (!entry) return

    const cells = { [form.idColumn]: entry.row[form.idColumn] }
    if (form.labelColumn && form.labelColumn !== form.idColumn) {
      cells[form.labelColumn] = entry.row[form.labelColumn]
    }
    const newRowId = addRow(workspace, form.tableId, cells, {
      source: 'form',
      note: `another row for ${cells[form.idColumn]}`,
    })
    rematerialize(workspace)
    const created = rowsForForm(workspace, form).find((r) => r.rowId === newRowId)
    set({
      revision: revision + 1,
      graph: workspace.graph,
      rowId: newRowId,
      draft: created ? valuesFromRow(form, created.row) : { identifier: cells[form.idColumn] },
      draftWarnings: [],
      savedNotice: t.enter.rowAdded,
    })
  },

  // ------------------------------------------------- editing from the views

  /** Whether a view may edit a node's attribute — see lib/viewEditor.js. */
  describeAttribute(nodeId, key) {
    return describeAttribute(get().workspace, nodeId, key)
  },

  /** An attribute changed in a view, written to the cells it was read from. */
  editAttribute(nodeId, key, value) {
    const { workspace, revision } = get()
    const result = writeAttribute(workspace, nodeId, key, value)
    if (result.ok && result.changed) {
      rematerialize(workspace)
      set({ revision: revision + 1, graph: workspace.graph, savedNotice: 'Saved' })
    }
    return result
  },

  // ------------------------------------------------- editing the matrix

  /** Whether the matrix of this property can be edited — see lib/matrixEditor.js. */
  describeMatrix(payload) {
    return describeMatrix(get().workspace, payload)
  },

  /** addRelation | setRelation | removeRelation, from the Matrix view. */
  editMatrix(action, payload) {
    const { workspace, revision } = get()
    const run = { addRelation: addMatrixRelation, setRelation: setMatrixRelation, removeRelation: removeMatrixRelation }[action]
    if (!run || !workspace) return { ok: false, error: 'Nothing to edit.' }
    let result
    try {
      result = run(workspace, payload)
    } catch (error) {
      result = { ok: false, error: error.message }
    }
    if (result.ok) {
      rematerialize(workspace)
      set({ revision: revision + 1, graph: workspace.graph, savedNotice: 'Saved' })
    }
    return result
  },

  // ------------------------------------------------- phases of the matrix

  matrixRules() {
    return matrixRules(get().workspace)
  },

  describePhases(payload) {
    return describePhases(get().workspace, payload)
  },

  // ------------------------------------------- unit types (lib/unitTypeEditor.js)

  describeUnitTypes(payload) {
    return describeUnitTypes(get().workspace, payload, get().config)
  },

  /** A unit's type from the matrix: one undo. */
  editUnitTypes(payload) {
    return get().runMatrixEdit({ assign: setUnitType }, 'assign', payload, '')
  },

  listPhases(payload) {
    return listPhases(get().workspace, payload)
  },

  /**
   * create | rename | move | remove | assign — journal groups like any edit —
   * and addToMapping, which changes the mapping itself: not undoable, the
   * forms are rebuilt, and the notice says so.
   */
  editPhases(action, payload) {
    return get().runMatrixEdit({
      addToMapping: addPhasesToMapping, create: createPhase, rename: renamePhase,
      move: movePhase, remove: deletePhase, assign: setUnitPhase,
    }, action, payload, 'Phases added to the mapping — the project file carries them; earlier edits stay undoable')
  },

  // ------------------------------------------- objects and object groups

  describeObjects(payload) {
    return describeObjects(get().workspace, payload)
  },

  listObjects(payload) {
    const ws = get().workspace
    return { objects: listObjects(ws, payload), groups: listGroups(ws, payload) }
  },

  /** As editPhases: every action one undo, except addToMapping. */
  editObjects(action, payload) {
    return get().runMatrixEdit({
      addToMapping: addObjectsToMapping, createObject, createGroup, renameObject, renameGroup,
      removeObject: deleteObject, removeGroup: deleteGroup, assign: setUnitObject, setGroup: setObjectGroup,
    }, action, payload, 'Objects and groups added to the mapping — the project file carries them; earlier edits stay undoable')
  },

  /** One action of the phase or object editor, and what follows from it. */
  runMatrixEdit(actions, action, payload, mappingNotice) {
    const { workspace, revision, config, model } = get()
    if (!workspace) return { ok: false, error: 'Nothing to edit.' }
    const run = actions[action]
    if (!run) return { ok: false, error: `Unknown action ${action}.` }
    let result
    try {
      // New phases, objects and groups are named by the identifier rules of the settings.
      result = run(workspace, { ...payload, rules: config.uriRules || {} })
    } catch (error) {
      result = { ok: false, error: error.message }
    }
    if (!result.ok) return result
    rematerialize(workspace)
    const patch = { revision: revision + 1, graph: workspace.graph, savedNotice: 'Saved' }
    if (action === 'addToMapping') {
      // What was put into the mapping gets a rule for its identifiers, where it has none.
      const rules = { ...(config.uriRules || {}) }
      const ph = phaseSetup(workspace.model, payload.typeKey)
      for (const e of [ph?.phase, ph?.role]) if (e && !rules[e.nodeId]) rules[e.nodeId] = PHASE_RULE
      const ob = objectSetup(workspace.model, payload.typeKey)
      if (ob?.object?.labelColumn && !rules[ob.object.nodeId]) rules[ob.object.nodeId] = `Obj_{${ob.object.labelColumn}~local}`
      if (ob?.group?.labelColumn && !rules[ob.group.nodeId]) rules[ob.group.nodeId] = `Objgr_{${ob.group.labelColumn}~local}`
      const nextConfig = { ...config, uriRules: rules }
      patch.config = nextConfig
      patch.forms = buildForms(model, nextConfig)
      patch.savedNotice = mappingNotice
    }
    set(patch)
    return result
  },

  suggestUnitIdentifier(payload) {
    return suggestUnitIdentifier(get().workspace, get().config, payload)
  },

  /** A single cell, from the grid. */
  editCell(tableId, rowId, column, value) {
    const { workspace, revision } = get()
    if (!workspace) return
    const entry = setCell(workspace, tableId, rowId, column, value, { source: 'grid' })
    if (!entry) return
    rematerialize(workspace)
    set({ revision: revision + 1, graph: workspace.graph })
  },

  undo() {
    const { workspace, revision } = get()
    if (!workspace || !undoEdit(workspace)) return
    rematerialize(workspace)
    set({ revision: revision + 1, graph: workspace.graph, draft: null, draftDirty: false, rowId: null, savedNotice: 'Undone' })
    get().discardProtocol()
  },

  redo() {
    const { workspace, revision } = get()
    if (!workspace || !redoEdit(workspace)) return
    rematerialize(workspace)
    set({ revision: revision + 1, graph: workspace.graph, draft: null, draftDirty: false, rowId: null, savedNotice: 'Redone' })
    get().discardProtocol()
  },

  reset: () =>
    set({
      status: 'empty', error: null, filename: '', source: null, graph: null, model: null,
      derived: null, report: null, warnings: [], workspace: null, forms: null,
      config: emptySidecar(), ruleProposals: [], revision: 0,
      tab: 'overview', displayLang: null,
      formNodeId: null, rowId: null, draft: null, draftDirty: false, draftWarnings: [], savedNotice: '',
      enterMode: 'records', protocol: null,
    }),
}))

// ---- recording protocols ----------------------------------------------------------

/** The package that fits the mapping best: most fields in it, fewest left over — the default for a new unit. */
function bestFit(matches) {
  return [...matches].sort((a, b) => b.counts.mapped - a.counts.mapped || a.counts.omitted - b.counts.omitted)[0]
}

/** A package's form template: in its .zip, or none. */
async function templateOf(pkg) {
  return pkg.template || null
}

/** What each unit's PDF is made of: [{ pkg, template, unit }] — on its recorded package, else the best fit. */
async function pdfItems(workspace, graph, matches, unitIds) {
  const fallback = bestFit(matches).pkg.id
  const items = []
  for (const id of unitIds) {
    const recorded = unitProtocol(workspace.model, matches[0], id)
    const unit = unitForPdf(workspace, graph, matches, id, matches.some((m) => m.pkg.id === recorded) ? recorded : fallback)
    items.push({ pkg: unit.match.pkg, template: await templateOf(unit.match.pkg), unit })
  }
  return items
}

/** Imported packages replace a package of the same id. */
function mergePackages(current, incoming) {
  const ids = new Set(incoming.map((p) => p.id))
  return [...current.filter((p) => !ids.has(p.id)), ...incoming]
}

/** `values` laid over the empty shape of a protocol — every field there, nothing foreign kept. */
function mergeValues(empty, values) {
  const out = {}
  for (const [section, fields] of Object.entries(empty)) {
    out[section] = {}
    for (const [key, blank] of Object.entries(fields)) {
      const v = values?.[section]?.[key]
      out[section][key] = v === undefined || (typeof blank === 'object' && blank !== null && !Array.isArray(blank) && (typeof v !== 'object' || v === null)) ? blank : v
    }
  }
  return out
}

const matchCache = { relations: null, packages: null, bindings: null, result: [] }

/**
 * The packages bound to this project, matched (lib/protocols.js). Kept until
 * the mapping, the packages or the bindings change — a phase added to the
 * mapping replaces its relations.
 */
export function protocolMatches(state) {
  const model = state.workspace?.model
  if (!model) return []
  const bindings = state.config?.protocolBindings || null
  if (matchCache.relations === model.relations && matchCache.packages === state.packages && matchCache.bindings === bindings) return matchCache.result
  const result = state.packages.map((pkg) => matchPackage(model, pkg, bindings?.[pkg.id])).filter((m) => !m.error)
  Object.assign(matchCache, { relations: model.relations, packages: state.packages, bindings, result })
  return result
}

/** The units a protocol can be entered for. */
export function protocolUnitList(state) {
  const matches = protocolMatches(state)
  return matches.length ? protocolUnits(state.workspace.model, matches[0]) : []
}

/** Undo/redo availability and how much has changed, for the header. */
export function editState(state) {
  const journal = state.workspace?.journal
  if (!journal) return { canUndo: false, canRedo: false, changes: 0 }
  const summary = summarise(journal)
  return { canUndo: canUndo(journal), canRedo: canRedo(journal), changes: summary.actions, summary }
}
