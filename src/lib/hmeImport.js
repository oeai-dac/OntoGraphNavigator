/**
 * The Harris Matrix Editor's projects, brought into the Navigator — and the
 * empty "matrix first" template, which is the same thing with no units.
 *
 * As decided:
 *
 *   mapping     the BDA standard mapping the HME carries (src/hme/rdfMappings.js),
 *               bound to one flat table exactly as the HME's own Studio export
 *               binds it (src/hme/rdfBindings.js) — one row per relation,
 *               written from the upper unit — and extended by
 *                 unit type   A8 –P2 has type→ E55 Type          ("Unit type")
 *                 geometry    A8 –O32i was located by→ S23 Position Determination
 *                             –O30 determined position→ geo:wktLiteral (as the
 *                             reference project has it)
 *                 phases      the 4b phases (phaseEditor.js)
 *   units       of every protocol, as SEs: the fields the standard protocol
 *               shares come along, the rest is reported by name
 *   objects     an HME object becomes the BDA object (Objnr) of its units, unless
 *               the protocol names one there — then that one counts, and the
 *               report says so
 *
 * Since step 7d the project keeps only the matrix part of that mapping, and
 * since 2026-10-19 in English: SU, SU_relation, Relation_type, Objno,
 * Objgroup_no, Unit_type, Measurement — identifiers SU001, Obj_…, Objgr_…,
 * Unit_type_…, SU001_measurement. The SE-Protokoll (German, as the BDA form
 * is) comes with its package.
 *
 * Positions and colours are display state of the HME and are not carried over.
 * The result is a Studio project file (JSON), opened like any other.
 */

import { RDF_MAPPINGS } from '../hme/rdfMappings.js'
import { RDF_BINDINGS, UNBOUND } from '../hme/rdfBindings.js'
import { slugLocal } from '../hme/uriNames.js'
import { readProjectFile, writeProjectFile } from './projectFile'
import { createJournal } from './journal'
import { createWorkspace } from './edits'
import { expandId } from './prefixes'
import { addPhasesToMapping, createPhase, listPhases, setUnitPhase } from './phaseEditor'
import { matchPackage, protocolUnits, writeProtocol } from './protocols'
import { bindAsProposed } from './protocolBinding'

const PROTOCOL = 'standard'
const DEFAULT_ID_PREFIX = 'hme'
const DEFAULT_ID_NAMESPACE = 'https://example.org/hme/'
const EMPTY_COLUMN = '_nicht_zugeordnet'
const CRM = 'http://www.cidoc-crm.org/cidoc-crm/'
const CRMSCI = 'http://www.cidoc-crm.org/extensions/crmsci/'
const GEO = 'http://www.opengis.net/ont/geosparql#'

/** The rule a phase's identifier is made by, here and wherever phases are added to a mapping. */
export const PHASE_RULE = '{Phase~local}_ID'

/**
 * Identifier rules of the matrix mapping: units "SU" + the number, objects,
 * groups and unit types by their name, measurements by their unit, phases by
 * their name — for the sidecar, where the data offers none to read off. The
 * editors make new identifiers by them (phaseEditor.js, objectEditor.js).
 */
export const BDA_URI_RULES = {
  n10: 'SU{SU~senr}',
  n11: '{SU_uri}_designation',
  n14: 'SU{SU_relation~senr}',
  n9: 'Obj_{Objno~local}',
  n8: 'Objgr_{Objgroup_no~local}',
  nUnitType: 'Unit_type_{Unit_type~local}',
  nMeasurement: '{SU_uri}_measurement',
  nPhase: PHASE_RULE,
  nPhaseOrder: PHASE_RULE,
}

/**
 * The matrix part of the BDA mapping in English: the HME's columns (its own
 * bindings, src/hme/rdfBindings.js, write them) renamed, their identifiers
 * made over, the nodes named anew.
 */
