// Turns Dot-One-qualified edges (built by the OntoCartographer backend as synthetic
// "<propUri>#dot1:<canonicalValue>" keys, see backend/main.py) into a
// stratigraphic sequence graph suitable for a Harris Matrix layout.
//
// Mirrors the backend's qualifier vocabulary (_DOT_ONE_VOCAB) so the same
// über/unter/gleichzeitig/entspricht words are understood consistently on
// both sides. Unknown vocabulary is never guessed at -- it's kept visible
// as a distinctly-styled "unklare Beziehung" connector instead of being
// silently mis-ranked.

const LOWER = new Set(['unter', 'below', 'under', 'unten'])
const HIGHER = new Set(['ueber', 'above', 'over', 'oben'])
// "Same rank, no further constraint" -- contemporary units, drawn at the
// same height but with no preference for how close together they sit.
const SAME_RANK = new Set([
  'gleichzeitig', 'zeitgleich', 'same time', 'same-time', 'contemporary with',
])
// "Same rank AND as close together as the layout allows" -- these describe
// what is effectively the same context recorded under two identifiers.
const EQUALS = new Set(['entspricht', 'equals', 'same as', 'corresponds to'])

const DOT1_MARK = '#dot1:'

/**
 * The kinds of stratigraphic relation, in the order they are offered when one
 * is drawn. `words` is what is written where a dataset gives no hint of its
 * own wording -- see qualifierVocabulary. Further kinds (cuts, fills) go here,
 * with their vocabulary in the sets above and in the Studio's _DOT_ONE_VOCAB.
 */
export const RELATION_KINDS = [
  { kind: 'higher', label: 'lies above', words: { en: 'above', de: 'ueber' } },
  { kind: 'lower', label: 'lies below', words: { en: 'below', de: 'unter' } },
  { kind: 'same-rank', label: 'is contemporary with', words: { en: 'contemporary with', de: 'gleichzeitig' } },
  { kind: 'equals', label: 'equals', words: { en: 'equals', de: 'entspricht' } },
]

/** The kind read the other way round: "A above B" is "B below A". */
export const oppositeKind = (kind) => ({ higher: 'lower', lower: 'higher' }[kind] || kind)

const GERMAN = new Set(['ueber', 'unter', 'oben', 'unten', 'gleichzeitig', 'zeitgleich', 'entspricht'])

/**
 * The word a dataset uses for each kind of relation -- so a relation drawn
 * here is written the way the others already are ("ueber" beside "ueber", not
 * "above"). Taken from the values present for this property, the most
 * frequent per kind; a kind not present yet gets the word of the language the
 * others are in.
 */
export function qualifierVocabulary(graph, baseProp) {
  const counts = new Map() // canonical value -> count
  for (const nd of Object.values(graph?.nodes || {})) {
    for (const [key, targets] of Object.entries(nd.o || {})) {
      const idx = key.indexOf(DOT1_MARK)
      if (idx < 0 || key.slice(0, idx) !== baseProp) continue
      const value = key.slice(idx + DOT1_MARK.length)
      counts.set(value, (counts.get(value) || 0) + targets.length)
    }
  }
  let german = 0
  let other = 0
  for (const [value, n] of counts) {
    if (GERMAN.has(value)) german += n
    else if (classify(value) !== 'unknown') other += n
  }
  const lang = german > other ? 'de' : 'en'
  const vocabulary = {}
  for (const { kind, words } of RELATION_KINDS) {
    let best = null
    let bestCount = 0
    for (const [value, n] of counts) {
      if (classify(value) === kind && n > bestCount) {
        best = value
        bestCount = n
      }
    }
    vocabulary[kind] = best || words[lang]
  }
  return vocabulary
}

/**
 * How `a` relates to `b` for this property -- as `a` states it, or as `b`
 * states it the other way round. Null when they are not related.
 */
export function relationBetween(graph, baseProp, a, b) {
  const read = (from, to) => {
    for (const [key, targets] of Object.entries(graph?.nodes?.[from]?.o || {})) {
      const idx = key.indexOf(DOT1_MARK)
      if (idx < 0 || key.slice(0, idx) !== baseProp || !targets.includes(to)) continue
      return classify(key.slice(idx + DOT1_MARK.length))
    }
    return null
  }
  const direct = read(a, b)
  if (direct) return direct
  const reverse = read(b, a)
  return reverse ? oppositeKind(reverse) : null
}

/**
 * Every relation a unit has for this property, as it reads from that unit:
 * [{ partner, kind }] -- "this unit <kind> partner". Both what the unit states
 * and what others state about it (the reverse reading sits on the unit too).
 * Two contradicting statements between the same pair ("above" and "below")
 * come out as two entries, so either can be taken back on its own.
 */
