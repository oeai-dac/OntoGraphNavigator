// Phases in the Harris matrix: which units belong to which phase, in which
// order the phases come, and a layout that stacks the matrix phase by phase.
//
// Read from the graph alone, as any other view does: a phase is a node the
// units point at through one property -- by default CIDOC CRM's
// P10_falls_within to an E4_Period --, and the order of the phases comes from
// P120_occurs_before between them (the earlier phase occurs before the later).
// Without P120 the phases are ordered by their names, naturally ("Phase 2"
// before "Phase 10").
//
// Order convention, as in the Harris Matrix Editor: phases[0] is the YOUNGEST,
// drawn at the top.

import { layoutHarrisMatrix } from './dagreLayout.js'

const DOT1_MARK = '#dot1:'
const naturally = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const baseOf = (key) => key.split('#as:')[0].split(DOT1_MARK)[0]

/**
 * Properties the units could be phased by: every non-stratigraphic relation
 * they have, best guesses first -- P10 falls within, then any relation to an
 * E4 Period, then the rest. [{ key, count }]
 */
export function phaseCandidates(graph, unitIds) {
  const counts = new Map()
  for (const id of unitIds) {
    for (const [key, targets] of Object.entries(graph?.nodes?.[id]?.o || {})) {
      if (key.includes(DOT1_MARK) || !targets.length) continue
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  const score = (key) => {
    if (/P10_falls_within/.test(baseOf(key))) return 0
    for (const id of unitIds) {
      const t = graph.nodes[id]?.o?.[key]?.[0]
      if (t) return /E4_Period/.test(graph.nodes[t]?.t || '') ? 1 : 2
    }
    return 2
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count, score: score(key) }))
    .sort((a, b) => a.score - b.score || b.count - a.count)
}

/** The property phases are read from by default, or '' when nothing looks like one. */
export function defaultPhaseKey(graph, unitIds) {
  const best = phaseCandidates(graph, unitIds)[0]
  return best && best.score < 2 ? best.key : ''
}

/**
 * The phases of these units through `key`.
 * @returns {{ phases: [{id, label}], phaseOf: Map<unitId, phaseId>, rankOf: Map<phaseId, index>, ordered: 'P120'|'name' }}
 *   phases youngest first; rankOf gives each phase its index in that list.
 */
export function readPhases(graph, unitIds, key, extraPhases = []) {
  const phaseOf = new Map()
  const ids = new Set(extraPhases.map((p) => p.id))
  const labels = new Map(extraPhases.map((p) => [p.id, p.label]))
  for (const id of unitIds) {
    const target = graph?.nodes?.[id]?.o?.[key]?.[0]
    if (!target) continue
    phaseOf.set(id, target)
    ids.add(target)
  }
  for (const id of ids) if (!labels.has(id)) labels.set(id, graph.nodes[id]?.l || id)

  // P120 occurs before: earlier -> later, among the phases found.
  const later = new Map([...ids].map((id) => [id, []]))
  const indegree = new Map([...ids].map((id) => [id, 0]))
  let stated = 0
  for (const id of ids) {
    for (const [k, targets] of Object.entries(graph?.nodes?.[id]?.o || {})) {
      if (!/P120_occurs_before/.test(baseOf(k))) continue
      for (const t of targets) {
        if (!ids.has(t) || t === id) continue
        later.get(id).push(t)
        indegree.set(t, indegree.get(t) + 1)
        stated++
      }
    }
  }
  const byName = (a, b) => naturally.compare(labels.get(a), labels.get(b))
  let oldestFirst
  if (stated) {
    // Kahn, ties by name; whatever a cycle leaves over goes last, by name.
    const ready = [...ids].filter((id) => !indegree.get(id)).sort(byName)
    oldestFirst = []
    while (ready.length) {
      const id = ready.shift()
      oldestFirst.push(id)
      for (const t of later.get(id)) {
        indegree.set(t, indegree.get(t) - 1)
        if (!indegree.get(t)) {
          ready.push(t)
          ready.sort(byName)
        }
      }
    }
    const rest = [...ids].filter((id) => !oldestFirst.includes(id)).sort(byName)
    oldestFirst.push(...rest)
  } else {
    // Names alone: "Phase 1" is taken as the oldest, as phases are usually numbered.
    oldestFirst = [...ids].sort(byName)
  }
  const phases = oldestFirst.reverse().map((id) => ({ id, label: labels.get(id) }))
  return {
    phases,
    phaseOf,
    rankOf: new Map(phases.map((p, i) => [p.id, i])),
    ordered: stated ? 'P120' : 'name',
  }
}

