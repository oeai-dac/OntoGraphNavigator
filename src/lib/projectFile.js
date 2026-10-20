/**
 * Reading and writing the OntoCartographer Studio project file (version 4).
 *
 * The file is a *mapping plus embedded tables*, not an instance graph. The
 * tables are repeated on every mapping node that sits on them, which is why the
 * reference project weighs 52 MB while holding roughly 11 MB of distinct rows
 * (tbl_5 alone: 1422 WKT rows carried four times).
 *
 * `readProjectFile` therefore deduplicates on load and `writeProjectFile` puts
 * the copies back, so the Studio keeps seeing the format it wrote.
 */

import { expandTerm, localName } from './prefixes'
import { edgeKey, isFoldedLiteralClass, typeKey } from './keys'
import { normalizeLanguages } from './languages'

export const MIDPOINT_TYPE = 'dotOneMidpoint'

/**
 * @param {object} json parsed project file
 * @returns {object} model — see docs/internal-model.md
 */
export function readProjectFile(json) {
  const prefixMap = { ...(json.prefixMap || {}) }
  const idPrefix = json.idPrefix || ''

  // ---- tables: one copy per tableId -------------------------------------
  const tables = new Map()
  for (const node of json.nodes || []) {
    const d = node.data || {}
    if (!d.tableId) continue
    if (!tables.has(d.tableId)) {
      const rows = Array.isArray(d.tableRows) ? d.tableRows : []
      tables.set(d.tableId, {
        id: d.tableId,
        name: d.tableName || '',
        rows,
        columns: rows.length ? Object.keys(rows[0]) : [],
      })
    } else if (!tables.get(d.tableId).rows.length && Array.isArray(d.tableRows) && d.tableRows.length) {
      // A node may have been added before the table was filled; take the fuller copy.
      const t = tables.get(d.tableId)
      t.rows = d.tableRows
      t.columns = Object.keys(d.tableRows[0])
    }
  }

  // A table without rows has no row to read its columns from; the Studio's
  // table summary still names them (an empty template, a table emptied).
  for (const entry of Array.isArray(json.tables) ? json.tables : []) {
    const t = tables.get(entry?.tableId)
    if (t && !t.columns.length && Array.isArray(entry.headers)) t.columns = [...entry.headers]
  }

  // ---- mapping nodes -----------------------------------------------------
  const entities = new Map() // nodeId -> entity
  const literals = new Map() // nodeId -> folded literal
  const midpoints = new Set()

  for (const node of json.nodes || []) {
    if (node.type === MIDPOINT_TYPE) {
      midpoints.add(node.id)
      continue
    }
    const d = node.data || {}
    if (!d.uri) continue

    const classUri = expandTerm(d.uri, prefixMap)
    const common = {
      nodeId: node.id,
      classUri,
      classLabel: d.label || '',
      rdfsLabel: d.rdfs_label || '',
      explorerLabel: d.explorerLabel || '',
      tableId: d.tableId || '',
      noPrefix: d.noPrefix === true,
    }

    if (isFoldedLiteralClass(d.uri) || isFoldedLiteralClass(classUri)) {
      // The value column is what actually carries the text; `mappedColumn` may
      // point at a synthetic id column instead (SEBeschreibung_ID).
      literals.set(node.id, {
        ...common,
        valueColumn: d.labelColumn || d.mappedColumn || '',
        // Only relevant when the node is *not* in literal mode: then the RDF
        // export makes a resource out of this column and hangs the text off it
        // as a label. The Graph-JSON folds it either way.
        idColumn: d.mappedColumn || '',
      })
    } else {
      entities.set(node.id, {
        ...common,
        color: d.nodeColor || '',
        idColumn: d.mappedColumn || '',
        labelColumn: d.labelColumn || null,
        // The label and Explorer name in the project's further languages:
        // { lang: column } and { lang: name }. The plain fields are the primary.
        labelColumnI18n: { ...(d.labelColumnI18n || {}) },
        explorerLabelI18n: { ...(d.explorerLabelI18n || {}) },
        typeKey: typeKey(classUri, d.explorerLabel),
      })
    }
  }

  // ---- mapping edges -----------------------------------------------------
  const relations = []
  const literalEdges = []
  const dot1Relations = []

  const byId = new Map((json.edges || []).map((e) => [e.id, e]))

  for (const edge of json.edges || []) {
    const d = edge.data || {}
    if (d.isSplitSeg2 || d.isDotOne) continue // reconstructed from seg1 below

    const propertyUri = expandTerm(d.propertyUri || d.label, prefixMap)
    if (!propertyUri) continue

    // A dot-one annotation is stored as midpoint + seg1 + seg2 + dot1 edge.
    // seg1 knows the real target and where the annotation value comes from.
    if (d.isSplitSeg1) {
      const valueNode = entities.get(d.dotOneNodeId) || literals.get(d.dotOneNodeId)
      dot1Relations.push({
        edgeId: edge.id,
        source: edge.source,
        target: d.originalTarget,
        propertyUri,
        // Prefixed form, kept because the display label of a dot-one edge is
        // built from it plus the untransliterated value: "crmarchaeo:AP11_… (über)".
        propertyLabel: d.label || propertyUri,
        dotOnePropertyUri: expandTerm(d.dotOnePropUri || d.dotOneProp, prefixMap),
        valueNodeId: d.dotOneNodeId || '',
        valueColumn: valueNode?.idColumn || valueNode?.valueColumn || '',
        valueTableId: valueNode?.tableId || '',
        joinSource: d.joinColumnSource || null,
        joinTarget: d.joinColumnTarget || null,
        seg2Id: d.dotOneEdgeId ? byId.get(d.dotOneEdgeId)?.id : undefined,
      })
      continue
    }

    if (midpoints.has(edge.source) || midpoints.has(edge.target)) continue

    if (literals.has(edge.target)) {
      const lit = literals.get(edge.target)
      literalEdges.push({
        edgeId: edge.id,
        source: edge.source,
        literalNodeId: edge.target,
        propertyUri,
        // The attribute key is the explorer name, else the property's local name.
        // Verified: "Befundbeschreibung", "Anmerkung Fund" (explorer names) next
        // to "AP24_starts", "O30_determined_position" (local names).
        attrKey: lit.explorerLabel || localName(propertyUri),
        joinSource: d.joinColumnSource || null,
        joinTarget: d.joinColumnTarget || null,
      })
      continue
    }

    if (!entities.has(edge.source) || !entities.has(edge.target)) continue

    relations.push({
      edgeId: edge.id,
      source: edge.source,
      target: edge.target,
      propertyUri,
      explorerLabel: d.explorerLabel || '',
      // The Studio stores the resolved inverse *display name* here, not a URI —
      // "Ist Material von", not owl:inverseOf. It becomes the key on the `i` side.
      inverseName: d.noInverse ? '' : d.inversePropertyUri || '',
      joinSource: d.joinColumnSource || null,
      joinTarget: d.joinColumnTarget || null,
      edgeKey: edgeKey(propertyUri, d.explorerLabel),
    })
  }

  // Every top-level field, as read. The Studio adds fields with its versions
  // (`wideningAll`, `tables`, `languages` …); writing back only the ones this
  // loader knows would drop the rest — a project opened and saved here would
  // lose its languages.
  const { nodes: _nodes, edges: _edges, ...fileFields } = json

  return {
    version: json.version ?? 4,
    idPrefix,
    prefixMap,
    wideningParent: json.wideningParent ?? true,
    wideningChild: json.wideningChild ?? false,
    namedGraphs: json.namedGraphs || [],
    // null for a project saved before Studio 3.1, which names no languages —
    // see languages.js for what that means.
    languages: json.languages ? normalizeLanguages(json.languages) : null,
    fileFields,
    tables,
    entities,
    literals,
    relations,
    literalEdges,
    dot1Relations,
    // Kept verbatim so the file can be written back with positions, sizes and
    // every field this loader does not care about still intact.
    canvas: { nodes: json.nodes || [], edges: json.edges || [] },
  }
}

