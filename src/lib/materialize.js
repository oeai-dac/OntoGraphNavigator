/**
 * Tables + mapping  ->  Graph-JSON (docs/graph-json-format.md).
 *
 * This is a re-implementation of what OntoCartographer Studio's backend does in
 * `/pipeline/graph-explorer-json`. It is verified against a real Studio export
 * by tests/run-materialize-check.mjs — that test is the reason this file may be
 * trusted at all, since the format contract carries no version field.
 *
 * The one rule that is easy to get wrong, and that the reference data forced:
 *
 *   EMISSION IS EDGE-DRIVEN, NOT NODE-DRIVEN.
 *
 * A mapped node does not produce an instance for every row where its id column
 * is filled. It produces one only where a relation actually pairs it with a
 * partner. In the reference project, `Datierung_ID` holds both `X_ProdDate`
 * (872) and `X_GenesisDate` (32) values in a single column, and two mapping
 * nodes read that same column. Only the edges tell them apart: the production
 * date hangs off the human-made finds, the genesis date off the organic ones.
 * Emitting per node would merge them into one type of 904 nodes; emitting per
 * edge yields the 872 + 32 the Studio produced.
 */

import { expandId, localName } from './prefixes'
import { canonicalDot1, dot1DisplayValue, dot1Key, oppositeDot1 } from './keys'
import { isMultilingual, languagesOf } from './languages'

const EMPTY = Object.freeze({})

/** Trimmed — for identifiers, join keys and emptiness tests. */
function cell(row, column) {
  if (!column) return ''
  const v = row?.[column]
  return v === null || v === undefined ? '' : String(v).trim()
}

/**
 * Attribute values, normalised the way the Studio's pipeline normalises them.
 *
 * Line breaks and tabs collapse to a single space, then the result is trimmed.
 * The reason for the first step is the TSV stage between mapping and export: a
 * newline inside a find description would tear the row apart, so it is replaced
 * on the way through. `\r\n` becomes one space, not two — exactly the
 * three-character difference measured on SE 2001's description. The trim then
 * removes what a *trailing* newline left behind, which is how SE 2007 and
 * SE 2009 end one character shorter in the reference than a bare replace gives.
 */
function cellValue(row, column) {
  if (!column) return ''
  const v = row?.[column]
  if (v === null || v === undefined) return ''
  return String(v).replace(/[\r\n\t]+/g, ' ').trim()
}

/**
 * A key hit more than once keeps every distinct value, joined by "; ".
 *
 * The separator is not a taste decision — it is what the Studio writes, read off
 * the reference export where a production date carries "69; -28".
 */
export const MULTI_VALUE_SEPARATOR = '; '

function mergeValues(existing, next) {
  if (existing === undefined) return next
  if (existing === next) return existing
  const parts = String(existing).split(MULTI_VALUE_SEPARATOR)
  if (parts.includes(next)) return existing
  return `${existing}${MULTI_VALUE_SEPARATOR}${next}`
}

/*
 * INCREMENTAL BY CONSTRUCTION
 *
 * Every statement the materialisation makes comes from one mapping rule applied
 * to one pair of rows — a *contribution*. A contribution depends on nothing but
 * its rule and its two rows, so when a row changes, only the contributions that
 * row takes part in can change, and only the nodes those contributions name.
 *
 * A node is then rebuilt from its contributions alone, in the order a full run
 * would have met them: rule, then source row, then target row. That order is
 * not cosmetic. First writer wins for type and label, `o`/`i` lists keep their
 * order, and multi-valued attributes join in the order they were read — so the
 * order is what makes an incrementally maintained graph equal to a fresh one.
 * tests/run-incremental-check.mjs holds the two against each other.
 *
 * The full run is the same code: generate every contribution in that order,
 * then build each node from its list. There is no second path that could drift.
 *
 * The contribution index doubles as the provenance index — which rows a node
 * comes from, and which nodes a row produces. Editing in a view needs exactly
 * that to turn "this node, this field" back into a table cell.
 */

const REL = 0
const DOT1 = 1
const LIT = 2

/**
 * Identifier and display label for one mapping node in one row, and the label
 * in each further language that has a column and a value (`null` when none).
 */
