/**
 * RDF  ->  Graph-JSON, entirely in the browser.
 *
 * The way in when no project file exists. Mirrors the GraphExplorer's own
 * importer so the same file yields the same graph in both applications.
 *
 * What cannot be recovered without the ontology, and is not guessed:
 *   - incoming edges keep the forward property name; there is no `owl:inverseOf`
 *     to rename them with
 *   - colours come from the neutral palette, not from CIDOC anchor classes
 *   - named graphs are flattened
 *
 * RDF/XML is not accepted — N3.js cannot parse it. Convert to Turtle first.
 */

import { canonicalDot1, dot1Key, oppositeDot1 } from './keys'
import { localName } from './prefixes'
import { deriveSchema } from './schema'
import { parseRdf } from './rdfSerialize'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const RDF_REIFIES = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies'

/** Predicates treated as a display label, best first. */
const LABEL_PREDICATES = [
  'http://www.w3.org/2000/01/rdf-schema#label',
  'http://www.w3.org/2004/02/skos/core#prefLabel',
  'http://purl.org/dc/terms/title',
  'http://purl.org/dc/elements/1.1/title',
  'http://xmlns.com/foaf/0.1/name',
  'http://schema.org/name',
  'https://schema.org/name',
  'http://www.w3.org/2004/02/skos/core#altLabel',
]
const LABEL_RANK = new Map(LABEL_PREDICATES.map((p, i) => [p, i]))

/** German first, then untagged, then anything — as the sister tools do. */
function languageRank(language) {
  if (language === 'de') return 0
  if (!language) return 1
  if (language === 'en') return 2
  return 3
}

export function importRdf(text, options = {}) {
  const quads = parseRdf(text, options)
  return quadsToGraph(quads, options)
}

export function quadsToGraph(quads, options = {}) {
  const nodes = new Map()
  const report = { quads: quads.length, dot1: 0, namedGraphs: new Set(), skipped: 0 }

  const node = (id) => {
    let n = nodes.get(id)
    if (!n) nodes.set(id, (n = { l: '', t: '', a: {}, o: {}, i: {}, _label: null }))
    return n
  }
  const push = (bag, key, value) => {
    let list = bag[key]
    if (!list) bag[key] = list = []
    if (!list.includes(value)) list.push(value)
  }

  // Blank nodes standing for a reified statement, when the parser produced the
  // RDF 1.2 shape instead of a quoted triple.
  const reified = new Map()
  for (const q of quads) {
    if (q.predicate.value === RDF_REIFIES && q.object.termType === 'Quad') reified.set(q.subject.value, q.object)
  }

  const annotations = [] // [{ statement, predicate, object }]
  const plain = []

  for (const q of quads) {
    if (q.graph?.value) report.namedGraphs.add(q.graph.value)
    if (q.predicate.value === RDF_REIFIES) continue
    if (q.subject.termType === 'Quad') {
      annotations.push({ statement: q.subject, object: q.object })
      continue
    }
    const statement = reified.get(q.subject.value)
    if (statement) {
      annotations.push({ statement, object: q.object })
      continue
    }
    if (q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode') {
      report.skipped++
      continue
    }
    plain.push(q)
  }

  // ---- plain statements ----------------------------------------------------
  const attributeKeys = new Map() // predicate -> chosen attribute key
  const usedKeys = new Set()
  const attributeKeyFor = (predicate) => {
    let key = attributeKeys.get(predicate)
    if (key) return key
    const base = localName(predicate)
    key = base
    let n = 2
    while (usedKeys.has(key)) key = `${base}#${n++}`
    usedKeys.add(key)
    attributeKeys.set(predicate, key)
    return key
  }

  for (const q of plain) {
    const subject = q.subject.value
    const n = node(subject)

    if (q.predicate.value === RDF_TYPE) {
      if (!n.t) n.t = q.object.value
      continue
    }

    if (q.object.termType === 'Literal') {
      const rank = LABEL_RANK.get(q.predicate.value)
      if (rank !== undefined) {
        const candidate = { rank, language: languageRank(q.object.language), value: q.object.value }
        if (
          !n._label ||
          candidate.rank < n._label.rank ||
          (candidate.rank === n._label.rank && candidate.language < n._label.language)
        ) {
          n._label = candidate
          n.l = q.object.value
        }
        continue
      }
      const key = attributeKeyFor(q.predicate.value)
      n.a[key] = n.a[key] === undefined ? q.object.value : `${n.a[key]}; ${q.object.value}`
      continue
    }

    // Resource object: an edge, materialised on both sides.
    push(n.o, q.predicate.value, q.object.value)
    push(node(q.object.value).i, q.predicate.value, subject)
  }

  // ---- annotated statements become stratigraphy ----------------------------
  for (const { statement, object } of annotations) {
    const source = statement.subject.value
    const target = statement.object.value
    const property = statement.predicate.value
    // The annotation value is a resource in the Studio's export and in HME's;
    // its label reads better than its identifier, so prefer it when present.
    const valueNode = nodes.get(object.value)
    const raw = object.termType === 'Literal' ? object.value : valueNode?.l || localName(object.value)
    const value = canonicalDot1(raw)
    if (!value) continue

    const key = dot1Key(property, value)
    push(node(source).o, key, target)
    report.dot1++

    // The reverse reading, as in the Studio's Graph-JSON. Without it the same
    // data would look different depending on which file was opened.
    const opposite = oppositeDot1(value)
    if (opposite !== null) push(node(target).o, dot1Key(property, opposite), source)

    // The plain triple is in the data too; drop it so the relation is not shown
    // twice, once typed and once bare.
    const bag = node(source).o[property]
    if (bag) {
      const at = bag.indexOf(target)
      if (at >= 0) bag.splice(at, 1)
      if (!bag.length) delete node(source).o[property]
    }
    const back = node(target).i[property]
    if (back) {
      const at = back.indexOf(source)
      if (at >= 0) back.splice(at, 1)
      if (!back.length) delete node(target).i[property]
    }
  }

  // ---- assemble ------------------------------------------------------------
  const graphNodes = {}
  for (const [id, n] of nodes) {
    delete n._label
    if (!n.l) n.l = localName(id) || id
    graphNodes[id] = n
  }

  const node_types = {}
  const edge_types = {}
  for (const n of Object.values(graphNodes)) {
    node_types[n.t] = (node_types[n.t] || 0) + 1
    for (const [key, list] of Object.entries(n.o)) edge_types[key] = (edge_types[key] || 0) + list.length
  }

  const graph = {
    meta: {
      title: options.title || 'RDF import',
      node_count: Object.keys(graphNodes).length,
      edge_count: Object.values(edge_types).reduce((a, b) => a + b, 0),
      generated_by: 'OntoGraphNavigator',
    },
    nodes: graphNodes,
    node_types,
    edge_types,
    schema: {},
  }
  graph.schema = deriveSchema(graph)

  report.namedGraphs = [...report.namedGraphs]
  return { graph, report }
}
