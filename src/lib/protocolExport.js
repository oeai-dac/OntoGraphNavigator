/**
 * What a unit's PDF protocol is filled from (lib/protocolPdf.js): its protocol
 * as the tables hold it, its neighbours in the matrix, and what the matrix
 * knows besides — its phase, its object.
 */

import { readProtocol, unitProtocol } from './protocols'
import { matrixRules } from './matrixEditor'
import { statementsOf } from '../views/lib/harrisMatrix'

const firstTarget = (graph, node, pattern) => {
  for (const [key, targets] of Object.entries(node?.o || {})) {
    if (key.includes('#dot1:') || !pattern.test(key.split('#')[0])) continue
    const t = targets.find((x) => graph.nodes[x])
    if (t) return graph.nodes[t].l || t
  }
  return ''
}

/**
 * @returns {{ label, values, above: string[], below: string[], derived: object, packageId: string }}
 */
export function unitForPdf(workspace, graph, matches, unitId, packageId = null) {
  const recorded = unitProtocol(workspace.model, matches[0], unitId)
  const match = matches.find((m) => m.pkg.id === (packageId || recorded)) || matches[0]
  const { values, label } = readProtocol(workspace, match, unitId)
  const node = graph?.nodes?.[unitId]
  const above = []
  const below = []
  const baseProp = matrixRules(workspace).find((r) => r.typeKey === node?.t)?.baseProp || matrixRules(workspace)[0]?.baseProp
  if (graph && baseProp) {
    for (const s of statementsOf(graph, baseProp, unitId)) {
      const name = graph.nodes[s.partner]?.l || s.partner
      if (s.kind === 'higher') below.push(name)
      else if (s.kind === 'lower') above.push(name)
    }
  }
  const naturally = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return {
    label: label || node?.l || unitId,
    values,
    above: above.sort(naturally.compare),
    below: below.sort(naturally.compare),
    derived: {
      'interpretation.vorlaeufige_Datierung': firstTarget(graph, node, /P10_falls_within$/),
      // The object's name where the protocol names no object of its own (in the
      // BDA mapping the object node is the object number: nothing to derive).
      'befunddaten.Objbez': values?.befunddaten?.Objnr ? '' : firstTarget(graph, node, /P46i_forms_part_of$/),
    },
    packageId: match.pkg.id,
    match,
  }
}
