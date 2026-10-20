import { useEffect, useMemo, useState } from 'react'
import { useStore, useStoreApi } from '../../store'
import { availableViewKeys } from '../../lib/views'
import {
  PRESETS,
  buildPreset,
  pane as paneNode,
  split as splitNode,
  closePane,
  countPanes,
  setPaneView,
  setSplitRatio,
  splitPane,
  MAX_PANES,
} from '../../lib/dashboardLayout'
import { SplitView } from './SplitView'

// Read-modify-write against the store instead of through props: this keeps
// the `actions` object below referentially stable for the whole session,
// which is what lets DashboardPane's memo() actually bite during a drag.
// Made once per store -- an application may have its own.
function makeActions(api) {
  const updateLayout = (fn) => {
    const s = api.getState()
    s.setDashboardLayout(fn(s.dashboardLayout))
  }
  return {
    setView: (paneId, view) => updateLayout((t) => setPaneView(t, paneId, view)),
    split: (paneId, dir) => updateLayout((t) => splitPane(t, paneId, dir)),
    close: (paneId) => updateLayout((t) => closePane(t, paneId)),
    setRatio: (splitId, ratio) => updateLayout((t) => setSplitRatio(t, splitId, ratio)),
  }
}

export function DashboardTab({ active }) {
  const api = useStoreApi()
  const actions = useMemo(() => makeActions(api), [api])
  const graph = useStore((s) => s.graph)
  const layout = useStore((s) => s.dashboardLayout)
  const setDashboardLayout = useStore((s) => s.setDashboardLayout)

  // Every pane is a full view -- a Leaflet map, a ReactFlow canvas -- and the
  // classic tabs all stay mounted alongside. Building the arrangement only
  // once the user actually opens the Dashboard avoids paying for a second
  // copy of all that for people who never do. Once mounted it stays, so pane
  // state (map zoom, layer visibility) survives a trip to another tab.
  const [mounted, setMounted] = useState(active)
  useEffect(() => {
    if (active) setMounted(true)
  }, [active])

  const also = useStore((s) => s.viewsAlso)
  const hostPanes = useStore((s) => s.hostPanes)
  const hostPresets = useStore((s) => s.hostPresets)
  const allowedViews = useMemo(() => [...availableViewKeys(graph, also), ...hostPanes.map((p) => p.key)], [graph, also, hostPanes])
  const paneCount = countPanes(layout)

  if (!graph) return null

  return (
    <div className={'panel dash-panel' + (active ? ' on' : '')} id="tab-dashboard">
      <div className="dash-bar">
        <span className="dash-bar-lbl">Layout</span>
        {PRESETS.map((p) => (
          <button
            key={p.key}
            className="dash-preset"
            onClick={() => {
              const next = buildPreset(p.key, allowedViews)
              if (next) setDashboardLayout(next)
            }}
            title="Replace layout"
          >
            {p.label}
          </button>
        ))}
        {hostPresets.map((p) => (
          <button
            key={p.key}
            className="dash-preset"
            title="Replace layout"
            onClick={() => {
              // [a, b] side by side ('row') or one above the other ('col');
              // a third pane under the second for [a, b, c].
              const v = (key) => (allowedViews.includes(key) ? key : allowedViews[0])
              const [a, b, c] = p.panes.map(v)
              const second = c ? splitNode('col', paneNode(b), paneNode(c)) : paneNode(b)
              setDashboardLayout(b ? splitNode(p.dir || 'row', paneNode(a), second, p.ratio || 0.45) : paneNode(a))
            }}
          >
            {p.label}
          </button>
        ))}
        <span className="dash-hint">
          {paneCount} of {MAX_PANES} panes · selection and filters apply to all
        </span>
      </div>

      <div className="dash-root">
        {mounted && (
          <SplitView
            node={layout}
            graph={graph}
            active={active}
            canClose={paneCount > 1}
            actions={actions}
          />
        )}
      </div>
    </div>
  )
}
