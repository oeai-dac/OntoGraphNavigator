/**
 * Tables + mapping  ->  RDF quads (TriG / Turtle, with RDF-star).
 *
 * The second thing the Studio's backend does, and the one the Graph-JSON cannot
 * reproduce on its own: here the *property URI* of every folded literal
 * survives — `crm:P3_has_note`, not the display key "Befundbeschreibung".
 *
 * Three rules were read off the reference export and would not be guessed:
 *
 *  1. A triple lands in the named graph of the mapping node that is the
 *     *source* of the edge being written — not the graph of its own subject.
 *  2. Because of that, type and label triples are repeated in every graph that
 *     reaches the node. SE 2001 carries `a A8_Stratigraphic_Unit` in both
 *     `oeai:SE` (its own relations) and `oeai:Grabung` (the Sondage pointing at
 *     it). That is duplication in the data, not in this code.
 *  3. A literal-class mapping node only becomes a literal when it is in literal
 *     mode. `Anmerkung Fund` is not, so its 491 notes are resources carrying the
 *     text as a label, while the 61 `Befundbeschreibung` notes are strings.
 */

import { expandId, expandTerm } from './prefixes'
import { languagesOf } from './languages'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label'
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string'
const WKT_LITERAL = 'http://www.opengis.net/ont/geosparql#wktLiteral'
const RDFS_LITERAL = 'http://www.w3.org/2000/01/rdf-schema#Literal'

/** Triples of mapping nodes that belong to no named graph. */
export const DEFAULT_GRAPH = 'urn:x-default:graph'

/*
 * Labels carry the language they are written in: the plain label column the
 * project's primary language, `labelColumnI18n` the others — as the Studio
 * writes them since 3.1. Before, the Studio tagged every label @en whatever
 * its language, and so did this file; the reference TriG in _session/ still
 * shows it (tests/run-rdf-check.mjs pins that language to compare against it).
 */

function cell(row, column) {
  if (!column) return ''
  const v = row?.[column]
  return v === null || v === undefined ? '' : String(v).trim()
}

function literalValue(row, column) {
  if (!column) return ''
  const v = row?.[column]
  if (v === null || v === undefined) return ''
  return String(v).replace(/[\r\n\t]+/g, ' ').trim()
}

/** Datatype for a literal produced by a mapping node of this class. */
export function datatypeFor(classUri) {
  if (!classUri) return XSD_STRING
  if (classUri === RDFS_LITERAL || classUri === 'rdfs:Literal') return XSD_STRING
  if (classUri === WKT_LITERAL || classUri === 'geo:wktLiteral') return WKT_LITERAL
  if (classUri.startsWith('http://www.w3.org/2001/XMLSchema#')) return classUri
  if (classUri.startsWith('xsd:')) return `http://www.w3.org/2001/XMLSchema#${classUri.slice(4)}`
  return XSD_STRING
}

/** mapping node id -> named graph URI */
function graphIndex(model) {
  const index = new Map()
  for (const ng of model.namedGraphs || []) {
    const uri = expandTerm(ng.label, model.prefixMap) || ng.label
    for (const nodeId of ng.nodeIds || []) index.set(nodeId, uri)
  }
  return index
}

function pairRows(model, sourceTableId, targetTableId, joinSource, joinTarget) {
  const src = model.tables.get(sourceTableId)
  const tgt = model.tables.get(targetTableId)
  if (!src || !tgt) return []
  if (joinSource && joinTarget) {
    const index = new Map()
    for (const row of tgt.rows) {
      const key = cell(row, joinTarget)
      if (!key) continue
      let bucket = index.get(key)
      if (!bucket) index.set(key, (bucket = []))
      bucket.push(row)
    }
    const pairs = []
    for (const srcRow of src.rows) {
      const key = cell(srcRow, joinSource)
      const bucket = key && index.get(key)
      if (!bucket) continue
      for (const tgtRow of bucket) pairs.push([srcRow, tgtRow])
    }
    return pairs
  }
  if (sourceTableId === targetTableId) return src.rows.map((row) => [row, row])
  return []
}

function instanceOf(entity, row, model, langs) {
  const raw = cell(row, entity.idColumn)
  if (!raw) return null
  const id = expandId(raw, model.prefixMap, model.idPrefix, entity.noPrefix)
  if (!id) return null
  // No label column means no `rdfs:label` at all — unlike the Graph-JSON, which
  // falls back to the identifier so a list has something to show. Writing that
  // fallback into RDF would invent 3278 labels that merely repeat the URI.
  const label = entity.labelColumn ? cell(row, entity.labelColumn) : ''
  const labelI18n = []
  for (const lang of langs) {
    const text = cell(row, entity.labelColumnI18n?.[lang])
    if (text) labelI18n.push([lang, text])
  }
  return { id, label, labelI18n }
}

/**
 * @returns {{quads: Array, diagnostics: object}} quads as plain objects:
 *   { subject, predicate, object, graph }  where object is
 *   { type: 'uri', value } | { type: 'literal', value, datatype?, language? }
 *   and subject may be { type: 'triple', subject, predicate, object } for
 *   RDF-star annotations.
 */
