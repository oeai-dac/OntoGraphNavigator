// The Graph tab's model: which nodes are currently drawn, and where.
//
// Everything visible is DERIVED from three small pieces of state -- the root
// node, the set of expanded nodes, and how many neighbours each connection
// group has loaded. The visible set itself is never stored. That is what makes
// collapsing correct rather than merely plausible: closing a node is removing
// its id from `expanded` and deriving again, so neighbours that were only
// reachable through it disappear on their own, while ones a second expanded
// node also holds simply stay. Keeping the drawn set as state instead would
// turn every collapse into a "is this still held elsewhere?" graph search --
// and get it quietly wrong the first time two branches meet on the same node,
// which in a CIDOC graph is the normal case, not the exception.
//
// Pure and UI-free like the rest of lib/ -- see
// tests/fixtures/run-graph-explore-check.mjs.

import dagre from 'dagre'
import { edgeLabel } from './schema'

// How many neighbours one connection group contributes per expansion. A
// single node in the example dataset can carry over a thousand finds; drawing
// them all on one click would freeze the canvas and say nothing. The rest
// stays one "+N laden" click away (see loadMore), so nothing is hidden
// silently -- the counts are always shown.
export const DEFAULT_GROUP_LIMIT = 25

// A hard ceiling across the whole canvas, independent of the per-group limit:
// enough expansions of enough groups would otherwise still add up to a graph
// no browser can lay out. Reaching it is reported (`truncated`), not swallowed.
export const MAX_VISIBLE_NODES = 1500

// Node box size. Lives here because both the radial placement and the Dagre
// re-layout have to agree on it, and the component reads the same constants
// so the drawn box matches what was laid out.
export const NODE_WIDTH = 178
export const NODE_HEIGHT = 46

const MIN_RADIUS = 200
const ARC_PER_CHILD = 215 // arc length reserved per child, in px

const DIR_RANK = { o: 0, i: 1 } // outgoing groups before incoming, as in NodeDetail

function localName(uri) {
  const looksLikeUri = /:\/\//.test(uri) || uri.includes('#')
  const local = looksLikeUri ? (uri.includes('#') ? uri.split('#').pop() : uri.split('/').pop()) : uri
  return local.replace(/_/g, ' ')
}

/** Label for an edge as drawn on the canvas. Normally just the schema's label;
    the one special case is `<property>#dot1:<value>`, the RDF-Star
    stratigraphy key from the format spec, which as a raw string says nothing.
    Only decomposed when the schema has no label for the full key, so a
    curated label always wins. */
export function exploreEdgeLabel(schema, etype) {
  const known = schema?.edgeLabels?.[etype]
  if (known) return known
  const at = etype.indexOf('#dot1:')
  if (at > 0) {
    const base = etype.slice(0, at)
    return (schema?.edgeLabels?.[base] || localName(base)) + ' · ' + etype.slice(at + 6)
  }
  return edgeLabel(schema, etype)
}

/** A node's connections, grouped by edge type and direction, in the same order
    the Explorer's detail view uses. Ids the graph doesn't actually carry are
    dropped here rather than at each call site, so every count downstream --
    the badge on a box, the "N von M" of a group -- is a count of things that
    can really be drawn. */
export function neighborGroups(graph, id) {
  const nd = graph?.nodes?.[id]
  if (!nd) return []
  const keep = (ids) => (ids || []).filter((t) => graph.nodes[t])
  const groups = [
    ...Object.entries(nd.o || {}).map(([etype, ids]) => ({ key: 'o:' + etype, etype, dir: 'o', ids: keep(ids) })),
    ...Object.entries(nd.i || {}).map(([etype, ids]) => ({ key: 'i:' + etype, etype, dir: 'i', ids: keep(ids) })),
  ].filter((g) => g.ids.length)
  return groups.sort((a, b) => DIR_RANK[a.dir] - DIR_RANK[b.dir] || a.etype.localeCompare(b.etype))
}

