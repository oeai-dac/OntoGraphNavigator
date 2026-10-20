/**
 * Where thesauri come from.
 *
 * Two routes, and the choice is not a preference:
 *
 *   file    the normal case. Drop a SKOS file in, keep it, work offline.
 *   online  fetch it from the publisher.
 *
 * The online route needs help, because `vocabs-downloads.acdh.oeaw.ac.at` sends
 * no `Access-Control-Allow-Origin` header at all — measured, not assumed. A
 * browser therefore refuses the request outright, however well-formed it is.
 *
 * So the fetch goes through the development server, which is how this tool is
 * actually started (`npm run dev`, or the .bat file). Vite forwards `/vocabs/…`
 * to the publisher; no browser rule is broken because the request goes to the
 * page's own origin.
 *
 * Consequence to be aware of: a *built* copy served from a plain web server has
 * no proxy. There the online route fails and the file route is the way. That is
 * reported as such rather than silently returning nothing.
 *
 * The clean fix is not ours to make: one `Access-Control-Allow-Origin: *` on
 * that static file server would make the online route work everywhere.
 */

import { readSkos } from './thesaurus'

/** Path prefix the dev server forwards. Must match vite.config.js. */
export const PROXY_PREFIX = '/vocabs'

const ACDH_HOST = 'https://vocabs-downloads.acdh.oeaw.ac.at'

/**
 * Vocabularies known by name, so nobody has to paste a URL.
 * `path` is relative to the publisher's host.
 */
export const KNOWN_THESAURI = [
  {
    id: 'oeai-materials',
    name: 'OeAI Materials',
    description: 'Material vocabulary of the Austrian Archaeological Institute',
    host: ACDH_HOST,
    path: '/vocabs-main/Archaeology/OeAIMaterials/oeai_materials.ttl',
    conceptNamespace: 'https://vocabs.acdh.oeaw.ac.at/oeai-materials/',
  },
  {
    id: 'oeai-cultural-periods',
    name: 'OeAI Cultural Time Periods',
    description: 'Chronological vocabulary of the Austrian Archaeological Institute',
    host: ACDH_HOST,
    path: '/vocabs-main/Archaeology/OeAICulturalTimePeriods/oeai_cultural_time_periods.ttl',
    conceptNamespace: 'https://vocabs.acdh.oeaw.ac.at/oeai-cultural-periods/',
  },
]

export function knownThesaurusById(id) {
  return KNOWN_THESAURI.find((entry) => entry.id === id) || null
}

/** The publisher's own URL, for showing and for copying. */
export function directUrl(entry) {
  return `${entry.host}${entry.path}`
}

/** True while the dev server is in front of us and can proxy. */
export function proxyAvailable() {
  return Boolean(import.meta.env?.DEV)
}

/**
 * Fetch and parse a known vocabulary.
 *
 * @param {object} entry  from KNOWN_THESAURI
 * @returns {Promise<object>} thesaurus
 */
export async function fetchKnownThesaurus(entry, options = {}) {
  const url = proxyAvailable() ? `${PROXY_PREFIX}${entry.path}` : directUrl(entry)
  let response
  try {
    response = await fetch(url, { headers: { Accept: 'text/turtle, application/x-turtle, text/plain' } })
  } catch (error) {
    throw new Error(
      proxyAvailable()
        ? `${entry.name} could not be fetched: ${error.message}`
        : `${entry.name} could not be fetched. The publisher sends no CORS header, so a browser cannot ` +
          `read it directly from a built copy. Run the development server, or download ` +
          `${directUrl(entry)} and load the file.`
    )
  }
  if (!response.ok) throw new Error(`${entry.name} could not be fetched: HTTP ${response.status} ${response.statusText}`)

  const text = await response.text()
  const thesaurus = readSkos(text, { name: options.name || entry.name })
  thesaurus.origin = { kind: 'online', url: directUrl(entry), fetchedAt: new Date().toISOString() }
  thesaurus.source = text
  return thesaurus
}

/** Read a thesaurus from a file the user chose. The extension is not trusted. */
export async function readThesaurusFile(file) {
  const text = await file.text()
  const thesaurus = readSkos(text, { name: file.name.replace(/\.[^.]+$/, '') })
  thesaurus.origin = { kind: 'file', filename: file.name, loadedAt: new Date().toISOString() }
  thesaurus.source = text
  return thesaurus
}

/**
 * A thesaurus kept in a project zip (lib/projectZip.js), read again as it was
 * when the project was saved — no fetch, nothing leaves the computer.
 */
export function readKeptThesaurus({ text, name, origin }) {
  const thesaurus = readSkos(text, { name })
  thesaurus.origin = origin || { kind: 'project' }
  thesaurus.source = text
  return thesaurus
}

/**
 * Which vocabulary plausibly belongs to a field, judged by the values already in
 * it. A column full of `vocabs:concept…` under the materials namespace needs no
 * asking about.
 */
export function suggestThesaurus(values, thesauri) {
  const sample = values.filter(Boolean).slice(0, 200)
  if (!sample.length) return null
  let best = null
  for (const thesaurus of thesauri) {
    let hits = 0
    for (const value of sample) if (thesaurus.concepts.has(String(value).trim())) hits++
    const ratio = hits / sample.length
    if (ratio > 0.2 && (!best || ratio > best.ratio)) best = { thesaurus, ratio, hits }
  }
  return best
}