const ENGLISH = {
  n10: { explorerLabel: 'SU (number)', idCol: ['SE_uri', 'SU_uri'], labelCol: ['SE', 'SU'], id: (v) => v.replace(/^SE/, 'SU') },
  n11: { explorerLabel: 'SU designation', idCol: ['SE_Bez_uri', 'SU_designation_uri'], labelCol: ['SE_Bez', 'SU_designation'], id: (v) => v.replace(/^SE/, 'SU').replace(/_Bez$/, '_designation') },
  n25: { explorerLabel: 'SU description', idCol: ['Beschreibung_SE', 'SU_description'], labelCol: null, id: (v) => v },
  n14: { explorerLabel: 'SU (relation)', idCol: ['SE_Relation_uri', 'SU_relation_uri'], labelCol: ['SE_Relation', 'SU_relation'], id: (v) => v.replace(/^SE/, 'SU') },
  n23: { explorerLabel: 'Relation type', idCol: ['Relationstyp_uri', 'Relation_type_uri'], labelCol: ['Relationstyp', 'Relation_type'], id: (v) => v.replace(/^Relationstyp_/, 'Relation_type_') },
  n9: { explorerLabel: 'Objno.', idCol: ['Objnr_uri', 'Objno_uri'], labelCol: ['Objnr', 'Objno'], id: (v) => v },
  n8: { explorerLabel: 'Objgr. (no.)', idCol: ['Objgr_Nr_uri', 'Objgroup_no_uri'], labelCol: ['Objgr_Nr', 'Objgroup_no'], id: (v) => v },
}

/** Where each BDA form keeps a longer description (the HME's descFallback). */
const DESCRIPTION_FIELD = { standard: 'beschreibungen.Beschreibung_SE', bau: 'beschreibung.Beschreibung', holz: 'funktion_ansprache.Funktion_Ansprache', mensch: 'skelett.Anmerkungen' }

/** The relation kinds as the BDA mapping's vocabulary spells them (the HME wrote "above" only). */
const RELATION_WORD = { higher: 'above', 'same-rank': 'contemporary with', equals: 'equals' }

const PROTOCOL_NAMES = { standard: 'Standard', bau: 'Baulicher Bestand', holz: 'Baulicher Bestand – Holz', mensch: 'Menschliche Überreste' }

/** An HME project file (1.0–1.2), not a Studio project and not a graph. */
export function isHmeProject(json) {
  if (!Array.isArray(json?.nodes) || !Array.isArray(json?.edges)) return false
  if (typeof json.version === 'number') return false // the Studio's format version
  if (json.nodes.some((n) => n && (n.type === 'ontologyNode' || n.type === 'dotOneMidpoint' || n.data))) return false
  return 'phases' in json || 'objects' in json || json.nodes.every((n) => n && 'label' in n && 'id' in n)
}

// ---- values ---------------------------------------------------------------------

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
const seNumber = (node) => String(node.label || '').replace(/^SU\s*/i, '').trim()
const seUri = (nr) => (nr ? `SU${slugLocal(nr)}` : '')

function readPath(se, path) {
  const [section, field] = path.split('.')
  const v = se?.[section]?.[field]
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'true' : ''
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'object') return ''
  return String(v).trim()
}

const filled = (v) => {
  if (v === null || v === undefined) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.values(v).some(filled)
  return true
}

/** GeoJSON geometry (or Feature) → WKT; '' when there is none. */
export function geoJsonToWkt(g) {
  if (!g) return ''
  if (g.type === 'Feature') return geoJsonToWkt(g.geometry)
  const hasZ = JSON.stringify(g.coordinates || []).match(/\[[^[\]]*,[^[\]]*,[^[\]]*\]/)
  const pt = (c) => c.map((x) => String(x)).join(' ')
  const ring = (cs) => `(${cs.map(pt).join(', ')})`
  const poly = (rs) => `(${rs.map(ring).join(', ')})`
  const z = hasZ ? ' Z' : ''
  switch (g.type) {
    case 'Point': return `POINT${z} (${pt(g.coordinates)})`
    case 'MultiPoint': return `MULTIPOINT${z} (${g.coordinates.map((c) => `(${pt(c)})`).join(', ')})`
    case 'LineString': return `LINESTRING${z} ${ring(g.coordinates)}`
    case 'MultiLineString': return `MULTILINESTRING${z} (${g.coordinates.map(ring).join(', ')})`
    case 'Polygon': return `POLYGON${z} ${poly(g.coordinates)}`
    case 'MultiPolygon': return `MULTIPOLYGON${z} (${g.coordinates.map(poly).join(', ')})`
    case 'GeometryCollection': return `GEOMETRYCOLLECTION${z} (${(g.geometries || []).map(geoJsonToWkt).join(', ')})`
    default: return ''
  }
}