/** Every distinct node reachable in one hop. Distinct, because the same
    neighbour often sits in several groups (and on both sides of a relation);
    counting group lengths would promise more boxes than a click delivers. */
export function neighborIds(graph, id) {
  const out = new Set()
  for (const g of neighborGroups(graph, id)) for (const t of g.ids) out.add(t)
  out.delete(id)
  return out
}

const limitKey = (id, groupKey) => id + '\u0000' + groupKey

function limitFor(state, id, groupKey) {
  const v = state?.limits?.[limitKey(id, groupKey)]
  return typeof v === 'number' ? v : DEFAULT_GROUP_LIMIT
}

// -- state ------------------------------------------------------------------
//
// The whole exploration is this one small object. It is plain data on purpose:
// derivation is a pure function of it, so every reducer below can be tested
// without a canvas.

export function emptyExploreState() {
  return { rootId: null, expanded: [], limits: {} }
}

/** Start over from one node, which is opened right away -- landing on a single
    unopened box would make the first click a formality. */
export function rootAt(nodeId) {
  return { rootId: nodeId, expanded: [nodeId], limits: {} }
}

export function isExpanded(state, id) {
  return (state?.expanded || []).includes(id)
}

export function expand(state, id) {
  if (isExpanded(state, id)) return state
  return { ...state, expanded: [...state.expanded, id] }
}

/** Close a node. Its per-group load counts are dropped too, so re-opening it
    later starts from the default rather than silently restoring a "+N laden"
    the user can no longer see. */
export function collapse(state, id) {
  if (!isExpanded(state, id)) return state
  const limits = {}
  const prefix = id + '\u0000'
  for (const [k, v] of Object.entries(state.limits || {})) {
    if (!k.startsWith(prefix)) limits[k] = v
  }
  return { ...state, expanded: state.expanded.filter((x) => x !== id), limits }
}

export function toggle(state, id) {
  return isExpanded(state, id) ? collapse(state, id) : expand(state, id)
}

/** Raise one group's limit by another batch, expanding the node if it was
    closed -- "load more" on a closed node can only mean "open it and show
    more". */
export function loadMore(state, id, groupKey, step = DEFAULT_GROUP_LIMIT) {
  const next = expand(state, id)
  return {
    ...next,
    limits: { ...next.limits, [limitKey(id, groupKey)]: limitFor(state, id, groupKey) + step },
  }
}

/** Back to just the root, still open. Everything else closes. */
export function collapseAll(state) {
  return state?.rootId ? rootAt(state.rootId) : emptyExploreState()
}

// -- derivation --------------------------------------------------------------

/**
 * The drawn graph for a state: which boxes exist, which line connects which,
 * and how each box was reached.
 *
 * Returns `{ nodes, edges, byId, truncated }`. `nodes` is in breadth-first
 * order starting at the root, which the placement below relies on: a parent is
 * always positioned before the children that fan out around it.
 */
