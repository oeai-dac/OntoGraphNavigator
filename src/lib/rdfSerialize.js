/**
 * Quads -> TriG or Turtle text.
 *
 * `toQuads` produces plain objects so the export logic stays testable without a
 * parser; this module is the only place that touches N3.
 *
 * Named graphs survive in TriG and N-Quads only. Turtle, N-Triples and N3 have
 * no graph context, so everything is merged into one graph — the same loss the
 * Studio takes, and the reason the format picker warns about it.
 */

import N3 from 'n3'
import { DEFAULT_GRAPH } from './rdfExport'

const { DataFactory } = N3
const { namedNode, literal, defaultGraph } = DataFactory

export const RDF_FORMATS = {
  trig: { label: 'TriG', extension: 'trig', mime: 'application/trig', graphs: true, star: true },
  turtle: { label: 'Turtle', extension: 'ttl', mime: 'text/turtle', graphs: false, star: true },
  nquads: { label: 'N-Quads', extension: 'nq', mime: 'application/n-quads', graphs: true, star: true },
  ntriples: { label: 'N-Triples', extension: 'nt', mime: 'application/n-triples', graphs: false, star: true },
}

function toTerm(object) {
  if (object.type === 'uri') return namedNode(object.value)
  if (object.language) return literal(object.value, object.language)
  return literal(object.value, namedNode(object.datatype))
}

/** A term as it is written inside a hand-built RDF-star line. */
function writeTerm(term) {
  if (typeof term === 'string') return `<${term}>`
  if (term.type === 'uri') return `<${term.value}>`
  const escaped = term.value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"${term.language ? `@${term.language}` : `^^<${term.datatype}>`}`
}

/**
 * The RDF-star annotations, written by hand.
 *
 * N3's writer serialises a quoted triple in the RDF 1.2 triple-term form, which
 * its own parser then refuses in subject position. Rather than pin both sides to
 * a moving specification, the annotation block is emitted directly — in the same
 * shape and the same place the Studio's export puts it.
 */
function writeAnnotations(annotations, withGraphs) {
  if (!annotations.length) return ''
  const line = (a) =>
    `  << ${writeTerm(a.subject.subject)} ${writeTerm(a.subject.predicate)} ${writeTerm(a.subject.object)} >> ` +
    `${writeTerm(a.predicate)} ${writeTerm(a.object)} .`

  if (!withGraphs) {
    return '\n' + annotations.map((a) => line(a).trimStart()).join('\n') + '\n'
  }

  const byGraph = new Map()
  for (const a of annotations) {
    const g = a.graph || DEFAULT_GRAPH
    if (!byGraph.has(g)) byGraph.set(g, [])
    byGraph.get(g).push(a)
  }
  let out = ''
  for (const [graph, list] of byGraph) {
    out += `\n# RDF-star annotations for graph ${graph}\n<${graph}> {\n${list.map(line).join('\n')}\n}\n`
  }
  return out
}

/**
 * @param {Array}  quads      from toQuads()
 * @param {object} options
 * @param {string} [options.format='trig']
 * @param {object} [options.prefixes]  prefix -> namespace
 * @returns {Promise<string>}
 */
export function serializeRdf(quads, options = {}) {
  const formatKey = options.format || 'trig'
  const spec = RDF_FORMATS[formatKey]
  if (!spec) throw new Error(`unknown RDF format: ${formatKey}`)

  const isAnnotation = (q) => typeof q.subject !== 'string'
  const plain = quads.filter((q) => !isAnnotation(q))
  const annotations = quads.filter(isAnnotation)

  const writer = new N3.Writer({
    format: formatKey === 'nquads' ? 'N-Quads' : formatKey === 'ntriples' ? 'N-Triples' : spec.graphs ? 'TriG' : 'Turtle',
    prefixes: formatKey === 'nquads' || formatKey === 'ntriples' ? {} : options.prefixes || {},
  })

  for (const q of plain) {
    const graph = spec.graphs && q.graph ? namedNode(q.graph) : defaultGraph()
    writer.addQuad(namedNode(q.subject), namedNode(q.predicate), toTerm(q.object), graph)
  }

  return new Promise((resolve, reject) => {
    writer.end((error, result) => {
      if (error) reject(error)
      else resolve(result + writeAnnotations(annotations, spec.graphs))
    })
  })
}

/** Parse any RDF text this tool accepts. Throws with a readable message. */
export function parseRdf(text, { format = 'application/trig-star' } = {}) {
  try {
    return new N3.Parser({ format }).parse(text)
  } catch (error) {
    throw new Error(`RDF could not be parsed: ${error.message}`)
  }
}