// ---- the extension of the BDA mapping -------------------------------------------

/** Columns the extension adds to the flat table, and how a unit fills them. */
const EXTRA = [
  { idCol: 'Unit_type_uri', labelCol: 'Unit_type', id: (c) => (c.node.type ? `Unit_type_${slugLocal(c.node.type)}` : ''), label: (c) => c.node.type || '' },
  { idCol: 'Measurement_uri', labelCol: 'Measurement', id: (c) => (c.wkt ? `${seUri(c.seNr)}_measurement` : ''), label: (c) => (c.wkt ? `Measurement ${c.node.label}` : '') },
  { idCol: 'wkt_geom', literal: true, id: (c) => c.wkt },
]

function extendMapping(project, tableId, tableName, rows) {
  const unitNode = project.nodes.find((n) => n.id === 'n10')
  const at = unitNode?.position || { x: 0, y: 0 }
  const template = project.edges.find((e) => e.data?.propertyUri && !e.data?.isSplitSeg1 && !e.data?.isSplitSeg2)
  const look = template
    ? Object.fromEntries(['focusable', 'style', 'markerEnd', 'labelStyle', 'labelBgStyle', 'labelBgPadding', 'labelBgBorderRadius'].filter((k) => k in template).map((k) => [k, template[k]]))
    : {}
  const node = (id, dx, dy, data) => ({
    id, type: 'ontologyNode', position: { x: at.x + dx, y: at.y + dy },
    data: { rdfs_label: '', instanceLabel: '', isFreeNode: false, tableId, tableName, tableRows: rows, ...data },
  })
  project.nodes.push(
    node('nUnitType', -420, 260, {
      label: 'crm:E55_Type', uri: `${CRM}E55_Type`, nodeType: 'object', nodeColor: '#fab565',
      mappedColumn: 'Unit_type_uri', labelColumn: 'Unit_type', noPrefix: false, explorerLabel: 'Unit type',
    }),
    node('nMeasurement', -420, 420, {
      label: 'S23_Position_Determination', uri: `${CRMSCI}S23_Position_Determination`, nodeType: 'subject', nodeColor: '#82ddff',
      mappedColumn: 'Measurement_uri', labelColumn: 'Measurement', noPrefix: false, explorerLabel: 'Measurement SU',
    }),
    node('nGeometry', -840, 420, {
      label: 'geo:wktLiteral', uri: `${GEO}wktLiteral`, nodeType: 'subject', nodeColor: '#ffffff',
      mappedColumn: 'wkt_geom', labelColumn: 'wkt_geom', noPrefix: true,
    }),
  )
  const edge = (id, source, target, label, propertyUri, explorerLabel) => ({
    ...look, id, source, target, sourceHandle: 'r-s', targetHandle: 'l-t', label,
    data: { label, propertyUri, explorerLabel, joinColumnSource: null, joinColumnTarget: null },
  })
  project.edges.push(
    edge('e_n10_nUnitType', 'n10', 'nUnitType', 'P2_has_type', `${CRM}P2_has_type`, 'unit type'),
    edge('e_n10_nMeasurement', 'n10', 'nMeasurement', 'O32i_was_located_by', `${CRMSCI}O32i_was_located_by`, 'located by'),
    edge('e_nMeasurement_nGeometry', 'nMeasurement', 'nGeometry', 'O30_determined_position', `${CRMSCI}O30_determined_position`, 'geometry'),
  )
  project.prefixMap = { geo: GEO, ...project.prefixMap }
}

// ---- the flat table ---------------------------------------------------------------

/**
 * The HME's buildMappingTable (io/rdfTable.js), for units of every protocol,
 * with the extension's columns, and recording which form fields it read.
 */
