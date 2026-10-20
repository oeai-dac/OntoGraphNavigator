// Editing a WKT geometry vertex by vertex -- and writing back no more than was
// changed.
//
// A geometry is read into "paths": each a list of vertices, flat for points
// and lines, a closed ring of a polygon stored open (its closing vertex, the
// repeat of the first, is put back on writing). Every vertex keeps the text of
// its numbers as it stood in the source, so a vertex nobody touched is written
// back character for character -- precision, trailing zeros and all. A moved
// or new vertex is written with as many decimals as the source used; its
// further ordinates (Z, M) are kept on a move and interpolated on an insert.
//
// Pure functions on plain data, no map, no projection: the Map tab converts
// between the dataset's coordinate system and the screen, this file only ever
// sees the dataset's own numbers.

const FULL_RE = /^(\s*)([A-Za-z]+)(\s*)(ZM|Z|M)?(\s*)\(([\s\S]*)\)(\s*)$/i

function splitTopLevel(str) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < str.length; i++) {
    const c = str[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      parts.push(str.slice(start, i))
      start = i + 1
    }
  }
  parts.push(str.slice(start))
  return parts
}

// The separator a list was written with: the comma and whatever whitespace
// follows it -- read off the second item, since the first has none before it.
const sepOf = (parts) => (parts.length > 1 ? `,${/^\s*/.exec(parts[1])[0]}` : null)

const unwrap = (s) => {
  const t = s.trim()
  return t.startsWith('(') && t.endsWith(')') ? t.slice(1, -1) : null
}

function readVertex(text) {
  const tokens = text.trim().split(/\s+/)
  if (tokens.length < 2) return null
  const nums = tokens.map(Number)
  if (nums.some((n) => !Number.isFinite(n))) return null
  return { x: nums[0], y: nums[1], rest: nums.slice(2), tokens }
}

function readList(text, model) {
  const pieces = text.split(',')
  if (model && !model.sep.coord) model.sep.coord = sepOf(pieces)
  const out = []
  for (const piece of pieces) {
    const v = readVertex(piece)
    if (!v) return null
    out.push(v)
  }
  return out
}

const sameTokens = (a, b) => a.tokens.length === b.tokens.length && a.tokens.every((t, i) => t === b.tokens[i])

/** A ring read from the source: stored open, if it was closed. */
function readRing(text, polygon, ring, model) {
  const vertices = readList(text, model)
  if (!vertices || vertices.length < 2) return null
  const closed = vertices.length > 3 && sameTokens(vertices[0], vertices[vertices.length - 1])
  return { kind: 'ring', polygon, ring, closed, vertices: closed ? vertices.slice(0, -1) : vertices }
}

const decimalsOf = (token) => {
  const dot = token.indexOf('.')
  if (dot < 0) return 0
  const exp = token.search(/e/i)
  return (exp < 0 ? token.length : exp) - dot - 1
}

/**
 * Read a WKT value for editing, or null if it is not a single geometry this
 * editor knows. GEOMETRYCOLLECTION and empty geometries are left alone.
 */
