/**
 * Rules for minting identifiers.
 *
 * Identifiers are never assigned silently: a rule fills the field in, and the
 * field stays visible and editable. The rule exists so nobody types the same
 * derivation four hundred times, not so the decision is taken away.
 *
 * The need is documented inside the sample data itself — HME's mapping has nodes
 * literally named "Generieren: SE_Probe_[Nummer]" and "Generieren: SE_gen",
 * because the rule had nowhere to live but the display name.
 *
 *   {Column}          value of another column in the same row
 *   {A|B|C}           first of several columns that is not empty
 *   {Column~slug}     URI-safe (umlauts transliterated, spaces to hyphens)
 *   {Column~senr}     the number of a stratigraphic unit: without a leading
 *                     "SU"/"SE", URI-safe as the HME mints it ("SU 001" -> "001")
 *   {Column~local}    URI-safe the way the Harris Matrix Editor mints names
 *                     (umlauts transliterated, accents dropped, underscores)
 *   {Column~num}      digits only — "SU 001" becomes "001"
 *   {Column~upper}    {Column~lower}
 *   {seq}  {seq:4}    running number, optionally zero-padded
 *   {today}  {year}   2026-08-05, 2026
 *   {uuid}            random identifier, for when nothing else is unique
 *
 * Anything outside braces is literal. A literal brace is written {{ or }}.
 */

const UMLAUTS = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' }

const MODIFIERS = {
  slug: (v) =>
    v
      .replace(/[äöüÄÖÜß]/g, (c) => UMLAUTS[c])
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, ''),
  senr: (v) => MODIFIERS.local(v.replace(/^\s*S[UE]\s*[-_.]?\s*(?=\d)/i, '')),
  local: (v) =>
    v
      .trim()
      .replace(/[äöüÄÖÜß]/g, (c) => UMLAUTS[c])
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[_-]+|[_-]+$/g, ''),
  num: (v) => (v.match(/\d+/g) || []).join(''),
  upper: (v) => v.toUpperCase(),
  lower: (v) => v.toLowerCase(),
  trim: (v) => v.trim(),
}

export const MODIFIER_NAMES = Object.keys(MODIFIERS)

/** Placeholders that do not name a column. */
const SPECIAL = new Set(['seq', 'today', 'year', 'uuid'])

/**
 * @param {string} template
 * @returns {Array} tokens: {type:'text',value} | {type:'field',columns,modifier} |
 *                          {type:'special',name,pad}
 * @throws on unbalanced braces or an unknown modifier
 */
export function parseTemplate(template) {
  const source = String(template ?? '')
  const tokens = []
  let text = ''
  let i = 0

  while (i < source.length) {
    const ch = source[i]
    if (ch === '{' && source[i + 1] === '{') { text += '{'; i += 2; continue }
    if (ch === '}' && source[i + 1] === '}') { text += '}'; i += 2; continue }
    if (ch === '}') throw new Error(`Unexpected "}" at position ${i + 1}`)
    if (ch !== '{') { text += ch; i++; continue }

    const end = source.indexOf('}', i)
    if (end < 0) throw new Error(`"{" at position ${i + 1} is never closed`)
    if (text) { tokens.push({ type: 'text', value: text }); text = '' }

    const body = source.slice(i + 1, end).trim()
    i = end + 1
    if (!body) throw new Error('Empty placeholder "{}"')

    const [namePart, modifier] = body.split('~').map((s) => s.trim())
    if (modifier !== undefined && !MODIFIERS[modifier]) {
      throw new Error(`Unknown modifier "~${modifier}". Available: ${MODIFIER_NAMES.join(', ')}`)
    }

    const [head, pad] = namePart.split(':').map((s) => s.trim())
    if (SPECIAL.has(head)) {
      if (head === 'seq' && pad !== undefined && !/^\d+$/.test(pad)) {
        throw new Error(`"{seq:${pad}}" — the padding must be a number`)
      }
      tokens.push({ type: 'special', name: head, pad: pad ? Number(pad) : 0, modifier })
      continue
    }

    const columns = namePart.split('|').map((s) => s.trim()).filter(Boolean)
    if (!columns.length) throw new Error(`Empty column name in "{${body}}"`)
    tokens.push({ type: 'field', columns, modifier })
  }
  if (text) tokens.push({ type: 'text', value: text })
  return tokens
}