function instanceOf(entity, row, model, langs) {
  const raw = cell(row, entity.idColumn)
  if (!raw) return null
  const id = expandId(raw, model.prefixMap, model.idPrefix, entity.noPrefix)
  if (!id) return null
  const label = entity.labelColumn ? cell(row, entity.labelColumn) || raw : raw
  let labelI18n = null
  for (const lang of langs) {
    const text = cell(row, entity.labelColumnI18n?.[lang])
    if (text) (labelI18n ||= {})[lang] = text
  }
  return { id, label, labelI18n }
}

/**
 * The mapping, flattened into rules in the order a full run applies them:
 * relations, then dot-one stratigraphy, then folded literals.
 *
 * How a rule pairs rows — the three cases, in the order the Studio resolves them:
 *   join columns given  -> equi-join on those columns (multi-valued: more rows, never a product)
 *   same table          -> row-wise zip; the row *is* the pairing
 *   otherwise           -> not pairable; reported rather than silently dropped
 *
 * `joined` decides how an edge is counted: a join deduplicates on the
 * domain/range pair, a row-wise zip does not. Ten rows naming the same two
 * campaigns are ten edges in `edge_types`; 786 joined rows resolving to 48
 * distinct pairs are 48.
 */
function compileRules(model, entity, diagnostics) {
  const rules = []
  const add = (rule) => {
    const src = model.tables.get(rule.srcTable)
    const tgt = model.tables.get(rule.tgtTable)
    if (!src || !tgt) return
    if (rule.joinSource && rule.joinTarget) rule.joined = true
    else if (rule.srcTable === rule.tgtTable) rule.joined = false
    else {
      diagnostics.unpairable.push(rule.label)
      return
    }
    rule.g = rules.length
    rules.push(rule)
  }

  for (const rel of model.relations) {
    const source = entity(rel.source)
    const target = entity(rel.target)
    if (!source || !target) {
      diagnostics.danglingRelations++
      continue
    }
    add({
      kind: REL, rel, source, target, srcTable: source.tableId, tgtTable: target.tableId,
      joinSource: rel.joinSource, joinTarget: rel.joinTarget, label: rel.edgeKey,
    })
  }
  // No inverse is written for dot-one edges: every reverse-less edge in the
  // reference export is a dot-one edge, and the Harris matrix reads direction
  // from the layout anyway.
  for (const rel of model.dot1Relations) {
    const source = entity(rel.source)
    const target = entity(rel.target)
    if (!source || !target) {
      diagnostics.danglingRelations++
      continue
    }
    add({
      kind: DOT1, rel, source, target, srcTable: source.tableId, tgtTable: target.tableId,
      joinSource: rel.joinSource, joinTarget: rel.joinTarget, label: rel.propertyUri,
    })
  }
  for (const le of model.literalEdges) {
    const source = entity(le.source)
    const lit = model.literals.get(le.literalNodeId)
    if (!source || !lit) continue
    add({
      kind: LIT, rel: le, source, lit, srcTable: source.tableId, tgtTable: lit.tableId,
      joinSource: le.joinSource, joinTarget: le.joinTarget, label: le.attrKey,
    })
  }
  return rules
}

/** The columns of each table whose value any rule reads. Edits elsewhere change nothing. */
function readColumns(rules) {
  const byTable = new Map()
  const note = (table, column) => {
    if (!column) return
    let set = byTable.get(table)
    if (!set) byTable.set(table, (set = new Set()))
    set.add(column)
  }
  for (const r of rules) {
    note(r.srcTable, r.source.idColumn)
    note(r.srcTable, r.source.labelColumn)
    for (const c of Object.values(r.source.labelColumnI18n || {})) note(r.srcTable, c)
    if (r.joined) {
      note(r.srcTable, r.joinSource)
      note(r.tgtTable, r.joinTarget)
    }
    if (r.kind === LIT) note(r.tgtTable, r.lit.valueColumn)
    else {
      note(r.tgtTable, r.target.idColumn)
      note(r.tgtTable, r.target.labelColumn)
      for (const c of Object.values(r.target.labelColumnI18n || {})) note(r.tgtTable, c)
    }
    if (r.kind === DOT1) note(r.rel.valueTableId, r.rel.valueColumn)
  }
  return byTable
}

