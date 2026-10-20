import React, { useEffect, useRef, useState } from 'react'
import { protocolMatches, protocolUnitList, useStore } from '../store'
import Enter from './Enter'
import { listPanes } from '../views/lib/dashboardLayout'
import {
  createExplorerStore, ExplorerStoreProvider, availableViews, ViewBoundary, NodeHoverCard,
  ExplorerTab, GraphTab, MatrixTab, MapTab, Scene3dTab, TimelineTab, ChartsTab, DashboardTab,
} from '../views'
import { typeLabel, edgeLabel, humaniseKey } from '../views/lib/schema'

/**
 * The GraphExplorer's views over the graph being edited.
 *
 * src/views/ is a copy of the GraphExplorer's (npm run sync-views) — the
 * same Explorer, Graph, Harris matrix, Map, 3D, Timeline, Charts and
 * Dashboard. They read their own store; this file is the only place that
 * feeds it, and the only place that connects their tabs with this tool's.
 *
 * Editing: with a project file loaded, the views get an editor (see the
 * GraphExplorer's src/views/README.md, "Editing") — attributes in the
 * Explorer, geometries on the Map. It writes where a value was read from, via
 * lib/viewEditor.js, through the journal like every other edit. A graph
 * loaded without its project has no tables to write into, and no editor.
 */

// One store for the session. Colours and layouts are kept apart from the
// GraphExplorer's, so the two tools do not change each other's.
export const explorerStore = createExplorerStore({ prefsKey: 'ogn:explorerPrefs:v1' })

const COMPONENTS = {
  explore: ExplorerTab,
  graph: GraphTab,
  matrix: MatrixTab,
  map: MapTab,
  scene3d: Scene3dTab,
  timeline: TimelineTab,
  charts: ChartsTab,
  dashboard: DashboardTab,
}
export const VIEW_TAB_KEYS = Object.keys(COMPONENTS)
export const isViewTab = (tab) => VIEW_TAB_KEYS.includes(tab)

/**
 * The view tabs this graph can show, with their labels. The GraphExplorer's
 * own Overview stays out — this tool has its own, with the load report.
 */
export function viewTabsFor(graph, also = []) {
  if (!graph) return []
  const tabs = availableViews(graph, also)
    .filter((v) => v.key !== 'overview' && COMPONENTS[v.key])
    .map((v) => ({ key: v.key, label: v.tabLabel }))
  tabs.push({ key: 'dashboard', label: 'Dashboard' })
  return tabs
}

// ---- feeding the views -----------------------------------------------------------
// Fed only once a view has been opened: for a graph of 300k nodes, deriving
// the views' indexes is not free, and someone only entering data never pays.
// An edit hands over the same `nodes` object (updated in place, see
// rematerialize in lib/edits.js) — then the views keep tab, filters and
// selection; a new `nodes` object is a different graph and starts them over.
let fed = false
let lastNodes = null

function feed(graph) {
  const views = explorerStore.getState()
  if (!graph) {
    views.reset()
    lastNodes = null
    return
  }
  if (graph.nodes === lastNodes) views.updateGraph(graph)
  else views.loadGraph(graph)
  lastNodes = graph.nodes
  // The views read the graph in the language chosen in the header.
  views.setDisplayLang(useStore.getState().displayLang)
}

useStore.subscribe((state, prev) => {
  if (state.graph === prev.graph) return
  if (fed || !state.graph) feed(state.graph)
  if (!state.graph) fed = false
})

useStore.subscribe((state, prev) => {
  if (state.displayLang !== prev.displayLang && fed) explorerStore.getState().setDisplayLang(state.displayLang)
})

// ---- the Dashboard: this tool's entry form as a pane beside the views ----------------
// (GraphExplorer src/views/README.md, "Host panes"). Its own look: OGN's tokens
// and element rules apply inside .ogn-pane (styles.css).
const ENTER_PANE = 'host:enter'
function EnterPane() {
  return (
    <div className="ogn-pane">
      <Enter />
    </div>
  )
}
explorerStore.getState().setHostPanes(
  [{ key: ENTER_PANE, label: 'Enter', icon: '✎', Component: EnterPane }],
  [
    { key: 'enter-map', label: 'Enter │ Map', panes: [ENTER_PANE, 'map'] },
    { key: 'enter-matrix', label: 'Enter │ Matrix', panes: [ENTER_PANE, 'matrix'] },
    { key: 'enter-map-matrix', label: 'Enter │ Map ╱ Matrix', panes: [ENTER_PANE, 'map', 'matrix'] },
  ],
)

