/**
 * Entry forms, derived from the mapping.
 *
 * The mapping already holds everything a form needs — fields, value ranges and
 * the target column of each — so no form is written by hand. The same idea as
 * HME's BDA form, which runs off the schema rather than off hard-coded fields.
 *
 * The part that makes it usable is folding: nobody wants to "create an
 * E12_Production" in order to type a date. A satellite node — one that sits on
 * the same table, is owned by exactly one parent, and carries nothing but
 * literals — disappears into its parent's form as a group of plain fields. Its
 * identifier is minted by a rule instead of typed.
 *
 * What comes out of a find's form in the reference project:
 *
 *   Inventory number   HMO_INVENTARNUMMER      identifier, rule-filled
 *   Find type          E55 via Object_ID       concept, 35 known values
 *   Material           E57 via Material_ID     concept, thesaurus-bound
 *   Note               rdfs:Literal            text
 *   Image link         E42 via …_search        value
 *   Dating from–to     E12 + two xsd:gYear     group, two year fields
 *   Found in SU        join on column SE       reference
 *   Find spot          S23 on another table    geometry, read-only
 */

import { localName } from './prefixes'
import { isMultilingual, languagesOf } from './languages'

/** Field kinds the interface knows how to render. */
export const FIELD_KINDS = ['identifier', 'label', 'text', 'longtext', 'url', 'year', 'date', 'number', 'boolean', 'geometry', 'concept', 'reference', 'group']

/**
 * Above this share of distinct values, a column is not a controlled vocabulary.
 * The image link in the reference project has one value per find; offering those
 * 500 as a list to choose from would be noise, not help.
 */
const VOCABULARY_CARDINALITY_LIMIT = 0.5

const XSD = 'http://www.w3.org/2001/XMLSchema#'
const LONG_TEXT = /description|beschreibung|remarks?|anmerkung|notes?\b/i
const NAME_CLASS = /E41_Appellation$|E42_Identifier$|E35_Title$/
const WKT = 'http://www.opengis.net/ont/geosparql#wktLiteral'

/** Which input a folded literal deserves, from the class the mapping gave it. */
export function fieldKindForClass(classUri, sampleValues = []) {
  const uri = String(classUri || '')
  if (uri === WKT || uri === 'geo:wktLiteral') return 'geometry'
  const local = uri.startsWith(XSD) ? uri.slice(XSD.length) : uri.startsWith('xsd:') ? uri.slice(4) : ''
  switch (local) {
    case 'gYear': case 'gYearMonth': return 'year'
    case 'date': case 'dateTime': return 'date'
    case 'integer': case 'int': case 'long': case 'decimal': case 'double': case 'float': case 'nonNegativeInteger':
      return 'number'
    case 'boolean': return 'boolean'
    default: break
  }
  const longest = sampleValues.reduce((n, v) => Math.max(n, String(v ?? '').length), 0)
  return longest > 80 ? 'longtext' : 'text'
}

function cell(row, column) {
  const v = row?.[column]
  return v === null || v === undefined ? '' : String(v).trim()
}

/**
 * Distinct values of a column, most frequent first — the picker's option list.
 *
 * Exported because the value list must be read *live*. A form is built once and
 * describes the shape of a record, which does not change while entering; the
 * values in a column change with every record saved. Snapshotting them here
 * meant a newly created site did not appear in the next site's picker until the
 * project file had been saved and loaded again.
 */
export function distinctValues(rows, column, limit = 500) {
  if (!column) return []
  const counts = new Map()
  for (const row of rows) {
    const value = cell(row, column)
    if (!value) continue
    counts.set(value, (counts.get(value) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }))
}

/**
 * How many parents point at an entity, and which.
 * A satellite must be owned by exactly one.
 */
function ownership(model) {
  const parents = new Map() // nodeId -> Set of parent nodeIds
  for (const rel of model.relations) {
    if (!parents.has(rel.target)) parents.set(rel.target, new Set())
    parents.get(rel.target).add(rel.source)
  }
  for (const rel of model.dot1Relations) {
    if (!parents.has(rel.target)) parents.set(rel.target, new Set())
    parents.get(rel.target).add(rel.source)
  }
  return parents
}

function outgoingOf(model, nodeId) {
  return model.relations.filter((r) => r.source === nodeId)
}
function literalsOf(model, nodeId) {
  return model.literalEdges.filter((e) => e.source === nodeId)
}

/**
 * A satellite: same table, single owner, and nothing hanging off it but
 * literals. Anything else is a thing in its own right and gets its own form.
 */
