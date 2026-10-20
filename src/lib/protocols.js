/**
 * Recording protocols as packages.
 *
 *   protocol.json     name, publisher, version, language, the class of its units
 *   schema.json       sections and fields (the BDA form schema)
 *   bindings.json     field -> path of property + class from the unit — never
 *                     node ids — and the column name a new field gets; steps
 *                     marked `recorded` stand for the protocol itself; `links`
 *                     are relations between steps no field runs along
 *   template.pdf      optional, the fillable form
 *   pdf-fields.json   optional, field -> AcroForm field
 *
 * A package is used in a project once it is bound to it (step 7d,
 * lib/protocolBinding.js): the binding, kept in the project's settings, says
 * for every field where it lives —
 *
 *   package   the path bindings.json gives, followed through the mapping: the
 *             label or literal column of the node at its end, and the
 *             identifiers of that node and of the nodes on the way, by the
 *             templates in bindings.json
 *   parts     a node of the mapping for each part of the field (its value,
 *             each qualifier, each part of an object field) — one the mapping
 *             had, or one the binding put there
 *   omit      left out: not in the form, empty in the PDF
 *
 * matchPackage turns package and binding into where each field is read and
 * written.
 *
 * Values have the shape the Harris Matrix Editor keeps a protocol in
 * (node.se): { section: { field: value } }, value a string, a boolean, an
 * array (multi select), { wert, erhalten, original, sichtbar } (qualified),
 * or { sub: { part: value } } (object, part 'wert' where it has no name).
 *
 * A unit's protocol lives in its rows of the units' table — every row of the
 * unit carries it, as every row repeats the unit's own values. Fields of the
 * project ("Kopfdaten") live in every row of the table.
 */

import { inGroup, rowIdOf, setCell } from './edits'
import { expandId } from './prefixes'

