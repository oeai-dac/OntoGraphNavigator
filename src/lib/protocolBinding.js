/**
 * Binding a recording protocol to a project.
 *
 * A package says what a protocol asks for; the project's mapping says where
 * things live. The binding joins the two, field by field, and is kept with the
 * project's settings (config.protocolBindings, in the .ognproj):
 *
 *   { unitNodeId, fields: { 'section.key': choice } }
 *
 *   { use: 'package' }               the path the package gives (bindings.json);
 *                                    with `create`, what the mapping lacks of it
 *                                    is put there, as the package models it
 *   { use: 'parts', parts: { part: nodeId | null } }
 *                                    a node of the mapping for each part: the
 *                                    value ('main'), each qualifier, each part
 *                                    of an object field ('sub.part')
 *   { use: 'omit' }                  left out
 *
 * proposeBinding suggests one: the package's path where the mapping has it,
 * else a node the unit already carries under the same column or name, else the
 * package's path put into the mapping (P1 is identified by → E41 Appellation …),
 * else — for a field the package has no path for — a new node: text, numbers,
 * yes/no and multiple choices as a literal via
 * P3 has note, a single choice as an E55 Type via P2 has type, its name the
 * field's. applyBinding puts the new nodes into the mapping, as the phase and
 * object editors do, and returns the binding to keep.
 */

import { fieldKind, isDerived, LOCAL, objectParts, resolvePath, stepFrom, unitEntityFor } from './protocols'
import { readProjectFile, writeProjectFile } from './projectFile'
import { inGroup, rowIdOf, setCell } from './edits'

const CRM = 'http://www.cidoc-crm.org/cidoc-crm/'
const CRMARCHAEO = 'http://www.cidoc-crm.org/extensions/crmarchaeo/'
const CRMSCI = 'http://www.cidoc-crm.org/extensions/crmsci/'
const XSD = 'http://www.w3.org/2001/XMLSchema#'
const RDFS_LITERAL = 'http://www.w3.org/2000/01/rdf-schema#Literal'

/** A class or property of a package's path, by its local name: CIDOC CRM and its extensions. */
function crmTerm(name) {
  const n = String(name || '')
  if (/^https?:/.test(n)) return { uri: n, label: local(n) }
  if (/^AP?\d/.test(n)) return { uri: CRMARCHAEO + n, label: `crmarchaeo:${n}` }
  if (/^[SO]\d/.test(n)) return { uri: CRMSCI + n, label: `crmsci:${n}` }
  return { uri: CRM + n, label: `crm:${n}` }
}

/** The last step's class, when it is a value rather than a thing: its datatype. */
function literalType(c) {
  const n = String(c || '')
  if (/^literal$/i.test(n)) return { uri: RDFS_LITERAL, label: 'rdfs:Literal' }
  if (/^date$/i.test(n)) return { uri: `${XSD}date`, label: 'xsd:date' }
  if (/^(string|gYear|dateTime|decimal|integer|boolean)$/.test(n)) return { uri: `${XSD}${n}`, label: `xsd:${n}` }
  if (n.startsWith('xsd:')) return { uri: XSD + n.slice(4), label: n }
  return null
}

const humanTerm = (n) => String(n || '').replace(/_/g, ' ')