const LANE_GAP = 70 // between two phases
const LANE_PAD = 26 // around the units of a phase, inside its lane
const ROW_GAP = 40 // between two rows of units inside a phase

/**
 * The matrix laid out phase by phase: each phase a band, youngest on top,
 * units without a phase at the bottom.
 *
 * Where a unit stands left to right comes from the layout of the *whole*
 * matrix (layoutHarrisMatrix, with `nest` keeping the units of an object
 * together); the phases only move units up or down. Inside a band the units
 * keep the order of their heights in the whole matrix, in as many rows as
 * they need. So a unit given a phase only slides vertically into its band,
 * and the matrix keeps its columns -- three trenches stay three columns,
 * whichever unit was put into a phase first.
 *
 * @returns {{ positions, width, height, lanes: [{ id, label, x, y, w, h }] }}
 */
export function layoutByPhase(unitIds, phaseModel, rankEdges, sameRankEdges, equalsEdges, nest = null) {
  const whole = layoutHarrisMatrix(unitIds, rankEdges, sameRankEdges, equalsEdges, nest)
  const { width, height } = whole
  const groups = phaseModel.phases.map((p) => ({ id: p.id, label: p.label, members: [] }))
  const index = new Map(groups.map((g, i) => [g.id, i]))
  const none = { id: null, label: 'No phase', members: [] }
  for (const id of unitIds) {
    const p = phaseModel.phaseOf.get(id)
    if (p !== undefined && index.has(p)) groups[index.get(p)].members.push(id)
    else none.members.push(id)
  }
  if (none.members.length) groups.push(none)

  let minX = Infinity
  let maxX = -Infinity
  for (const id of unitIds) {
    const p = whole.positions[id]
    if (!p) continue
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x + width)
  }
  if (!Number.isFinite(minX)) { minX = 0; maxX = width }

  const positions = {}
  const lanes = []
  const pitch = height + ROW_GAP
  let y = 0
  for (const g of groups) {
    // The rows of this band: the distinct heights of its units in the whole matrix.
    const heights = [...new Set(g.members.map((id) => Math.round(whole.positions[id].y)))].sort((a, b) => a - b)
    const rowOf = new Map(heights.map((h, i) => [h, i]))
    const rows = new Map()
    for (const id of g.members) {
      const r = rowOf.get(Math.round(whole.positions[id].y))
      positions[id] = { x: whole.positions[id].x, y: y + LANE_PAD + r * pitch }
      if (!rows.has(r)) rows.set(r, [])
      rows.get(r).push(id)
    }
    // Two units the whole matrix keeps apart by height may land in one row: never on top of each other.
    for (const ids of rows.values()) {
      ids.sort((a, b) => positions[a].x - positions[b].x)
      for (let i = 1; i < ids.length; i++) {
        const prev = positions[ids[i - 1]]
        if (positions[ids[i]].x < prev.x + width + 10) positions[ids[i]].x = prev.x + width + 10
        maxX = Math.max(maxX, positions[ids[i]].x + width)
      }
    }
    const h = (heights.length ? heights.length * pitch - ROW_GAP : height) + 2 * LANE_PAD
    lanes.push({ id: g.id, label: g.label, x: minX - LANE_PAD * 4, y, h })
    y += h + LANE_GAP
  }
  for (const lane of lanes) lane.w = maxX - minX + LANE_PAD * 5
  return { positions, width, height, lanes }
}

/**
 * The phase checks of the Harris Matrix Editor, for lib/matrixChecks.js:
 *   error    an older phase above a younger one
 *   warning  a relation that skips phases with no unit between
 *   warning  contemporary / equal units in different phases
 *   warning  units without a phase (when there are phases at all)
 */