const local = (uri) => String(uri || '').split(/[/#]/).pop().replace(/^.*:/, '')
const cell = (row, column) => {
  if (!column) return ''
  const v = row?.[column]
  return v === null || v === undefined ? '' : String(v).trim()
}
const MULTI_SEPARATOR = '; '

// ---- packages -------------------------------------------------------------------------

/** Field definitions of a schema in order: [{ path, section, key, def }]. */
export function schemaFields(schema) {
  const out = []
  for (const [section, fields] of Object.entries(schema?.felder || {})) {
    for (const [key, def] of Object.entries(fields || {})) {
      if (!def || typeof def !== 'object' || Array.isArray(def) || !('typ' in def || 'label' in def)) continue
      out.push({ path: `${section}.${key}`, section, key, def })
    }
  }
  return out
}

/** How a field is entered: text, longtext, boolean, single, multi, qualified, object, grid, drawing. */
export function fieldKind(def) {
  if (def.qualifikatoren) return 'qualified'
  switch (def.typ) {
    case 'boolean': return 'boolean'
    case 'single_select': return 'single'
    case 'multi_select': return 'multi'
    case 'object': return 'object'
    case 'array': return 'grid'
    case 'grafik': return 'drawing'
    default: return def.hinweis === 'Freitextfeld' || /Beschreibung|Anmerkung/i.test(def.label || '') ? 'longtext' : 'text'
  }
}

/** The parts of an object field: [{ key, parts: [{ key, kind }] }], part key 'wert' where it has none (the HME's shapes). */
export function objectParts(def) {
  return Object.entries(def.felder || {}).map(([key, sub]) => {
    const parts = []
    if (sub && typeof sub === 'object') {
      if ('typ' in sub && Object.keys(sub).length <= 2) {
        parts.push({ key: 'wert', kind: sub.typ === 'boolean' ? 'boolean' : 'text' })
        for (const [k, v] of Object.entries(sub)) if (k !== 'typ' && typeof v === 'string') parts.push({ key: k, kind: 'text' })
      } else {
        for (const [k, v] of Object.entries(sub)) {
          const t = typeof v === 'object' && v !== null ? v.typ : v
          parts.push({ key: k, kind: t === 'boolean' ? 'boolean' : 'text' })
        }
      }
    }
    return { key, parts }
  })
}

/**
 * A package from its files (parsed JSON; `template` an ArrayBuffer/Uint8Array or
 * null). Returns { ...package, problems } — problems a package can be used with
 * are warnings, the rest errors.
 */
export function readPackage({ protocol, schema, bindings, pdfFields = null, template = null }) {
  const problems = []
  if (!protocol?.id) problems.push({ severity: 'error', message: 'protocol.json names no id.' })
  if (!schema?.felder) problems.push({ severity: 'error', message: 'schema.json has no fields ("felder").' })
  if (!bindings?.unit?.class) problems.push({ severity: 'error', message: 'bindings.json names no class for the units.' })
  const fields = schemaFields(schema)
  const paths = new Set(fields.map((f) => f.path))
  for (const f of fields) {
    if (fieldKind(f.def) === 'grid') continue
    if (!bindings?.fields?.[f.path] && !bindings?.columns?.[f.path]) problems.push({ severity: 'warning', message: `${f.path} has neither a path in the mapping nor a column.` })
  }
  for (const p of Object.keys(bindings?.fields || {})) if (!paths.has(p)) problems.push({ severity: 'warning', message: `bindings.json binds ${p}, which the schema does not have.` })
  for (const p of Object.keys(pdfFields?.fields || {})) if (!paths.has(p)) problems.push({ severity: 'warning', message: `pdf-fields.json fills ${p}, which the schema does not have.` })
  return { id: protocol?.id, protocol, schema, bindings, pdfFields, template, fields, problems }
}

// ---- matching a package against a mapping ------------------------------------------------

/** The entity a package's units are, by its class: the one with the matrix relation first. */
export function unitEntityFor(model, cls) {
  const ofClass = (e) => e && local(e.classUri) === cls
  for (const rel of model.dot1Relations) {
    const e = model.entities.get(rel.source)
    if (ofClass(e)) return e
  }
  return [...model.entities.values()].find(ofClass) || null
}

const hintOf = (node) => [node.explorerLabel, node.labelColumn, node.idColumn, node.valueColumn, node.rdfsLabel, node.classLabel]
  .filter(Boolean).join(' ').toLowerCase()

/**
 * One step of a path from `from` (an entity): the entity or literal it reaches,
 * or null. A hint must be met — a unit's P2 has type is its interpretation only
 * where the node says so, not whichever type the unit has.
 */
export function stepFrom(model, from, step, last) {
  const p = local(step.p)
  const c = step.c
  let candidates = []
  if (step.inverse) {
    candidates = model.relations
      .filter((r) => r.target === from.nodeId && local(r.propertyUri) === p)
      .map((r) => ({ node: model.entities.get(r.source), rel: r }))
      .filter((x) => x.node && local(x.node.classUri) === c)
  } else {
    candidates = model.relations
      .filter((r) => r.source === from.nodeId && local(r.propertyUri) === p)
      .map((r) => ({ node: model.entities.get(r.target), rel: r }))
      .filter((x) => x.node && local(x.node.classUri) === c)
    if (last) {
      const lits = model.literalEdges
        .filter((le) => le.source === from.nodeId && local(le.propertyUri) === p)
        .map((le) => ({ node: model.literals.get(le.literalNodeId), rel: le, literal: true }))
        .filter((x) => x.node && local(x.node.classUri).toLowerCase().includes(c.toLowerCase()))
      candidates = candidates.concat(lits)
    }
  }
  if (step.hint) {
    // One hint, or a list of them — any will do ("stratigrafische Einheit", "SU description").
    const hints = [].concat(step.hint).map((h) => String(h).toLowerCase())
    candidates = candidates.filter((x) => hints.some((h) => hintOf(x.node).includes(h)))
  }
  return candidates.length === 1 ? candidates[0] : null
}

/** Column names the mapping reads in a table — a column of our own must not be one of them. */
function mappedColumns(model, tableId) {
  const out = new Set()
  for (const e of model.entities.values()) if (e.tableId === tableId) { if (e.idColumn) out.add(e.idColumn); if (e.labelColumn) out.add(e.labelColumn) }
  for (const l of model.literals.values()) if (l.tableId === tableId && l.valueColumn) out.add(l.valueColumn)
  for (const r of [...model.relations, ...model.dot1Relations, ...model.literalEdges]) { if (r.joinSource) out.add(r.joinSource); if (r.joinTarget) out.add(r.joinTarget) }
  return out
}

/**
 * Where one part of a field is kept, from the node bound to it: a literal's
 * column; an entity's label column, with its identifier made from the value
 * (`<explorer name>_<value>`, so the same value is the same node — a type).
 */
function slotOf(model, nodeId) {
  if (!nodeId) return null
  const lit = model.literals.get(nodeId)
  if (lit) return lit.valueColumn ? { column: lit.valueColumn } : null
  const e = model.entities.get(nodeId)
  if (!e) return null
  const prefix = LOCAL(e.explorerLabel || local(e.classUri)) || 'Typ'
  if (e.labelColumn && e.idColumn && e.labelColumn !== e.idColumn) return { column: e.labelColumn, idColumn: e.idColumn, idPrefix: prefix }
  if (e.idColumn) return { column: e.idColumn, idOnly: true }
  return null
}

/** The slots of a field bound part by part: { main, quals, parts } as its kind has them. */
function slotsOf(model, def, parts = {}) {
  const kind = fieldKind(def)
  if (kind === 'qualified') {
    return { main: slotOf(model, parts.main), quals: Object.fromEntries(Object.keys(def.qualifikatoren).map((q) => [q, slotOf(model, parts[q])])) }
  }
  if (kind === 'object') {
    return { parts: Object.fromEntries(objectParts(def).map((sub) => [sub.key, Object.fromEntries(sub.parts.map((part) => [part.key, slotOf(model, parts[`${sub.key}.${part.key}`])]))])) }
  }
  return { main: slotOf(model, parts.main) }
}

const slotsIn = (storage) => [
  storage.main,
  ...Object.values(storage.quals || {}),
  ...Object.values(storage.parts || {}).flatMap((p) => Object.values(p)),
].filter(Boolean)

/**
 * A field's path in bindings.json, followed from the unit through the mapping.
 * @returns {object|null} { how: 'mapped', … } or { how: 'elsewhere', node }, null where the path ends
 */
export function resolvePath(model, pkg, unit, f) {
  const b = pkg.bindings.fields?.[f.path]
  if (!b?.path) return null
  const steps = pkg.bindings.steps || {}
  let at = unit
  const chain = []
  for (let i = 0; i < b.path.length; i++) {
    const s = b.path[i]
    const step = typeof s === 'string' ? steps[s] : s
    if (!step) return null
    const hit = stepFrom(model, at, step, i === b.path.length - 1)
    if (!hit) return null
    chain.push({ node: hit.node, literal: !!hit.literal, joined: !!(hit.rel.joinSource && hit.rel.joinTarget), step })
    at = hit.node
  }
  if (chain.some((c) => c.joined || c.node.tableId !== unit.tableId)) return { how: 'elsewhere', node: chain[chain.length - 1].node }
  const end = chain[chain.length - 1]
  return {
    how: 'mapped',
    value: b.value || (end.literal ? 'literal' : 'label'),
    scope: b.scope || 'unit',
    end: end.node,
    endLiteral: end.literal,
    id: b.id || '',
    via: chain.slice(0, -1).map((c) => ({ node: c.node, id: c.step.id || '', label: c.step.label || '', scope: c.step.scope || 'unit', recorded: !!c.step.recorded })),
    endStep: end.step,
  }
}

/** Is a field filled in by the Navigator itself — the matrix's grid, the unit's name? */
export function isDerived(pkg, f) {
  const b = pkg.bindings.fields?.[f.path]
  return !!(b?.derived || b?.unitLabel || fieldKind(f.def) === 'grid')
}

/**
 * Where each field of `pkg` lives in this project, by its binding (see the
 * head of this file; lib/protocolBinding.js makes one).
 * @returns {{ pkg, unit, fields: Map<path, resolution>, counts, protocolColumn } | { pkg, error, unbound? }}
 */
export function matchPackage(model, pkg, binding) {
  if (!binding) return { pkg, error: 'This protocol is not bound to the project yet.', unbound: true }
  const unit = (binding.unitNodeId && model.entities.get(binding.unitNodeId)) || unitEntityFor(model, pkg.bindings.unit?.class)
  if (!unit) return { pkg, error: `The mapping has no ${pkg.bindings.unit?.class || 'class'} for this protocol's units.` }
  const taken = mappedColumns(model, unit.tableId)
  const fields = new Map()
  const counts = { mapped: 0, omitted: 0, derived: 0, elsewhere: 0, lost: 0 }
  const scopeOf = (f) => pkg.bindings.fields?.[f.path]?.scope || (f.section === 'kopfdaten' ? 'project' : 'unit')
  for (const f of pkg.fields) {
    const b = pkg.bindings.fields?.[f.path]
    if (b?.derived || fieldKind(f.def) === 'grid') { fields.set(f.path, { how: 'derived', derived: b?.derived || 'matrix' }); counts.derived++; continue }
    if (b?.unitLabel) { fields.set(f.path, { how: 'unitLabel' }); counts.derived++; continue }
    const choice = binding.fields?.[f.path]
    if (choice?.use === 'package') {
      const res = resolvePath(model, pkg, unit, f)
      // A path the mapping no longer has: the field is out until bound again.
      if (!res) { fields.set(f.path, { how: 'omit', lost: true }); counts.lost++; continue }
      fields.set(f.path, res)
      counts[res.how === 'elsewhere' ? 'elsewhere' : 'mapped']++
      continue
    }
    if (choice?.use === 'parts') {
      const storage = slotsOf(model, f.def, choice.parts)
      if (slotsIn(storage).length) { fields.set(f.path, { how: 'parts', storage, scope: scopeOf(f) }); counts.mapped++; continue }
      fields.set(f.path, { how: 'omit', lost: Object.values(choice.parts || {}).some(Boolean) })
      counts[Object.values(choice.parts || {}).some(Boolean) ? 'lost' : 'omitted']++
      continue
    }
    fields.set(f.path, { how: 'omit' })
    counts.omitted++
  }
  const protocolColumn = pkg.bindings.protocolColumn || 'Protokolltyp'
  return { pkg, unit, binding, fields, counts, protocolColumn: taken.has(protocolColumn) ? `${protocolColumn}_Protokoll` : protocolColumn }
}

// ---- templates --------------------------------------------------------------------------

export const LOCAL = (v) => String(v).trim()
  .replace(/[äöüÄÖÜß]/g, (ch) => ({ ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' }[ch]))
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[_-]+|[_-]+$/g, '')

/** "{a|b~local}" templates of bindings.json; '' when any placeholder is empty. */
export function renderBinding(template, ctx) {
  if (!template) return ''
  let empty = false
  const out = String(template).replace(/\{([^}]+)\}/g, (_, body) => {
    const [alts, mod] = body.split('~')
    let v = ''
    for (const alt of alts.split('|')) {
      const name = alt.trim()
      v = name.startsWith('f:') ? flat(ctx.values, name.slice(2)) : String(ctx[name] ?? '')
      if (v) break
    }
    if (!v) { empty = true; return '' }
    return mod === 'local' ? LOCAL(v) : v
  })
  return empty ? '' : out
}

function flat(values, path) {
  const [s, f] = path.split('.')
  const v = values?.[s]?.[f]
  if (v === true) return 'true'
  if (v === null || v === undefined || v === false) return ''
  if (Array.isArray(v)) return v.join(MULTI_SEPARATOR)
  if (typeof v === 'object') return String(v.wert ?? '')
  return String(v).trim()
}

const hasValue = (v) => {
  if (v === null || v === undefined || v === false) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.values(v).some(hasValue)
  return true
}

// ---- units ------------------------------------------------------------------------------

const unitIdOf = (model, unit, raw) => expandId(raw, model.prefixMap, model.idPrefix, unit.noPrefix)

/** The rows that are this unit in the units' table. */
export function unitRows(model, unit, unitId) {
  return (model.tables.get(unit.tableId)?.rows || []).filter((r) => {
    const raw = cell(r, unit.idColumn)
    return raw && unitIdOf(model, unit, raw) === unitId
  })
}

/** The units a protocol can be entered for: every one with a row, by label. [{ id, raw, label }] */
export function protocolUnits(model, match) {
  const { unit } = match
  const seen = new Map()
  for (const row of model.tables.get(unit.tableId)?.rows || []) {
    const raw = cell(row, unit.idColumn)
    if (!raw) continue
    const id = unitIdOf(model, unit, raw)
    if (!seen.has(id)) seen.set(id, { id, raw, label: cell(row, unit.labelColumn) || raw })
  }
  const naturally = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...seen.values()].sort((a, b) => naturally.compare(a.label, b.label))
}

/** The protocol package a unit is recorded on (its key in the protocol column), or ''. */
export function unitProtocol(model, match, unitId) {
  return cell(unitRows(model, match.unit, unitId)[0], match.protocolColumn)
}

// ---- reading ----------------------------------------------------------------------------

function mostCommon(rows, column) {
  const counts = new Map()
  for (const r of rows) { const v = cell(r, column); if (v) counts.set(v, (counts.get(v) || 0) + 1) }
  let best = ''
  let n = 0
  for (const [v, c] of counts) if (c > n) { best = v; n = c }
  return best
}

/** A value kept part by part (slotsOf), in the HME's shape. A part left out reads empty. */
function readSlots(def, storage, getColumn) {
  const get = (slot) => (slot ? getColumn(slot.column) : '')
  const yes = (raw) => raw === 'true' || raw === 'ja' || raw === 'yes'
  const kind = fieldKind(def)
  if (kind === 'boolean') return yes(get(storage.main))
  if (kind === 'multi') return get(storage.main) ? get(storage.main).split(/\s*;\s*/).filter(Boolean) : []
  if (kind === 'qualified') {
    const v = { wert: get(storage.main) }
    for (const [q, slot] of Object.entries(storage.quals)) v[q] = yes(get(slot))
    return v
  }
  if (kind === 'object') {
    const v = {}
    for (const sub of objectParts(def)) {
      v[sub.key] = {}
      for (const part of sub.parts) {
        const raw = get(storage.parts[sub.key]?.[part.key])
        v[sub.key][part.key] = part.kind === 'boolean' ? yes(raw) : raw
      }
    }
    return v
  }
  return get(storage.main)
}

/**
 * The protocol of one unit as the tables hold it.
 * @returns {{ values, protocol: string, label: string, rows: number }}
 */
export function readProtocol(workspace, match, unitId) {
  const { model } = workspace
  const { unit } = match
  const tableRows = model.tables.get(unit.tableId)?.rows || []
  const rows = unitRows(model, unit, unitId)
  const first = rows[0]
  const values = {}
  for (const f of match.pkg.fields) {
    const res = match.fields.get(f.path)
    if (!res || res.how === 'derived' || res.how === 'elsewhere' || res.how === 'omit') continue
    const get = res.scope === 'project' ? (col) => mostCommon(tableRows, col) : (col) => cell(first, col)
    let v
    if (res.how === 'unitLabel') v = cell(first, unit.labelColumn) || cell(first, unit.idColumn)
    else if (res.how === 'parts') v = readSlots(f.def, res.storage, get)
    else if (res.value === 'exists') v = !!get(res.end.idColumn)
    else if (res.value === 'literal' || res.endLiteral) v = get(res.end.valueColumn)
    else v = get(res.end.labelColumn || res.end.idColumn)
    if (!values[f.section]) values[f.section] = {}
    values[f.section][f.key] = v
  }
  return { values, protocol: cell(first, match.protocolColumn), label: cell(first, unit.labelColumn) || cell(first, unit.idColumn), rows: rows.length }
}

// ---- writing ----------------------------------------------------------------------------

function ensureColumns(model, tableId, columns) {
  const t = model.tables.get(tableId)
  for (const c of columns) if (c && !t.columns.includes(c)) t.columns.push(c)
}

/** The cells of a field kept part by part, for the value `v`: each part's column, and an entity's identifier. */
function slotCells(def, storage, v) {
  const out = {}
  const put = (slot, text) => {
    if (!slot) return
    const value = String(text ?? '').trim()
    if (slot.idOnly) { out[slot.column] = value ? LOCAL(value) : ''; return }
    out[slot.column] = value
    if (slot.idColumn) out[slot.idColumn] = value ? `${slot.idPrefix}_${LOCAL(value)}` : ''
  }
  const kind = fieldKind(def)
  if (kind === 'boolean') put(storage.main, v ? 'true' : '')
  else if (kind === 'multi') put(storage.main, Array.isArray(v) ? v.join(MULTI_SEPARATOR) : String(v || ''))
  else if (kind === 'qualified') {
    put(storage.main, v?.wert || '')
    for (const [q, slot] of Object.entries(storage.quals)) put(slot, v?.[q] ? 'true' : '')
  } else if (kind === 'object') {
    for (const sub of objectParts(def)) {
      for (const part of sub.parts) {
        const pv = v?.[sub.key]?.[part.key]
        put(storage.parts[sub.key]?.[part.key], part.kind === 'boolean' ? (pv ? 'true' : '') : pv || '')
      }
    }
  } else put(storage.main, v)
  return out
}

/**
 * Write a unit's protocol: `values` (HME shape) and the package it is recorded
 * on. Fields `values` does not name are left as they are. One journal group —
 * one undo.
 *
 * Identifiers are written where a value is new or changed, or none is there
 * yet; an identifier already standing for an unchanged value is left alone —
 * an object named by the object editor keeps the identifier it was given.
 */
export function writeProtocol(workspace, match, unitId, values, { protocol } = {}) {
  const { model } = workspace
  const { unit } = match
  let rows = unitRows(model, unit, unitId)
  return inGroup(workspace, () => {
    if (!rows.length) return { ok: false, error: 'This unit has no row in the units\' table yet — enter it in the matrix first.' }
    const before = readProtocol(workspace, match, unitId).values
    const first = rows[0]
    const ctx = {
      unit: cell(first, unit.idColumn),
      unitLabel: cell(first, unit.labelColumn) || cell(first, unit.idColumn),
      unitNumber: (cell(first, unit.labelColumn) || cell(first, unit.idColumn)).replace(/^SU\s*/i, '').trim(),
      values,
    }
    const unitCells = {} // column -> value, on the unit's rows
    const projectCells = {} // column -> value, on every row of the table
    const needed = new Map() // intermediate node id -> { node, id, label, need }
    const holdsValue = new Set() // nodes that are a field with a value: they stay, whatever hangs off them
    const changed = (f) => JSON.stringify(values?.[f.section]?.[f.key] ?? '') !== JSON.stringify(before?.[f.section]?.[f.key] ?? '')
    // Does the unit's own protocol hold anything? Then a node that stands for
    // the protocol itself (a step marked `recorded`, the SE-Protokoll) is there.
    const recordedAny = match.pkg.fields.some((f) => {
      const res = match.fields.get(f.path)
      if (!res || res.scope === 'project' || ['derived', 'elsewhere', 'unitLabel', 'omit'].includes(res.how)) return false
      const given = values?.[f.section]?.[f.key] !== undefined
      return hasValue(given ? values[f.section][f.key] : before?.[f.section]?.[f.key])
    })

    for (const f of match.pkg.fields) {
      const res = match.fields.get(f.path)
      if (!res || res.how === 'derived' || res.how === 'elsewhere' || res.how === 'unitLabel' || res.how === 'omit') continue
      // A field not given is left as it is — and still holds up the nodes it hangs off.
      const given = values?.[f.section]?.[f.key] !== undefined
      const v = given ? values[f.section][f.key] : before?.[f.section]?.[f.key]
      const target = given ? (res.scope === 'project' ? projectCells : unitCells) : {}
      if (res.how === 'parts') {
        Object.assign(target, slotCells(f.def, res.storage, v))
        continue
      }
      const present = hasValue(v)
      for (const via of res.via) {
        // A field of the whole project passes the unit's own nodes (the Kopfdaten
        // reach the excavation through the unit's trench) without writing them.
        if (res.scope === 'project' && via.scope !== 'project') continue
        const n = needed.get(via.node.nodeId) || { node: via.node, id: via.id, label: via.label, need: false, scope: via.scope }
        n.need = n.need || present || (via.recorded && recordedAny)
        needed.set(via.node.nodeId, n)
      }
      const end = res.end
      if (res.value === 'exists') {
        const n = needed.get(end.nodeId) || { node: end, id: res.endStep.id || '', label: res.endStep.label || '', need: false, scope: res.scope }
        n.need = n.need || !!v
        needed.set(end.nodeId, n)
        continue
      }
      const text = typeof v === 'string' ? v.trim() : given ? flat(values, f.path) : flat(before, f.path)
      if (text) holdsValue.add(end.nodeId)
      if (res.value === 'literal' || res.endLiteral) {
        target[end.valueColumn] = text
        continue
      }
      if (end.labelColumn && end.labelColumn !== end.idColumn) target[end.labelColumn] = text
      const current = res.scope === 'project' ? '' : cell(first, end.idColumn)
      if (!text) target[end.idColumn] = ''
      else if (changed(f) || !current) target[end.idColumn] = renderBinding(res.id, { ...ctx, value: text }) || (end.labelColumn ? LOCAL(text) : text)
    }
    // The nodes on the way: there while a field hangs off them, gone when none does.
    for (const n of needed.values()) {
      const target = n.scope === 'project' ? projectCells : unitCells
      if (n.node.idColumn in target || holdsValue.has(n.node.nodeId)) continue // the node is itself a field, written above
      const current = cell(first, n.node.idColumn)
      if (!n.need) {
        target[n.node.idColumn] = ''
        if (n.node.labelColumn && n.node.labelColumn !== n.node.idColumn) target[n.node.labelColumn] = ''
      } else if (!current) {
        target[n.node.idColumn] = renderBinding(n.id, ctx)
        if (n.node.labelColumn && n.node.labelColumn !== n.node.idColumn) target[n.node.labelColumn] = renderBinding(n.label, ctx)
      }
    }
    if (protocol !== undefined) unitCells[match.protocolColumn] = protocol

    ensureColumns(model, unit.tableId, [...Object.keys(unitCells), ...Object.keys(projectCells)])
    let written = 0
    for (const row of rows) {
      for (const [column, value] of Object.entries(unitCells)) if (setCell(workspace, unit.tableId, rowIdOf(row), column, value, { source: 'form' })) written++
    }
    if (Object.keys(projectCells).length) {
      for (const row of model.tables.get(unit.tableId).rows) {
        for (const [column, value] of Object.entries(projectCells)) if (setCell(workspace, unit.tableId, rowIdOf(row), column, value, { source: 'form' })) written++
      }
    }
    return { ok: true, written }
  })
}

/** An empty protocol in the schema's shape — for a unit with nothing recorded yet. */
export function emptyProtocol(pkg) {
  const values = {}
  for (const f of pkg.fields) {
    const kind = fieldKind(f.def)
    let v = ''
    if (kind === 'boolean') v = false
    else if (kind === 'multi') v = []
    else if (kind === 'qualified') v = { wert: '', ...Object.fromEntries(Object.keys(f.def.qualifikatoren).map((q) => [q, false])) }
    else if (kind === 'object') v = Object.fromEntries(objectParts(f.def).map((s) => [s.key, Object.fromEntries(s.parts.map((p) => [p.key, p.kind === 'boolean' ? false : '']))]))
    else if (kind === 'grid') continue
    if (!values[f.section]) values[f.section] = {}
    values[f.section][f.key] = v
  }
  return values
}


/**
 * A package from its files by name ({ 'protocol.json': text|bytes, … }), as
 * a folder or a zip holds them; names may carry a folder in front.
 */
export function packageFromFiles(files) {
  const byName = {}
  for (const [name, content] of Object.entries(files)) byName[name.split('/').pop().toLowerCase()] = content
  const text = (n) => {
    const c = byName[n]
    if (c === undefined) return null
    return typeof c === 'string' ? c : new TextDecoder().decode(c)
  }
  const json = (n) => {
    const t = text(n)
    return t === null ? null : JSON.parse(t.replace(/^﻿/, ''))
  }
  return readPackage({
    protocol: json('protocol.json'),
    schema: json('schema.json'),
    bindings: json('bindings.json'),
    pdfFields: json('pdf-fields.json'),
    template: byName['template.pdf'] && typeof byName['template.pdf'] !== 'string' ? byName['template.pdf'] : null,
  })
}
