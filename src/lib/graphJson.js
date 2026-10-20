/**
 * Reading and writing Graph-JSON (docs/graph-json-format.md).
 *
 * Reading is deliberately forgiving, as the contract asks of consumers: missing
 * optional blocks are tolerated, unknown fields ignored, non-string attribute
 * values are not a crash. What is *not* tolerated is a dangling reference —
 * that would show up later as an empty detail view with no explanation.
 */

import { deriveSchema } from './schema'

/**
 * @returns {{graph: object, report: object}}
 * @throws when the file is not Graph-JSON at all
 */
export function readGraphJson(json) {
  if (!json || typeof json !== 'object') throw new Error('not a JSON object')
  if (!json.nodes || typeof json.nodes !== 'object' || Array.isArray(json.nodes)) {
    throw new Error('no "nodes" object — this does not look like Graph-JSON')
  }

  const nodes = {}
  const report = {
    nodes: 0,
    edges: 0,
    dangling: [],
    typeless: 0,
    nonStringAttributes: 0,
    countsDiffered: false,
  }

  for (const [id, raw] of Object.entries(json.nodes)) {
    if (!raw || typeof raw !== 'object') continue
    const node = {
      l: typeof raw.l === 'string' ? raw.l : String(raw.l ?? id),
      t: typeof raw.t === 'string' ? raw.t : '',
      a: {},
      o: {},
      i: {},
    }
    if (!node.t) report.typeless++
    for (const [key, value] of Object.entries(raw.a || {})) {
      if (typeof value !== 'string') report.nonStringAttributes++
      node.a[key] = value
    }
    for (const side of ['o', 'i']) {
      for (const [key, list] of Object.entries(raw[side] || {})) {
        node[side][key] = Array.isArray(list) ? list.slice() : [list]
      }
    }
    nodes[id] = node
    report.nodes++
  }

  for (const [id, node] of Object.entries(nodes)) {
    for (const [side, bag] of [['o', node.o], ['i', node.i]]) {
      for (const [key, list] of Object.entries(bag)) {
        for (const target of list) {
          if (!nodes[target]) report.dangling.push(`${id} ${side}[${key}] -> ${target}`)
        }
        if (side === 'o') report.edges += list.length
      }
    }
  }

  // Recount rather than trust: the contract says a consumer counts for itself.
  const node_types = {}
  const edge_types = {}
  for (const node of Object.values(nodes)) {
    node_types[node.t] = (node_types[node.t] || 0) + 1
    for (const [key, list] of Object.entries(node.o)) {
      edge_types[key] = (edge_types[key] || 0) + list.length
    }
  }
  if (json.node_types && Object.keys(json.node_types).length !== Object.keys(node_types).length) {
    report.countsDiffered = true
  }

  const graph = {
    meta: json.meta || {},
    nodes,
    // Declared counts are kept where given — they are the producer's tally and
    // may legitimately differ from ours (a join deduplicates, a row does not).
    node_types: json.node_types || node_types,
    edge_types: json.edge_types || edge_types,
    schema: {},
  }
  graph.schema = deriveSchema({ ...graph, schema: json.schema })

  return { graph, report }
}

/** Graph-JSON text, ready to write to a file. */
export function writeGraphJson(graph, { pretty = false } = {}) {
  const ordered = {
    meta: graph.meta || {},
    node_types: graph.node_types || {},
    edge_types: graph.edge_types || {},
    schema: graph.schema || {},
    nodes: graph.nodes || {},
    // Present only for a multilingual project — see materialize.js.
    ...(graph.languages ? { languages: graph.languages } : {}),
  }
  return JSON.stringify(ordered, null, pretty ? 2 : 0)
}

/**
 * What a graph offers a data-entry tool when no project file came with it.
 *
 * The mapping is gone, so this is the best reconstruction available: which
 * types exist, which attribute keys and which relations each type actually
 * carries. Enough to list and inspect; not enough to write a faithful project
 * file, because the target table and column of every field are unknown.
 */
export function deriveModelFromGraph(graph) {
  const types = new Map()

  for (const [id, node] of Object.entries(graph.nodes)) {
    let entry = types.get(node.t)
    if (!entry) {
      entry = {
        typeKey: node.t,
        label: graph.schema.typeLabels?.[node.t] || node.t,
        color: graph.schema.typeColors?.[node.t] || '',
        count: 0,
        attributes: new Map(),
        outgoing: new Map(),
        incoming: new Map(),
        sampleId: id,
      }
      types.set(node.t, entry)
    }
    entry.count++
    for (const key of Object.keys(node.a)) entry.attributes.set(key, (entry.attributes.get(key) || 0) + 1)
    for (const [side, bag] of [['outgoing', node.o], ['incoming', node.i]]) {
      for (const [key, list] of Object.entries(bag)) {
        let rel = entry[side].get(key)
        if (!rel) entry[side].set(key, (rel = { key, count: 0, targetTypes: new Set() }))
        rel.count += list.length
        for (const target of list) {
          const t = graph.nodes[target]?.t
          if (t) rel.targetTypes.add(t)
        }
      }
    }
  }

  return {
    source: 'graph',
    types: [...types.values()]
      .map((t) => ({
        ...t,
        attributes: [...t.attributes.entries()]
          .map(([key, count]) => ({ key, count, coverage: count / t.count }))
          .sort((a, b) => b.count - a.count),
        outgoing: [...t.outgoing.values()].map((r) => ({ ...r, targetTypes: [...r.targetTypes] })),
        incoming: [...t.incoming.values()].map((r) => ({ ...r, targetTypes: [...r.targetTypes] })),
      }))
      .sort((a, b) => b.count - a.count),
    // Stated plainly so the export screen can grey out what it cannot deliver.
    canWriteProjectFile: false,
    canWriteFaithfulRdf: false,
  }
}
