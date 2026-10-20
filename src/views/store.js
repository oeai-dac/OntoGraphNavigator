import { languagesOf, localizeGraph } from './lib/languages'
import { createContext, createElement, useContext } from 'react'
import { create } from 'zustand'
import { deriveSchema, withPaletteColors } from './lib/schema'
import { collapseTypes } from './lib/collapse'
import { DEFAULT_PREFS_KEY, loadPrefs, savePrefs as writePrefs, savePrefsSoon as writePrefsSoon } from './lib/prefs'
import { defaultLayout, sanitizeLayout } from './lib/dashboardLayout'

const TRAIL_MAX = 30

// Vorbelegung fuer das Koordinatensystem der Geometrien.
//
// Die App fragt bewusst nach, statt zu raten: rohes WKT traegt hier keine SRID,
// und eine falsche Annahme wuerde Geometrien still an den falschen Ort setzen.
// Wer den Datensatz aber kennt, kann die Frage vorab beantworten -- der
// Standalone-Build tut das (siehe scripts/build-standalone.mjs), weil dort
// feststeht, welche Daten mitgeschickt werden. Ohne Vorgabe bleibt es beim
// Nachfragen, und aendern laesst sie sich in beiden Faellen weiterhin ueber
// "EPSG ... ändern" im Karten-Tab.
const DEFAULT_GEO_EPSG =
  (typeof window !== 'undefined' && window.__GRAPH_EXPLORER_EPSG__) || null

// Derive the read-model the whole app consumes (schema, node index) from a
// display graph. Shared by loadGraph and the collapse toggle so both paths
// stay in sync.
function deriveGraphState(graph, prefs) {
  const baseSchema = deriveSchema(graph)
  const nodeIds = Object.keys(graph.nodes)
  const typeIndex = {}
  nodeIds.forEach((id) => {
    const t = graph.nodes[id].t
    if (!typeIndex[t]) typeIndex[t] = []
    typeIndex[t].push(id)
  })
  return { graph, baseSchema, schema: mergeSchema(baseSchema, prefs), nodeIds, typeIndex }
}

// `schema` (used everywhere else in the app) is always the graph's own
// derived/embedded schema with the user's saved color/attribute-order
// overrides layered on top -- so every existing typeColor()/mainAttrs
// call site picks up customizations automatically, with no changes needed
// beyond where the overrides are actually set.
// Where an "open this in the Explorer" action should land. The Dashboard
// shows the Explorer next to the view that was clicked and shares this very
// state with it, so switching tabs there would tear down the arrangement the
// user just built -- stay put and let their Explorer pane, if they have one,
// pick the selection up.
function explorerTab(get) {
  return get().activeTab === 'dashboard' ? 'dashboard' : 'explore'
}

// The display graph from the loaded one: pass-through types collapsed, then
// read in the display language (lib/languages.js) — the last step, so a
// language switch never has to collapse anew, and saving skips it.
function displayOf(baseGraph, collapsedTypes, lang) {
  const collapsed = collapsedTypes.length ? collapseTypes(baseGraph, collapsedTypes) : baseGraph
  return localizeGraph(collapsed, lang)
}

function mergeSchema(baseSchema, prefs) {
  if (!baseSchema) return null
  return {
    ...baseSchema,
    typeColors: { ...baseSchema.typeColors, ...prefs.typeColors },
    // Purely a user layer -- a graph never brings per-node colors along, they
    // exist so a single node ("Bronze/Kupfer") can be picked out of its type.
    nodeColors: prefs.nodeColors,
    mainAttrs: { ...baseSchema.mainAttrs, ...prefs.attrOrder },
  }
}

/**
 * The state every view reads, as a factory: the GraphExplorer makes one for
 * itself, and another application showing these views (the
 * OntoGraphNavigator) makes its own. The views find it through the context
 * at the end of this file, never by importing a single instance.
 *
 * @param {object} [options]
 * @param {string} [options.prefsKey]  localStorage key for colours, attribute
 *        order and dashboard layout (lib/prefs.js)
 * @param {string} [options.geoEpsg]   CRS of the geometries, when known in advance
 * @param {object} [options.editor]    lets the views change the data — see
 *        README.md, "Editing". Without one, as in the GraphExplorer, the views
 *        only show.
 */