function buildTable({ nodes, edges, projectMeta, read }) {
  const bindings = RDF_BINDINGS[PROTOCOL]
  const columns = []
  for (const b of [...Object.values(bindings.nodes), ...EXTRA]) {
    if (b.idCol && !columns.includes(b.idCol)) columns.push(b.idCol)
    if (b.labelCol && !columns.includes(b.labelCol)) columns.push(b.labelCol)
  }
  columns.push(EMPTY_COLUMN)

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const unnamed = []
  const own = nodes.filter((n) => {
    const nr = seNumber(n) || readPath(n.se, 'befunddaten.SE')
    if (!nr) unnamed.push(n.label || `(no label, id ${n.id})`)
    return !!nr
  })
  const ownIds = new Set(own.map((n) => n.id))

  const emit = (node, partner, kind = 'higher') => {
    const se = node.se || {}
    const v = (path) => {
      read.add(path)
      return readPath(se, path)
    }
    const truthy = (x) => x !== '' && x !== 'false'
    const ctx = {
      node, se, v, meta: projectMeta || {}, partner,
      seNr: seNumber(node) || v('befunddaten.SE'),
      partnerNr: partner ? seNumber(partner) || readPath(partner.se, 'befunddaten.SE') : '',
      relationType: partner ? RELATION_WORD[kind] || 'above' : '',
      hasFunde: truthy(v('befunddaten.Funde')) || v('befunddaten.Funde_Text') !== '',
      hasProbe: truthy(v('befunddaten.Probe')) || v('befunddaten.Probe_Art') !== '',
      hasProtokoll: Object.values(se).some((section) => section && typeof section === 'object' && Object.values(section).some(filled)),
      wkt: geoJsonToWkt(node.geometry),
    }
    const row = Object.fromEntries(columns.map((c) => [c, '']))
    for (const b of [...Object.values(bindings.nodes), ...EXTRA]) {
      const id = b.id ? b.id(ctx) : ''
      row[b.idCol] = id === null || id === undefined ? '' : String(id)
      if (b.labelCol) {
        const label = id ? (b.label ? b.label(ctx) : '') : ''
        row[b.labelCol] = label === null || label === undefined ? '' : String(label)
      }
    }
    return row
  }

  const rows = []
  let relations = 0
  for (const node of own) {
    // Written from the upper unit (or from the first of two on one level).
    const below = edges.filter((e) => e.source === node.id && ownIds.has(e.target))
    relations += below.length
    if (!below.length) rows.push(emit(node, null))
    else for (const e of below) rows.push(emit(node, byId.get(e.target), e.kind))
  }
  return { columns, rows, own, unnamed, relations }
}

// ---- the project ---------------------------------------------------------------------

/**
 * What of the BDA mapping a project starts with: the matrix and what it stands
 * on — units (n10) with their designation (n11, E41 via P1, short text) and
 * description (n25, a note via P3, long text), the partner of a relation (n14)
 * with the relation's kind (n23), objects (n9) and object groups (n8); unit
 * type, measurement and
 * geometry are added by extendMapping, phases by the phase editor. Everything
 * else of the SE-Protokoll comes with a recording protocol bound to the
 * project (step 7d, lib/protocolBinding.js), as its package models it.
 */
const MATRIX_NODES = new Set(['n10', 'n11', 'n25', 'n14', 'n23', 'n9', 'n8'])

/** The unit types of the Harris Matrix Editor, offered for "Unit type" before any is in the data. */
export const HME_UNIT_TYPES = ['layer', 'deposit', 'fill', 'structure', 'interface']