// The matrix of a mapping that has one is offered also before its first unit — in the Dashboard too.
useStore.subscribe((state, prev) => {
  if (state.workspace === prev.workspace && state.graph === prev.graph) return
  explorerStore.getState().setViewsAlso(state.workspace && useStore.getState().matrixRules().length ? ['matrix'] : [])
})

// A unit chosen in the map or the matrix, while the Enter pane is beside them:
// its record (or protocol) opens there — never over unsaved changes.
explorerStore.subscribe((state, prev) => {
  if (!state.selectedId || state.selectedId === prev.selectedId) return
  if (useStore.getState().tab !== 'dashboard') return
  if (!listPanes(state.dashboardLayout).some((p) => p.view === ENTER_PANE)) return
  useStore.getState().openForNode(state.selectedId)
})

/** The Explorer, showing the records of one type (the Overview's list of types). */
export function openTypeInExplorer(typeKey) {
  ensureFed()
  explorerStore.getState().openExplorerFiltered(typeKey)
  useStore.getState().setTab('explore')
}

/** The views get the graph now — also when no view tab was opened (the bridge asks). */
function ensureFed() {
  if (fed) return
  const graph = useStore.getState().graph
  if (!graph) return
  fed = true
  feed(graph)
}

// ---- the bridge to QGIS and Blender (views/bridge/explorer-bridge.js) -------------
// The same page side as the GraphExplorer's: the plugins connect to this tool
// exactly as to the GraphExplorer, unchanged. What differs is what a selection
// from them opens: the protocol of that unit where a protocol is being
// entered, the Explorer otherwise. And the graph is this project's — a plugin
// cannot load another one into it.
function openFromBridge(id) {
  const app = useStore.getState()
  const views = explorerStore.getState()
  if (app.tab === 'enter' && app.enterMode === 'protocols' && protocolUnitList(app).some((u) => u.id === id)) {
    app.openProtocol(id)
    views.navigateTo(id, false)
    return
  }
  views.openInExplorer(id)
  if (app.tab !== 'explore') app.setTab('explore')
}

const BRIDGE_API_VERSION = 4 // as the GraphExplorer's: the plugins check for "at least"

if (typeof window !== 'undefined' && !window.__GRAPH_EXPLORER_API__) {
  window.__GRAPH_EXPLORER_API__ = {
    version: BRIDGE_API_VERSION,
    store: {
      getState() {
        ensureFed()
        return { ...explorerStore.getState(), openInExplorer: openFromBridge }
      },
      subscribe: (fn) => explorerStore.subscribe(fn),
    },
    labels: { type: typeLabel, edge: edgeLabel, attr: humaniseKey },
    // Geometries written back from QGIS (step 6c): where they go, and writing them.
    geometry: {
      crs: () => (ensureFed(), explorerStore.getState().geoEpsg || null),
      describe: (nodeIds) => useStore.getState().describeGeometries(nodeIds),
      write(items, epsg) {
        const views = explorerStore.getState()
        if (epsg && !views.geoEpsg) views.setGeoEpsg(String(epsg))
        return useStore.getState().writeGeometries(items)
      },
    },
    // Values and new records from QGIS (step 6c).
    values: {
      describe: (nodeIds, attrKey) => useStore.getState().describeValues(nodeIds, attrKey),
      write: (attrKey, items) => useStore.getState().writeValues(attrKey, items),
    },
    records: {
      describe: (spec, keys) => useStore.getState().describeNewRecords(spec, keys),
      create: (spec, items) => useStore.getState().createRecords(spec, items),
    },
    holdsProject: 'The OntoGraphNavigator shows the project it edits — it does not load a graph from another application. Open the project there, or send the graph to a GraphExplorer.',
  }
}

// A unit opened in the protocol form is the selection the plugins follow.
useStore.subscribe((state, prev) => {
  const id = state.protocol?.unitId
  if (!id || id === prev.protocol?.unitId || !fed) return
  if (explorerStore.getState().selectedId !== id) explorerStore.getState().navigateTo(id, false)
})

