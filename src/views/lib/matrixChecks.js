// Checks on a Harris matrix -- what the Harris Matrix Editor reported, for the
// sequence the Matrix tab draws (lib/harrisMatrix.js: buildSequence).
//
//   error    cycle           A below B below … below A: no order satisfies it
//   error    contradiction   A contemporary with / equal to B, yet one lies
//                            above the other along the sequence
//   warning  unknown         a relation whose word is not in the vocabulary;
//                            drawn, but not used for the order
//   warning  duplicate       two units with the same label
//   warning  isolated        a unit with no stratigraphic relation at all
//   info     redundant       A above C stated, although A above B above C says
//                            it already -- a Harris matrix draws only direct
//                            relations
//
// With phases (lib/matrixPhases.js: readPhases), their checks join in:
// an older phase above a younger, phases skipped, one level across phases,
// units without a phase.
//
// Pure: (nodeIds, labelOf, sequence) -> { issues, counts }. Iterative
// throughout -- a chain of thousands of units must not exhaust the stack.

import { phaseIssues } from './matrixPhases.js'
import { objectIssues } from './matrixObjects.js'

const REDUNDANCY_LIMIT = 3000 // units; above, the per-edge search costs too much to do on every redraw

function adjacency(nodeIds, edges) {
  const adj = new Map(nodeIds.map((id) => [id, []]))
  for (const e of edges) if (adj.has(e.source) && adj.has(e.target)) adj.get(e.source).push(e.target)
  return adj
}

/** Strongly connected components (Tarjan, iterative). A component of more than one unit is a cycle. */
function cycles(nodeIds, adj) {
  let index = 0
  const idx = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const found = []
  for (const start of nodeIds) {
    if (idx.has(start)) continue
    const work = [[start, 0]]
    idx.set(start, index)
    low.set(start, index)
    index++
    stack.push(start)
    onStack.add(start)
    while (work.length) {
      const frame = work[work.length - 1]
      const [v, i] = frame
      const next = adj.get(v) || []
      if (i < next.length) {
        frame[1]++
        const w = next[i]
        if (!idx.has(w)) {
          idx.set(w, index)
          low.set(w, index)
          index++
          stack.push(w)
          onStack.add(w)
          work.push([w, 0])
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), idx.get(w)))
        }
        continue
      }
      work.pop()
      if (work.length) {
        const parent = work[work.length - 1][0]
        low.set(parent, Math.min(low.get(parent), low.get(v)))
      }
      if (low.get(v) === idx.get(v)) {
        const component = []
        let w
        do {
          w = stack.pop()
          onStack.delete(w)
          component.push(w)
        } while (w !== v)
        if (component.length > 1) found.push(component.reverse())
      }
    }
  }
  return found
}

/** Is `to` reachable from `from`, optionally not using the direct edge from→to? */
function reachable(adj, from, to, skipDirect = false) {
  const seen = new Set([from])
  const todo = []
  for (const n of adj.get(from) || []) {
    if (skipDirect && n === to) continue
    if (!seen.has(n)) {
      seen.add(n)
      todo.push(n)
    }
  }
  while (todo.length) {
    const v = todo.pop()
    if (v === to) return true
    for (const n of adj.get(v) || []) {
      if (!seen.has(n)) {
        seen.add(n)
        todo.push(n)
      }
    }
  }
  return false
}

export function checkMatrix(nodeIds, labelOf, sequence, { phaseModel, objectModel } = {}) {
  const { rankEdges = [], sameRankEdges = [], equalsEdges = [], unknownEdges = [] } = sequence
  const issues = []
  const name = (id) => labelOf(id) || id
  const adj = adjacency(nodeIds, rankEdges) // lower -> higher

  for (const component of cycles(nodeIds, adj)) {
    issues.push({
      type: 'cycle',
      severity: 'error',
      message: `Cycle: ${component.map(name).join(' → ')} → ${name(component[0])}`,
      nodeIds: component,
      description: 'Each of these lies below the next, and the last below the first — no order can satisfy that. One of the relations is wrong.',
    })
  }

  const levelPairs = [
    ...sameRankEdges.map((e) => ({ ...e, word: 'contemporary with' })),
    ...equalsEdges.map((e) => ({ ...e, word: 'equal to' })),
  ]
  for (const e of levelPairs) {
    const aBelowB = reachable(adj, e.source, e.target)
    const bBelowA = !aBelowB && reachable(adj, e.target, e.source)
    if (!aBelowB && !bBelowA) continue
    const [lower, upper] = aBelowB ? [e.source, e.target] : [e.target, e.source]
    issues.push({
      type: 'contradiction',
      severity: 'error',
      message: `${name(e.source)} is ${e.word} ${name(e.target)}, but ${name(lower)} lies below ${name(upper)}`,
      nodeIds: [e.source, e.target],
      description: 'Units on the same level cannot also lie one above the other through the sequence.',
    })
  }

  for (const e of unknownEdges) {
    issues.push({
      type: 'unknown',
      severity: 'warning',
      message: `${name(e.source)} – ${name(e.target)}: relation of unknown kind`,
      nodeIds: [e.source, e.target],
      description: 'Its word is not in the vocabulary (above, below, contemporary, equals …). It is drawn, but not used for the order.',
    })
  }

  const byLabel = new Map()
  for (const id of nodeIds) {
    const key = String(name(id)).trim().toLowerCase()
    if (!byLabel.has(key)) byLabel.set(key, [])
    byLabel.get(key).push(id)
  }
  for (const ids of byLabel.values()) {
    if (ids.length < 2) continue
    issues.push({
      type: 'duplicate',
      severity: 'warning',
      message: `${ids.length} units are called "${name(ids[0])}"`,
      nodeIds: ids,
      description: 'Different units with the same name are easily mixed up in the matrix and on the recording sheets.',
    })
  }

  const related = new Set()
  for (const e of [...rankEdges, ...sameRankEdges, ...equalsEdges, ...unknownEdges]) {
    related.add(e.source)
    related.add(e.target)
  }
  const isolated = nodeIds.filter((id) => !related.has(id))
  if (isolated.length) {
    issues.push({
      type: 'isolated',
      severity: 'warning',
      message: isolated.length === 1
        ? `${name(isolated[0])} has no stratigraphic relation`
        : `${isolated.length} units have no stratigraphic relation`,
      nodeIds: isolated,
      description: 'A unit outside the sequence has no place in the matrix yet.',
    })
  }

  let redundancySkipped = false
  if (nodeIds.length <= REDUNDANCY_LIMIT) {
    for (const e of rankEdges) {
      if (reachable(adj, e.source, e.target, true)) {
        issues.push({
          type: 'redundant',
          severity: 'info',
          message: `${name(e.target)} above ${name(e.source)} follows from other relations already`,
          nodeIds: [e.source, e.target],
          description: 'A Harris matrix shows direct relations only; this one is implied by a longer path.',
        })
      }
    }
  } else {
    redundancySkipped = true
  }

  if (phaseModel) issues.push(...phaseIssues(nodeIds, labelOf, sequence, phaseModel))
  if (objectModel) issues.push(...objectIssues(labelOf, objectModel))

  const counts = { error: 0, warning: 0, info: 0 }
  for (const issue of issues) counts[issue.severity]++
  return { issues, counts, redundancySkipped }
}
