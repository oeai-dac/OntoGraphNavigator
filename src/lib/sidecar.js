/**
 * The companion file, `<project>.ogn.json`.
 *
 * Identifier rules, thesaurus bindings and field order are the Navigator's own
 * settings. The Studio's project format has no slot for them, and a field
 * smuggled in would be dropped the next time the Studio saves. So they live
 * beside the project, in a file that survives every round trip through it.
 */

import { inferTemplate } from './uriTemplate'

export const SIDECAR_KIND = 'ontographnavigator-settings'
export const SIDECAR_VERSION = 1

export function emptySidecar() {
  return {
    kind: SIDECAR_KIND,
    version: SIDECAR_VERSION,
    // mapping node id -> identifier rule
    uriRules: {},
    // mapping node id -> { thesaurusId, scheme, languages }
    thesaurusBindings: {},
    // form node id -> field keys, in the order they should appear
    fieldOrder: {},
    // field keys never to show
    hidden: [],
    // Whether a rule is applied without asking. Off by default: an identifier is
    // never assigned silently.
    silentIdentifiers: {},
    // matrix view -> unit id -> { x, y }: units placed by hand (the Matrix tab)
    matrixPositions: {},
    // protocol package id -> where its fields live (lib/protocolBinding.js)
    protocolBindings: {},
    // mapping node id -> values offered for it before any is in the data (the unit types)
    valueLists: {},
    author: '',
  }
}

export function readSidecar(json) {
  if (!json || typeof json !== 'object') throw new Error('not a JSON object')
  if (json.kind !== SIDECAR_KIND) throw new Error('This is not an OntoGraphNavigator settings file')
  const base = emptySidecar()
  return {
    ...base,
    ...json,
    uriRules: { ...base.uriRules, ...(json.uriRules || {}) },
    thesaurusBindings: { ...base.thesaurusBindings, ...(json.thesaurusBindings || {}) },
    fieldOrder: { ...base.fieldOrder, ...(json.fieldOrder || {}) },
    hidden: json.hidden || [],
    silentIdentifiers: { ...base.silentIdentifiers, ...(json.silentIdentifiers || {}) },
    matrixPositions: { ...base.matrixPositions, ...(json.matrixPositions || {}) },
    protocolBindings: { ...base.protocolBindings, ...(json.protocolBindings || {}) },
    valueLists: { ...base.valueLists, ...(json.valueLists || {}) },
  }
}

export function writeSidecar(config, { pretty = true } = {}) {
  const out = { ...emptySidecar(), ...config, kind: SIDECAR_KIND, version: SIDECAR_VERSION }
  return JSON.stringify(out, null, pretty ? 2 : 0)
}

/**
 * Propose settings for a project that has none.
 *
 * Identifier rules are read off the columns as they stand — see
 * `inferTemplate`. Proposed, not applied: each one is shown with the share of
 * existing values it reproduces, and confirmed by hand.
 *
 * @returns {{config: object, proposals: Array}}
 */
export function proposeSidecar(model, options = {}) {
  const { minCoverage = 0.8 } = options
  const config = emptySidecar()
  const proposals = []

  // A node's rows are those where its own identifier column is filled. Deriving
  // over all rows would mix two rules that share a column, as `Datierung_ID`
  // does with production and genesis dates.
  for (const entity of model.entities.values()) {
    const table = model.tables.get(entity.tableId)
    if (!table || !entity.idColumn) continue

    const owners = model.relations.filter((r) => r.target === entity.nodeId)
    let rows = table.rows
    if (owners.length === 1) {
      const parent = model.entities.get(owners[0].source)
      if (parent && parent.tableId === entity.tableId && parent.idColumn) {
        rows = table.rows.filter((row) => String(row[parent.idColumn] ?? '').trim())
      }
    }

    const guess = inferTemplate(entity.idColumn, rows, { columns: table.columns, minCoverage })

    if (!guess) {
      // Nothing to read a rule off. In a project that has no rows at all — a
      // model just drawn, or one cleared to start over — a satellite would
      // otherwise be unusable: its identifier is never typed, so without a rule
      // its node cannot come into being. Derive one from its owner instead.
      //
      // Only when the table is genuinely empty. If there are rows and inference
      // still failed, the column is irregular and guessing would be worse than
      // asking.
      if (table.rows.length === 0 && owners.length === 1) {
        const parent = model.entities.get(owners[0].source)
        if (parent && parent.tableId === entity.tableId && parent.idColumn) {
          const suffix = (entity.explorerLabel || entity.classLabel || entity.nodeId)
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_+|_+$/g, '')
          const template = `{${parent.idColumn}}_${suffix}`
          config.uriRules[entity.nodeId] = template
          proposals.push({
            nodeId: entity.nodeId,
            label: entity.explorerLabel || entity.classLabel,
            column: entity.idColumn,
            tableId: entity.tableId,
            template,
            coverage: 1,
            rows: 0,
            confident: true,
            fromDefault: true,
          })
        }
      }
      continue
    }

    proposals.push({
      nodeId: entity.nodeId,
      label: entity.explorerLabel || entity.classLabel,
      column: entity.idColumn,
      tableId: entity.tableId,
      template: guess.template,
      coverage: guess.coverage,
      rows: guess.rows,
      // Perfect rules are safe to adopt; anything less deserves a look.
      confident: guess.coverage >= 0.999,
    })
    if (guess.coverage >= 0.999) config.uriRules[entity.nodeId] = guess.template
  }

  return { config, proposals }
}

/**
 * Which vocabulary belongs to which field, judged by the values already stored.
 * Only proposes where the evidence is strong; a wrong binding is worse than none.
 */
export function proposeThesaurusBindings(model, thesauri, options = {}) {
  const { minRatio = 0.5 } = options
  const bindings = {}
  const proposals = []
  if (!thesauri?.length) return { bindings, proposals }

  for (const entity of model.entities.values()) {
    const table = model.tables.get(entity.tableId)
    if (!table || !entity.idColumn) continue
    const values = [...new Set(table.rows.map((r) => String(r[entity.idColumn] ?? '').trim()).filter(Boolean))]
    if (values.length < 2) continue

    for (const thesaurus of thesauri) {
      const namespace = thesaurus.schemes[0]?.uri
      if (!namespace) continue
      // Compared on the namespace rather than the expanded URI, so a prefixed
      // cell value like `vocabs:concept23817` is recognised without expansion.
      const hits = values.filter((v) => {
        const local = v.includes(':') ? v.slice(v.indexOf(':') + 1) : v
        return thesaurus.concepts.has(`${namespace}${local}`) || thesaurus.concepts.has(v)
      }).length
      const ratio = hits / values.length
      if (ratio < minRatio) continue
      proposals.push({
        nodeId: entity.nodeId,
        label: entity.explorerLabel || entity.classLabel,
        column: entity.idColumn,
        thesaurusId: thesaurus.id,
        thesaurusName: thesaurus.name,
        ratio,
        hits,
        values: values.length,
      })
      bindings[entity.nodeId] = { thesaurusId: thesaurus.id, languages: ['de', 'en'] }
      break
    }
  }

  return { bindings, proposals }
}
