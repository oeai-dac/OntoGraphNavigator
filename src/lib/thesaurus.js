/**
 * SKOS thesauri: reading, searching, and one repair.
 *
 * A thesaurus turns a free-text field into a controlled one. The mapping
 * already models what a picker needs — `mappedColumn` takes the concept URI and
 * `labelColumn` its preferred label — so choosing a concept fills both columns
 * at once and nothing has to be configured beyond which vocabulary belongs to
 * which field.
 *
 * Accepted: SKOS in Turtle, TriG, N-Triples, N-Quads. Not RDF/XML — the parser
 * cannot read it. The file extension is ignored; what matters is whether the
 * content parses (one of the sample files arrived named `.txt`).
 */

import N3 from 'n3'
import { localName } from './prefixes'

const SKOS = 'http://www.w3.org/2004/02/skos/core#'
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const DCT = 'http://purl.org/dc/terms/'
const DC = 'http://purl.org/dc/elements/1.1/'

/**
 * Windows-1252 in the range where it differs from Latin-1 (0x80–0x9F).
 *
 * This range is what makes the difference in practice: "Ü" is C3 9C in UTF-8,
 * and 0x9C is undefined in Latin-1 but "œ" in Windows-1252 — which is why the
 * damaged file reads "Ãœbersetzung" and not "Ãbersetzung". Assuming
 * Latin-1 leaves exactly the capital umlauts and "ß" unrepaired.
 */
const CP1252_HIGH = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
}

/**
 * Characters as they look when their UTF-8 bytes were read as Windows-1252 and
 * encoded again — "färbig" arriving as "fÃ¤rbig".
 *
 * Built by construction rather than typed out, so the table cannot be subtly
 * wrong, and applied only to these exact sequences: a blanket re-decode of the
 * whole file would corrupt anything that was in fact correct.
 */
const MOJIBAKE = (() => {
  const encoder = new TextEncoder()
  const byteToChar = (b) => CP1252_HIGH[b] ?? String.fromCharCode(b)
  const pairs = []
  for (const ch of 'äöüÄÖÜßáéíóúàèìòùâêîôûãõñçÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÃÕÑÇåÅøØæÆþÞ–—„“”‘’…•°·µ§€™') {
    const broken = [...encoder.encode(ch)].map(byteToChar).join('')
    if (broken !== ch) pairs.push([broken, ch])
  }
  // Longest first, so a three-byte sequence is not eaten by a two-byte one.
  pairs.sort((a, b) => b[0].length - a[0].length)
  return pairs
})()

/** @returns {{text: string, repaired: number}} */
export function repairMojibake(text) {
  let out = text
  let repaired = 0
  for (const [broken, correct] of MOJIBAKE) {
    if (!out.includes(broken)) continue
    const before = out.length
    out = out.split(broken).join(correct)
    repaired += (before - out.length) / (broken.length - correct.length)
  }
  return { text: out, repaired: Math.round(repaired) }
}

function literalsByLanguage(target, quad) {
  const lang = quad.object.language || ''
  if (!target[lang]) target[lang] = []
  target[lang].push(quad.object.value)
}

/**
 * @param {string} text  SKOS in a parseable RDF syntax
 * @param {object} [options]
 * @param {string} [options.name]  display name for this source
 * @returns {{id: string, name: string, schemes: Array, concepts: Map, index: Array, report: object}}
 */
export function readSkos(text, options = {}) {
  const { text: cleaned, repaired } = repairMojibake(text)
  let quads
  try {
    quads = new N3.Parser().parse(cleaned)
  } catch (error) {
    throw new Error(`Thesaurus could not be parsed: ${error.message}`)
  }

  const concepts = new Map()
  const schemes = new Map()
  const concept = (uri) => {
    let c = concepts.get(uri)
    if (!c) {
      c = {
        uri,
        prefLabel: {},
        altLabel: {},
        definition: {},
        scopeNote: {},
        notation: '',
        broader: [],
        narrower: [],
        exactMatch: [],
        scheme: '',
        topConcept: false,
        deprecated: false,
      }
      concepts.set(uri, c)
    }
    return c
  }

  // Only subjects declared as skos:Concept count. These files also carry
  // exactMatch statements *about* Getty and chronontology URIs, and those are
  // not concepts of this vocabulary.
  const declared = new Set()
  for (const q of quads) {
    if (q.predicate.value === RDF_TYPE) {
      if (q.object.value === `${SKOS}Concept`) declared.add(q.subject.value)
      else if (q.object.value === `${SKOS}ConceptScheme`) schemes.set(q.subject.value, { uri: q.subject.value, title: {} })
      else if (q.object.value === 'http://www.w3.org/2002/07/owl#DeprecatedClass') concept(q.subject.value).deprecated = true
    }
  }

  for (const q of quads) {
    const s = q.subject.value
    const p = q.predicate.value

    if (schemes.has(s)) {
      if (p === `${DCT}title` || p === `${DC}title` || p === `${SKOS}prefLabel`) {
        literalsByLanguage(schemes.get(s).title, q)
      }
      continue
    }
    if (!declared.has(s)) continue
    const c = concept(s)

    switch (p) {
      case `${SKOS}prefLabel`: literalsByLanguage(c.prefLabel, q); break
      case `${SKOS}altLabel`: literalsByLanguage(c.altLabel, q); break
      case `${SKOS}definition`: literalsByLanguage(c.definition, q); break
      case `${SKOS}scopeNote`: literalsByLanguage(c.scopeNote, q); break
      case `${SKOS}notation`: c.notation = q.object.value; break
      case `${SKOS}broader`: c.broader.push(q.object.value); break
      case `${SKOS}narrower`: c.narrower.push(q.object.value); break
      case `${SKOS}exactMatch`: c.exactMatch.push(q.object.value); break
      case `${SKOS}inScheme`: c.scheme = q.object.value; break
      case `${SKOS}topConceptOf`: c.scheme = c.scheme || q.object.value; c.topConcept = true; break
      case `${DCT}modified`: c.modified = q.object.value; break
      case 'http://www.w3.org/2002/07/owl#deprecated': c.deprecated = q.object.value === 'true'; break
      default: break
    }
  }

  const languages = new Set()
  for (const c of concepts.values()) for (const lang of Object.keys(c.prefLabel)) if (lang) languages.add(lang)

  const schemeList = [...schemes.values()]
  const id = schemeList[0]?.uri || options.name || 'thesaurus'
  const name =
    options.name ||
    schemeList[0]?.title?.de?.[0] ||
    schemeList[0]?.title?.en?.[0] ||
    localName(id.replace(/\/$/, '')) ||
    'Thesaurus'

  const thesaurus = {
    id,
    name,
    schemes: schemeList,
    concepts,
    index: [],
    report: {
      triples: quads.length,
      concepts: concepts.size,
      languages: [...languages].sort(),
      repaired,
      deprecated: [...concepts.values()].filter((c) => c.deprecated).length,
    },
  }
  thesaurus.index = buildIndex(thesaurus)
  return thesaurus
}

