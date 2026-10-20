// The Harris matrix as GraphML for yEd, and back — the Harris Matrix Editor's
// format (io/graphml.js), so a matrix goes to yEd and returns from it:
//
//   units       ShapeNodes; the unit type (layer, deposit, fill, structure,
//               interface) as the HME draws it — its shape and colour — and as
//               data `hme_type`
//   relations   edges, the upper unit the source ("lies above"); contemporary
//               and equal units as undirected dashed / dotted lines, their
//               kind in data `ogn_relation` (the HME reads every edge as
//               "above")
//   phases      groups, youngest first; the units of an object inside a
//               phase as a group within it; which group is which in data
//               `ogn_group` ('phase' | 'object'), the group of an object in
//               `ogn_object_group`. Without these (a file from yEd or the HME)
//               a group at the top is a phase and a group inside one an object.
//   positions   from the matrix layout, so yEd shows it as the matrix does.
//
// Plain functions, no DOM: the reader brings its own small XML parser, so it
// runs the same in the browser and in the checks.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const TYPE_STYLE = {
  layer: { shape: 'rectangle', fill: '#FEF3C7', border: '#D97706' },
  deposit: { shape: 'rectangle', fill: '#DBEAFE', border: '#2563EB' },
  fill: { shape: 'trapezoid', fill: '#FCE7F3', border: '#DB2777' },
  structure: { shape: 'hexagon', fill: '#DCFCE7', border: '#16A34A' },
  interface: { shape: 'ellipse', fill: '#E0E7FF', border: '#4F46E5' },
}
export const UNIT_TYPES = Object.keys(TYPE_STYLE)

/** How the Matrix tab draws a unit of each type: the HME's colours and symbols, an interface round. */
export const UNIT_TYPE_LOOK = {
  layer: { ...TYPE_STYLE.layer, symbol: '▬', label: 'Layer' },
  deposit: { ...TYPE_STYLE.deposit, symbol: '▤', label: 'Deposit' },
  fill: { ...TYPE_STYLE.fill, symbol: '▥', label: 'Fill' },
  structure: { ...TYPE_STYLE.structure, symbol: '◆', label: 'Structure' },
  interface: { ...TYPE_STYLE.interface, symbol: '○', label: 'Interface' },
}
const PLAIN = { shape: 'rectangle', fill: '#F3F4F6', border: '#4B5563' }

// ---- writing ---------------------------------------------------------------------------

/**
 * @param {object} m
 *   units      [{ id, label, type?, description? }]
 *   relations  [{ a, b, kind }]  kind 'higher' (a lies above b) | 'same-rank' | 'equals'
 *   phases     [{ id, label, color }] youngest first;  phaseOf Map<unit, phase>
 *   objects    [{ id, label, color, group? (label) }]; objectOf Map<unit, object>
 *   positions  { unit: { x, y } }, width, height — the matrix layout
 */