export function parseWktForEdit(wkt) {
  if (typeof wkt !== 'string') return null
  const m = FULL_RE.exec(wkt)
  if (!m) return null
  const type = m[2].toUpperCase()
  const body = m[6]
  const model = {
    type,
    // Everything before the opening parenthesis, as written ("POLYGON Z ", "Polygon").
    head: `${m[1]}${m[2]}${m[3]}${m[4] || ''}${m[5]}`,
    tail: m[7],
    // Separators per level -- files mix them ("(1 2, 3 4)),((5 6, …").
    sep: { coord: null, ring: null, polygon: null },
    pointParens: false,
    paths: [],
  }
  switch (type) {
    case 'POINT': {
      const v = readVertex(body)
      if (!v) return null
      model.paths.push({ kind: 'point', vertices: [v] })
      break
    }
    case 'LINESTRING': {
      const vertices = readList(body, model)
      if (!vertices || vertices.length < 2) return null
      model.paths.push({ kind: 'line', vertices })
      break
    }
    case 'POLYGON': {
      const parts = splitTopLevel(body)
      model.sep.ring = sepOf(parts)
      const rings = parts.map(unwrap)
      if (rings.some((r) => r === null)) return null
      for (let j = 0; j < rings.length; j++) {
        const ring = readRing(rings[j], 0, j, model)
        if (!ring) return null
        model.paths.push(ring)
      }
      break
    }
    case 'MULTIPOINT': {
      const items = splitTopLevel(body)
      model.sep.coord = sepOf(items)
      model.pointParens = items.every((s) => unwrap(s) !== null)
      for (const item of items) {
        const v = readVertex(model.pointParens ? unwrap(item) : item)
        if (!v) return null
        model.paths.push({ kind: 'point', vertices: [v] })
      }
      break
    }
    case 'MULTILINESTRING': {
      const items = splitTopLevel(body)
      model.sep.ring = sepOf(items)
      for (const item of items) {
        const inner = unwrap(item)
        const vertices = inner && readList(inner, model)
        if (!vertices || vertices.length < 2) return null
        model.paths.push({ kind: 'line', vertices })
      }
      break
    }
    case 'MULTIPOLYGON': {
      const parts = splitTopLevel(body)
      model.sep.polygon = sepOf(parts)
      const polygons = parts.map(unwrap)
      if (polygons.some((p) => p === null)) return null
      for (let i = 0; i < polygons.length; i++) {
        const ringParts = splitTopLevel(polygons[i])
        if (!model.sep.ring) model.sep.ring = sepOf(ringParts)
        const rings = ringParts.map(unwrap)
        if (rings.some((r) => r === null)) return null
        for (let j = 0; j < rings.length; j++) {
          const ring = readRing(rings[j], i, j, model)
          if (!ring) return null
          model.paths.push(ring)
        }
      }
      break
    }
    default:
      return null
  }
  if (!model.paths.length) return null
  // A level the source never needed (one ring only) borrows from the next one
  // down, so a ring or polygon added later reads like the rest.
  model.sep.coord ||= ', '
  model.sep.ring ||= model.sep.coord
  model.sep.polygon ||= model.sep.ring

  // Decimals per ordinate, the most the source uses anywhere -- what a moved
  // or new vertex is written with.
  model.decimals = []
  for (const path of model.paths) {
    for (const v of path.vertices) {
      v.tokens.forEach((t, i) => { model.decimals[i] = Math.max(model.decimals[i] || 0, decimalsOf(t)) })
    }
  }
  return model
}

// ---- writing -------------------------------------------------------------------

function formatNumber(model, n, i) {
  const text = n.toFixed(model.decimals[i] ?? 0)
  return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text
}

function vertexText(model, v) {
  if (v.tokens) return v.tokens.join(' ')
  // A moved vertex keeps its further ordinates as written; a new one has them computed.
  const rest = v.restTokens || v.rest.map((n, i) => formatNumber(model, n, i + 2))
  return [formatNumber(model, v.x, 0), formatNumber(model, v.y, 1), ...rest].join(' ')
}

function pathText(model, path) {
  const vertices = path.kind === 'ring' && path.closed ? [...path.vertices, path.vertices[0]] : path.vertices
  return vertices.map((v) => vertexText(model, v)).join(model.sep.coord)
}

/** The geometry as WKT, in the source's own spelling. */
export function writeWkt(model) {
  const { sep, paths } = model
  let body
  switch (model.type) {
    case 'POINT':
      body = vertexText(model, paths[0].vertices[0])
      break
    case 'LINESTRING':
      body = pathText(model, paths[0])
      break
    case 'POLYGON':
      body = paths.map((p) => `(${pathText(model, p)})`).join(sep.ring)
      break
    case 'MULTIPOINT':
      body = paths.map((p) => (model.pointParens ? `(${pathText(model, p)})` : pathText(model, p))).join(sep.coord)
      break
    case 'MULTILINESTRING':
      body = paths.map((p) => `(${pathText(model, p)})`).join(sep.ring)
      break
    case 'MULTIPOLYGON': {
      const byPolygon = []
      for (const p of paths) (byPolygon[p.polygon] ||= []).push(`(${pathText(model, p)})`)
      body = byPolygon.filter(Boolean).map((rings) => `(${rings.join(sep.ring)})`).join(sep.polygon)
      break
    }
    default:
      throw new Error(`Cannot write ${model.type}`)
  }
  return `${model.head}(${body})${model.tail}`
}