export function deriveGraph(graph, state) {
  const rootId = state?.rootId
  if (!graph?.nodes?.[rootId]) return { nodes: [], edges: [], byId: new Map(), truncated: false }

  const expanded = new Set(state.expanded || [])
  const byId = new Map([[rootId, { id: rootId, parentId: null, depth: 0 }]])
  const queue = [rootId]
  let truncated = false

  while (queue.length && !truncated) {
    const id = queue.shift()
    if (!expanded.has(id)) continue // reached, but closed: contributes nothing
    const depth = byId.get(id).depth
    for (const g of neighborGroups(graph, id)) {
      for (const tid of g.ids.slice(0, limitFor(state, id, g.key))) {
        if (byId.has(tid)) continue
        if (byId.size >= MAX_VISIBLE_NODES) {
          truncated = true
          break
        }
        byId.set(tid, { id: tid, parentId: id, depth: depth + 1 })
        queue.push(tid)
      }
      if (truncated) break
    }
  }

  const nodes = [...byId.values()]
  const edges = []
  const seen = new Set()      // one entry per drawn relation
  const pairs = new Set()     // unordered pairs already connected

  // Walking `o` alone already yields every relation exactly once: the format
  // materializes both directions, so an edge recorded as A.o also sits in B.i,
  // and taking both would draw the same relation twice -- under two different
  // names, since the spec explicitly allows the inverse side to be labelled
  // differently ("Hat POIs" / "Ist POI von").
  for (const id of byId.keys()) {
    for (const [etype, ids] of Object.entries(graph.nodes[id].o || {})) {
      for (const tid of ids || []) {
        if (!byId.has(tid)) continue
        const key = id + '\u0000' + etype + '\u0000' + tid
        if (seen.has(key)) continue
        seen.add(key)
        pairs.add(id < tid ? id + '\u0000' + tid : tid + '\u0000' + id)
        edges.push({ id: key, source: id, target: tid, etype })
      }
    }
  }

  // A second pass over `i`, but only for pairs the first pass left unconnected.
  // Producers are required to write both sides; when one doesn't, the neighbour
  // was still opened from `i` and would otherwise sit there as a box with no
  // line to whatever put it on screen. Restricting this to unconnected pairs
  // keeps the double-naming above from creeping back in.
  for (const id of byId.keys()) {
    for (const [etype, ids] of Object.entries(graph.nodes[id].i || {})) {
      for (const sid of ids || []) {
        if (!byId.has(sid)) continue
        const pair = id < sid ? id + '\u0000' + sid : sid + '\u0000' + id
        if (pairs.has(pair)) continue
        pairs.add(pair)
        edges.push({ id: sid + '\u0000' + etype + '\u0000' + id, source: sid, target: id, etype, inferred: true })
      }
    }
  }

  return { nodes, edges, byId, truncated }
}

/** What one node's connection groups look like right now: how many of each are
    drawn, how many exist, and how many the canvas is still missing. This is
    what the group chips render, and it is also how a box knows whether to
    offer "open" at all. */
export function groupStatus(graph, state, visibleIds, id) {
  const open = isExpanded(state, id)
  return neighborGroups(graph, id).map((g) => {
    const limit = limitFor(state, id, g.key)
    const shown = open ? g.ids.slice(0, limit).filter((t) => visibleIds.has(t)).length : 0
    return {
      key: g.key,
      etype: g.etype,
      dir: g.dir,
      total: g.ids.length,
      shown,
      // "Not yet asked for" -- distinct from `total - shown`, which also counts
      // neighbours already on screen because another branch brought them in.
      remaining: Math.max(0, g.ids.length - (open ? limit : 0)),
    }
  })
}

/** How many of a node's neighbours are not on the canvas -- the number the box
    offers on its badge. Zero means clicking it adds nothing new, which is
    worth showing differently from "not opened yet". */
export function hiddenNeighborCount(graph, visibleIds, id) {
  let n = 0
  for (const t of neighborIds(graph, id)) if (!visibleIds.has(t)) n++
  return n
}

// -- placement ---------------------------------------------------------------
//
// Positions are ReactFlow's, i.e. the box's top-left corner. All boxes are the
// same size, so using them as if they were centres (as the fan geometry below
// does) shifts the whole drawing by half a box and changes nothing else.

/**
 * Give every node a position, keeping the ones already placed exactly where
 * they are. That fixed-point property is the entire point of the radial
 * layout: expanding a node must not move anything the user has already read,
 * or every click costs them their orientation. A full re-layout is available,
 * but only when it is asked for (`layoutExploreGraph`).
 *
 * New nodes fan out around their parent, away from where that parent was
 * itself reached from, so a branch grows outward instead of folding back over
 * its own origin.
 */