export function writeMatrixGraphML({ units, relations, phases = [], phaseOf = new Map(), objects = [], objectOf = new Map(), positions = {}, width = 130, height = 36, title = '' }) {
  const ids = new Map(units.map((u, i) => [u.id, `n${i + 1}`]))
  const out = []
  const node = (u, indent) => {
    const s = TYPE_STYLE[u.type] || PLAIN
    const p = positions[u.id] || { x: 0, y: 0 }
    out.push(`${indent}<node id="${ids.get(u.id)}">`)
    out.push(`${indent}  <data key="d_node">`)
    out.push(`${indent}    <y:ShapeNode>`)
    out.push(`${indent}      <y:Geometry height="${height}" width="${width}" x="${Math.round(p.x)}" y="${Math.round(p.y)}"/>`)
    out.push(`${indent}      <y:Fill color="${s.fill}" transparent="false"/>`)
    out.push(`${indent}      <y:BorderStyle color="${s.border}" type="line" width="1.5"/>`)
    out.push(`${indent}      <y:NodeLabel alignment="center" autoSizePolicy="content" fontFamily="Dialog" fontSize="12" fontStyle="bold" hasBackgroundColor="false" hasLineColor="false" modelName="internal" modelPosition="c" textColor="#333333">${esc(u.label)}</y:NodeLabel>`)
    out.push(`${indent}      <y:Shape type="${s.shape}"/>`)
    out.push(`${indent}    </y:ShapeNode>`)
    out.push(`${indent}  </data>`)
    if (u.type) out.push(`${indent}  <data key="d_hme_type">${esc(u.type)}</data>`)
    if (u.description) out.push(`${indent}  <data key="d_hme_desc">${esc(u.description)}</data>`)
    out.push(`${indent}  <data key="d_ogn_id">${esc(u.id)}</data>`)
    out.push(`${indent}</node>`)
  }
  const group = (id, label, color, kind, extra, indent) => {
    out.push(`${indent}<node id="${esc(id)}" yfiles.foldertype="group">`)
    out.push(`${indent}  <data key="d_node">`)
    out.push(`${indent}    <y:ProxyAutoBoundsNode>`)
    out.push(`${indent}      <y:Realizers active="0">`)
    out.push(`${indent}        <y:GroupNode>`)
    out.push(`${indent}          <y:Fill color="${color}40" transparent="false"/>`)
    out.push(`${indent}          <y:BorderStyle color="${color}" type="dashed" width="2.0"/>`)
    out.push(`${indent}          <y:NodeLabel alignment="center" autoSizePolicy="node_width" backgroundColor="${color}" fontFamily="Dialog" fontSize="13" fontStyle="bold" hasLineColor="false" modelName="internal" modelPosition="t" textColor="#FFFFFF">${esc(label)}</y:NodeLabel>`)
    out.push(`${indent}          <y:Shape type="roundrectangle"/>`)
    out.push(`${indent}          <y:State closed="false" closedHeight="50.0" closedWidth="100.0" innerGraphDisplayEnabled="false"/>`)
    out.push(`${indent}        </y:GroupNode>`)
    out.push(`${indent}      </y:Realizers>`)
    out.push(`${indent}    </y:ProxyAutoBoundsNode>`)
    out.push(`${indent}  </data>`)
    out.push(`${indent}  <data key="d_ogn_group">${kind}</data>`)
    if (extra) out.push(`${indent}  <data key="d_ogn_object_group">${esc(extra)}</data>`)
    out.push(`${indent}  <graph edgedefault="directed" id="${esc(id)}:">`)
  }
  const close = (indent) => out.push(`${indent}  </graph>`, `${indent}</node>`)

  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>')
  out.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:java="http://www.yworks.com/xml/yfiles-common/1.0/java" xmlns:sys="http://www.yworks.com/xml/yfiles-common/markup/primitives/2.0" xmlns:x="http://www.yworks.com/xml/yfiles-common/markup/2.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:y="http://www.yworks.com/xml/graphml" xmlns:yed="http://www.yworks.com/xml/yed/3" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://www.yworks.com/xml/schema/graphml/1.1/ygraphml.xsd">')
  out.push('  <key for="node" id="d_node" yfiles.type="nodegraphics"/>')
  out.push('  <key for="edge" id="d_edge" yfiles.type="edgegraphics"/>')
  out.push('  <key attr.name="hme_type" attr.type="string" for="node" id="d_hme_type"/>')
  out.push('  <key attr.name="hme_description" attr.type="string" for="node" id="d_hme_desc"/>')
  out.push('  <key attr.name="ogn_id" attr.type="string" for="node" id="d_ogn_id"/>')
  out.push('  <key attr.name="ogn_group" attr.type="string" for="node" id="d_ogn_group"/>')
  out.push('  <key attr.name="ogn_object_group" attr.type="string" for="node" id="d_ogn_object_group"/>')
  out.push('  <key attr.name="ogn_relation" attr.type="string" for="edge" id="d_ogn_relation"/>')
  out.push(`  <graph edgedefault="directed" id="G">${title ? `<!-- ${esc(title).replace(/--/g, '- -')} -->` : ''}`)

  const objectById = new Map(objects.map((o) => [o.id, o]))
  const placed = new Set()
  const byObject = (members, indent, scope) => {
    const groups = new Map()
    for (const u of members) {
      const o = objectOf.get(u.id)
      if (o === undefined || !objectById.has(o)) continue
      if (!groups.has(o)) groups.set(o, [])
      groups.get(o).push(u)
    }
    for (const [o, list] of groups) {
      const obj = objectById.get(o)
      group(`obj_${scope}_${ids.get(list[0].id)}`, obj.label, obj.color || '#8b5cf6', 'object', obj.group, indent)
      for (const u of list) { node(u, `${indent}    `); placed.add(u.id) }
      close(indent)
    }
  }
  phases.forEach((ph, i) => {
    const members = units.filter((u) => phaseOf.get(u.id) === ph.id)
    if (!members.length) return
    group(`phase_${i + 1}`, ph.label, ph.color || '#ef4444', 'phase', null, '    ')
    byObject(members, '        ', `p${i + 1}`)
    for (const u of members) if (!placed.has(u.id)) { node(u, '        '); placed.add(u.id) }
    close('    ')
  })
  const rest = units.filter((u) => !placed.has(u.id))
  byObject(rest, '    ', 'x')
  for (const u of rest) if (!placed.has(u.id)) node(u, '    ')

  relations.forEach((r, i) => {
    if (!ids.has(r.a) || !ids.has(r.b)) return
    const above = r.kind === 'higher'
    const style = above ? 'line' : r.kind === 'equals' ? 'dotted' : 'dashed'
    out.push(`    <edge id="e${i + 1}" source="${ids.get(r.a)}" target="${ids.get(r.b)}">`)
    out.push('      <data key="d_edge">')
    out.push('        <y:PolyLineEdge>')
    out.push(`          <y:LineStyle color="${above ? '#666666' : '#32A88B'}" type="${style}" width="1.0"/>`)
    out.push(`          <y:Arrows source="none" target="${above ? 'standard' : 'none'}"/>`)
    out.push('        </y:PolyLineEdge>')
    out.push('      </data>')
    out.push(`      <data key="d_ogn_relation">${above ? 'above' : r.kind === 'equals' ? 'equals' : 'contemporary'}</data>`)
    out.push('    </edge>')
  })
  out.push('  </graph>')
  out.push('</graphml>')
  return out.join('\n')
}

