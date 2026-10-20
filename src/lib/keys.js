/**
 * The three key shapes of the Graph-JSON format.
 *
 * Type and edge keys are opaque to consumers except for two documented markers
 * (see docs/graph-json-format.md §3):
 *
 *   <uri>#as:<slug>    display alias — one ontology class shown as several types
 *   <uri>#dot1:<value> RDF-star stratigraphy — switches on the Harris matrix
 *
 * Both are produced here and nowhere else.
 */

const UMLAUTS = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'ae', Ö: 'oe', Ü: 'ue', ß: 'ss' }

/**
 * Letters a slug spells out rather than drops. German umlauts by convention
 * ("Fläche" -> flaeche, not flche); the rest are letters Unicode does not
 * decompose into a base letter plus accent, so stripping accents alone would
 * lose them. Everything else with an accent loses just the accent (é -> e,
 * č -> c, ³ -> 3) — no list needed for that.
 */
const SLUG_SPELLED = {
  ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', ẞ: 'SS',
  æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ø: 'o', Ø: 'O', ł: 'l', Ł: 'L',
  đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', þ: 'th', Þ: 'Th', ı: 'i',
}
const SPELLED_CHARS = new RegExp(`[${Object.keys(SLUG_SPELLED).join('')}]`, 'g')

/**
 * Slug for a `#as:` key — the Studio's `_slugify` (backend/main.py), exactly.
 *
 * Verified against the reference export: "Fund (human-made)" -> fund_human_made,
 * "Link zu oeai.DAM" -> link_zu_oeai_dam, "SE-Interpretation" -> se_interpretation.
 *
 * Spelled-out letters first ("Grabungsfläche" -> grabungsflaeche), then
 * accents stripped, then anything still outside a–z and 0–9 becomes "_"
 * (spaces, punctuation, other scripts). A name of nothing but symbols becomes
 * "x". The key is how the Studio, the GraphExplorer and this tool recognise
 * one type as the same, so this has to match the Studio character for
 * character — tests/run-keys-check.mjs and the Studio's import test hold the
 * same table of examples.
 */
export function slugify(label) {
  const slug = String(label ?? '')
    .trim()
    .normalize('NFC')
    .replace(SPELLED_CHARS, (c) => SLUG_SPELLED[c])
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return slug || 'x'
}

const hasName = (label) => String(label ?? '').trim() !== ''

/** `<classUri>#as:<slug>` when an explorer name is set, otherwise the bare URI. */
export function typeKey(classUri, explorerLabel) {
  return hasName(explorerLabel) ? `${classUri}#as:${slugify(explorerLabel)}` : classUri
}

/** `<propertyUri>#as:<slug>` when an explorer name is set, otherwise the bare URI. */
export function edgeKey(propertyUri, explorerLabel) {
  return hasName(explorerLabel) ? `${propertyUri}#as:${slugify(explorerLabel)}` : propertyUri
}

export const DOT1_MARK = '#dot1:'

/**
 * Canonical vocabulary for stratigraphic relation values.
 *
 * Anything outside this set is kept as-is: the Harris matrix draws it as an
 * unclear relation (red dashed) rather than dropping it.
 */
export function canonicalDot1(value) {
  const canon = dot1RawText(value)
    .replace(/[äöüÄÖÜß]/g, (c) => UMLAUTS[c])
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
  if (canon in DOT1_OPPOSITE) return canon
  // Qualifier URIs are often minted as "<column>_<value>"
  // (".../Relationstyp_above"): a known trailing part is the value.
  const words = canon.split(' ')
  for (let i = 1; i < words.length; i++) {
    const tail = words.slice(i).join(' ')
    if (tail in DOT1_OPPOSITE) return tail
  }
  return canon
}

/**
 * The words in a qualifier cell, whatever form it takes: a plain value
 * ("ueber"), a URI (".../oeai/ueber"), a prefixed name ("oeai:ueber",
 * which is what a cell holds when the ID prefix is not in the prefix table),
 * and with underscores for spaces ("contemporary_with", the URI-safe form).
 *
 * The same reading as the Studio's `_dot_one_raw_text` and `_dot_one_canon`
 * (backend/main.py). It has to be: the Studio's export is the reference, and a
 * cell the two read differently would be a different relation in each tool.
 */
function dot1RawText(value) {
  let v = String(value ?? '').trim()
  if (v.includes('://')) v = v.split('#').pop().split('/').pop()
  else {
    const m = /^[A-Za-z][\w.-]*:(?!\/\/)(.+)$/.exec(v)
    if (m) v = m[1]
  }
  return v.replace(/_/g, ' ')
}

/** `<propertyUri>#dot1:<canonical value>` */
export function dot1Key(propertyUri, value) {
  return `${propertyUri}${DOT1_MARK}${canonicalDot1(value)}`
}

/**
 * The reverse reading of a stratigraphic relation.
 *
 * Dot-one edges carry no inverse property — the reverse is written as another
 * outgoing edge with the opposite vocabulary term. Verified against the
 * reference export: all 220 dot-one entries are mirrored, and the 20 nodes that
 * appear only as relation partners get their edges from nothing else.
 *
 * Returns `null` for a value outside the vocabulary. Such a relation is kept in
 * the forward direction only: inventing a reverse reading for an unknown term
 * would assert something the data does not say.
 */
const DOT1_OPPOSITE = {
  unter: 'ueber', ueber: 'unter',
  unten: 'oben', oben: 'unten',
  below: 'above', above: 'below',
  under: 'over', over: 'under',
  entspricht: 'entspricht', equals: 'equals',
  'same as': 'same as', 'corresponds to': 'corresponds to',
  zeitgleich: 'zeitgleich', gleichzeitig: 'gleichzeitig',
  'same time': 'same time', 'contemporary with': 'contemporary with',
}

export function oppositeDot1(value) {
  return DOT1_OPPOSITE[canonicalDot1(value)] ?? null
}

/**
 * How a canonical dot-one value is spelled in a display label.
 *
 * The key must drop the umlaut (`#dot1:ueber`), the label need not — the
 * reference export writes "crmarchaeo:AP11_has_physical_relation_to (über)"
 * while the table cell itself reads "ueber". So this is a display table, not a
 * lookup of the original value.
 */
const DOT1_DISPLAY = { ueber: 'über' }

export function dot1DisplayValue(canonical) {
  return DOT1_DISPLAY[canonical] ?? canonical
}

/**
 * Classes whose instances are folded into the parent's attributes instead of
 * becoming nodes of their own (docs/graph-json-format.md §2.3).
 *
 * Free nodes keep the prefixed form in `data.uri` (`rdfs:Literal`), mapped ones
 * carry the expanded URI — both spellings have to match.
 */
export function isFoldedLiteralClass(uri) {
  const raw = String(uri ?? '')
  return (
    raw === 'rdfs:Literal' ||
    raw === 'http://www.w3.org/2000/01/rdf-schema#Literal' ||
    raw.startsWith('xsd:') ||
    raw.startsWith('http://www.w3.org/2001/XMLSchema#') ||
    raw === 'geo:wktLiteral' ||
    raw === 'http://www.opengis.net/ont/geosparql#wktLiteral'
  )
}