export function toQuads(model, options = {}) {
  const overrides = options.overrides || {}
  const entity = (nodeId) => {
    const base = model.entities.get(nodeId)
    if (!base) return null
    const patch = overrides[nodeId]
    return patch ? { ...base, ...patch } : base
  }

  const graphs = graphIndex(model)
  const graphOf = (nodeId) => graphs.get(nodeId) || DEFAULT_GRAPH

  const seen = new Set()
  const quads = []
  const diagnostics = { skippedRelations: 0, skippedLiterals: 0 }

  function emit(subject, predicate, object, graph) {
    const key =
      (subject.type === 'triple'
        ? `<<${subject.subject}|${subject.predicate}|${subject.object}>>`
        : subject) +
      `|${predicate}|${object.type}|${object.value}|${object.datatype || ''}|${object.language || ''}|${graph}`
    if (seen.has(key)) return
    seen.add(key)
    quads.push({ subject, predicate, object, graph })
  }

  const uri = (value) => ({ type: 'uri', value })
  const { primary, additional: langs } = languagesOf(model)
  const labelLiteral = (value, language) => ({ type: 'literal', value, ...(language ? { language } : {}) })

  /** Type and labels of a node, written into the graph of the edge being processed. */
  function describe(ent, inst, graph) {
    emit(inst.id, RDF_TYPE, uri(ent.classUri), graph)
    if (inst.label) emit(inst.id, RDFS_LABEL, labelLiteral(inst.label, primary), graph)
    for (const [lang, text] of inst.labelI18n) emit(inst.id, RDFS_LABEL, labelLiteral(text, lang), graph)
  }

  // ---- relations between real nodes ---------------------------------------
  for (const rel of model.relations) {
    const source = entity(rel.source)
    const target = entity(rel.target)
    if (!source || !target) {
      diagnostics.skippedRelations++
      continue
    }
    const graph = graphOf(rel.source)
    for (const [srcRow, tgtRow] of pairRows(model, source.tableId, target.tableId, rel.joinSource, rel.joinTarget)) {
      const s = instanceOf(source, srcRow, model, langs)
      const t = instanceOf(target, tgtRow, model, langs)
      if (!s || !t) continue
      describe(source, s, graph)
      describe(target, t, graph)
      emit(s.id, rel.propertyUri, uri(t.id), graph)
    }
  }

  // ---- stratigraphy: the plain triple plus its RDF-star annotation ----------
  for (const rel of model.dot1Relations) {
    const source = entity(rel.source)
    const target = entity(rel.target)
    if (!source || !target) continue
    const graph = graphOf(rel.source)
    const valueNode = entity(rel.valueNodeId)
    for (const [srcRow, tgtRow] of pairRows(model, source.tableId, target.tableId, rel.joinSource, rel.joinTarget)) {
      const s = instanceOf(source, srcRow, model, langs)
      const t = instanceOf(target, tgtRow, model, langs)
      if (!s || !t) continue
      const valueRow = rel.valueTableId === source.tableId ? srcRow : tgtRow
      const rawValue = cell(valueRow, rel.valueColumn)
      if (!rawValue) continue
      const valueUri = expandId(rawValue, model.prefixMap, model.idPrefix, valueNode?.noPrefix)

      describe(source, s, graph)
      describe(target, t, graph)
      emit(s.id, rel.propertyUri, uri(t.id), graph)
      emit(
        { type: 'triple', subject: s.id, predicate: rel.propertyUri, object: t.id },
        rel.dotOnePropertyUri,
        uri(valueUri),
        graph
      )
    }
  }

  // ---- literals ------------------------------------------------------------
  for (const le of model.literalEdges) {
    const source = entity(le.source)
    const lit = model.literals.get(le.literalNodeId)
    if (!source || !lit) {
      diagnostics.skippedLiterals++
      continue
    }
    const graph = graphOf(le.source)
    for (const [srcRow, litRow] of pairRows(model, source.tableId, lit.tableId, le.joinSource, le.joinTarget)) {
      const s = instanceOf(source, srcRow, model, langs)
      if (!s) continue
      const text = literalValue(litRow, lit.valueColumn)

      if (lit.noPrefix) {
        if (!text) continue
        describe(source, s, graph)
        emit(s.id, le.propertyUri, { type: 'literal', value: text, datatype: datatypeFor(lit.classUri) }, graph)
      } else {
        // Not in literal mode: the note becomes a resource of its own, and the
        // text rides along as its label.
        const raw = cell(litRow, lit.idColumn || lit.valueColumn)
        const objectId = raw && expandId(raw, model.prefixMap, model.idPrefix, false)
        if (!objectId) continue
        describe(source, s, graph)
        emit(s.id, le.propertyUri, uri(objectId), graph)
        // The note resource is typed like any other node — `a rdfs:Literal` —
        // and carries its text as the label.
        emit(objectId, RDF_TYPE, uri(lit.classUri), graph)
        if (text) emit(objectId, RDFS_LABEL, labelLiteral(text, primary), graph)
      }
    }
  }

  return { quads, diagnostics }
}