export function phaseIssues(unitIds, labelOf, sequence, phaseModel) {
  const { rankEdges = [], sameRankEdges = [], equalsEdges = [] } = sequence
  const { phaseOf, rankOf, phases } = phaseModel
  const issues = []
  if (!phases.length) return issues
  const name = (id) => labelOf(id) || id
  const phaseName = (id) => phases[rankOf.get(id)]?.label || id
  // rankEdges run lower -> higher; the higher unit should be in the same or a younger phase.
  const adj = new Map(unitIds.map((id) => [id, []]))
  for (const e of rankEdges) adj.get(e.target)?.push(e.source) // higher -> lower, to walk down
  for (const e of rankEdges) {
    const upper = e.target
    const lower = e.source
    const pu = phaseOf.get(upper)
    const pl = phaseOf.get(lower)
    if (pu === undefined || pl === undefined) continue
    const ru = rankOf.get(pu)
    const rl = rankOf.get(pl)
    if (ru > rl) {
      issues.push({
        type: 'phase_direction',
        severity: 'error',
        message: `${name(upper)} (${phaseName(pu)}) lies above ${name(lower)} (${phaseName(pl)}): an older phase above a younger`,
        nodeIds: [upper, lower],
        description: 'A unit of an older phase cannot lie above a unit of a younger phase. Either the relation or one of the phases is wrong.',
      })
    } else if (rl - ru > 1) {
      // Skipped phases: is there a way down from upper to lower through a unit of one of them?
      const skipped = new Set(phases.slice(ru + 1, rl).map((p) => p.id))
      const seen = new Set([upper])
      const todo = [...adj.get(upper)].filter((n) => n !== lower)
      let through = false
      while (todo.length && !through) {
        const v = todo.pop()
        if (seen.has(v)) continue
        seen.add(v)
        if (skipped.has(phaseOf.get(v))) through = true
        for (const n of adj.get(v) || []) if (n !== lower) todo.push(n)
      }
      if (!through) {
        issues.push({
          type: 'phase_skip',
          severity: 'warning',
          message: `${name(upper)} above ${name(lower)} skips ${[...skipped].map(phaseName).join(', ')}`,
          nodeIds: [upper, lower],
          description: 'The relation crosses phases without a unit in between — stratigraphy missing, or a unit in the wrong phase?',
        })
      }
    }
  }
  for (const e of [...sameRankEdges.map((x) => ({ ...x, word: 'contemporary with' })), ...equalsEdges.map((x) => ({ ...x, word: 'equal to' }))]) {
    const pa = phaseOf.get(e.source)
    const pb = phaseOf.get(e.target)
    if (pa === undefined || pb === undefined || pa === pb) continue
    issues.push({
      type: 'phase_level',
      severity: 'warning',
      message: `${name(e.source)} (${phaseName(pa)}) is ${e.word} ${name(e.target)} (${phaseName(pb)})`,
      nodeIds: [e.source, e.target],
      description: 'Units on one level would normally belong to one phase.',
    })
  }
  const without = unitIds.filter((id) => !phaseOf.has(id))
  if (without.length && without.length < unitIds.length) {
    issues.push({
      type: 'no_phase',
      severity: 'warning',
      message: without.length === 1 ? `${name(without[0])} has no phase` : `${without.length} units have no phase`,
      nodeIds: without,
      description: 'Assign a phase from the unit\'s stratigraphic position.',
    })
  }
  return issues
}

/**
 * The phases put into an order given from outside -- the editor's list, which
 * knows phases no unit belongs to yet and their place among the others.
 * Phases the graph has beyond that list keep their order, after it.
 */
export function inGivenOrder(phaseModel, given) {
  if (!given?.length) return phaseModel
  const known = new Map(phaseModel.phases.map((p) => [p.id, p]))
  const listed = new Set(given.map((p) => p.id))
  const phases = [
    ...given.map((p) => ({ id: p.id, label: p.label || known.get(p.id)?.label || p.id })),
    ...phaseModel.phases.filter((p) => !listed.has(p.id)),
  ]
  return { ...phaseModel, phases, rankOf: new Map(phases.map((p, i) => [p.id, i])) }
}