// The editor the views call. Each call goes to the store as it is then — the
// workspace of the file loaded at that moment.
const editor = {
  describeAttribute: (nodeId, key) => useStore.getState().describeAttribute(nodeId, key),
  setAttribute: (nodeId, key, value) => useStore.getState().editAttribute(nodeId, key, value),
  // The Matrix view: relations drawn, changed, removed (lib/matrixEditor.js).
  matrix: {
    describe: (payload) => useStore.getState().describeMatrix(payload),
    rules: () => useStore.getState().matrixRules(),
    // Units placed by hand, per matrix view — kept with the settings, in the project zip.
    positions: {
      load: (key) => useStore.getState().matrixPositions(key),
      save: (key, positions) => useStore.getState().setMatrixPositions(key, positions),
    },
    // The recording protocol of a unit (lib/protocols.js), in the Enter tab.
    hasProtocols: () => protocolMatches(useStore.getState()).length > 0,
    openProtocol: (unitId) => useStore.getState().openProtocol(unitId),
    addRelation: (payload) => useStore.getState().editMatrix('addRelation', payload),
    setRelation: (payload) => useStore.getState().editMatrix('setRelation', payload),
    removeRelation: (payload) => useStore.getState().editMatrix('removeRelation', payload),
    suggestIdentifier: (payload) => useStore.getState().suggestUnitIdentifier(payload),
    // Phases (lib/phaseEditor.js): in the mapping, in the tables, per unit.
    phases: {
      describe: (payload) => useStore.getState().describePhases(payload),
      list: (payload) => useStore.getState().listPhases(payload),
      addToMapping: (payload) => useStore.getState().editPhases('addToMapping', payload),
      create: (payload) => useStore.getState().editPhases('create', payload),
      rename: (payload) => useStore.getState().editPhases('rename', payload),
      move: (payload) => useStore.getState().editPhases('move', payload),
      remove: (payload) => useStore.getState().editPhases('remove', payload),
      assign: (payload) => useStore.getState().editPhases('assign', payload),
    },
    // Objects and object groups (lib/objectEditor.js).
    objects: {
      describe: (payload) => useStore.getState().describeObjects(payload),
      list: (payload) => useStore.getState().listObjects(payload),
      addToMapping: (payload) => useStore.getState().editObjects('addToMapping', payload),
      createObject: (payload) => useStore.getState().editObjects('createObject', payload),
      createGroup: (payload) => useStore.getState().editObjects('createGroup', payload),
      renameObject: (payload) => useStore.getState().editObjects('renameObject', payload),
      renameGroup: (payload) => useStore.getState().editObjects('renameGroup', payload),
      removeObject: (payload) => useStore.getState().editObjects('removeObject', payload),
      removeGroup: (payload) => useStore.getState().editObjects('removeGroup', payload),
      assign: (payload) => useStore.getState().editObjects('assign', payload),
      setGroup: (payload) => useStore.getState().editObjects('setGroup', payload),
    },
    unitTypes: {
      describe: (payload) => useStore.getState().describeUnitTypes(payload),
      assign: (payload) => useStore.getState().editUnitTypes(payload),
    },
  },
}

useStore.subscribe((state, prev) => {
  if (state.workspace === prev.workspace) return
  explorerStore.getState().setEditor(state.workspace ? editor : null)
})

// A view asking for another tab — "open in Explorer" from the matrix, a bar
// clicked in Charts — moves this tool's tab along.
explorerStore.subscribe((state, prev) => {
  if (state.activeTab === prev.activeTab || !isViewTab(state.activeTab)) return
  const app = useStore.getState()
  if (isViewTab(app.tab) && app.tab !== state.activeTab) app.setTab(state.activeTab)
})

/**
 * All views, mounted once opened and kept mounted — a map's zoom, a matrix
 * laid out, a dashboard arranged survive a trip to the entry form. Hidden
 * while another tab of this tool is shown.
 */
export default function ViewsHost({ tab }) {
  const graph = useStore((s) => s.graph)
  const active = isViewTab(tab)
  const opened = useRef(new Set())
  const [, rerender] = useState(0)

  if (active && !opened.current.has(tab)) opened.current.add(tab)

  useEffect(() => {
    if (!active) return
    if (!fed) {
      fed = true
      feed(useStore.getState().graph)
    }
    if (explorerStore.getState().activeTab !== tab) explorerStore.getState().setActiveTab(tab)
    rerender((n) => n + 1)
  }, [active, tab])

  // A new file: views start over and are mounted again as they are opened.
  useEffect(() => {
    if (!graph) opened.current = new Set()
  }, [graph])

  if (!opened.current.size || !fed) return null

  return (
    <ExplorerStoreProvider store={explorerStore}>
      <div className="ge-root ogn-views" style={{ display: active ? 'flex' : 'none' }}>
        <div className="content">
          {[...opened.current].map((key) => {
            const View = COMPONENTS[key]
            const on = active && key === tab
            return (
              <ViewBoundary key={key} name={key} className={'panel' + (on ? ' on' : '')}>
                <View active={on} />
              </ViewBoundary>
            )
          })}
        </div>
        <NodeHoverCard />
      </div>
    </ExplorerStoreProvider>
  )
}
