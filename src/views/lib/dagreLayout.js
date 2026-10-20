import dagre from 'dagre'

const NODE_WIDTH = 130
const NODE_HEIGHT = 36
const CLUSTER_GAP = 10

/**
 * Layered (Sugiyama-style) layout for the Harris Matrix, enforcing:
 *
 *   1. rankEdges are already deduplicated by buildSequence() -- each real
 *      relation is drawn exactly once regardless of which side ("über" or
 *      "unter") it was recorded from.
 *   2. rankEdges are directed "physically lower -> physically higher".
 *      With rankdir 'BT', dagre places edge sources below their targets,
 *      so earlier/lower units sink towards the bottom and later/higher
 *      units rise towards the top -- the conventional Harris Matrix
 *      reading direction.
 *   3. sameRankEdges (zeitgleich) and equalsEdges (entspricht) force their
 *      endpoints onto the IDENTICAL rank: both are collapsed into one
 *      union-find cluster *before* layout, laid out as a single wide dagre
 *      node, then expanded back into individual boxes at that node's rank.
 *      dagre has no native "same rank" edge constraint, so this collapse/
 *      expand approach is what actually guarantees the same height instead
 *      of just hoping the ranking algorithm happens to agree.
 *   4. Within a cluster, "entspricht" partners are ordered to sit directly
 *      next to each other (nearest possible); plain "zeitgleich" members
 *      fill the remaining slots without that adjacency preference.
 */
/*
 *   5. With `nest` -- { objectOf: Map<unit, object>, groupOf: Map<object, group> }
 *      -- the units of one object are kept together, and the objects of one
 *      group: dagre's compound graph, each object (and group) a cluster. Its
 *      box comes back in `boxes` ({ id, kind, x, y, w, h }, top left), the
 *      frame the Matrix tab draws. A same-rank cluster whose members belong
 *      to different objects is split, one part per object, each in its
 *      object. dagre knows no "same rank" constraint, and in a compound graph
 *      its own nesting edges outweigh any we could add; so the heights then
 *      come from the matrix laid out without objects (where the cluster is
 *      one node, its members on one rank for certain), left to right from the
 *      layout with objects (each object together), and units that come to
 *      share a row are moved apart. Without `nest`, nothing changes.
 */