/**
 * Turn the change notifications from the write layer into a graph.
 *
 * @param {object} model  from readProjectFile
 * @param {object} [options]
 * @param {object} [options.overrides]  mapping node id -> partial entity, for
 *        pinning a field the loaded project file states differently. Used by the
 *        fixture test to work around a known drift between the two sample files.
 */
export function createMaterializer(model, options = {}) {
  const overrides = options.overrides || EMPTY
  const entity = (nodeId) => {
    const base = model.entities.get(nodeId)
    if (!base) return null
    const patch = overrides[nodeId]
    return patch ? { ...base, ...patch } : base
  }

  const staticDiagnostics = { unpairable: [], danglingRelations: 0 }
  // The further languages, fixed for the materializer's life: a change of
  // languages is a change of mapping, and builds a new one.
  const languages = languagesOf(model)
  const langs = languages.additional
  const rules = compileRules(model, entity, staticDiagnostics)
  const columnsRead = readColumns(rules)
  const rulesByTable = new Map()
  for (const r of rules) {
    for (const t of new Set([r.srcTable, r.tgtTable])) {
      if (!rulesByTable.has(t)) rulesByTable.set(t, [])
      rulesByTable.get(t).push(r)
    }
  }

  // ---- row order --------------------------------------------------------
  // A row's place in its table, as a number that survives deletions. New rows
  // are appended, which is also where the write layer puts them.
  const seq = new WeakMap()
  const nextSeq = new Map()
  for (const [id, table] of model.tables) {
    table.rows.forEach((row, i) => seq.set(row, i))
    nextSeq.set(id, table.rows.length)
  }

  // ---- join indexes ---------------------------------------------------------
  // One per (table, column) a join reads, on both sides — the source side is
  // what finds the partners of a changed target row. Buckets stay in row order.
  const indexes = new Map() // "table\0column" -> { table, column, buckets, keyOf }
  const indexFor = (table, column) => indexes.get(`${table}\u0000${column}`)
  for (const r of rules) {
    if (!r.joined) continue
    for (const [table, column] of [[r.srcTable, r.joinSource], [r.tgtTable, r.joinTarget]]) {
      const k = `${table}\u0000${column}`
      if (indexes.has(k)) continue
      const index = { table, column, buckets: new Map(), keyOf: new Map() }
      for (const row of model.tables.get(table).rows) indexInsert(index, row, false)
      indexes.set(k, index)
    }
  }
  const indexesByTable = new Map()
  for (const index of indexes.values()) {
    if (!indexesByTable.has(index.table)) indexesByTable.set(index.table, [])
    indexesByTable.get(index.table).push(index)
  }

  function indexInsert(index, row, ordered) {
    const key = cell(row, index.column)
    if (!key) return
    index.keyOf.set(row, key)
    let bucket = index.buckets.get(key)
    if (!bucket) index.buckets.set(key, (bucket = []))
    if (!ordered || !bucket.length || seq.get(bucket[bucket.length - 1]) < seq.get(row)) {
      bucket.push(row)
      return
    }
    const s = seq.get(row)
    let lo = 0
    let hi = bucket.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (seq.get(bucket[mid]) < s) lo = mid + 1
      else hi = mid
    }
    bucket.splice(lo, 0, row)
  }

  function indexRemove(index, row) {
    const key = index.keyOf.get(row)
    if (key === undefined) return
    index.keyOf.delete(row)
    const bucket = index.buckets.get(key)
    const at = bucket.indexOf(row)
    if (at >= 0) bucket.splice(at, 1)
    if (!bucket.length) index.buckets.delete(key)
  }

  // ---- contributions -------------------------------------------------------
  const byRow = new Map() // row -> Set of contributions
  const byNode = new Map() // node id -> Set of contributions, in the order met
  const dot1Values = new Map() // dot-one key -> { value, count }
  const unmirrored = new Map() // value -> count
  let dirty = new Set()

  /** What one rule says about one pair of rows, or null when it says nothing. */
  function contribution(rule, srcRow, tgtRow) {
    const s = instanceOf(rule.source, srcRow, model, langs)
    if (!s) return null
    if (rule.kind === LIT) {
      const value = cellValue(tgtRow, rule.lit.valueColumn)
      if (!value.trim()) return null
      return { rule, src: srcRow, tgt: tgtRow, sId: s.id, sLabel: s.label, sLabelI18n: s.labelI18n, tId: null, value }
    }
    const t = instanceOf(rule.target, tgtRow, model, langs)
    if (!t) return null
    const c = {
      rule, src: srcRow, tgt: tgtRow,
      sId: s.id, sLabel: s.label, sLabelI18n: s.labelI18n,
      tId: t.id, tLabel: t.label, tLabelI18n: t.labelI18n,
    }
    if (rule.kind === DOT1) {
      const valueRow = rule.rel.valueTableId === rule.source.tableId ? srcRow : tgtRow
      const value = canonicalDot1(cell(valueRow, rule.rel.valueColumn))
      if (!value) return null
      c.value = value
      c.fwd = dot1Key(rule.rel.propertyUri, value)
      const opposite = oppositeDot1(value)
      c.opposite = opposite
      c.rev = opposite === null ? null : dot1Key(rule.rel.propertyUri, opposite)
    }
    return c
  }

  const addTo = (map, key, c) => {
    let set = map.get(key)
    if (!set) map.set(key, (set = new Set()))
    set.add(c)
  }
  const removeFrom = (map, key, c) => {
    const set = map.get(key)
    if (!set) return
    set.delete(c)
    if (!set.size) map.delete(key)
  }
  const countUp = (map, key, value) => {
    const e = map.get(key)
    if (e) e.count++
    else map.set(key, { value, count: 1 })
  }
  const countDown = (map, key) => {
    const e = map.get(key)
    if (e && --e.count === 0) map.delete(key)
  }

  function register(c) {
    addTo(byRow, c.src, c)
    if (c.tgt !== c.src) addTo(byRow, c.tgt, c)
    addTo(byNode, c.sId, c)
    dirty.add(c.sId)
    if (c.tId !== null) {
      addTo(byNode, c.tId, c)
      dirty.add(c.tId)
    }
    if (c.fwd) {
      countUp(dot1Values, c.fwd, c.value)
      if (c.rev) countUp(dot1Values, c.rev, c.opposite)
      else countUp(unmirrored, c.value, c.value)
    }
  }

  function unregister(c) {
    removeFrom(byRow, c.src, c)
    if (c.tgt !== c.src) removeFrom(byRow, c.tgt, c)
    removeFrom(byNode, c.sId, c)
    dirty.add(c.sId)
    if (c.tId !== null) {
      removeFrom(byNode, c.tId, c)
      dirty.add(c.tId)
    }
    if (c.fwd) {
      countDown(dot1Values, c.fwd)
      if (c.rev) countDown(dot1Values, c.rev)
      else countDown(unmirrored, c.value)
    }
  }

  function pair(rule, srcRow, tgtRow) {
    const c = contribution(rule, srcRow, tgtRow)
    if (c) register(c)
  }

  /** Every contribution the row takes part in, on either side of every rule. */
  function generateFor(tableId, row) {
    for (const rule of rulesByTable.get(tableId) || []) {
      if (!rule.joined) {
        pair(rule, row, row)
        continue
      }
      if (rule.srcTable === tableId) {
        const key = cell(row, rule.joinSource)
        const bucket = key && indexFor(rule.tgtTable, rule.joinTarget).buckets.get(key)
        if (bucket) for (const tgtRow of bucket) pair(rule, row, tgtRow)
      }
      if (rule.tgtTable === tableId) {
        const key = cell(row, rule.joinTarget)
        const bucket = key && indexFor(rule.srcTable, rule.joinSource).buckets.get(key)
        if (bucket) {
          for (const srcRow of bucket) {
            // A self-join met this pair already from the source side.
            if (srcRow === row && rule.srcTable === tableId) continue
            pair(rule, srcRow, row)
          }
        }
      }
    }
  }

  function dropFor(row) {
    const set = byRow.get(row)
    if (!set) return
    for (const c of [...set]) unregister(c)
  }

  // ---- nodes -----------------------------------------------------------------
  const nodes = {} // id -> { l, t, a, o, i }   — the graph's own `nodes`
  const nodeMeta = new Map() // id -> { counts, conflicts, collisions }
  const nodeTypes = new Map() // type key -> count
  const edgeCounts = new Map() // edge key -> count
  const collisions = new Map() // id -> [{ id, kept, also }]
  let conflicts = 0

  const order = (a, b) =>
    a.rule.g - b.rule.g || seq.get(a.src) - seq.get(b.src) || seq.get(a.tgt) - seq.get(b.tgt)

  /**
   * One node from its contributions, which must be in run order.
   *
   * Edge counts are tallied per matched row pair, *before* the o-lists are
   * deduplicated — that is what the Studio reports. Every count belongs to the
   * edge's source node, which is what lets a node carry its own share.
   */
  function buildNode(id, list) {
    let node = null
    const meta = { counts: new Map(), conflicts: 0, collisions: [] }
    // A set beside every list, for the membership test. `list.includes` made a
    // full run quadratic in the longest list — and a thesaurus concept shared by
    // every find is exactly such a list: 53,000 entries at 300k nodes, where the
    // run took 100 s instead of a few.
    const members = new WeakMap()
    const seenForward = new Set()

    const ensure = (ent, label, labelI18n) => {
      if (!node) node = { l: label || id, t: ent.typeKey, a: {}, o: {}, i: {} }
      // Translations come from every statement the node is in, first one per
      // language wins — the Studio's ensure_node. The key only appears on a
      // node that has one, so a monolingual graph keeps its exact shape.
      if (labelI18n) {
        for (const [lang, text] of Object.entries(labelI18n)) {
          if (!node.l_i18n) node.l_i18n = {}
          if (!node.l_i18n[lang]) node.l_i18n[lang] = text
        }
      }
      if (node.t === ent.typeKey) return
      // First writer wins for type and label. The reference data relies on this:
      // an SE number appearing both as a unit (tbl_3) and as a relation partner
      // (tbl_2) must stay an SE, and the mapping lists that node first.
      if (node.t !== ent.typeKey) meta.collisions.push({ id, kept: node.t, also: ent.typeKey })
    }
    const push = (bag, key, value) => {
      let list = bag[key]
      let seen
      if (!list) {
        bag[key] = list = []
        members.set(list, (seen = new Set()))
      } else {
        seen = members.get(list)
      }
      if (seen.has(value)) return false
      seen.add(value)
      list.push(value)
      return true
    }
    const bump = (key) => meta.counts.set(key, (meta.counts.get(key) || 0) + 1)

    for (const c of list) {
      const rule = c.rule
      const isSource = c.sId === id
      const isTarget = c.tId === id

      if (rule.kind === LIT) {
        // Attributes never bring a node into being — an entity with nothing but a
        // note attached has no triple and does not exist in the Studio's output.
        if (!node) continue
        const key = rule.rel.attrKey
        const merged = mergeValues(node.a[key], c.value)
        if (node.a[key] !== undefined && merged !== node.a[key]) meta.conflicts++
        node.a[key] = merged
        continue
      }

      if (isSource) ensure(rule.source, c.sLabel, c.sLabelI18n)
      if (isTarget) ensure(rule.target, c.tLabel, c.tLabelI18n)

      if (rule.kind === REL) {
        if (isSource) {
          const added = push(node.o, rule.rel.edgeKey, c.tId)
          if (!rule.joined || added) bump(rule.rel.edgeKey)
        }
        if (isTarget && rule.rel.inverseName) push(node.i, rule.rel.inverseName, c.sId)
        continue
      }

      // Dot-one. Deduplicated on the pair, like any join — but only against the
      // other *forward* rows. The o-list cannot serve as the tally here, because
      // a mirror may already have put this very edge in place, and a row stating
      // "B lies above A" is still its own statement. tbl_2 holds one duplicate
      // pair, which is the single edge between 79 rows and the reported 78.
      if (isSource) {
        push(node.o, c.fwd, c.tId)
        const seenKey = `${c.fwd}\u0000${c.tId}`
        if (!seenForward.has(seenKey)) {
          seenForward.add(seenKey)
          bump(c.fwd)
        }
      }
      // The reverse reading, as another outgoing edge on the target. Not counted
      // in edge_types — the Studio tallies the rows it read, and this is not one.
      if (isTarget && c.rev) push(node.o, c.rev, c.sId)
    }
    return { node, meta }
  }

  function retire(id) {
    const node = nodes[id]
    if (!node) return
    const meta = nodeMeta.get(id)
    countMap(nodeTypes, node.t, -1)
    for (const [key, n] of meta.counts) countMap(edgeCounts, key, -n)
    conflicts -= meta.conflicts
    collisions.delete(id)
    nodeMeta.delete(id)
    delete nodes[id]
  }

  function enter(id, node, meta) {
    nodes[id] = node
    nodeMeta.set(id, meta)
    countMap(nodeTypes, node.t, 1)
    for (const [key, n] of meta.counts) countMap(edgeCounts, key, n)
    conflicts += meta.conflicts
    if (meta.collisions.length) collisions.set(id, meta.collisions)
  }

  function rebuild(id, sorted) {
    retire(id)
    const set = byNode.get(id)
    if (!set) return
    const list = sorted ? [...set] : [...set].sort(order)
    const { node, meta } = buildNode(id, list)
    if (node) enter(id, node, meta)
  }

  // ---- full run ----------------------------------------------------------------
  // Pairs in run order: source rows in table order, each with its partners in
  // table order. byNode's sets therefore come out sorted, and so does the order
  // of the node ids, which is the order a node is first met in.
  for (const rule of rules) {
    const src = model.tables.get(rule.srcTable)
    if (!rule.joined) {
      for (const row of src.rows) pair(rule, row, row)
      continue
    }
    const index = indexFor(rule.tgtTable, rule.joinTarget)
    for (const srcRow of src.rows) {
      const key = cell(srcRow, rule.joinSource)
      const bucket = key && index.buckets.get(key)
      if (bucket) for (const tgtRow of bucket) pair(rule, srcRow, tgtRow)
    }
  }
  for (const id of byNode.keys()) rebuild(id, true)
  dirty = new Set()

  // ---- reacting to edits ---------------------------------------------------------
  function rowAdded(tableId, row) {
    if (!model.tables.has(tableId)) return
    seq.set(row, nextSeq.get(tableId))
    nextSeq.set(tableId, nextSeq.get(tableId) + 1)
    for (const index of indexesByTable.get(tableId) || []) indexInsert(index, row, true)
    generateFor(tableId, row)
  }

  function rowRemoved(tableId, row) {
    dropFor(row)
    for (const index of indexesByTable.get(tableId) || []) indexRemove(index, row)
  }

  function cellChanged(tableId, row, column) {
    if (!columnsRead.get(tableId)?.has(column)) return
    dropFor(row)
    for (const index of indexesByTable.get(tableId) || []) {
      if (index.column !== column) continue
      indexRemove(index, row)
      indexInsert(index, row, true)
    }
    generateFor(tableId, row)
  }

  // ---- output -------------------------------------------------------------------
  function result() {
    for (const id of dirty) rebuild(id, false)
    dirty = new Set()

    const node_types = Object.fromEntries(nodeTypes)
    const edge_types = Object.fromEntries(edgeCounts)
    const typeColors = {}
    const typeLabels = {}
    const edgeLabels = {}

    for (const ent of model.entities.values()) {
      const e = overrides[ent.nodeId] ? { ...ent, ...overrides[ent.nodeId] } : ent
      if (!(e.typeKey in node_types)) continue
      if (e.color) typeColors[e.typeKey] = e.color
      typeLabels[e.typeKey] = e.explorerLabel || e.rdfsLabel || localName(e.classUri).replace(/_/g, ' ')
    }
    for (const rel of model.relations) {
      if (rel.edgeKey in edge_types) {
        edgeLabels[rel.edgeKey] = rel.explorerLabel || localName(rel.propertyUri).replace(/_/g, ' ')
      }
      if (rel.inverseName) edgeLabels[rel.inverseName] = rel.inverseName
    }
    // Dot-one edges are labelled with the prefixed property plus the value as it
    // stands in the table — "crmarchaeo:AP11_has_physical_relation_to (über)",
    // with the umlaut the key had to drop.
    for (const rel of model.dot1Relations) {
      for (const [key, { value }] of dot1Values) {
        if (key.startsWith(rel.propertyUri)) edgeLabels[key] = `${rel.propertyLabel} (${dot1DisplayValue(value)})`
      }
    }

    let edgeCount = 0
    for (const count of edgeCounts.values()) edgeCount += count

    const schema = { typeColors, typeLabels, edgeLabels, mainAttrs: {} }
    const graph = {
      meta: {
        title: 'OntoGraphNavigator Export',
        node_count: nodeMeta.size,
        edge_count: edgeCount,
        generated_by: 'OntoGraphNavigator',
      },
      nodes,
      node_types,
      edge_types,
      schema,
    }
    // Only once the project has a further language, as in the Studio's export:
    // a monolingual graph keeps the exact shape the Explorer always read. Type
    // names per language come from the Explorer names in that language; the
    // Studio also falls back to an ontology's rdfs:label@lang, which needs the
    // ontology this tool does not load.
    if (isMultilingual(languages)) {
      graph.languages = { primary: languages.primary, additional: [...langs] }
      const typeLabelsI18n = {}
      for (const ent of model.entities.values()) {
        const e = overrides[ent.nodeId] ? { ...ent, ...overrides[ent.nodeId] } : ent
        if (!e.explorerLabel || !(e.typeKey in node_types)) continue
        for (const lang of langs) {
          const text = e.explorerLabelI18n?.[lang]
          if (text && !typeLabelsI18n[lang]?.[e.typeKey]) (typeLabelsI18n[lang] ||= {})[e.typeKey] = text
        }
      }
      if (Object.keys(typeLabelsI18n).length) schema.typeLabelsI18n = typeLabelsI18n
    }

    return {
      graph,
      diagnostics: {
        unpairable: staticDiagnostics.unpairable,
        danglingRelations: staticDiagnostics.danglingRelations,
        attributeConflicts: conflicts,
        typeCollisions: [...collisions.values()].flat(),
        unmirroredDot1: new Set(unmirrored.keys()),
      },
    }
  }

  // ---- provenance -----------------------------------------------------------------
  /** The rows a node is made from, with the rule that read each pair. */
  function provenanceOf(nodeId) {
    const set = byNode.get(nodeId)
    if (!set) return []
    return [...set].sort(order).map((c) => ({
      kind: c.rule.kind === REL ? 'relation' : c.rule.kind === DOT1 ? 'dot1' : 'literal',
      rule: c.rule.rel,
      role: c.sId === nodeId ? 'source' : 'target',
      srcTable: c.rule.srcTable,
      srcRow: c.src,
      tgtTable: c.rule.tgtTable,
      tgtRow: c.tgt,
      partner: c.sId === nodeId ? c.tId : c.sId,
      // The canonical qualifier of a dot-one statement ("ueber"), as stated by its source.
      ...(c.value !== undefined && c.rule.kind === DOT1 ? { value: c.value } : {}),
    }))
  }

  /** The nodes a row takes part in producing. */
  function nodesOfRow(row) {
    const ids = new Set()
    for (const c of byRow.get(row) || []) {
      if (nodes[c.sId]) ids.add(c.sId)
      if (c.tId !== null && nodes[c.tId]) ids.add(c.tId)
    }
    return [...ids]
  }

  return { result, rowAdded, rowRemoved, cellChanged, provenanceOf, nodesOfRow }
}

function countMap(map, key, delta) {
  const n = (map.get(key) || 0) + delta
  if (n) map.set(key, n)
  else map.delete(key)
}

/**
 * The whole graph in one go.
 *
 * @param {object} model  from readProjectFile
 * @param {object} [options]  see createMaterializer
 */
export function materialize(model, options = {}) {
  return createMaterializer(model, options).result()
}