// ---- a small XML reader ---------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  return ENTITIES[e] ?? m
})

/** XML text -> { tag, attrs, children, text } (the document element). Enough for GraphML. */
export function parseXml(text) {
  const root = { tag: '#document', attrs: {}, children: [], text: '' }
  const stack = [root]
  let i = 0
  const s = String(text)
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt < 0) break
    if (lt > i) stack[stack.length - 1].text += decode(s.slice(i, lt))
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt); i = e < 0 ? s.length : e + 3; continue }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt); stack[stack.length - 1].text += s.slice(lt + 9, e < 0 ? s.length : e); i = e < 0 ? s.length : e + 3; continue }
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt); i = e < 0 ? s.length : e + 2; continue }
    if (s.startsWith('<!', lt)) { const e = s.indexOf('>', lt); i = e < 0 ? s.length : e + 1; continue }
    const gt = s.indexOf('>', lt)
    if (gt < 0) throw new Error('Unclosed tag in the XML.')
    let body = s.slice(lt + 1, gt)
    i = gt + 1
    if (body[0] === '/') {
      const tag = body.slice(1).trim()
      while (stack.length > 1 && stack[stack.length - 1].tag !== tag) stack.pop()
      if (stack.length > 1) stack.pop()
      continue
    }
    const selfClosing = body.endsWith('/')
    if (selfClosing) body = body.slice(0, -1)
    const m = body.match(/^\s*([^\s/>]+)/)
    if (!m) continue
    const el = { tag: m[1], attrs: {}, children: [], text: '' }
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g
    let a
    while ((a = attrRe.exec(body.slice(m[0].length)))) el.attrs[a[1]] = decode(a[3] ?? a[4] ?? '')
    stack[stack.length - 1].children.push(el)
    if (!selfClosing) stack.push(el)
  }
  const doc = root.children.find((c) => c.tag)
  if (!doc) throw new Error('No XML element found.')
  return doc
}

const local = (tag) => tag.split(':').pop()
const kids = (el, name) => el.children.filter((c) => local(c.tag) === name)
function find(el, name, out = []) {
  for (const c of el.children) {
    if (local(c.tag) === name) out.push(c)
    find(c, name, out)
  }
  return out
}
const textOf = (el) => (el ? el.text + el.children.map(textOf).join('') : '')

// ---- reading -----------------------------------------------------------------------------

