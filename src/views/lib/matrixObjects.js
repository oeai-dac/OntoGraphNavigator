// Objects and object groups in the Harris matrix: which object a unit forms
// part of, and which group an object forms part of.
//
// Read from the graph alone, as the phases are (matrixPhases.js): an object is
// a node the units point at through P46i forms part of -- a wall, a room, a
// grave --, and a group a node the objects point at through P46i in turn (the
// BDA's "Objektgruppe"). Any other property can be chosen instead.
//
// One object per unit is the rule (the BDA protocol has one field for it). A
// unit with more is read with its first and reported by the checks.

const DOT1_MARK = '#dot1:'
const baseOf = (key) => key.split('#as:')[0].split(DOT1_MARK)[0]
const PART_OF = /P46i_forms_part_of/

/**
 * Properties the units could be grouped into objects by: "forms part of"
 * relations to nodes that are not units themselves, most used first. [{ key, count }]
 */
export function objectCandidates(graph, unitIds) {
  const units = new Set(unitIds)
  const counts = new Map()
  for (const id of unitIds) {
    for (const [key, targets] of Object.entries(graph?.nodes?.[id]?.o || {})) {
      if (key.includes(DOT1_MARK) || !PART_OF.test(baseOf(key))) continue
      if (!targets.some((t) => !units.has(t) && graph.nodes[t])) continue
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count)
}

/** The property objects are read from by default, or ''. */
export function defaultObjectKey(graph, unitIds) {
  return objectCandidates(graph, unitIds)[0]?.key || ''
}

/** The "forms part of" property most objects point at their group through, or ''. */
export function defaultGroupKey(graph, objectIds) {
  const counts = new Map()
  const objects = new Set(objectIds)
  for (const id of objectIds) {
    for (const [key, targets] of Object.entries(graph?.nodes?.[id]?.o || {})) {
      if (key.includes(DOT1_MARK) || !PART_OF.test(baseOf(key))) continue
      if (!targets.some((t) => !objects.has(t) && graph.nodes[t])) continue
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
}

const naturally = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * The objects of these units through `key`, and their groups through `groupKey`
 * ('' = the default, null = none).
 * `extra` = { objects: [{id, label, group}], groups: [{id, label}] } from an
 * editor that knows objects and groups no unit belongs to yet.
 *
 * @returns {{ objects: [{id,label}], objectOf: Map<unit, object>, several: Map<unit, object[]>,
 *             groups: [{id,label}], groupOf: Map<object, group>, key, groupKey }}
 */
export function readObjects(graph, unitIds, key, { groupKey = '', extra = null } = {}) {
  const units = new Set(unitIds)
  const objectOf = new Map()
  const several = new Map()
  const labels = new Map()
  for (const o of extra?.objects || []) labels.set(o.id, o.label)
  for (const id of unitIds) {
    const targets = (graph?.nodes?.[id]?.o?.[key] || []).filter((t) => !units.has(t))
    if (!targets.length) continue
    objectOf.set(id, targets[0])
    if (targets.length > 1) several.set(id, targets)
    for (const t of targets) if (!labels.has(t)) labels.set(t, graph.nodes[t]?.l || t)
  }
  const objectIds = [...labels.keys()]
  const gKey = groupKey === null ? '' : groupKey || defaultGroupKey(graph, objectIds)
  const groupOf = new Map()
  const groupLabels = new Map()
  for (const g of extra?.groups || []) groupLabels.set(g.id, g.label)
  const objects = new Set(objectIds)
  for (const id of objectIds) {
    const given = extra?.objects?.find((o) => o.id === id)
    const target = given && 'group' in given
      ? given.group
      : gKey ? (graph?.nodes?.[id]?.o?.[gKey] || []).find((t) => !objects.has(t) && !units.has(t)) : null
    if (!target) continue
    groupOf.set(id, target)
    if (!groupLabels.has(target)) groupLabels.set(target, graph?.nodes?.[target]?.l || target)
  }
  const byLabel = (map) => (a, b) => naturally.compare(map.get(a), map.get(b))
  return {
    objects: objectIds.sort(byLabel(labels)).map((id) => ({ id, label: labels.get(id) })),
    objectOf,
    several,
    groups: [...groupLabels.keys()].sort(byLabel(groupLabels)).map((id) => ({ id, label: groupLabels.get(id) })),
    groupOf,
    key,
    groupKey: gKey,
  }
}

/** The checks: a unit in more than one object (warning). */
export function objectIssues(labelOf, objectModel) {
  const out = []
  const nameOf = new Map(objectModel.objects.map((o) => [o.id, o.label]))
  for (const [unit, objects] of objectModel.several) {
    out.push({
      type: 'several_objects',
      severity: 'warning',
      nodeIds: [unit],
      message: `${labelOf(unit) || unit} forms part of ${objects.length} objects: ${objects.map((o) => nameOf.get(o) || o).join(', ')}`,
      description: 'A unit is expected in one object (one field in the protocol). The matrix keeps it with the first.',
    })
  }
  return out
}

const BOX_PAD = 12 // around the units of an object
const BOX_LABEL = 22 // room for the name above them

/**
 * The frames of objects and groups, from where the units are -- laid out, or
 * moved by hand. With phases, an object with units in two phases gets a frame
 * in each. [{ id, kind: 'object'|'group', phase, x, y, w, h, members }]
 */
export function objectBoxes(positions, width, height, objectModel, phaseModel = null) {
  if (!objectModel) return []
  const scopeOf = (unit) => (phaseModel ? (phaseModel.phaseOf.get(unit) ?? null) : null)
  const objects = new Map() // object + scope -> { id, phase, members }
  for (const [unit, object] of objectModel.objectOf) {
    if (!positions[unit]) continue
    const k = `${object}\u241f${scopeOf(unit)}`
    if (!objects.has(k)) objects.set(k, { id: object, phase: scopeOf(unit), members: [] })
    objects.get(k).members.push(unit)
  }
  const frame = (rects, pad, label) => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const r of rects) {
      x0 = Math.min(x0, r.x)
      y0 = Math.min(y0, r.y)
      x1 = Math.max(x1, r.x + r.w)
      y1 = Math.max(y1, r.y + r.h)
    }
    return { x: x0 - pad, y: y0 - pad - label, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad + label }
  }
  const boxes = []
  for (const o of objects.values()) {
    const rect = frame(o.members.map((u) => ({ x: positions[u].x, y: positions[u].y, w: width, h: height })), BOX_PAD, BOX_LABEL)
    boxes.push({ id: o.id, kind: 'object', phase: o.phase, members: o.members, ...rect })
  }
  const groups = new Map()
  for (const b of [...boxes]) {
    const g = objectModel.groupOf.get(b.id)
    if (g === undefined) continue
    const k = `${g}\u241f${b.phase}`
    if (!groups.has(k)) groups.set(k, { id: g, phase: b.phase, parts: [] })
    groups.get(k).parts.push(b)
  }
  for (const g of groups.values()) {
    const rect = frame(g.parts, BOX_PAD, BOX_LABEL)
    boxes.push({ id: g.id, kind: 'group', phase: g.phase, members: g.parts.flatMap((p) => p.members), ...rect })
  }
  return boxes
}