function buildProjectJson({ nodes, edges, projectMeta, idPrefix, idNamespace, read }) {
  const mapping = RDF_MAPPINGS[PROTOCOL]
  const bindings = RDF_BINDINGS[PROTOCOL]
  const table = buildTable({ nodes, edges, projectMeta, read })
  // The table is the matrix's now, not the SE-Protokoll's (step 7d).
  const { tableId } = bindings
  const tableName = 'Harris matrix (SU)'

  const project = JSON.parse(JSON.stringify(mapping))
  project.nodes = project.nodes.filter((n) => n.type === 'dotOneMidpoint' || MATRIX_NODES.has(n.id))
  const kept = new Set(project.nodes.map((n) => n.id))
  project.edges = project.edges.filter((e) => kept.has(e.source) && kept.has(e.target))
  // The table keeps the columns of these nodes only.
  const columns = new Set()
  for (const id of MATRIX_NODES) for (const c of [bindings.nodes[id]?.idCol, bindings.nodes[id]?.labelCol]) if (c) columns.add(c)
  for (const b of EXTRA) for (const c of [b.idCol, b.labelCol]) if (c) columns.add(c)
  table.columns = table.columns.filter((c) => columns.has(c))
  for (const row of table.rows) for (const c of Object.keys(row)) if (!columns.has(c)) delete row[c]
  // In English: the columns renamed, their identifiers made over.
  const renamed = new Map()
  for (const e of Object.values(ENGLISH)) { renamed.set(e.idCol[0], e.idCol[1]); if (e.labelCol) renamed.set(e.labelCol[0], e.labelCol[1]) }
  table.columns = table.columns.map((c) => renamed.get(c) || c)
  for (const row of table.rows) {
    for (const e of Object.values(ENGLISH)) {
      const [oldId, newId] = e.idCol
      if (oldId in row) { row[newId] = row[oldId] ? e.id(String(row[oldId])) : row[oldId]; delete row[oldId] }
      if (!e.labelCol) continue
      const [oldLabel, newLabel] = e.labelCol
      if (oldLabel in row) { row[newLabel] = row[oldLabel]; delete row[oldLabel] }
    }
  }
  project.idPrefix = idPrefix
  project.prefixMap = { ...mapping.prefixMap, [idPrefix]: idNamespace }
  project.nodes = project.nodes.map((node) => {
    if (node.type === 'dotOneMidpoint') return node
    const b = bindings.nodes[node.id]
    const en = ENGLISH[node.id]
    return {
      ...node,
      data: {
        ...node.data,
        ...(en ? { explorerLabel: en.explorerLabel } : {}),
        mappedColumn: en ? en.idCol[1] : b ? b.idCol : EMPTY_COLUMN,
        labelColumn: en ? en.labelCol?.[1] || null : b ? b.labelCol || null : null,
        noPrefix: b ? !!b.literal : false,
        tableId,
        tableName,
        tableRows: table.rows,
      },
    }
  })
  // A dot-one property in the mapping is a bare name ("AP11.1_has_type"); the
  // HME resolves it against the parent property's namespace.
  project.edges = project.edges.map((edge) => {
    const d = edge.data || {}
    if (!d.isSplitSeg1 || !d.dotOnePropUri || /^https?:/.test(d.dotOnePropUri)) return edge
    const parent = expand(d.propertyUri || '', project.prefixMap)
    const cut = Math.max(parent.lastIndexOf('/'), parent.lastIndexOf('#'))
    const raw = d.dotOnePropUri.includes(':') ? expand(d.dotOnePropUri, project.prefixMap) : d.dotOnePropUri
    return { ...edge, data: { ...d, dotOnePropUri: /^https?:/.test(raw) ? raw : cut > 0 ? parent.slice(0, cut + 1) + raw : raw } }
  })
  extendMapping(project, tableId, tableName, table.rows)
  // The Studio's table summary: it names the columns also when there is no row.
  project.tables = [{ tableId, name: tableName, headers: [...table.columns], rowCount: table.rows.length }]
  // The BDA forms are German; the relation kinds keep the English the HME gives them.
  project.languages = { primary: 'de', additional: [] }
  return { project, table }
}

function expand(value, prefixMap) {
  const v = String(value ?? '').trim()
  if (!v || /^(https?|urn):/.test(v)) return v
  const i = v.indexOf(':')
  if (i < 1) return v
  const ns = prefixMap[v.slice(0, i)]
  return ns ? ns + v.slice(i + 1) : v
}

/** The units' type key in the model read from the project: the source of the stratigraphic rule. */
function unitTypeKey(model) {
  const rel = model.dot1Relations[0]
  return rel ? model.entities.get(rel.source)?.typeKey : null
}

/**
 * HME project JSON (parsed) → { json: Studio project file, report }.
 * `hme` = null builds the empty template.
 */
