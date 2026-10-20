/**
 * A Harris matrix from GraphML (yEd, the Harris Matrix Editor, or exported
 * here) — read by the views' reader (views/lib/matrixGraphml.js) and handed on
 * as an HME project, so it becomes a project on the BDA mapping exactly as an
 * HME file does (lib/hmeImport.js): units, relations of every kind, phases,
 * objects and their groups, unit types.
 */

import { readMatrixGraphML } from '../views/lib/matrixGraphml'

export function graphmlToHme(text) {
  const m = readMatrixGraphML(text)
  const objectOf = new Map()
  for (const o of m.objects) for (const u of o.units) if (!objectOf.has(u)) objectOf.set(u, o)
  return {
    version: '1.2',
    source: 'GraphML',
    nodes: m.units.map((u) => {
      const o = objectOf.get(u.gid)
      return {
        id: u.gid,
        label: u.label,
        description: u.description || '',
        type: u.type || '',
        phase: u.phase || '',
        protocol: 'standard',
        // The group of the unit's object is the BDA form's object group.
        se: o?.group ? { befunddaten: { Objgr_Nr: o.group } } : {},
      }
    }),
    edges: m.relations.map((r, i) => ({ id: `e${i + 1}`, source: r.a, target: r.b, kind: r.kind })),
    phases: m.phases.map((p) => ({ id: p.gid, name: p.label, color: p.color })),
    objects: m.objects.map((o) => ({ id: o.gid, name: o.label, color: o.color, nodeIds: o.units })),
  }
}