function isSatellite(model, parents, parentId, childId) {
  const parent = model.entities.get(parentId)
  const child = model.entities.get(childId)
  if (!parent || !child) return false
  if (parent.tableId !== child.tableId) return false
  const owners = parents.get(childId)
  if (!owners || owners.size !== 1 || !owners.has(parentId)) return false
  if (outgoingOf(model, childId).length) return false
  // Nothing to fold means nothing to show. The unit's interpretation is owned by
  // exactly one unit and sits on its table, but carries no literal of its own —
  // folding it would produce an empty group where a picker belongs.
  return literalsOf(model, childId).length > 0
}

/**
 * A value node: a leaf whose whole purpose is to carry a controlled value —
 * a type, a material, an identifier. Shared between parents, so not a
 * satellite, but it does not deserve a form of its own either.
 */
function isValueNode(model, nodeId) {
  const entity = model.entities.get(nodeId)
  if (!entity) return false
  return outgoingOf(model, nodeId).length === 0 && literalsOf(model, nodeId).length === 0
}

/**
 * @param {object} model  from readProjectFile
 * @param {object} [config]  sidecar settings: { uriRules, thesaurusBindings, hidden }
 * @returns {{forms: Array, byNode: Map, byType: Map}}
 */
/** A field's name as a label: its first letter a capital ("unit type" → "Unit type"). */
const asLabel = (text) => (text ? String(text).charAt(0).toUpperCase() + String(text).slice(1) : text)

/** Every field of a form (and of its groups) named as a label. */
function capitalise(fields) {
  for (const f of fields) {
    if (f.label) f.label = asLabel(f.label)
    if (Array.isArray(f.fields)) capitalise(f.fields)
  }
  return fields
}

