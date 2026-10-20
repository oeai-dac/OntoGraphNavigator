/**
 * Prefix handling for instance identifiers.
 *
 * A cell value in a mapped ID column becomes a node identifier in one of three
 * ways, and the order matters:
 *
 *   1. the node is in literal mode (`noPrefix`)  -> the value is taken verbatim
 *   2. the value carries its own `prefix:local`  -> that prefix wins
 *   3. otherwise                                 -> the project's `idPrefix`
 *
 * Rule 2 is what lets a single column mix namespaces: `vocabs:concept23817`
 * next to a plain `EDP22-SE2001`.
 */

/** Matches `prefix:local`, but not a full URI (`http://…`) and not a bare word. */
const PREFIXED = /^([A-Za-z][\w.-]*):(.+)$/

/** True when the value already looks like an absolute URI. */
export function isAbsoluteUri(value) {
  return /^[A-Za-z][\w+.-]*:\/\//.test(value) || value.startsWith('urn:')
}

/**
 * Expand a cell value into a full identifier.
 *
 * @param {string}  value      raw cell content
 * @param {object}  prefixMap  prefix -> namespace
 * @param {string}  idPrefix   the project's default prefix (a *prefix*, not a namespace)
 * @param {boolean} noPrefix   literal mode: never prepend anything
 */
export function expandId(value, prefixMap, idPrefix, noPrefix = false) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  if (noPrefix) return raw
  if (isAbsoluteUri(raw)) return raw

  const m = PREFIXED.exec(raw)
  if (m && Object.prototype.hasOwnProperty.call(prefixMap, m[1])) {
    return prefixMap[m[1]] + m[2]
  }

  const base = prefixMap[idPrefix]
  return base ? base + raw : raw
}

/**
 * Expand a class or property reference from the mapping.
 *
 * Mapping nodes carry `data.uri`, which is usually already absolute — but free
 * nodes keep the prefixed form (`rdfs:Literal`), so both have to be handled.
 */
export function expandTerm(term, prefixMap) {
  const raw = String(term ?? '').trim()
  if (!raw) return ''
  if (isAbsoluteUri(raw)) return raw
  const m = PREFIXED.exec(raw)
  if (m && Object.prototype.hasOwnProperty.call(prefixMap, m[1])) {
    return prefixMap[m[1]] + m[2]
  }
  return raw
}

/** Shorten a URI back to `prefix:local` when a prefix covers it — longest namespace wins. */
export function compactUri(uri, prefixMap) {
  const raw = String(uri ?? '')
  let best = null
  for (const [prefix, ns] of Object.entries(prefixMap)) {
    if (!ns || !raw.startsWith(ns)) continue
    if (!best || ns.length > best.ns.length) best = { prefix, ns }
  }
  return best ? `${best.prefix}:${raw.slice(best.ns.length)}` : raw
}

/** Local name of a URI: everything after the last `#`, `/` or `:`. */
export function localName(uri) {
  const raw = String(uri ?? '')
  const cut = Math.max(raw.lastIndexOf('#'), raw.lastIndexOf('/'), raw.lastIndexOf(':'))
  return cut >= 0 ? raw.slice(cut + 1) : raw
}

/**
 * Namespaces bound to more than one prefix.
 *
 * The reference project carries `vocabs` and `vacabs` on the same namespace —
 * a typo that keeps both alive. Harmless for expansion, but it makes compaction
 * arbitrary, so the check list reports it.
 */
export function duplicateNamespaces(prefixMap) {
  const byNs = new Map()
  for (const [prefix, ns] of Object.entries(prefixMap)) {
    if (!ns) continue
    if (!byNs.has(ns)) byNs.set(ns, [])
    byNs.get(ns).push(prefix)
  }
  return [...byNs.entries()]
    .filter(([, prefixes]) => prefixes.length > 1)
    .map(([ns, prefixes]) => ({ namespace: ns, prefixes }))
}