export function convertHme(hme, { idPrefix, idNamespace, packages = [] } = {}) {
  const src = hme || { nodes: [], edges: [], phases: [], objects: [] }
  const phases = Array.isArray(src.phases) ? src.phases : []
  const objects = Array.isArray(src.objects) ? src.objects : []
  const prefix = idPrefix || src.rdfSettings?.idPrefix || DEFAULT_ID_PREFIX
  const namespace = idNamespace || src.rdfSettings?.idNamespace || DEFAULT_ID_NAMESPACE
  const report = {
    source: src.source || 'HME',
    template: !(src.nodes || []).length,
    units: 0,
    relations: 0,
    phases: phases.length,
    objects: 0,
    types: 0,
    geometries: 0,
    unnamed: [],
    otherProtocols: [],
    objectKept: [],
    severalObjects: [],
    descriptionsJoined: [],
    unmappedFields: [],
    namespace: `${prefix}: ${namespace}`,
    defaultNamespace: namespace === DEFAULT_ID_NAMESPACE,
  }

  // Units, as the HME's own export would see them — with what the matrix
  // already knows written into empty form fields (as the HME's form does).
  const objectsOf = new Map()
  for (const o of objects) for (const id of o.nodeIds || []) {
    if (!objectsOf.has(id)) objectsOf.set(id, [])
    objectsOf.get(id).push(o)
  }
  const nodes = (src.nodes || []).map((n) => {
    const se = JSON.parse(JSON.stringify(n.se && typeof n.se === 'object' ? n.se : {}))
    const put = (path, value) => {
      const [s, f] = path.split('.')
      se[s] = { ...(se[s] || {}), [f]: value }
    }
    if (n.protocol && n.protocol !== PROTOCOL) report.otherProtocols.push(`${n.label} (${PROTOCOL_NAMES[n.protocol] || n.protocol})`)
    // The unit's description, where the HME shows it: as "SE (Bez.)" when that
    // is empty, else in the form's description field when that is empty — never twice.
    const description = String(n.description || '').trim()
    if (description) {
      if (blank(readPath(se, 'befunddaten.SE_Bez'))) put('befunddaten.SE_Bez', description)
      else if (readPath(se, 'befunddaten.SE_Bez') !== description) {
        const fallback = packages.find((pkg) => pkg.protocol?.key === (n.protocol || PROTOCOL))?.pdfFields?.descFallback || DESCRIPTION_FIELD[n.protocol || PROTOCOL]
        if (fallback && blank(readPath(se, fallback))) put(fallback, description)
        else if (fallback && !String(readPath(se, fallback)).includes(description)) {
          // Both taken: the HME's description joins the protocol's — never lost.
          put(fallback, `${readPath(se, fallback)}

${description}`)
          report.descriptionsJoined.push(n.label)
        }
      }
    }
    const phase = phases.find((p) => p.id === n.phase)
    if (phase?.name && blank(readPath(se, 'interpretation.vorlaeufige_Datierung'))) put('interpretation.vorlaeufige_Datierung', phase.name)
    const mine = objectsOf.get(n.id) || []
    if (mine.length > 1) report.severalObjects.push(`${n.label}: ${mine.map((o) => o.name).join(', ')} — kept in ${mine[0].name}`)
    if (mine.length) {
      const name = String(mine[0].name || '').trim()
      const own = readPath(se, 'befunddaten.Objnr')
      if (!own) {
        put('befunddaten.Objnr', name)
        if (blank(readPath(se, 'befunddaten.Objbez'))) put('befunddaten.Objbez', name)
      } else if (own !== name) {
        report.objectKept.push(`${n.label}: the protocol names object ${own}, the HME put it in ${name} — ${own} kept`)
      }
    }
    // The description is in the protocol now; the binding's own fallback to it would put it twice.
    return { ...n, description: '', protocol: PROTOCOL, se }
  })

  const read = new Set()
  const { project, table } = buildProjectJson({ nodes, edges: src.edges || [], projectMeta: src.projectMeta, idPrefix: prefix, idNamespace: namespace, read })
  report.units = table.own.length
  report.relations = table.relations
  report.unnamed = table.unnamed
  report.types = new Set(table.own.map((n) => n.type).filter(Boolean)).size
  report.geometries = table.own.filter((n) => geoJsonToWkt(n.geometry)).length
  report.objects = new Set(table.rows.map((r) => r.Objno_uri).filter(Boolean)).size

  // Form fields with a value the mapping has no place for — by field, with how many units.
  const unmapped = new Map()
  for (const n of src.nodes || []) {
    for (const [section, fields] of Object.entries(n.se || {})) {
      if (section === 'kopfdaten' || section === 'stratigrafie' || !fields || typeof fields !== 'object') continue
      for (const [field, value] of Object.entries(fields)) {
        // The SE number is the unit's label, read from there.
        if (!filled(value) || read.has(`${section}.${field}`) || `${section}.${field}` === 'befunddaten.SE') continue
        const key = `${section}.${field}`
        unmapped.set(key, (unmapped.get(key) || 0) + 1)
      }
    }
  }
  report.unmappedFields = [...unmapped.entries()].sort((a, b) => b[1] - a[1]).map(([path, count]) => ({ path, count }))

  // Phases: put into the mapping, created oldest first (each new one is the
  // youngest), and given to their units — on a model read from the file, then
  // written back, so the result opens with no edit history.
  const model = readProjectFile(JSON.parse(JSON.stringify(project)))
  const ws = createWorkspace({ model, journal: createJournal({ author: 'HME import' }) })
  const typeKey = unitTypeKey(model)
  const added = typeKey ? addPhasesToMapping(ws, { typeKey }) : { ok: false }
  if (added.ok && phases.length) {
    const idOf = new Map()
    for (const p of [...phases].reverse()) {
      const made = createPhase(ws, { typeKey, label: String(p.name || p.id), rules: BDA_URI_RULES })
      if (made.ok) idOf.set(p.id, made.id)
    }
    const unit = [...model.entities.values()].find((e) => e.typeKey === typeKey)
    for (const n of table.own) {
      const phaseId = idOf.get(n.phase)
      if (!phaseId) continue
      const raw = seUri(seNumber(n) || readPath(n.se, 'befunddaten.SE'))
      setUnitPhase(ws, { typeKey, unitId: expandId(raw, model.prefixMap, model.idPrefix, unit?.noPrefix), phaseId })
    }
    report.phases = listPhases(ws, { typeKey }).length
  }
  // The whole protocol of each unit, on the package of its protocol — when that
  // package has been added to the Navigator (step 7d: none comes with it). It
  // is bound as proposed: the package's paths, which the BDA mapping has, and
  // new fields of the mapping for the rest. Without the package, the values
  // stay in the HME file and the report says which package would take them.
  const byKey = new Map(packages.map((pkg) => [pkg.protocol?.key, pkg]))
  report.protocolsKept = 0
  report.protocolBindings = {}
  report.protocolsWaiting = {}
  if (typeKey) {
    const matches = new Map()
    const unitOf = new Map()
    for (const n of table.own) {
      const key = (src.nodes.find((x) => x.id === n.id) || {}).protocol || PROTOCOL
      const pkg = byKey.get(key) || byKey.get(PROTOCOL)
      if (!pkg) {
        const se = (src.nodes.find((x) => x.id === n.id) || {}).se || {}
        if (Object.values(se).some((section) => section && typeof section === 'object' && Object.values(section).some(filled))) {
          report.protocolsWaiting[key] = (report.protocolsWaiting[key] || 0) + 1
        }
        continue
      }
      if (!matches.has(pkg.id)) {
        const bound = bindAsProposed(ws, pkg)
        if (bound.ok) report.protocolBindings[pkg.id] = bound.binding
        matches.set(pkg.id, bound.ok ? matchPackage(model, pkg, bound.binding) : { error: bound.error })
      }
      const match = matches.get(pkg.id)
      if (match.error) continue
      if (!unitOf.size) for (const u of protocolUnits(model, match)) unitOf.set(u.raw, u.id)
      const unitId = unitOf.get(seUri(seNumber(n) || readPath(n.se, 'befunddaten.SE')))
      if (!unitId) continue
      const res = writeProtocol(ws, match, unitId, { ...n.se, ...(src.projectMeta ? { kopfdaten: src.projectMeta } : {}) }, { protocol: pkg.id })
      if (res.ok) report.protocolsKept++
    }
    // Kept now, every field in the mapping: nothing stays a note.
    if (report.protocolsKept && !Object.keys(report.protocolsWaiting).length) report.unmappedFields = []
  }
  report.unbound = Object.values(UNBOUND[PROTOCOL] || {})
  return { json: writeProjectFile(model), report }
}