const cell = (row, column) => {
  const v = row?.[column]
  return v === null || v === undefined ? '' : String(v).trim()
}

/**
 * @param {string|Array} template  the rule, or already-parsed tokens
 * @param {object} row
 * @param {object} [context]  { sequence, now, uuid }
 * @returns {{value: string, missing: string[]}} `missing` names the placeholders
 *          that resolved to nothing — an identifier with a hole in it is worse
 *          than none, so the caller can refuse it.
 */
export function renderTemplate(template, row, context = {}) {
  const tokens = Array.isArray(template) ? template : parseTemplate(template)
  const now = context.now instanceof Date ? context.now : new Date()
  const missing = []
  let value = ''

  for (const token of tokens) {
    if (token.type === 'text') { value += token.value; continue }

    let piece = ''
    if (token.type === 'special') {
      switch (token.name) {
        case 'seq':
          piece = String(context.sequence ?? 1)
          if (token.pad) piece = piece.padStart(token.pad, '0')
          break
        case 'today': piece = now.toISOString().slice(0, 10); break
        case 'year': piece = String(now.getFullYear()); break
        case 'uuid':
          piece = context.uuid || (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
          break
        default: break
      }
    } else {
      for (const column of token.columns) {
        const candidate = cell(row, column)
        if (candidate) { piece = candidate; break }
      }
      if (!piece) missing.push(token.columns.join('|'))
    }

    if (token.modifier && piece) piece = MODIFIERS[token.modifier](piece)
    value += piece
  }

  return { value, missing }
}

/**
 * Static check against the columns a table actually has.
 * A typo in a column name is otherwise only noticed as a silently empty part.
 */
export function validateTemplate(template, columns = []) {
  const errors = []
  const warnings = []
  let tokens = []
  try {
    tokens = parseTemplate(template)
  } catch (error) {
    return { ok: false, errors: [error.message], warnings, tokens: [] }
  }

  const known = new Set(columns)
  let hasVariablePart = false
  for (const token of tokens) {
    if (token.type === 'field') {
      hasVariablePart = true
      if (known.size) {
        const unknown = token.columns.filter((c) => !known.has(c))
        if (unknown.length === token.columns.length) {
          errors.push(`No such column: ${unknown.map((c) => `"${c}"`).join(', ')}`)
        } else if (unknown.length) {
          warnings.push(`Unknown column in the fallback chain: ${unknown.map((c) => `"${c}"`).join(', ')}`)
        }
      }
    } else if (token.type === 'special' && token.name !== 'today' && token.name !== 'year') {
      hasVariablePart = true
    }
  }
  if (tokens.length && !hasVariablePart) {
    warnings.push('The rule contains nothing that varies — every row would get the same identifier.')
  }
  return { ok: errors.length === 0, errors, warnings, tokens }
}

/**
 * Render against real rows, so a rule can be judged before it is used.
 * Reports collisions, because that is what a rule most often gets wrong.
 */
export function previewTemplate(template, rows, options = {}) {
  const { limit = 5, context = {} } = options
  const check = validateTemplate(template, options.columns)
  if (!check.ok) return { ...check, samples: [], collisions: [], empty: 0 }

  const seen = new Map()
  const samples = []
  let empty = 0
  let sequence = context.sequence ?? 1

  rows.forEach((row, index) => {
    const { value, missing } = renderTemplate(check.tokens, row, { ...context, sequence: sequence++ })
    if (!value || missing.length) empty++
    if (value) seen.set(value, (seen.get(value) || 0) + 1)
    if (samples.length < limit) samples.push({ index, value, missing })
  })

  const collisions = [...seen.entries()].filter(([, n]) => n > 1).map(([value, n]) => ({ value, count: n }))
  return { ...check, samples, collisions, empty, distinct: seen.size, total: rows.length }
}

/**
 * A value that is not taken yet.
 * Only `{seq}` can be advanced, so without it the rule is returned as it stands
 * and the collision is the caller's to report.
 */
/**
 * An identifier for a new record by its rule — the identifier rules of the
 * settings, as the phase and object editors use them: the rule's value, made
 * unique against `taken`; `fallback` where there is no rule or it gives none.
 */
export function identifierByRule(rule, row, taken, fallback) {
  const unique = (base) => {
    if (!taken?.has(base)) return base
    let i = 2
    while (taken.has(`${base}_${i}`)) i++
    return `${base}_${i}`
  }
  if (rule) {
    const { value } = mintUnique(rule, row, taken)
    if (value) return unique(value)
  }
  return unique(fallback)
}

export function mintUnique(template, row, taken, context = {}) {
  const tokens = parseTemplate(template)
  const usesSequence = tokens.some((t) => t.type === 'special' && t.name === 'seq')
  let sequence = context.sequence ?? 1
  for (let attempt = 0; attempt < 10000; attempt++) {
    const { value, missing } = renderTemplate(tokens, row, { ...context, sequence })
    if (!value) return { value: '', missing, collision: false }
    if (!taken?.has(value)) return { value, missing, collision: false, sequence }
    if (!usesSequence) return { value, missing, collision: true }
    sequence++
  }
  return { value: '', missing: [], collision: true }
}

/**
 * Guess a rule from the identifiers already in a column.
 *
 * Looks for another column whose value is a prefix of each identifier, with a
 * constant remainder — which is how these identifiers are in fact built:
 * `EDP22-SE2001_verm_OK` is `{SE-Nummer}_verm_OK`.
 *
 * Several source columns are combined into a fallback chain when they share the
 * same remainder and each covers only part of the rows. Different remainders are
 * *not* merged: in tbl_11, `Datierung_ID` holds both `_ProdDate` and
 * `_GenesisDate`, and those are two rules on two mapping nodes, not one rule.
 *
 * @returns {{template: string, coverage: number, rows: number}|null}
 */
export function inferTemplate(column, rows, options = {}) {
  const { columns = [], minCoverage = 0.6 } = options
  const candidates = columns.filter((c) => c !== column)
  const filled = rows.filter((row) => cell(row, column))
  if (!filled.length) return null

  // (source column, remainder) -> how many rows it explains
  const groups = new Map()
  for (const row of filled) {
    const target = cell(row, column)
    for (const source of candidates) {
      const value = cell(row, source)
      if (!value || value.length >= target.length + 1) {
        if (value !== target) continue
      }
      if (!target.startsWith(value)) continue
      const remainder = target.slice(value.length)
      const key = `${source}\u0000${remainder}`
      const entry = groups.get(key) || { source, remainder, count: 0 }
      entry.count++
      groups.set(key, entry)
    }
  }
  if (!groups.size) return null

  const byRemainder = new Map()
  for (const entry of groups.values()) {
    const list = byRemainder.get(entry.remainder) || []
    list.push(entry)
    byRemainder.set(entry.remainder, list)
  }

  /**
   * Coverage is measured by *rendering* the candidate and comparing, never by
   * adding up how many rows each column could explain.
   *
   * Those two numbers come apart as soon as a fallback chain is involved. In
   * tbl_7, `Punktnr` explains 379 of 397 `geometry_id` values and `Fund-Nr.`
   * the remaining 18 — but `Punktnr` is never empty, so `{Punktnr|Fund-Nr.}`
   * always takes the first and reproduces 379, not 397. Summing the parts would
   * report a rule as perfect that gets eighteen identifiers wrong.
   */
  const score = (template) => {
    let tokens
    try {
      tokens = parseTemplate(template)
    } catch {
      return 0
    }
    let hits = 0
    for (const row of filled) {
      const { value } = renderTemplate(tokens, row)
      if (value && value === cell(row, column)) hits++
    }
    return hits / filled.length
  }

  let best = null
  const consider = (template, chainLength) => {
    const coverage = score(template)
    if (
      !best ||
      coverage > best.coverage + 1e-9 ||
      (Math.abs(coverage - best.coverage) < 1e-9 && chainLength < best.chain)
    ) {
      best = { template, coverage, rows: filled.length, chain: chainLength }
    }
  }

  for (const [remainder, entries] of byRemainder) {
    entries.sort((a, b) => b.count - a.count)
    const escaped = remainder.replace(/\{/g, '{{').replace(/\}/g, '}}')
    // Single columns first, then chains of the strongest few. A chain only wins
    // if it genuinely renders more values correctly.
    for (const entry of entries.slice(0, 4)) consider(`{${entry.source}}${escaped}`, 1)
    for (let length = 2; length <= Math.min(3, entries.length); length++) {
      const chain = entries.slice(0, length).map((e) => e.source)
      consider(`{${chain.join('|')}}${escaped}`, length)
    }
  }

  if (!best || best.coverage < minCoverage) return null
  delete best.chain
  return best
}