export function positionNewNodes(nodes, prev = {}) {
  const positions = { ...prev }
  const pending = new Map() // parent id -> ids waiting for a spot
  const parentOf = new Map()

  for (const n of nodes) {
    parentOf.set(n.id, n.parentId)
    if (positions[n.id]) continue
    if (n.parentId == null) {
      positions[n.id] = { x: 0, y: 0 }
      continue
    }
    if (!pending.has(n.parentId)) pending.set(n.parentId, [])
    pending.get(n.parentId).push(n.id)
  }

  // Breadth-first order means a node is always visited after the parent whose
  // fan positioned it -- so by the time we lay out its own children, it has a
  // position to fan them around.
  for (const n of nodes) {
    const kids = pending.get(n.id)
    if (!kids || !kids.length) continue
    const center = positions[n.id] || { x: 0, y: 0 }
    const gp = parentOf.get(n.id)
    const from = gp != null ? positions[gp] : null
    const outward = from ? Math.atan2(center.y - from.y, center.x - from.x) : -Math.PI / 2
    const full = !from
    const spread = full ? Math.PI * 2 : Math.PI * 1.45
    const radius = Math.max(MIN_RADIUS, (kids.length * ARC_PER_CHILD) / spread)
    kids.forEach((kid, i) => {
      let a
      if (kids.length === 1) a = outward
      // A full circle must not put the last child back on top of the first,
      // so its step divides by the count, not by count - 1.
      else if (full) a = outward + (i * spread) / kids.length
      else a = outward - spread / 2 + (i * spread) / (kids.length - 1)
      positions[kid] = { x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) }
    })
  }

  return positions
}

/** Lay the whole visible graph out hierarchically, left to right. This is the
    "Neu anordnen" button, not the default: it does tidy the structure, but it
    moves every box at once, which is exactly what the incremental placement
    above exists to avoid. */
export function layoutExploreGraph(nodes, edges) {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 130, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }))
  const seen = new Set()
  edges.forEach((e) => {
    // Self-loops and parallel edges confuse a layered layout; they are still
    // drawn, they just don't get a say in the ranking.
    if (e.source === e.target) return
    const k = e.source + '\u0000' + e.target
    if (seen.has(k)) return
    seen.add(k)
    g.setEdge(e.source, e.target)
  })
  dagre.layout(g)
  const positions = {}
  nodes.forEach((n) => {
    const gn = g.node(n.id)
    positions[n.id] = gn
      ? { x: gn.x - NODE_WIDTH / 2, y: gn.y - NODE_HEIGHT / 2 }
      : { x: 0, y: 0 }
  })
  return positions
}

// -- picking a starting point ------------------------------------------------

/** Candidate root nodes by label or id, optionally within one type. Attribute
    values are deliberately not searched: that is what the Suche tab is for,
    and scanning them on every keystroke over 120.000 nodes would make the
    field lag. The placeholder says so. */
export function searchNodes(graph, query, type = '', limit = 40) {
  const q = String(query || '').trim().toLowerCase()
  if (q.length < 2 && !type) return []
  const hits = []
  for (const [id, nd] of Object.entries(graph?.nodes || {})) {
    if (type && nd.t !== type) continue
    if (q.length >= 2) {
      const label = String(nd.l ?? '')
      if (!label.toLowerCase().includes(q) && !id.toLowerCase().includes(q)) continue
    }
    hits.push(id)
    if (hits.length >= limit) break
  }
  return hits
}

/** The most connected nodes, offered as starting points when nothing is
    selected yet -- the same "most networked" idea the Overview tab already
    uses, and the sensible place to start an exploration from. */
export function topDegreeNodes(graph, limit = 8) {
  const scored = []
  for (const [id, nd] of Object.entries(graph?.nodes || {})) {
    let degree = 0
    for (const ids of Object.values(nd.o || {})) degree += (ids || []).length
    for (const ids of Object.values(nd.i || {})) degree += (ids || []).length
    if (degree) scored.push({ id, degree })
  }
  scored.sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
  return scored.slice(0, limit)
}