// ---- editing -----------------------------------------------------------------------

const withPath = (model, pathIndex, fn) => ({
  ...model,
  paths: model.paths.map((p, i) => (i === pathIndex ? { ...p, vertices: fn(p.vertices, p) } : p)),
})

/** The fewest vertices a path can keep: 1 for a point, 2 for a line, 3 for a ring. */
export const minVertices = (path) => (path.kind === 'point' ? 1 : path.kind === 'line' ? 2 : 3)

/** Move one vertex. Its further ordinates (a height) stay as they were. */
export function moveVertex(model, pathIndex, vertexIndex, x, y) {
  return withPath(model, pathIndex, (vs) =>
    vs.map((v, i) => (i === vertexIndex ? { x, y, rest: v.rest, tokens: null, restTokens: v.tokens?.slice(2) } : v)))
}

/**
 * Insert a vertex after `afterIndex` (for a ring, after the last means before
 * the first). Its further ordinates are the mean of its two neighbours'.
 */
export function insertVertex(model, pathIndex, afterIndex, x, y) {
  return withPath(model, pathIndex, (vs, path) => {
    if (path.kind === 'point') return vs
    const a = vs[afterIndex]
    const b = vs[(afterIndex + 1) % vs.length]
    const rest = a.rest.map((r, i) => (b.rest[i] === undefined ? r : (r + b.rest[i]) / 2))
    const next = [...vs]
    next.splice(afterIndex + 1, 0, { x, y, rest, tokens: null })
    return next
  })
}

/** Remove a vertex, unless the path would fall below its minimum — then unchanged. */
export function removeVertex(model, pathIndex, vertexIndex) {
  const path = model.paths[pathIndex]
  if (!path || path.vertices.length <= minVertices(path)) return model
  return withPath(model, pathIndex, (vs) => vs.filter((_, i) => i !== vertexIndex))
}

/** Where a vertex can be inserted: the middle of every segment, rings closing back to their start. */
export function midpoints(model) {
  const out = []
  model.paths.forEach((path, pathIndex) => {
    if (path.kind === 'point') return
    const vs = path.vertices
    const count = path.kind === 'ring' ? vs.length : vs.length - 1
    for (let i = 0; i < count; i++) {
      const a = vs[i]
      const b = vs[(i + 1) % vs.length]
      out.push({ pathIndex, afterIndex: i, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    }
  })
  return out
}

/** GeoJSON-shaped coordinates of the edited geometry, [x, y] per vertex -- for drawing it. */
export function toCoordinates(model) {
  const pts = (path) => {
    const vs = path.vertices.map((v) => [v.x, v.y])
    return path.kind === 'ring' ? [...vs, vs[0]] : vs
  }
  const { paths } = model
  switch (model.type) {
    case 'POINT': return { type: 'Point', coordinates: pts(paths[0])[0] }
    case 'LINESTRING': return { type: 'LineString', coordinates: pts(paths[0]) }
    case 'POLYGON': return { type: 'Polygon', coordinates: paths.map(pts) }
    case 'MULTIPOINT': return { type: 'MultiPoint', coordinates: paths.map((p) => pts(p)[0]) }
    case 'MULTILINESTRING': return { type: 'MultiLineString', coordinates: paths.map(pts) }
    case 'MULTIPOLYGON': {
      const byPolygon = []
      for (const p of paths) (byPolygon[p.polygon] ||= []).push(pts(p))
      return { type: 'MultiPolygon', coordinates: byPolygon.filter(Boolean) }
    }
    default: return null
  }
}