/** Flat searchable list: one entry per label, pointing back at its concept. */
function buildIndex(thesaurus) {
  const index = []
  for (const c of thesaurus.concepts.values()) {
    const seen = new Set()
    for (const [kind, bag] of [['pref', c.prefLabel], ['alt', c.altLabel]]) {
      for (const [lang, values] of Object.entries(bag)) {
        for (const value of values) {
          const key = `${value}\u0000${lang}`
          if (seen.has(key)) continue
          seen.add(key)
          index.push({ uri: c.uri, kind, lang, value, lower: value.toLowerCase() })
        }
      }
    }
    if (c.notation) index.push({ uri: c.uri, kind: 'notation', lang: '', value: c.notation, lower: c.notation.toLowerCase() })
  }
  return index
}

/** Preferred label, honouring a language order and falling back sensibly. */
export function labelOf(concept, languages = ['de', 'en']) {
  if (!concept) return ''
  for (const lang of languages) {
    const hit = concept.prefLabel[lang]?.[0]
    if (hit) return hit
  }
  for (const values of Object.values(concept.prefLabel)) if (values[0]) return values[0]
  return localName(concept.uri)
}

/**
 * Search labels.
 *
 * Ranking: exact match, then start-of-string, then anywhere; a preferred label
 * beats an alternative one, and the requested language beats another. Without
 * this order a search for "Glas" buries the concept called exactly that under
 * everything merely containing it.
 */
export function searchConcepts(thesaurus, query, options = {}) {
  const { languages = ['de', 'en'], limit = 40 } = options
  const needle = String(query || '').trim().toLowerCase()
  if (!thesaurus) return []

  if (!needle) {
    return [...thesaurus.concepts.values()]
      .filter((c) => !c.deprecated)
      .sort((a, b) => labelOf(a, languages).localeCompare(labelOf(b, languages)))
      .slice(0, limit)
      .map((concept) => ({ concept, label: labelOf(concept, languages), matched: '' }))
  }

  const langRank = (lang) => {
    const at = languages.indexOf(lang)
    return at >= 0 ? at : languages.length
  }
  const scored = new Map()
  for (const entry of thesaurus.index) {
    const at = entry.lower.indexOf(needle)
    if (at < 0) continue
    const concept = thesaurus.concepts.get(entry.uri)
    if (!concept || concept.deprecated) continue
    const position = entry.lower === needle ? 0 : at === 0 ? 1 : 2
    const score = position * 100 + (entry.kind === 'pref' ? 0 : 10) + langRank(entry.lang) + entry.value.length / 1000
    const existing = scored.get(entry.uri)
    if (!existing || score < existing.score) {
      scored.set(entry.uri, { concept, score, label: labelOf(concept, languages), matched: entry.value })
    }
  }
  return [...scored.values()].sort((a, b) => a.score - b.score).slice(0, limit)
}

/** Broader chain, outermost first — for showing a concept in its context. */
export function pathOf(thesaurus, uri, languages = ['de', 'en']) {
  const path = []
  const seen = new Set()
  let current = thesaurus.concepts.get(uri)
  while (current && !seen.has(current.uri)) {
    seen.add(current.uri)
    path.unshift(labelOf(current, languages))
    current = thesaurus.concepts.get(current.broader[0])
  }
  return path
}

/**
 * How well a set of existing values is already covered by a thesaurus.
 *
 * The basis of the reconciliation view: which values are concepts already, which
 * match a label but carry no URI, and which are unknown.
 */
export function reconcile(thesaurus, values, options = {}) {
  const { languages = ['de', 'en'] } = options
  const byLabel = new Map()
  for (const entry of thesaurus.index) {
    const key = entry.lower
    if (!byLabel.has(key)) byLabel.set(key, entry.uri)
  }

  const result = { exact: [], byLabel: [], unknown: [] }
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (!text) continue
    if (thesaurus.concepts.has(text)) {
      result.exact.push({ value: text, uri: text })
      continue
    }
    const uri = byLabel.get(text.toLowerCase())
    if (uri) {
      result.byLabel.push({ value: text, uri, label: labelOf(thesaurus.concepts.get(uri), languages) })
      continue
    }
    result.unknown.push({ value: text })
  }
  return result
}