/**
 * GraphML (from here, the HME or yEd) -> the matrix it holds:
 *   { units: [{ gid, label, type, description }], relations: [{ a, b, kind }],
 *     phases: [{ gid, label, color }] (as in the file — youngest first, as written),
 *     objects: [{ gid, label, color, group, units: [gid] }], summary }
 */
export function readMatrixGraphML(text) {
  const doc = parseXml(text)
  if (local(doc.tag) !== 'graphml') throw new Error('Not a GraphML file.')
  const keys = {}
  for (const k of kids(doc, 'key')) {
    const name = k.attrs['attr.name'] || k.attrs['yfiles.type']
    if (name) keys[k.attrs.id] = name
  }
  const dataOf = (el, name) => {
    const d = kids(el, 'data').find((x) => keys[x.attrs.key] === name)
    return d ? textOf(d).trim() : ''
  }
  const graphics = (el) => kids(el, 'data').find((x) => keys[x.attrs.key] === 'nodegraphics' || find(x, 'ShapeNode').length || find(x, 'GroupNode').length)

  const units = []
  const phases = []
  const objects = []
  const relations = []
  const known = new Set()

  const visit = (el, phase, object) => {
    const g = graphics(el)
    const labels = g ? find(g, 'NodeLabel') : []
    const label = labels[0] ? textOf(labels[0]).trim() : ''
    if (el.attrs['yfiles.foldertype'] === 'group' || kids(el, 'graph').length) {
      const color = (g && (find(g, 'BorderStyle')[0]?.attrs.color || find(g, 'Fill')[0]?.attrs.color)) || ''
      const declared = dataOf(el, 'ogn_group')
      const kind = declared || (phase ? 'object' : 'phase')
      let p = phase
      let o = object
      if (kind === 'phase') {
        p = { gid: el.attrs.id, label: label || `Phase ${phases.length + 1}`, color: color.slice(0, 7) }
        phases.push(p)
      } else {
        o = { gid: el.attrs.id, label: label || `Object ${objects.length + 1}`, color: color.slice(0, 7), group: dataOf(el, 'ogn_object_group'), units: [] }
        objects.push(o)
      }
      for (const sub of kids(el, 'graph')) for (const child of kids(sub, 'node')) visit(child, p, o)
      return
    }
    const type = dataOf(el, 'hme_type')
    const shape = g ? find(g, 'Shape')[0]?.attrs.type : ''
    const fill = (g ? find(g, 'Fill')[0]?.attrs.color : '') || ''
    const byStyle = Object.entries(TYPE_STYLE).find(([, s]) => s.fill.toUpperCase() === fill.toUpperCase().slice(0, 7))?.[0]
    const u = {
      gid: el.attrs.id,
      label: label || el.attrs.id,
      type: UNIT_TYPES.includes(type) ? type : shape === 'ellipse' ? 'interface' : shape === 'trapezoid' ? 'fill' : shape === 'hexagon' ? 'structure' : byStyle || '',
      description: dataOf(el, 'hme_description') || (labels[1] ? textOf(labels[1]).trim() : ''),
      phase: phase?.gid || null,
    }
    units.push(u)
    known.add(u.gid)
    if (object) object.units.push(u.gid)
  }
  const top = kids(doc, 'graph')[0]
  if (!top) throw new Error('The GraphML file has no <graph>.')
  for (const child of kids(top, 'node')) visit(child, null, null)

  for (const e of find(doc, 'edge')) {
    const a = e.attrs.source
    const b = e.attrs.target
    if (!known.has(a) || !known.has(b) || a === b) continue
    const rel = dataOf(e, 'ogn_relation')
    relations.push({ a, b, kind: rel === 'contemporary' ? 'same-rank' : rel === 'equals' ? 'equals' : 'higher' })
  }
  return {
    units,
    relations,
    phases,
    objects,
    summary: `${units.length} units, ${relations.length} relations, ${phases.length} phases, ${objects.length} objects`,
  }
}

/** The unit type of a unit, where the graph says it: a type it has that is one of the HME's five. */
export function unitTypeOf(graph, id) {
  for (const [key, targets] of Object.entries(graph?.nodes?.[id]?.o || {})) {
    if (key.includes('#dot1:')) continue
    for (const t of targets) {
      const l = String(graph.nodes[t]?.l || '').trim().toLowerCase()
      if (UNIT_TYPES.includes(l)) return l
    }
  }
  return ''
}