export function statementsOf(graph, baseProp, id) {
  const out = []
  const seen = new Set()
  for (const [key, targets] of Object.entries(graph?.nodes?.[id]?.o || {})) {
    const idx = key.indexOf(DOT1_MARK)
    if (idx < 0 || key.slice(0, idx) !== baseProp) continue
    const kind = classify(key.slice(idx + DOT1_MARK.length))
    for (const partner of targets) {
      if (partner === id || seen.has(`${partner} ${kind}`)) continue
      seen.add(`${partner} ${kind}`)
      out.push({ partner, kind })
    }
  }
  return out
}

export function classify(canonValue) {
  if (LOWER.has(canonValue)) return 'lower'
  if (HIGHER.has(canonValue)) return 'higher'
  if (SAME_RANK.has(canonValue)) return 'same-rank'
  if (EQUALS.has(canonValue)) return 'equals'
  return 'unknown'
}

/** All distinct base dot-one properties present among the given node ids. */
export function detectDotOneProperties(graph, nodeIds) {
  const props = new Set()
  for (const id of nodeIds) {
    const nd = graph.nodes[id]
    if (!nd) continue
    for (const key of Object.keys(nd.o || {})) {
      const idx = key.indexOf(DOT1_MARK)
      if (idx >= 0) props.add(key.slice(0, idx))
    }
  }
  return [...props].sort()
}

/** True if the graph has ANY dot-one edges at all (used to show/hide the Matrix tab).
    Checks the cheap schema/edge_types maps first, then falls back to scanning
    node adjacency so schema-less graphs (Doc 4.3 backward-compat) still expose
    the Matrix tab when they genuinely contain dot-one edges -- previously the
    gate looked only at schema.edgeLabels and hid the tab for such graphs even
    though detectDotOneProperties()/buildSequence() would have worked. */
export function hasDotOneData(graph) {
  if (!graph) return false
  const labels = graph.schema?.edgeLabels
  if (labels && Object.keys(labels).some((k) => k.includes(DOT1_MARK))) return true
  const etypes = graph.edge_types
  if (etypes && Object.keys(etypes).some((k) => k.includes(DOT1_MARK))) return true
  for (const nd of Object.values(graph.nodes || {})) {
    for (const k of Object.keys(nd.o || {})) if (k.includes(DOT1_MARK)) return true
    for (const k of Object.keys(nd.i || {})) if (k.includes(DOT1_MARK)) return true
  }
  return false
}

/**
 * Build a stratigraphic sequence for `baseProp` among `nodeIds`.
 *
 * Returns (all deduplicated -- the same fact can appear on both ends after
 * the backend's o/i merge, e.g. "A unter B" and "B über A" resolve to the
 * identical pair here, drawn once):
 *   rankEdges     - directed { source, target }, source = physically lower
 *                    / earlier, target = physically higher / later
 *   sameRankEdges - undirected { source, target } (zeitgleich/gleichzeitig):
 *                    must render at the same height, no closeness preference
 *   equalsEdges   - undirected { source, target } (entspricht/equals): must
 *                    render at the same height AND as close together as
 *                    possible
 *   unknownEdges  - undirected { source, target } with unrecognised
 *                    qualifier vocabulary (shown, but not used for ranking)
 */
export function buildSequence(graph, nodeIds, baseProp) {
  const idSet = new Set(nodeIds)
  const rankPairs = new Map()   // "lo|hi" -> {source, target}
  const buckets = { 'same-rank': new Map(), equals: new Map(), unknown: new Map() }

  const addUndirected = (bucket, a, b) => {
    const [x, y] = a < b ? [a, b] : [b, a]
    bucket.set(`${x}|${y}`, { source: x, target: y })
  }

  for (const id of nodeIds) {
    const nd = graph.nodes[id]
    if (!nd) continue
    for (const [key, targets] of Object.entries(nd.o || {})) {
      const idx = key.indexOf(DOT1_MARK)
      if (idx < 0 || key.slice(0, idx) !== baseProp) continue
      const value = key.slice(idx + DOT1_MARK.length)
      const cls = classify(value)
      for (const tgt of targets) {
        if (!idSet.has(tgt) || tgt === id) continue
        if (cls === 'lower') {
          rankPairs.set(`${id}|${tgt}`, { source: id, target: tgt })
        } else if (cls === 'higher') {
          rankPairs.set(`${tgt}|${id}`, { source: tgt, target: id })
        } else {
          addUndirected(buckets[cls], id, tgt)
        }
      }
    }
  }

  return {
    rankEdges: [...rankPairs.values()],
    sameRankEdges: [...buckets['same-rank'].values()],
    equalsEdges: [...buckets.equals.values()],
    unknownEdges: [...buckets.unknown.values()],
  }
}
