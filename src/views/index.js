// The GraphExplorer's views, as one piece another application can show.
//
// This folder is self-contained: nothing in it imports from outside it, apart
// from npm packages. The OntoGraphNavigator keeps a copy of it (its
// `npm run sync-views` brings the copy up to date) -- so every change to a
// view is made here, in the GraphExplorer, and nowhere else. See README.md.
//
//   const store = createExplorerStore({ prefsKey: 'my-app:explorerPrefs:v1' })
//   store.getState().loadGraph(graphJson)        // first time
//   store.getState().updateGraph(graphJson)      // after an edit: view state kept
//
//   <ExplorerStoreProvider store={store}>
//     <div className="ge-root"> … <MatrixTab active /> … <NodeHoverCard /> </div>
//   </ExplorerStoreProvider>

import './views.css'

export { createExplorerStore, ExplorerStoreProvider, useStore, useStoreApi } from './store'
export { VIEWS, VIEW_KEYS, availableViews, availableViewKeys, isViewAvailable, viewLabel } from './lib/views'
export { allLanguages, languagesOf, localizeGraph } from './lib/languages'

export { OverviewTab } from './components/overview/OverviewTab'
export { ExplorerTab } from './components/explorer/ExplorerTab'
export { GraphTab } from './components/graph/GraphTab'
export { MatrixTab } from './components/matrix/MatrixTab'
export { MapTab } from './components/map/MapTab'
export { Scene3dTab } from './components/scene3d/Scene3dTab'
export { TimelineTab } from './components/timeline/TimelineTab'
export { ChartsTab } from './components/charts/ChartsTab'
export { DashboardTab } from './components/dashboard/DashboardTab'
export { NodeHoverCard } from './components/shared/NodeHoverCard'
export { ViewBoundary } from './components/shared/ViewBoundary'