export function layoutHarrisMatrix(nodeIds, rankEdges, sameRankEdges = [], equalsEdges = [], nest = null) {
  // --- Union-Find over same-rank + equals pairs -----------------------
  const parent = new Map(nodeIds.map((id) => [id, id]))
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)))
      x = parent.get(x)
    }
    return x
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const e of sameRankEdges) union(e.source, e.target)
  for (const e of equalsEdges) union(e.source, e.target)

  // --- Group members by cluster root -----------------------------------
  const nested = !!nest?.objectOf?.size
  const rawClusters = new Map() // cluster id -> [memberIds]
  const clusterOf = new Map() // member -> cluster id
  const sameRankParts = [] // [cluster id, cluster id]: parts of one same-rank cluster, in different objects
  const byRoot = new Map()
  for (const id of nodeIds) {
    const root = find(id)
    if (!byRoot.has(root)) byRoot.set(root, [])
    byRoot.get(root).push(id)
  }
  for (const [root, members] of byRoot) {
    const objects = nested ? [...new Set(members.map((m) => nest.objectOf.get(m) ?? null))] : [null]
    if (objects.length === 1) {
      rawClusters.set(root, members)
      for (const m of members) clusterOf.set(m, root)
      continue
    }
    // Members in different objects: one part per object, held on one rank.
    const parts = objects.map((o, i) => {
      const id = `${root} part ${i}`
      const mine = members.filter((m) => (nest.objectOf.get(m) ?? null) === o)
      rawClusters.set(id, mine)
      for (const m of mine) clusterOf.set(m, id)
      return id
    })
    for (let i = 1; i < parts.length; i++) sameRankParts.push([parts[i - 1], parts[i]])
  }

  // Order members within a cluster so "entspricht" partners end up
  // adjacent: walk the equals-subgraph restricted to this cluster's
  // members depth-first, which naturally groups connected members
  // consecutively; anything left over (only zeitgleich-linked, no
  // entspricht partner) is appended in its original order.
  function orderClusterMembers(members) {
    if (members.length <= 1) return members
    const memberSet = new Set(members)
    const adj = new Map(members.map((m) => [m, []]))
    for (const e of equalsEdges) {
      if (memberSet.has(e.source) && memberSet.has(e.target)) {
        adj.get(e.source).push(e.target)
        adj.get(e.target).push(e.source)
      }
    }
    const visited = new Set()
    const order = []
    for (const start of members) {
      if (visited.has(start)) continue
      const stack = [start]
      while (stack.length) {
        const cur = stack.pop()
        if (visited.has(cur)) continue
        visited.add(cur)
        order.push(cur)
        for (const nb of adj.get(cur)) if (!visited.has(nb)) stack.push(nb)
      }
    }
    return order
  }

  const clusterMembers = new Map() // root -> ordered member ids
  const clusterWidth = new Map()   // root -> total pixel width
  for (const [root, members] of rawClusters) {
    const ordered = orderClusterMembers(members)
    clusterMembers.set(root, ordered)
    clusterWidth.set(root, ordered.length * NODE_WIDTH + (ordered.length - 1) * CLUSTER_GAP)
  }

  // --- Collapsed dagre graph: one node per cluster ----------------------
  const g = new dagre.graphlib.Graph(nested ? { compound: true } : undefined)
  g.setGraph({ rankdir: 'BT', nodesep: 24, ranksep: 70, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const [root] of clusterMembers) {
    g.setNode(root, { width: clusterWidth.get(root), height: NODE_HEIGHT })
  }

  // Redirect rank edges through cluster roots; a rank edge whose two ends
  // land in the SAME cluster after collapsing means the source data has a
  // contradiction (e.g. "A über B" alongside "A zeitgleich B") -- drop it
  // here rather than create a self-loop, the contradiction itself is a
  // data-quality issue outside this layout step's job to resolve.
  const collapsedEdges = new Map()
  for (const e of rankEdges) {
    if (find(e.source) === find(e.target)) continue
    const rs = clusterOf.get(e.source)
    const rt = clusterOf.get(e.target)
    if (rs == null || rt == null) continue
    collapsedEdges.set(`${rs}|${rt}`, { source: rs, target: rt })
  }
  for (const e of collapsedEdges.values()) g.setEdge(e.source, e.target)

  const parents = new Map() // cluster id -> 'object' | 'group'
  if (nested) {
    const OBJ = 'obj:'
    const GRP = 'grp:'
    for (const [root, members] of clusterMembers) {
      const object = members.map((m) => nest.objectOf.get(m)).find((o) => o != null)
      if (object == null) continue
      if (!parents.has(OBJ + object)) {
        g.setNode(OBJ + object, {})
        parents.set(OBJ + object, 'object')
        const group = nest.groupOf?.get(object)
        if (group != null) {
          if (!parents.has(GRP + group)) {
            g.setNode(GRP + group, {})
            parents.set(GRP + group, 'group')
          }
          g.setParent(OBJ + object, GRP + group)
        }
      }
      g.setParent(root, OBJ + object)
    }
  }

  dagre.layout(g)

  const boxes = []
  for (const [cid, kind] of parents) {
    const b = g.node(cid)
    if (!b || !Number.isFinite(b.x)) continue
    boxes.push({ id: cid.slice(4), kind, x: b.x - b.width / 2, y: b.y - b.height / 2, w: b.width, h: b.height })
  }

  // --- Expand clusters back into individual node positions --------------
  const positions = {}
  for (const [root, members] of clusterMembers) {
    const gn = g.node(root)
    const totalW = clusterWidth.get(root)
    let curX = gn.x - totalW / 2
    for (const m of members) {
      positions[m] = { x: curX, y: gn.y - NODE_HEIGHT / 2 }
      curX += NODE_WIDTH + CLUSTER_GAP
    }
  }
  for (const id of nodeIds) {
    if (!positions[id]) positions[id] = { x: 0, y: 0 }
  }

  if (nested && sameRankParts.length) {
    const flat = layoutHarrisMatrix(nodeIds, rankEdges, sameRankEdges, equalsEdges, null)
    for (const id of nodeIds) positions[id] = { x: positions[id].x, y: flat.positions[id].y }
    const rows = new Map()
    for (const id of nodeIds) {
      const k = Math.round(positions[id].y)
      if (!rows.has(k)) rows.set(k, [])
      rows.get(k).push(id)
    }
    for (const ids of rows.values()) {
      ids.sort((a, b) => positions[a].x - positions[b].x)
      for (let i = 1; i < ids.length; i++) {
        const min = positions[ids[i - 1]].x + NODE_WIDTH + CLUSTER_GAP
        if (positions[ids[i]].x < min) positions[ids[i]].x = min
      }
    }
    return { positions, width: NODE_WIDTH, height: NODE_HEIGHT, boxes: boxesAround(positions, nest) }
  }

  return nested
    ? { positions, width: NODE_WIDTH, height: NODE_HEIGHT, boxes }
    : { positions, width: NODE_WIDTH, height: NODE_HEIGHT }
}

/** Frames around the units of each object and the objects of each group, from where the units are. */
function boxesAround(positions, nest) {
  const PAD = 10
  const extent = new Map() // 'object:id' | 'group:id' -> { x0, y0, x1, y1 }
  const grow = (key, x0, y0, x1, y1) => {
    const e = extent.get(key)
    extent.set(key, e ? { x0: Math.min(e.x0, x0), y0: Math.min(e.y0, y0), x1: Math.max(e.x1, x1), y1: Math.max(e.y1, y1) } : { x0, y0, x1, y1 })
  }
  for (const [unit, object] of nest.objectOf) {
    const p = positions[unit]
    if (!p || object == null) continue
    grow(`object:${object}`, p.x - PAD, p.y - PAD, p.x + NODE_WIDTH + PAD, p.y + NODE_HEIGHT + PAD)
  }
  for (const [key, e] of [...extent]) {
    const object = key.slice(7)
    const group = nest.groupOf?.get(object)
    if (group != null) grow(`group:${group}`, e.x0 - PAD, e.y0 - PAD, e.x1 + PAD, e.y1 + PAD)
  }
  return [...extent].map(([key, e]) => {
    const kind = key.startsWith('object:') ? 'object' : 'group'
    return { id: key.slice(kind.length + 1), kind, x: e.x0, y: e.y0, w: e.x1 - e.x0, h: e.y1 - e.y0 }
  })
}