export function buildForms(model, config = {}) {
  const parents = ownership(model)
  const uriRules = config.uriRules || {}
  const bindings = config.thesaurusBindings || {}

  // A node needs a form of its own unless it is folded into another one.
  const folded = new Set()
  for (const rel of model.relations) {
    if (isSatellite(model, parents, rel.source, rel.target)) folded.add(rel.target)
  }
  // Value nodes are reached through a picker, never through their own form.
  const valueNodes = new Set([...model.entities.keys()].filter((id) => isValueNode(model, id)))

  const rowsOf = (tableId) => model.tables.get(tableId)?.rows || []

  /**
   * The object a unit forms part of (P46i, on the unit's own rows): one of the
   * objects there are, or a new one by name — a choice, as in the matrix's
   * unit panel, not the object's columns typed in by hand.
   */
  function isPartOfShared(entity, rel, target) {
    return /P46i_forms_part_of$/.test(rel.propertyUri) && !rel.joinSource && target.tableId === entity.tableId &&
      !!target.labelColumn && target.labelColumn !== target.idColumn
  }

  function scalarField(entity, literalEdge, lit) {
    const rows = rowsOf(lit.tableId)
    const samples = rows.slice(0, 200).map((r) => cell(r, lit.valueColumn))
    let kind = fieldKindForClass(lit.classUri, samples)
    // A description is long text from the start, before any value says so.
    if (kind === 'text' && LONG_TEXT.test(`${lit.explorerLabel} ${lit.valueColumn}`)) kind = 'longtext'
    return {
      key: `lit:${literalEdge.literalNodeId}`,
      kind,
      label: lit.explorerLabel || localName(literalEdge.propertyUri).replace(/_/g, ' '),
      column: lit.valueColumn,
      tableId: lit.tableId,
      propertyUri: literalEdge.propertyUri,
      // Geometry is carried, not entered — the decision was to leave capture in QGIS.
      readOnly: kind === 'geometry',
      classUri: lit.classUri,
    }
  }

  /**
   * A leaf reached from this entity.
   *
   * Usually a concept picker — but not when the column plainly holds a free
   * value rather than a term: one distinct value per row, or literal mode with
   * no separate label column. The image link is that case; a list of 500 URLs
   * to pick from would be worse than a text box.
   */
  function conceptField(entity, rel, target) {
    const rows = rowsOf(target.tableId)
    const optionColumn = target.labelColumn || target.idColumn
    const options = distinctValues(rows, optionColumn)
    const filled = rows.reduce((n, row) => n + (cell(row, optionColumn) ? 1 : 0), 0)
    const freeText =
      (target.noPrefix && (!target.labelColumn || target.labelColumn === target.idColumn)) ||
      (filled > 20 && options.length / filled > VOCABULARY_CARDINALITY_LIMIT)

    const label = rel.explorerLabel || target.explorerLabel || localName(rel.propertyUri).replace(/_/g, ' ')
    // A name (an appellation, an identifier, a title) is the unit's own text, not
    // a term to choose: typed into the label column, its identifier by the rule.
    if (NAME_CLASS.test(target.classUri) && target.labelColumn && target.labelColumn !== target.idColumn) {
      return {
        key: `rel:${rel.edgeId}`,
        label,
        kind: (() => {
          const samples = distinctValues(rows, target.labelColumn).slice(0, 20).map((o) => o.value)
          return samples.length > 0 && samples.every((v) => /^https?:\/\//.test(v)) ? 'url' : fieldKindForClass('', samples)
        })(),
        column: target.labelColumn,
        idColumn: target.idColumn,
        idRule: uriRules[target.nodeId] || '',
        tableId: target.tableId,
        propertyUri: rel.propertyUri,
        targetNodeId: target.nodeId,
        readOnly: false,
      }
    }
    const common = {
      key: `rel:${rel.edgeId}`,
      label,
      column: target.idColumn,
      labelColumn: target.labelColumn && target.labelColumn !== target.idColumn ? target.labelColumn : null,
      tableId: target.tableId,
      propertyUri: rel.propertyUri,
      targetNodeId: target.nodeId,
      targetTypeKey: target.typeKey,
      readOnly: false,
    }

    if (freeText) {
      const samples = options.slice(0, 20).map((o) => o.value)
      const looksLikeUrl = samples.length > 0 && samples.every((v) => /^https?:\/\//.test(v))
      return { ...common, kind: looksLikeUrl ? 'url' : fieldKindForClass('', samples), options: [] }
    }

    return {
      ...common,
      kind: 'concept',
      // Choosing a concept fills both columns at once: the identifier and the
      // label. The mapping already models exactly that pair.
      options,
      // Values offered before any is in the data (config.valueLists: the unit types).
      suggested: config.valueLists?.[target.nodeId] || [],
      // A new value's identifier, where the mapping has a rule for it.
      idRule: uriRules[target.nodeId] || '',
      thesaurus: bindings[target.nodeId] || null,
    }
  }

  /**
   * A partner on the same table.
   *
   * Two entities on one table are related by *sharing a row* — that is what an
   * edge without join keys means in the Studio, and it is why a site and its
   * point of interest cannot be linked by choosing one another: they are linked
   * by being entered together.
   *
   * So the partner's own columns are offered inside this form, as a small group.
   * Filling them writes into the same row and the relation exists. Left empty,
   * nothing is written and nothing is claimed.
   */
  function partnerField(entity, rel, target, direction) {
    const rows = rowsOf(target.tableId)
    const label =
      direction === 'out'
        ? rel.explorerLabel || localName(rel.propertyUri).replace(/_/g, ' ')
        : rel.inverseName || `is ${localName(rel.propertyUri)} of`
    const fields = [
      {
        key: `partner-id:${rel.edgeId}:${direction}`,
        kind: 'reference',
        label: target.explorerLabel ? `${target.explorerLabel} — identifier` : 'Identifier',
        column: target.idColumn,
        tableId: target.tableId,
        options: distinctValues(rows, target.idColumn, 2000),
        readOnly: false,
      },
    ]
    if (target.labelColumn && target.labelColumn !== target.idColumn) {
      fields.push({
        key: `partner-label:${rel.edgeId}:${direction}`,
        kind: 'text',
        label: target.explorerLabel ? `${target.explorerLabel} — label` : 'Label',
        column: target.labelColumn,
        tableId: target.tableId,
        options: distinctValues(rows, target.labelColumn, 2000),
        readOnly: false,
      })
    }
    return {
      key: `ref:${rel.edgeId}:${direction}`,
      kind: 'group',
      // Not a satellite: its identifier is entered, not minted from a rule.
      partner: true,
      sameRow: true,
      label,
      column: null,
      tableId: entity.tableId,
      uriRule: null,
      propertyUri: rel.propertyUri,
      targetNodeId: target.nodeId,
      targetTypeKey: target.typeKey,
      direction,
      fields,
      readOnly: false,
    }
  }

  function referenceField(entity, rel, target, direction) {
    if (entity.tableId === target.tableId) return partnerField(entity, rel, target, direction)
    const joinColumn = direction === 'out' ? rel.joinSource : rel.joinTarget
    const otherColumn = direction === 'out' ? rel.joinTarget : rel.joinSource
    return {
      key: `ref:${rel.edgeId}:${direction}`,
      kind: 'reference',
      label:
        direction === 'out'
          ? rel.explorerLabel || localName(rel.propertyUri).replace(/_/g, ' ')
          : rel.inverseName || `is ${localName(rel.propertyUri)} of`,
      // Written on *this* entity's table, matched against the other one.
      column: joinColumn,
      tableId: entity.tableId,
      matchColumn: otherColumn,
      matchTableId: target.tableId,
      propertyUri: rel.propertyUri,
      targetNodeId: target.nodeId,
      targetTypeKey: target.typeKey,
      direction,
      // Whether the column being matched against is the partner's own identifier.
      // If it is, a value with no counterpart can be turned into a record; if it
      // is a bare join key, creating a row from it would invent a record nobody
      // described, so it is reported instead.
      matchIsIdentifier: otherColumn === target.idColumn,
      matchLabelColumn: target.labelColumn && target.labelColumn !== target.idColumn ? target.labelColumn : null,
      options: distinctValues(rowsOf(target.tableId), otherColumn, 2000),
      // Not editable when the link follows from the identifier rather than being
      // chosen: the find spot is joined on the inventory number, which the
      // identifier field already owns. Two fields writing one column would
      // silently overwrite each other.
      // Nothing to enter when the join runs over a column this record already
      // owns: the relation holds by virtue of the identifier or the label.
      readOnly: !joinColumn || joinColumn === entity.idColumn || joinColumn === entity.labelColumn,
    }
  }

  function groupField(entity, rel, satellite) {
    const subfields = []
    for (const le of literalsOf(model, satellite.nodeId)) {
      const lit = model.literals.get(le.literalNodeId)
      if (lit) subfields.push(scalarField(satellite, le, lit))
    }
    return {
      key: `grp:${rel.edgeId}`,
      kind: 'group',
      label: rel.explorerLabel || satellite.explorerLabel || localName(rel.propertyUri).replace(/_/g, ' '),
      // The satellite's own identifier is not typed — a rule derives it.
      column: satellite.idColumn,
      tableId: satellite.tableId,
      propertyUri: rel.propertyUri,
      targetNodeId: satellite.nodeId,
      uriRule: uriRules[satellite.nodeId] || null,
      fields: subfields,
      readOnly: subfields.every((f) => f.readOnly),
    }
  }

  const languages = languagesOf(model)
  const multilingual = isMultilingual(languages)

  const forms = []
  for (const entity of model.entities.values()) {
    if (folded.has(entity.nodeId) || valueNodes.has(entity.nodeId)) continue

    const fields = [
      {
        key: 'identifier',
        kind: 'identifier',
        label: 'Identifier',
        column: entity.idColumn,
        tableId: entity.tableId,
        uriRule: uriRules[entity.nodeId] || null,
        required: true,
        readOnly: false,
      },
    ]
    if (entity.labelColumn && entity.labelColumn !== entity.idColumn) {
      fields.push({
        key: 'label',
        kind: 'label',
        label: multilingual ? `Label (${languages.primary})` : 'Label',
        lang: languages.primary,
        column: entity.labelColumn,
        tableId: entity.tableId,
        readOnly: false,
      })
    }
    // One field per further language that has a column. A language without
    // one gets no field: the column is part of the mapping, and creating it
    // here would make the Studio show a translation slot as filled.
    for (const lang of languages.additional) {
      const column = entity.labelColumnI18n?.[lang]
      if (!column || column === entity.idColumn) continue
      fields.push({
        key: `label@${lang}`,
        kind: 'label',
        label: `Label (${lang})`,
        lang,
        column,
        tableId: entity.tableId,
        readOnly: false,
      })
    }

    for (const le of literalsOf(model, entity.nodeId)) {
      const lit = model.literals.get(le.literalNodeId)
      if (lit) fields.push(scalarField(entity, le, lit))
    }

    /**
     * A relation joined on this record's own identifier has nothing to enter:
     * it holds whenever the other side names this identifier. Shown as a field
     * it would display the identifier over and over — six times on the unit form
     * of the reference project — which reads as a fault and is only noise. It is
     * still worth naming, so it goes to a separate list the form states in one
     * line.
     */
    const implied = []
    const place = (field) => {
      if (field.kind === 'reference' && field.readOnly) implied.push(field)
      else fields.push(field)
    }

    for (const rel of outgoingOf(model, entity.nodeId)) {
      const target = model.entities.get(rel.target)
      if (!target) continue
      if (isSatellite(model, parents, entity.nodeId, rel.target)) fields.push(groupField(entity, rel, target))
      else if (valueNodes.has(rel.target) || isPartOfShared(entity, rel, target)) fields.push(conceptField(entity, rel, target))
      else place(referenceField(entity, rel, target, 'out'))
    }

    // Relations pointing *at* this entity are how a new record is attached to
    // its context — a find is entered under the stratigraphic unit that holds it.
    for (const rel of model.relations) {
      if (rel.target !== entity.nodeId) continue
      const source = model.entities.get(rel.source)
      if (!source || folded.has(rel.source)) continue
      place(referenceField(entity, rel, source, 'in'))
    }

    /**
     * One column, one field.
     *
     * Two fields writing the same cell would overwrite each other, and the
     * second would show whatever the first put there. Two shapes of this occur:
     *
     *  - Several relations that mean the same thing about one column. A find
     *    spot is joined from human-made finds, organic finds and samples alike,
     *    all through `Inv.-Nr.` — one field, whose label names all three.
     *  - Two different properties mapped onto one column, which is a fault in
     *    the mapping rather than here. HME's `_nicht_zugeordnet` holds two year
     *    properties at once. The first keeps the column, the rest are shown but
     *    locked, with the clash named.
     */
    const byColumn = new Map()
    const deduped = []
    for (const field of fields) {
      if (field.kind === 'group') {
        // Subfields write into the same row as everything else, so they take
        // part in the same reckoning — HME maps two year properties onto one
        // placeholder column, and both sit inside a folded group.
        field.fields = field.fields.map((sub) => {
          if (!sub.column) return sub
          const owner = byColumn.get(sub.column)
          if (!owner) {
            byColumn.set(sub.column, sub)
            return sub
          }
          return { ...sub, readOnly: true, conflictWith: owner.label }
        })
        deduped.push(field)
        continue
      }
      if (!field.column) {
        deduped.push(field)
        continue
      }
      const first = byColumn.get(field.column)
      if (!first) {
        byColumn.set(field.column, field)
        deduped.push(field)
        continue
      }
      if (first.kind === 'reference' && field.kind === 'reference') {
        first.label = `${first.label}, ${(field.label.split('—').pop() || field.label).trim()}`
        first.alternatives = [
          ...(first.alternatives || [{ tableId: first.matchTableId, column: first.matchColumn, targetTypeKey: first.targetTypeKey }]),
          { tableId: field.matchTableId, column: field.matchColumn, targetTypeKey: field.targetTypeKey },
        ]
        // Which of several record types a typed value would become is not
        // knowable, so nothing is created for a merged reference.
        first.matchIsIdentifier = false
        const seen = new Set(first.options.map((o) => o.value))
        for (const option of field.options) if (!seen.has(option.value)) first.options.push(option)
        continue
      }
      deduped.push({
        ...field,
        readOnly: true,
        conflictWith: first.label,
      })
    }
    fields.length = 0
    fields.push(...deduped)

    // Two mapping edges can carry the same explorer name — a unit "contains the
    // finds" both for human-made and for organic ones. Left alone, the form
    // would show the same label twice with no way to tell them apart.
    const labelCounts = new Map()
    for (const field of [...fields, ...implied]) labelCounts.set(field.label, (labelCounts.get(field.label) || 0) + 1)
    for (const field of [...fields, ...implied]) {
      if (labelCounts.get(field.label) > 1 && field.targetTypeKey) {
        const target = model.entities.get(field.targetNodeId)
        if (target?.explorerLabel) field.label = `${field.label} — ${target.explorerLabel}`
      }
    }

    forms.push({
      nodeId: entity.nodeId,
      typeKey: entity.typeKey,
      label: entity.explorerLabel || entity.rdfsLabel || localName(entity.classUri).replace(/_/g, ' '),
      classUri: entity.classUri,
      color: entity.color,
      tableId: entity.tableId,
      idColumn: entity.idColumn,
      labelColumn: entity.labelColumn,
      uriRule: uriRules[entity.nodeId] || null,
      fields: capitalise(config.hidden ? fields.filter((f) => !config.hidden.includes(f.key)) : fields),
      // Relations that follow from the identifier rather than being entered.
      implied: capitalise(implied),
    })
  }

  return {
    forms,
    byNode: new Map(forms.map((f) => [f.nodeId, f])),
    byType: new Map(forms.map((f) => [f.typeKey, f])),
    folded: [...folded],
    valueNodes: [...valueNodes],
  }
}

/**
 * Which columns a form writes. Everything else in the row is left alone —
 * a row is shared by several entities, and a form must not clear a neighbour's
 * fields just because it does not show them.
 */
export function columnsWritten(form) {
  const columns = new Set()
  const walk = (fields) => {
    for (const field of fields) {
      if (field.readOnly) continue
      if (field.column) columns.add(field.column)
      if (field.labelColumn) columns.add(field.labelColumn)
      if (field.fields) walk(field.fields)
    }
  }
  walk(form.fields)
  return [...columns]
}