/**
 * Write the model back as a Studio project file.
 *
 * Table rows are re-attached to every node that sits on the table — that
 * duplication *is* the format; leaving it out would produce a file the Studio
 * reads as empty.
 */
export function writeProjectFile(model) {
  const nodes = model.canvas.nodes.map((node) => {
    const d = node.data || {}
    if (!d.tableId) return node
    const table = model.tables.get(d.tableId)
    if (!table) return node
    return { ...node, data: { ...d, tableRows: table.rows } }
  })

  // The Studio's table summary (v5+): what its next session builds the table
  // placeholders from. Rows and columns added here have to show up in it.
  const fileFields = { ...(model.fileFields || {}) }
  if (Array.isArray(fileFields.tables)) {
    fileFields.tables = fileFields.tables.map((entry) => {
      const table = model.tables.get(entry?.tableId)
      if (!table) return entry
      const headers = [...(entry.headers || [])]
      for (const column of table.columns) if (!headers.includes(column)) headers.push(column)
      return { ...entry, headers, rowCount: table.rows.length }
    })
  }

  return {
    ...fileFields,
    version: model.version,
    idPrefix: model.idPrefix,
    prefixMap: model.prefixMap,
    wideningParent: model.wideningParent,
    wideningChild: model.wideningChild,
    namedGraphs: model.namedGraphs,
    // Written once known — also when declared here for an older project, which
    // then opens in the Studio with the languages decided here.
    ...(model.languages ? { languages: model.languages } : {}),
    nodes,
    edges: model.canvas.edges,
  }
}
