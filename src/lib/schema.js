/**
 * Deriving colours and labels for a graph that brought none.
 *
 * A file straight from the Studio carries a `schema` block and this module is
 * not needed. A graph read from raw RDF, or written by some other tool, does
 * not — and must still be usable. Mirrors the GraphExplorer's own derivation so
 * the same graph looks the same in both applications.
 */

import { localName } from './prefixes'

/**
 * 20 colours. The first 11 are the CIDOC CRM anchor-class colours of the
 * community convention, in the order the sister tools list them.
 *
 * Assignment is cyclic and by position only — this module does not know the
 * ontology, so it cannot tell that a class descends from E18. The Studio can,
 * which is why its export ships colours and this is only the fallback.
 */
export const PALETTE = [
  '#c78e66', // E18_Physical_Thing
  '#82ddff', // E2_Temporal_Entity
  '#ffbdca', // E39_Actor
  '#fef3ba', // E41_Appellation
  '#86bcc8', // E52_Time-Span
  '#94cc7d', // E53_Place
  '#b8b8b8', // E54_Dimension
  '#fab565', // E55_Type
  '#fddc34', // E28_Conceptual_Object
  '#cc80ff', // E92_Spacetime_Volume
  '#f0f0f0', // E59_Primitive_Value
  '#7fb3d5', '#d98880', '#a9dfbf', '#f9e79f', '#bb8fce',
  '#76d7c4', '#f0b27a', '#aeb6bf', '#85c1e9',
]

const AS_MARK = '#as:'

/**
 * Display name for a type or edge key.
 *
 * A key that does not look like a URI is passed through unchanged — a curated
 * name like "Straße/Ω" must not be cut down to its last path segment.
 */
export function humanise(key) {
  const raw = String(key ?? '')
  if (!raw) return ''
  const alias = raw.indexOf(AS_MARK)
  const base = alias >= 0 ? raw.slice(0, alias) : raw
  if (!base.includes('://') && !base.includes('#')) return base.replace(/_/g, ' ')
  return localName(base).replace(/_/g, ' ')
}

/**
 * Fill in whatever the graph did not bring.
 * Anything already present in `graph.schema` wins.
 */
export function deriveSchema(graph) {
  const given = graph.schema || {}
  const typeColors = { ...(given.typeColors || {}) }
  const typeLabels = { ...(given.typeLabels || {}) }
  const edgeLabels = { ...(given.edgeLabels || {}) }

  const typeKeys = Object.keys(graph.node_types || {})
  typeKeys.forEach((key, index) => {
    if (!typeColors[key]) typeColors[key] = PALETTE[index % PALETTE.length]
    if (!typeLabels[key]) typeLabels[key] = humanise(key)
  })

  for (const key of Object.keys(graph.edge_types || {})) {
    if (!edgeLabels[key]) edgeLabels[key] = humanise(key)
  }
  // Incoming keys are not listed in edge_types — they are the resolved inverse
  // names and appear only on the nodes themselves.
  for (const node of Object.values(graph.nodes || {})) {
    for (const key of Object.keys(node.i || {})) {
      if (!edgeLabels[key]) edgeLabels[key] = humanise(key)
    }
  }

  return { typeColors, typeLabels, edgeLabels, mainAttrs: { ...(given.mainAttrs || {}) } }
}

/**
 * Several palette colours are too light to read as text on a light background.
 * Darken exactly those, keeping the hue so types stay distinguishable.
 */
/** Text on a coloured background (a type's tag): dark on a light colour, white on a dark one. */
export function textOnColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!m) return 'inherit'
  const n = parseInt(m[1], 16)
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return luminance > 0.6 ? '#1e1e1c' : '#ffffff'
}

export function readableTextColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!m) return '#333333'
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  if (luminance <= 0.62) return `#${m[1]}`
  const factor = 0.55
  const dark = (c) => Math.round(c * factor)
  return `#${[dark(r), dark(g), dark(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}