/** A package path in words: "P1 is identified by → E41 Appellation". */
function describeModel(pkg, f) {
  const b = pkg.bindings.fields?.[f.path]
  if (!b?.path?.length) return ''
  return b.path.map((s) => {
    const step = typeof s === 'string' ? pkg.bindings.steps?.[s] : s
    if (!step) return '?'
    return `${step.inverse ? '← ' : ''}${humanTerm(step.p)} → ${humanTerm(step.c)}`
  }).join(' · ')
}
const local = (uri) => String(uri || '').split(/[/#]/).pop().replace(/^.*:/, '')
const human = (key) => String(key).replace(/_/g, ' ')
const norm = (s) => LOCAL(String(s || '').toLowerCase()).replace(/[_-]/g, '')
const cell = (row, column) => {
  const v = row?.[column]
  return v === null || v === undefined ? '' : String(v).trim()
}

/** How a part is entered: text, longtext, number, boolean, single, multi, drawing. */
function partKind(f, kind) {
  if (kind === 'text' && /^(number|integer|decimal)$/.test(f.def.typ || '')) return 'number'
  return kind
}

/**
 * The parts of a field, each of which lives in a node of its own:
 * [{ key, label, kind }]. A plain field has one ('main'); a qualified field
 * its value and a yes/no per qualifier; an object field each of its parts.
 */
export function fieldParts(f) {
  const kind = fieldKind(f.def)
  const label = String(f.def.label || f.key).replace(/[\s:]+$/, '')
  if (kind === 'grid') return []
  if (kind === 'qualified') {
    return [
      { key: 'main', label, kind: 'text' },
      ...Object.keys(f.def.qualifikatoren).map((q) => ({ key: q, label: `${label} – ${q}`, kind: 'boolean' })),
    ]
  }
  if (kind === 'object') {
    return objectParts(f.def).flatMap((sub) => sub.parts.map((part) => ({
      key: `${sub.key}.${part.key}`,
      label: `${label} – ${human(sub.key)}${part.key !== 'wert' ? ` (${human(part.key)})` : ''}`,
      kind: part.kind,
    })))
  }
  return [{ key: 'main', label, kind: partKind(f, kind) }]
}

/**
 * The column a new node of this part gets — the name a column of its own had
 * before step 7d, so values kept that way are taken over as they are.
 */
export function partColumn(pkg, f, partKey) {
  const base = pkg.bindings?.columns?.[f.path] || f.key
  if (partKey === 'main') return base
  if (!partKey.includes('.')) return `${base}_${partKey}`
  const [sub, part] = partKey.split('.')
  return part === 'wert' ? `${base}_${sub}` : `${base}_${sub}_${part}`
}

/** The units a protocol can be bound to: every entity of the mapping with a table. */
export function unitOptions(model) {
  return [...model.entities.values()]
    .filter((e) => e.tableId && e.idColumn)
    .map((e) => ({ nodeId: e.nodeId, label: e.explorerLabel || local(e.classUri), className: local(e.classUri) }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * What a part can be bound to among what the units already carry: literals and
 * entities hanging off the unit's node on its own table, without a join.
 * [{ nodeId, kind: 'literal'|'entity', name, column }]
 */
export function bindingCandidates(model, unit) {
  const out = []
  for (const le of model.literalEdges) {
    if (le.source !== unit.nodeId || le.joinSource) continue
    const lit = model.literals.get(le.literalNodeId)
    if (lit && lit.tableId === unit.tableId && lit.valueColumn) out.push({ nodeId: lit.nodeId, kind: 'literal', name: le.attrKey, column: lit.valueColumn })
  }
  for (const r of model.relations) {
    if (r.source !== unit.nodeId || r.joinSource) continue
    const e = model.entities.get(r.target)
    if (!e || e.nodeId === unit.nodeId || e.tableId !== unit.tableId || !(e.labelColumn || e.idColumn)) continue
    out.push({ nodeId: e.nodeId, kind: 'entity', name: r.explorerLabel || e.explorerLabel || local(r.propertyUri), className: local(e.classUri), column: e.labelColumn || e.idColumn })
  }
  return out
}

/** Where a field's package path ends, in words — for the dialog. */
function describePath(res) {
  if (!res) return ''
  const node = res.how === 'elsewhere' ? res.node : res.end
  return node.explorerLabel || node.attrKey || local(node.classUri)
}

/**
 * A binding to start from, and what the dialog offers.
 * `previous`: the binding kept so far — what it says stays, where it still holds.
 * @returns {{ unitNodeId, units, candidates, fields: [{ path, section, label, kind, parts, derived, packagePath, choice }] } | { error, units }}
 */
export function proposeBinding(model, pkg, { unitNodeId = null, previous = null } = {}) {
  const units = unitOptions(model)
  const unit = (unitNodeId && model.entities.get(unitNodeId))
    || (previous?.unitNodeId && model.entities.get(previous.unitNodeId))
    || unitEntityFor(model, pkg.bindings?.unit?.class)
  if (!unit) return { error: `The mapping has no ${pkg.bindings?.unit?.class || 'class'} — choose which units this protocol is for.`, units }
  const candidates = bindingCandidates(model, unit)
  const byColumn = new Map(candidates.map((c) => [c.column, c]))
  const byName = new Map(candidates.map((c) => [norm(c.name), c]))
  const names = new Set(candidates.map((c) => norm(c.name)))
  // A new name must differ from every other: the explorer name is the attribute's key.
  const uniqueLabel = (label, fallback) => {
    let name = label
    if (names.has(norm(name))) name = `${label} (${human(fallback)})`
    let i = 2
    while (names.has(norm(name))) name = `${label} (${i++})`
    names.add(norm(name))
    return name
  }

  // A node the units carry is offered to one part only: first where the column
  // is the one the package names, then by name; never a node a path ends in.
  const paths = new Map(pkg.fields.map((f) => [f.path, isDerived(pkg, f) ? null : resolvePath(model, pkg, unit, f)]))
  const used = new Set([...paths.values()].filter((r) => r?.how === 'mapped').map((r) => r.end.nodeId))
  const existingFor = new Map() // 'path|part' -> candidate
  for (const pass of ['column', 'name']) {
    for (const f of pkg.fields) {
      if (paths.get(f.path) || isDerived(pkg, f) || previous?.fields?.[f.path]) continue
      for (const part of fieldParts(f)) {
        const key = `${f.path}|${part.key}`
        if (existingFor.has(key)) continue
        const hit = pass === 'column' ? byColumn.get(partColumn(pkg, f, part.key)) : byName.get(norm(part.label))
        if (hit && !used.has(hit.nodeId)) { existingFor.set(key, hit); used.add(hit.nodeId) }
      }
    }
  }

  const fields = []
  for (const f of pkg.fields) {
    const parts = fieldParts(f)
    const derived = isDerived(pkg, f)
    const path = paths.get(f.path)
    const entry = {
      path: f.path, section: f.section, key: f.key,
      label: String(f.def.label || f.key).replace(/[\s:]+$/, ''),
      kind: fieldKind(f.def), parts, derived,
      packagePath: path ? { how: path.how, name: describePath(path) } : null,
      // The package's path, where the mapping lacks it: put there as the package models it.
      packageModel: !derived && !path && pkg.bindings.fields?.[f.path]?.path?.length ? describeModel(pkg, f) : '',
      choice: null,
    }
    const kept = previous?.fields?.[f.path]
    if (derived) entry.choice = { use: 'auto' }
    else if (kept && keeps(model, kept, path)) entry.choice = toChoice(kept)
    else if (path) entry.choice = { use: 'package' }
    else if (entry.packageModel && !parts.some((part) => existingFor.has(`${f.path}|${part.key}`))) entry.choice = { use: 'package', create: true }
    else {
      const chosen = {}
      for (const part of parts) {
        const existing = existingFor.get(`${f.path}|${part.key}`)
        if (existing) chosen[part.key] = { use: 'node', nodeId: existing.nodeId }
        else if (part.kind === 'drawing') chosen[part.key] = { use: 'omit' }
        else chosen[part.key] = { use: 'new', as: part.kind === 'single' ? 'type' : 'literal', name: uniqueLabel(part.label, partColumn(pkg, f, part.key)) }
      }
      entry.choice = { use: 'parts', parts: chosen }
    }
    fields.push(entry)
  }
  return { unitNodeId: unit.nodeId, units, candidates, fields }
}

/** Does a kept choice still hold in this mapping? */
function keeps(model, kept, path) {
  if (kept.use === 'omit') return true
  if (kept.use === 'package') return !!path
  if (kept.use === 'parts') return Object.values(kept.parts || {}).every((id) => !id || model.literals.has(id) || model.entities.has(id))
  return false
}

/** A kept binding entry as a dialog choice. */
function toChoice(kept) {
  if (kept.use !== 'parts') return { use: kept.use }
  return { use: 'parts', parts: Object.fromEntries(Object.entries(kept.parts || {}).map(([k, id]) => [k, id ? { use: 'node', nodeId: id } : { use: 'omit' }])) }
}

/** How many fields a set of choices binds where, for the dialog's footer. */
export function summarizeChoices(fields) {
  const out = { package: 0, modelled: 0, existing: 0, created: 0, omitted: 0, auto: 0 }
  for (const f of fields) {
    const c = f.choice
    if (!c || c.use === 'omit') out.omitted++
    else if (c.use === 'auto') out.auto++
    else if (c.use === 'package' && c.create) out.modelled++
    else if (c.use === 'package') out.package++
    else {
      const parts = Object.values(c.parts || {})
      if (parts.every((p) => p.use === 'omit')) out.omitted++
      else {
        out.created += parts.filter((p) => p.use === 'new').length
        if (parts.some((p) => p.use === 'node')) out.existing++
      }
    }
  }
  return out
}

const uniqueName = (base, taken) => {
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}_${i}`)) i++
  return `${base}_${i}`
}

/**
 * Put a binding in place: the new nodes into the mapping (on the units' table,
 * hanging off the unit node), and the binding to keep.
 *
 * `choices`: { unitNodeId, fields: { path: choice } } — choices as
 * proposeBinding makes them, `new` parts with `as` ('literal' | 'type') and
 * `name` (the explorer name).
 *
 * A change of the mapping — like adding phases, not an undoable edit. The
 * identifiers of new types, for values a column already holds, are filled in
 * as one undoable edit.
 * @returns {{ ok, binding, created } | { ok: false, error }}
 */
export function applyBinding(workspace, pkg, choices) {
  const { model } = workspace
  const unit = model.entities.get(choices.unitNodeId)
  if (!unit) return { ok: false, error: 'The units chosen for this protocol are not in the mapping.' }
  const table = model.tables.get(unit.tableId)
  if (!table) return { ok: false, error: 'The units have no table.' }

  const binding = { unitNodeId: unit.nodeId, fields: {} }
  const wanted = [] // { path, partKey, as, name, column, kind }
  const modelled = [] // fields whose package path goes into the mapping
  for (const f of pkg.fields) {
    const choice = choices.fields?.[f.path]
    if (!choice || choice.use === 'auto') continue
    if (choice.use === 'package' && choice.create) modelled.push(f)
    if (choice.use === 'package' || choice.use === 'omit') { binding.fields[f.path] = { use: choice.use }; continue }
    const parts = {}
    const kinds = new Map(fieldParts(f).map((p) => [p.key, p.kind]))
    for (const [key, part] of Object.entries(choice.parts || {})) {
      if (part.use === 'node' && part.nodeId) parts[key] = part.nodeId
      else if (part.use === 'new') {
        parts[key] = null
        wanted.push({ path: f.path, partKey: key, as: part.as === 'type' ? 'type' : 'literal', name: String(part.name || key).trim() || key, column: partColumn(pkg, f, key), kind: kinds.get(key) || 'text' })
      } else parts[key] = null
    }
    binding.fields[f.path] = { use: 'parts', parts }
  }
  if (!wanted.length && !modelled.length) return { ok: true, binding, created: 0 }

  // ---- the new nodes, on the canvas as the Studio draws its own
  const unitNode = model.canvas.nodes.find((n) => n.id === unit.nodeId)
  const at = unitNode?.position || { x: 0, y: 0 }
  const tableName = unitNode?.data?.tableName || table.name || ''
  const nodeIds = new Set(model.canvas.nodes.map((n) => n.id))
  // Columns another node of the mapping reads are taken; a column nobody maps
  // (a protocol's own column from before) is taken over with its values.
  const mapped = new Set()
  for (const e of model.entities.values()) if (e.tableId === unit.tableId) { if (e.idColumn) mapped.add(e.idColumn); if (e.labelColumn) mapped.add(e.labelColumn) }
  for (const l of model.literals.values()) if (l.tableId === unit.tableId && l.valueColumn) mapped.add(l.valueColumn)
  for (const r of [...model.relations, ...model.literalEdges, ...model.dot1Relations]) { if (r.joinSource) mapped.add(r.joinSource); if (r.joinTarget) mapped.add(r.joinTarget) }
  mapped.add('Protokolltyp')

  const template = model.canvas.edges.find((e) => e.data?.propertyUri && !e.data?.isSplitSeg1 && !e.data?.isSplitSeg2 && !e.data?.isDotOne)
  const look = template
    ? Object.fromEntries(['focusable', 'style', 'markerEnd', 'labelStyle', 'labelBgStyle', 'labelBgPadding', 'labelBgBorderRadius'].filter((k) => k in template).map((k) => [k, template[k]]))
    : {}
  const edge = (id, source, target, label, data) => ({ ...look, id, source, target, sourceHandle: 'r-s', targetHandle: 'l-t', label, data: { label, joinColumnSource: null, joinColumnTarget: null, ...data } })
  const common = { rdfs_label: '', instanceLabel: '', isFreeNode: false, tableId: unit.tableId, tableName, tableRows: table.rows }
  const PER_COLUMN = 14
  const typeColumns = [] // { idColumn, labelColumn, prefix }
  let placed = 0
  const nextPosition = () => {
    const i = placed++
    return { x: at.x + 720 + Math.floor(i / PER_COLUMN) * 320, y: at.y - 560 + (i % PER_COLUMN) * 90 }
  }

  // ---- package paths, as the package models them: each step found in the
  // mapping, or made — once, however many fields pass it (Schnitt, Grabung …)
  const madeSteps = new Map() // 'from|step' -> { nodeId, existing }
  const label = (f) => String(f.def.label || f.key).replace(/[\s:]+$/, '')
  const ownerOf = (stepKey) => pkg.fields.find((g) => {
    const path = pkg.bindings.fields?.[g.path]?.path
    return path?.length === 1 && path[0] === stepKey
  })
  const namingOf = (s, step, f, last) => {
    let name
    let column
    if (last) { name = label(f); column = partColumn(pkg, f, 'main') } else if (typeof s === 'string' && ownerOf(s)) {
      const owner = ownerOf(s)
      name = label(owner)
      column = partColumn(pkg, owner, 'main')
    } else {
      name = [].concat(step.hint || [])[0] || (typeof s === 'string' ? s.replace(/^./, (c) => c.toUpperCase()) : local(step.c))
      column = LOCAL(name)
    }
    // The hint is how the path finds the node again.
    const hints = [].concat(step.hint || [])
    if (hints.length && !hints.some((h) => name.toLowerCase().includes(String(h).toLowerCase()))) name = `${name} (${hints[0]})`
    return { name, column }
  }
  let made = 0
  /** Follow a path from the unit: each step found in the mapping, made so far, or — with `f` — made now. */
  const walk = (path, f = null) => {
    let here = { nodeId: unit.nodeId, existing: unit }
    path.forEach((s, i) => {
      const step = typeof s === 'string' ? pkg.bindings.steps?.[s] : s
      if (!step || !here) { here = null; return }
      const last = i === path.length - 1
      const key = `${here.nodeId}|${step.p}|${step.c}|${step.hint || ''}|${step.inverse ? 1 : 0}`
      if (madeSteps.has(key)) { here = madeSteps.get(key); return }
      const hit = here.existing ? stepFrom(model, here.existing, step, last) : null
      if (hit) { here = { nodeId: hit.node.nodeId, existing: hit.literal ? null : hit.node }; madeSteps.set(key, here); return }
      if (!f) { here = null; return }
      const { name, column: base } = namingOf(s, step, f, last && path === pkg.bindings.fields?.[f.path]?.path)
      const datatype = last ? literalType(step.c) : null
      const id = uniqueName(`nProt_${LOCAL(base)}`, nodeIds)
      nodeIds.add(id)
      const column = uniqueName(base, mapped)
      mapped.add(column)
      if (!table.columns.includes(column)) table.columns.push(column)
      if (datatype) {
        model.canvas.nodes.push({ id, type: 'ontologyNode', position: nextPosition(), data: { ...common, label: datatype.label, uri: datatype.uri, nodeType: 'subject', nodeColor: '#86bcc8', mappedColumn: column, labelColumn: column, noPrefix: true, explorerLabel: name } })
      } else {
        const idColumn = uniqueName(`${column}_uri`, new Set([...mapped, ...table.columns]))
        mapped.add(idColumn)
        table.columns.push(idColumn)
        const cls = crmTerm(step.c)
        model.canvas.nodes.push({ id, type: 'ontologyNode', position: nextPosition(), data: { ...common, label: cls.label, uri: cls.uri, nodeType: 'object', nodeColor: '#fab565', mappedColumn: idColumn, labelColumn: column, noPrefix: false, explorerLabel: name } })
      }
      const prop = crmTerm(step.p)
      const [source, target] = step.inverse ? [id, here.nodeId] : [here.nodeId, id]
      model.canvas.edges.push(edge(`e_${source}_${target}`, source, target, prop.label, { propertyUri: prop.uri, explorerLabel: datatype ? name : '' }))
      made++
      here = { nodeId: id, existing: null }
      madeSteps.set(key, here)
    })
    return here
  }
  for (const f of modelled) walk(pkg.bindings.fields?.[f.path]?.path || [], f)
  // Relations between the package's nodes that no field runs along (Schnitt contains Objektgruppe).
  if (modelled.length) {
    for (const link of pkg.bindings.links || []) {
      const from = walk(link.from)
      const to = walk(link.to)
      if (!from || !to) continue
      const prop = crmTerm(link.p)
      const there = model.canvas.edges.some((e) => e.source === from.nodeId && e.target === to.nodeId && String(e.data?.propertyUri || e.data?.label || '').endsWith(link.p))
      if (!there) model.canvas.edges.push(edge(`e_${from.nodeId}_${to.nodeId}_${LOCAL(link.p)}`, from.nodeId, to.nodeId, prop.label, { propertyUri: prop.uri, explorerLabel: '' }))
    }
  }

  wanted.forEach((w) => {
    const column = uniqueName(w.column, mapped)
    mapped.add(column)
    if (!table.columns.includes(column)) table.columns.push(column)
    const id = uniqueName(`nProt_${LOCAL(column)}`, nodeIds)
    nodeIds.add(id)
    const position = nextPosition()
    if (w.as === 'type') {
      const idColumn = uniqueName(`${column}_ID`, new Set([...mapped, ...table.columns]))
      mapped.add(idColumn)
      table.columns.push(idColumn)
      model.canvas.nodes.push({ id, type: 'ontologyNode', position, data: { ...common, label: 'crm:E55_Type', uri: `${CRM}E55_Type`, nodeType: 'object', nodeColor: '#fab565', mappedColumn: idColumn, labelColumn: column, noPrefix: false, explorerLabel: w.name } })
      model.canvas.edges.push(edge(`e_${unit.nodeId}_${id}`, unit.nodeId, id, 'P2_has_type', { propertyUri: `${CRM}P2_has_type`, explorerLabel: w.name }))
      typeColumns.push({ idColumn, labelColumn: column, prefix: LOCAL(w.name) || 'Typ' })
    } else {
      const datatype = w.kind === 'boolean' ? 'boolean' : w.kind === 'number' ? 'decimal' : 'string'
      model.canvas.nodes.push({ id, type: 'ontologyNode', position, data: { ...common, label: `xsd:${datatype}`, uri: `${XSD}${datatype}`, nodeType: 'subject', nodeColor: '#86bcc8', mappedColumn: column, labelColumn: column, noPrefix: true, explorerLabel: w.name } })
      model.canvas.edges.push(edge(`e_${unit.nodeId}_${id}`, unit.nodeId, id, 'P3_has_note', { propertyUri: `${CRM}P3_has_note`, explorerLabel: w.name }))
    }
    binding.fields[w.path].parts[w.partKey] = id
  })
  // The Studio's table summary names the new columns too.
  const summary = Array.isArray(model.fileFields?.tables) ? model.fileFields.tables.find((t) => t.tableId === unit.tableId) : null
  if (summary && Array.isArray(summary.headers)) for (const c of table.columns) if (!summary.headers.includes(c)) summary.headers.push(c)

  // The mapping part of the model read anew from the canvas; the tables — their
  // rows and the identities the journal refers to — stay as they are.
  const fresh = readProjectFile(writeProjectFile(model))
  for (const key of ['entities', 'literals', 'relations', 'literalEdges', 'dot1Relations']) model[key] = fresh[key]
  workspace.materializer = null

  // Types for values already there (a column taken over): their identifiers.
  if (typeColumns.length) {
    inGroup(workspace, () => {
      for (const row of table.rows) {
        for (const t of typeColumns) {
          const label = cell(row, t.labelColumn)
          if (label && !cell(row, t.idColumn)) setCell(workspace, unit.tableId, rowIdOf(row), t.idColumn, `${t.prefix}_${LOCAL(label)}`, { source: 'form' })
        }
      }
    })
  }
  return { ok: true, binding, created: wanted.length + made }
}

/** The proposal as it stands, as choices for applyBinding. */
export function choicesOf(proposal) {
  return { unitNodeId: proposal.unitNodeId, fields: Object.fromEntries(proposal.fields.map((f) => [f.path, f.choice])) }
}

/** Bind with what proposeBinding suggests — for the HME import and the checks. */
export function bindAsProposed(workspace, pkg, options = {}) {
  const proposal = proposeBinding(workspace.model, pkg, options)
  if (proposal.error) return { ok: false, error: proposal.error }
  return applyBinding(workspace, pkg, choicesOf(proposal))
}