export function createExplorerStore(options = {}) {
  const prefsKey = options.prefsKey || DEFAULT_PREFS_KEY
  const initialPrefs = loadPrefs(prefsKey)
  const defaultGeoEpsg = options.geoEpsg ?? DEFAULT_GEO_EPSG
  const savePrefs = (prefs) => writePrefs(prefs, prefsKey)
  const savePrefsSoon = (prefs) => writePrefsSoon(prefs, prefsKey)

  return create((set, get) => ({
    // -- Graph data --
    graph: null,       // the DISPLAY graph (baseGraph, optionally with types collapsed)
    baseGraph: null,   // the originally loaded graph, kept intact for collapse toggling
    collapsedTypes: [], // node type keys currently collapsed/bypassed (see lib/collapse.js)
    displayLang: null, // a language of a multilingual graph the views read it in; null = its primary (lib/languages.js)
    // Panes the application brings to the Dashboard beside the views:
    // [{ key, label, icon, Component }] (README.md, "Host panes"), and its presets.
    hostPanes: [],
    hostPresets: [],
    // Views the application offers although the graph has no data for them
    // yet (the matrix of a mapping with no unit yet): availableViews(graph, also).
    viewsAlso: [],
    baseSchema: null, // schema as derived from the loaded graph, before overrides
    schema: null,      // baseSchema + prefs overrides -- what the rest of the app reads
    nodeIds: [],
    typeIndex: {},
    loadError: '',

    // User customizations (type colors, attribute display order, dashboard
    // arrangement), persisted to localStorage for now -- see lib/prefs.js.
    prefs: initialPrefs,

    // -- UI state --
    activeTab: 'overview',

    // Dashboard tab: the split tree of panes (lib/dashboardLayout.js). Restored
    // from prefs, but only after sanitizing -- it comes from localStorage.
    // Views the current graph can't show are handled per pane at render time,
    // not by rewriting the layout, so they come back when a graph that does
    // support them is loaded.
    dashboardLayout: sanitizeLayout(initialPrefs.dashboard) || defaultLayout(),

    // Explorer tab
    explorerQuery: '',
    explorerType: '',
    explorerConditions: [], // advanced FilterBuilder conditions, see lib/filters.js
    explorerPage: 0,
    trail: [], // [{ id, label, type }]
    selectedId: null,

    // Map tab: CRS of the loaded dataset's WKT geometries, set once per
    // dataset by the user (EPSG code or a raw proj4 definition string) since
    // it can't be inferred from the WKT text itself.
    geoEpsg: defaultGeoEpsg,

    // 3D tab: the OBJ loaded next to the graph, already parsed --
    // { fileName, group (a three.js Group), placement: { e, n, h, up } }.
    // Lives here rather than in the tab so the tab and any Dashboard pane
    // showing the 3D view share one model (each draws its own clone). It
    // belongs to the dataset, so loading another graph drops it.
    model3d: null,

    // Editing, when the host offers it (README.md, "Editing"): the adapter, and
    // a geometry the Explorer asked the Map to open for editing.
    editor: options.editor || null,
    geometryEdit: null, // { nodeId, attrKey }

    setEditor(editor) {
      set({ editor: editor || null, geometryEdit: null })
    },

    // From the Explorer's "edit on map": the Map tab picks it up and clears it.
    startGeometryEdit(nodeId, attrKey) {
      set({ geometryEdit: { nodeId, attrKey }, selectedId: nodeId, activeTab: get().activeTab === 'dashboard' ? 'dashboard' : 'map' })
    },
    clearGeometryEdit() {
      set({ geometryEdit: null })
    },

    loadGraph(data) {
      if (!data || !data.nodes) {
        set({ loadError: 'No nodes found (expected { nodes: {...}, ... })' })
        return
      }
      data = withPaletteColors(data)
      // A language the new graph has stays chosen; otherwise its primary.
      const lang = languagesOf(data)?.additional.includes(get().displayLang) ? get().displayLang : null
      set({
        baseGraph: data,
        collapsedTypes: [],
        displayLang: lang,
        ...deriveGraphState(displayOf(data, [], lang), get().prefs),
        loadError: '',
        activeTab: 'overview',
        explorerQuery: '',
        explorerType: '',
        explorerConditions: [],
        explorerPage: 0,
        trail: [],
        selectedId: null,
        geoEpsg: defaultGeoEpsg,
        model3d: null,
      })
    },

    // For a host whose graph changes while it is on screen -- an editor saving a
    // record. Unlike loadGraph nothing is reset: tab, filters, the trail and the
    // selection stay, as far as their nodes still exist.
    updateGraph(data) {
      if (!data || !data.nodes) return
      data = withPaletteColors(data)
      const { collapsedTypes, prefs, selectedId, trail, displayLang } = get()
      const display = displayOf(data, collapsedTypes, displayLang)
      const nextTrail = trail.filter((t) => display.nodes[t.id])
      set({
        baseGraph: data,
        ...deriveGraphState(display, prefs),
        trail: nextTrail,
        selectedId: selectedId && display.nodes[selectedId] ? selectedId : (nextTrail[nextTrail.length - 1]?.id ?? null),
      })
    },

    // Collapse ("bypass") or re-expand a pass-through node type: removes those
    // nodes and links their neighbours directly (lib/collapse.js). The display
    // graph is always rebuilt from the untouched baseGraph, so toggling is free
    // and reversible. Node ids change, so navigation/paging is reset.
    toggleCollapseType(type) {
      const { baseGraph, collapsedTypes, prefs, displayLang } = get()
      if (!baseGraph) return
      const next = collapsedTypes.includes(type)
        ? collapsedTypes.filter((x) => x !== type)
        : [...collapsedTypes, type]
      const display = displayOf(baseGraph, next, displayLang)
      set({
        collapsedTypes: next,
        ...deriveGraphState(display, prefs),
        explorerPage: 0,
        trail: [],
        selectedId: null,
      })
    },

    // Read the graph in another of its languages (null: the primary). Nothing
    // else changes: tab, selection and trail stay — the ids are the same.
    setDisplayLang(lang) {
      const { baseGraph, collapsedTypes, prefs, displayLang } = get()
      const next = lang && languagesOf(baseGraph)?.additional.includes(lang) ? lang : null
      if (next === displayLang) return
      set({ displayLang: next, ...(baseGraph ? deriveGraphState(displayOf(baseGraph, collapsedTypes, next), prefs) : {}) })
    },

    // The graph as it is to be saved: collapsed as shown, in its own languages
    // (never the labels swapped for the display).
    graphForSaving() {
      const { baseGraph, collapsedTypes } = get()
      return baseGraph ? displayOf(baseGraph, collapsedTypes, null) : null
    },

    setHostPanes(panes = [], presets = []) {
      set({ hostPanes: panes.filter((p) => p?.key && p.Component), hostPresets: presets.filter((p) => p?.key && p.panes?.length) })
    },
    setViewsAlso(keys = []) {
      const prev = get().viewsAlso
      if (prev.length === keys.length && prev.every((k, i) => k === keys[i])) return
      set({ viewsAlso: [...keys] })
    },

    setLoadError(msg) {
      set({ loadError: msg })
    },

    setGeoEpsg(epsg) {
      set({ geoEpsg: epsg })
    },

    setModel3d(model) {
      set({ model3d: model })
    },
    setModel3dPlacement(patch) {
      const m = get().model3d
      if (m) set({ model3d: { ...m, placement: { ...m.placement, ...patch } } })
    },

    reset() {
      set({
        graph: null, baseGraph: null, collapsedTypes: [], displayLang: null, baseSchema: null, schema: null,
        nodeIds: [], typeIndex: {}, loadError: '',
        activeTab: 'overview', explorerQuery: '', explorerType: '', explorerConditions: [], explorerPage: 0,
        trail: [], selectedId: null, geoEpsg: defaultGeoEpsg, model3d: null,
      })
    },

    // -- User preference overrides (colors, attribute order) --
    setTypeColor(type, color) {
      const prefs = { ...get().prefs, typeColors: { ...get().prefs.typeColors, [type]: color } }
      savePrefs(prefs)
      set({ prefs, schema: mergeSchema(get().baseSchema, prefs) })
    },
    resetTypeColor(type) {
      const typeColors = { ...get().prefs.typeColors }
      delete typeColors[type]
      const prefs = { ...get().prefs, typeColors }
      savePrefs(prefs)
      set({ prefs, schema: mergeSchema(get().baseSchema, prefs) })
    },
    // Same, but for one single node: a color set here beats its type's color
    // wherever that node is drawn (list dots, hover card, Matrix, Zeitstrahl,
    // Karte). Node ids are stable across datasets only if the datasets share
    // them -- an override for an id the current graph doesn't have simply
    // never applies, so nothing has to be cleaned up on load.
    setNodeColor(id, color) {
      const prefs = { ...get().prefs, nodeColors: { ...(get().prefs.nodeColors || {}), [id]: color } }
      savePrefs(prefs)
      set({ prefs, schema: mergeSchema(get().baseSchema, prefs) })
    },
    resetNodeColor(id) {
      const nodeColors = { ...get().prefs.nodeColors }
      delete nodeColors[id]
      const prefs = { ...get().prefs, nodeColors }
      savePrefs(prefs)
      set({ prefs, schema: mergeSchema(get().baseSchema, prefs) })
    },
    setAttrOrder(type, orderedKeys) {
      const prefs = { ...get().prefs, attrOrder: { ...get().prefs.attrOrder, [type]: orderedKeys } }
      savePrefs(prefs)
      set({ prefs, schema: mergeSchema(get().baseSchema, prefs) })
    },
    resetAttrOrder(type) {
      const attrOrder = { ...get().prefs.attrOrder }
      delete attrOrder[type]
      const prefs = { ...get().prefs, attrOrder }
      savePrefs(prefs)
      set({ prefs, schema: mergeSchema(get().baseSchema, prefs) })
    },
    // Connection/neighbor-group order isn't read through the merged schema
    // (only NodeDetail uses it), so these just update prefs directly.
    setConnOrder(type, orderedKeys) {
      const prefs = { ...get().prefs, connOrder: { ...get().prefs.connOrder, [type]: orderedKeys } }
      savePrefs(prefs)
      set({ prefs })
    },
    resetConnOrder(type) {
      const connOrder = { ...get().prefs.connOrder }
      delete connOrder[type]
      const prefs = { ...get().prefs, connOrder }
      savePrefs(prefs)
      set({ prefs })
    },

    // Dashboard arrangement. Kept in prefs so it survives a reload and a new
    // import -- it describes how the user likes to work, not the data. The
    // write itself is coalesced because splitter drags update this on every
    // pointer move.
    setDashboardLayout(layout) {
      const prefs = { ...get().prefs, dashboard: layout }
      savePrefsSoon(prefs)
      set({ prefs, dashboardLayout: layout })
    },

    setActiveTab(tab) {
      set({ activeTab: tab })
    },

    setExplorerQuery(q) {
      set({ explorerQuery: q, explorerPage: 0 })
    },
    setExplorerType(t) {
      set({ explorerType: t, explorerPage: 0 })
    },
    setExplorerConditions(conditions) {
      set({ explorerConditions: conditions, explorerPage: 0 })
    },
    setExplorerPage(p) {
      set({ explorerPage: p })
    },

    // Jump to the Explorer tab, pre-filtered by node type (from Overview clicks)
    openExplorerFiltered(type) {
      set({ activeTab: explorerTab(get), explorerType: type || '', explorerQuery: '', explorerConditions: [], explorerPage: 0 })
    },

    // Jump to the Explorer tab with a full type + advanced-filter scope (from
    // a Charts tab bar click) -- re-expresses the bar's grouping as an
    // explicit condition so the two features close the loop: chart -> filter.
    openExplorerWithFilter(type, conditions) {
      set({ activeTab: explorerTab(get), explorerType: type || '', explorerQuery: '', explorerConditions: conditions || [], explorerPage: 0 })
    },

    // Jump to the Explorer tab and select a specific node (from Overview/Search clicks)
    openInExplorer(id) {
      set({ activeTab: explorerTab(get), explorerType: '', explorerQuery: '', explorerConditions: [], explorerPage: 0 })
      get().navigateTo(id, true)
    },

    navigateTo(nodeId, addTrail) {
      const { graph, trail } = get()
      if (addTrail) {
        const nd = graph?.nodes?.[nodeId]
        if (nd) {
          let nextTrail = trail
          if (!trail.length || trail[trail.length - 1].id !== nodeId) {
            nextTrail = [...trail, { id: nodeId, label: nd.l, type: nd.t }]
            if (nextTrail.length > TRAIL_MAX) nextTrail = nextTrail.slice(-TRAIL_MAX)
          }
          set({ trail: nextTrail })
        }
      }
      set({ selectedId: nodeId })
    },

    navigateBack() {
      const { trail } = get()
      if (trail.length <= 1) return
      const nextTrail = trail.slice(0, -1)
      const prev = nextTrail[nextTrail.length - 1]
      set({ trail: nextTrail, selectedId: prev.id })
    },

    // Breadcrumb chip click: truncate the trail at that point
    navigateToTrailIndex(idx) {
      const { trail } = get()
      const nextTrail = trail.slice(0, idx + 1)
      set({ trail: nextTrail, selectedId: nextTrail[nextTrail.length - 1].id })
    },
  }))
}


// -- How the views reach their store ----------------------------------------
// One store per application, handed down through React context. A view calls
// useStore(selector) exactly as it would a zustand hook; code outside render
// (event handlers that read-modify-write) takes useStoreApi().getState().

const StoreContext = createContext(null)

export function ExplorerStoreProvider({ store, children }) {
  return createElement(StoreContext.Provider, { value: store }, children)
}

export function useStoreApi() {
  const store = useContext(StoreContext)
  if (!store) throw new Error('The GraphExplorer views need an <ExplorerStoreProvider store={createExplorerStore()}> around them.')
  return store
}

export function useStore(selector, equalityFn) {
  return useStoreApi()(selector, equalityFn)
}
