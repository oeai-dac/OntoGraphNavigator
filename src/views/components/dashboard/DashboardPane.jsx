import { memo } from 'react'
import { VIEWS, isViewAvailable, viewLabel } from '../../lib/views'
import { useStore } from '../../store'
import { VIEW_COMPONENTS } from './viewRegistry'
import { ViewBoundary } from '../shared/ViewBoundary'

// One window of the Dashboard: a slim header to pick the view and split or
// close the pane, and the view itself below it.
//
// memo() matters here rather than being a habit: dragging a splitter pushes a
// new layout on every pointer move, but lib/dashboardLayout.js reuses
// untouched branches, so `node` keeps its identity and every pane that isn't
// being resized skips the render entirely -- including any open map.
export const DashboardPane = memo(function DashboardPane({ node, graph, active, canClose, actions }) {
  // A pane of the application's own (README.md, "Host panes") — an entry
  // form beside the map — or one of the views.
  const hostPanes = useStore((s) => s.hostPanes)
  const also = useStore((s) => s.viewsAlso)
  const host = hostPanes.find((p) => p.key === node.view) || null
  const View = host ? host.Component : VIEW_COMPONENTS[node.view]
  // A layout can outlive the graph it was built for: a map pane restored
  // against a graph without geometries has nowhere to go. Say so instead of
  // rendering an empty view, and leave the pane in place -- load a graph with
  // geometries again and it simply works.
  const available = !!host || isViewAvailable(graph, node.view, also)
  const label = host ? host.label : viewLabel(node.view)

  return (
    <div className="dash-pane">
      <div className="dash-pane-hdr">
        <select
          className="dash-pane-view"
          value={node.view}
          title="View of this pane"
          onChange={(e) => actions.setView(node.id, e.target.value)}
        >
          {VIEWS.filter((v) => isViewAvailable(graph, v.key, also)).map((v) => (
            <option key={v.key} value={v.key}>
              {v.icon} {v.label}
            </option>
          ))}
          {hostPanes.map((p) => (
            <option key={p.key} value={p.key}>
              {p.icon || '▣'} {p.label}
            </option>
          ))}
          {!available && (
            <option value={node.view}>{label} (not available)</option>
          )}
        </select>

        <span className="dash-pane-sp" />

        <button className="dash-pane-btn" title="Split side by side" onClick={() => actions.split(node.id, 'row')}>
          ⬌
        </button>
        <button className="dash-pane-btn" title="Split one above the other" onClick={() => actions.split(node.id, 'col')}>
          ⬍
        </button>
        <button
          className="dash-pane-btn"
          title={canClose ? 'Close pane' : 'The last pane cannot be closed'}
          disabled={!canClose}
          onClick={() => actions.close(node.id)}
        >
          ✕
        </button>
      </div>

      <div className="dash-pane-body">
        {View && available ? (
          // domId={null} keeps the tab's own element id off the clone -- the
          // classic tab stays mounted alongside and the id is its. Its own
          // boundary, so one broken pane doesn't take the arrangement down.
          <ViewBoundary name={label} className="dash-pane-body-error">
            <View active={active} domId={null} />
          </ViewBoundary>
        ) : (
          <div className="det-empty">This view is not available for the loaded graph.</div>
        )}
      </div>
    </div>
  )
})