/** The empty "matrix first" project: the BDA mapping with phases, unit type and geometry, and no unit yet. */
export function buildMatrixTemplate(options = {}) {
  return convertHme(null, options)
}

/** The template as the text of an (empty) HME project — opened like any file. */
export const EMPTY_HME_PROJECT = JSON.stringify({ version: '1.2', nodes: [], edges: [], phases: [], objects: [] })

/** The report as lines for the Overview's notes. */
export function describeHmeReport(report) {
  const lines = []
  if (report.template) {
    lines.push('A new Harris matrix: units, relations, phases, objects and groups, unit type and geometry are ready to be entered — start in the Matrix tab with "＋ Relation".')
  } else {
    lines.push(`Imported from ${report.source === 'GraphML' ? 'GraphML' : 'the Harris Matrix Editor'}: ${report.units} units, ${report.relations} relations, ${report.phases} phases, ${report.objects} objects, ${report.geometries} geometries — on the BDA matrix mapping (units, relations, phases, objects, unit type, geometry). Positions and colours are not carried over${report.source === 'GraphML' ? '; GraphML holds no protocols and no geometries' : ''}.`)
  }
  if (report.geometries) lines.push('The HME keeps no coordinate system with its geometries: the Map asks for the EPSG code once (UTM zone 32N is 32632).')
  if (report.defaultNamespace) lines.push(`The identifiers use the namespace ${report.namespace} — set the project's real one under Settings before the data goes anywhere.`)
  if (report.unnamed.length) lines.push(`${report.unnamed.length} unit(s) without an SE number could not be given an identifier and were left out: ${report.unnamed.join(', ')}.`)
  if (report.otherProtocols.length) lines.push(`${report.otherProtocols.length} unit(s) were recorded on another protocol and came in as SEs with the fields the standard protocol shares: ${report.otherProtocols.join(', ')}.`)
  if (report.descriptionsJoined?.length) lines.push(`${report.descriptionsJoined.length} unit(s) had a designation and a description in their protocol already: the HME's description was added to the description — ${report.descriptionsJoined.join(', ')}.`)
  if (report.objectKept.length) lines.push(`Object from the protocol kept over the HME's object: ${report.objectKept.join('; ')}.`)
  if (report.severalObjects.length) lines.push(`Units in more than one HME object — one is kept: ${report.severalObjects.join('; ')}.`)
  if (report.unmappedFields.length) {
    lines.push(`Form fields with values the mapping has no place for yet (they stay in the HME file): ${report.unmappedFields.map((f) => `${f.path} (${f.count})`).join(', ')}.`)
  }
  if (report.protocolsKept) {
    const names = Object.keys(report.protocolBindings || {}).join(', ')
    lines.push(`${report.protocolsKept} SE protocols kept whole (${names}): bound as proposed — the package's paths where the BDA mapping has them, new fields of the mapping for the rest. See or change the binding under Settings → Recording protocols.`)
  }
  const waiting = Object.entries(report.protocolsWaiting || {})
  if (waiting.length) {
    lines.push(`${waiting.reduce((n, [, c]) => n + c, 0)} unit(s) carry an SE protocol (${waiting.map(([k, c]) => `${k}: ${c}`).join(', ')}), but no protocol package for it has been added: its values stay in the HME file. Add the package (.zip) under Settings → Recording protocols, then open the HME file again to take them over.`)
  }
  if (report.template) lines.push('No recording protocol yet: add one (a .zip package) under Settings → Recording protocols. Binding one puts its fields into the mapping, as the package models them.')
  return lines
}
