/**
 * Entry forms derived from the mapping.
 *
 * The assertion that matters: the form for a find must be the archaeological
 * record — inventory number, find type, material, note, dating, the unit it came
 * from — and *not* a list of CIDOC scaffolding nodes. If E12_Production shows up
 * as something to create, the folding did not work.
 *
 *   node tests/run-forms-check.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

register('./resolve-extensionless.mjs', import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const session = path.join(root, '_session')
if (!fs.existsSync(path.join(session, 'OntoCartographer_Projektdatei.json'))) {
  console.log('skip  the reference data (_session/) is not in this copy — it is research data and not distributed with the Navigator')
  process.exit(0)
}
const load = (f) => import(pathToFileURL(path.join(root, 'src/lib', f)))

const { readProjectFile } = await load('projectFile.js')
const { buildForms, columnsWritten, fieldKindForClass } = await load('forms.js')

let failures = 0
const fail = (headline, details = []) => {
  failures++
  console.log(`FAIL  ${headline}`)
  for (const line of details.slice(0, 8)) console.log(`        ${line}`)
}
const pass = (headline) => console.log(`ok    ${headline}`)

// ------------------------------------------------------------- field kinds
{
  const cases = [
    ['http://www.w3.org/2001/XMLSchema#gYear', [], 'year'],
    ['xsd:date', [], 'date'],
    ['xsd:integer', [], 'number'],
    ['http://www.opengis.net/ont/geosparql#wktLiteral', [], 'geometry'],
    ['rdfs:Literal', ['short'], 'text'],
    ['rdfs:Literal', ['x'.repeat(200)], 'longtext'],
  ]
  let ok = true
  for (const [uri, samples, expect] of cases) {
    const got = fieldKindForClass(uri, samples)
    if (got !== expect) { fail(`fieldKindForClass(${uri}) = ${got}, expected ${expect}`); ok = false }
  }
  if (ok) pass(`field kinds: ${cases.length} classes mapped to the right input`)
}

const project = JSON.parse(fs.readFileSync(path.join(session, 'OntoCartographer_Projektdatei.json'), 'utf8'))
const model = readProjectFile(project)
const { forms, byNode, folded, valueNodes } = buildForms(model)

console.log(
  `\n${forms.length} forms from ${model.entities.size} mapped nodes ` +
    `(${folded.length} folded away, ${valueNodes.length} are value nodes)`
)

// --------------------------------------------------- the find, in detail
{
  const form = byNode.get('n59')
  if (!form) {
    fail('no form for n59 (Fund human-made)')
  } else {
    console.log(`\nform "${form.label}"  table ${form.tableId}`)
    for (const field of form.fields) {
      const extra = []
      if (field.column) extra.push(`col=${field.column}`)
      if (field.labelColumn) extra.push(`label=${field.labelColumn}`)
      if (field.options?.length) extra.push(`${field.options.length} known values`)
      if (field.fields) extra.push(`subfields: ${field.fields.map((f) => `${f.label}[${f.kind}]`).join(', ')}`)
      if (field.readOnly) extra.push('read-only')
      console.log(`  ${field.kind.padEnd(10)} ${field.label}   ${extra.join('  ')}`)
    }

    const kinds = form.fields.map((f) => f.kind)
    const labels = form.fields.map((f) => f.label)

    // The dating must be one folded group of two year fields, not a node to create.
    const dating = form.fields.find((f) => f.kind === 'group')
    if (!dating) {
      fail('the find form has no folded group — the dating was not folded in')
    } else if (dating.fields.length === 2 && dating.fields.every((f) => f.kind === 'year')) {
      pass(`dating folded into "${dating.label}" as two year fields, identifier left to a rule`)
    } else {
      fail(`the folded group has ${dating.fields.length} subfield(s): ${dating.fields.map((f) => `${f.label}[${f.kind}]`).join(', ')}`)
    }

    // Find type and material must be pickers writing the id/label pair.
    const concepts = form.fields.filter((f) => f.kind === 'concept')
    const withPair = concepts.filter((f) => f.column && f.labelColumn)
    if (withPair.length >= 2) {
      pass(`${concepts.length} concept pickers, ${withPair.length} of them writing an id/label pair`)
    } else {
      fail(`only ${withPair.length} concept picker(s) write both columns`, concepts.map((f) => `${f.label}: ${f.column} / ${f.labelColumn}`))
    }

    // The unit the find came from must be offered as a reference.
    const inbound = form.fields.filter((f) => f.kind === 'reference' && f.direction === 'in' && !f.readOnly)
    if (inbound.length) {
      pass(`attachable to its context: ${inbound.map((f) => `"${f.label}" via column ${f.column}`).join(', ')}`)
    } else {
      fail('the find cannot be attached to a stratigraphic unit — no writable inbound reference')
    }

    // Geometry is carried, not entered.
    const geometry = form.fields.filter((f) => f.kind === 'geometry' || (f.fields || []).some((s) => s.kind === 'geometry'))
    if (geometry.every((f) => f.readOnly)) pass('geometry fields are read-only, as decided')
    else fail('a geometry field is editable, but capture was to stay in QGIS')

    if (!labels.some((l) => /Production|E12/i.test(l))) pass('no CIDOC scaffolding class appears as a field label')
    else fail(`a scaffolding class leaked into the form: ${labels.filter((l) => /Production|E12/i.test(l)).join(', ')}`)

    const written = columnsWritten(form)
    console.log(`  writes columns: ${written.join(', ')}`)
    const table = model.tables.get(form.tableId)
    const unknown = written.filter((c) => !table.columns.includes(c))
    if (!unknown.length) pass(`all ${written.length} written columns exist in ${form.tableId}`)
    else fail(`columns not in ${form.tableId}: ${unknown.join(', ')}`)
  }
}

// ----------------------------------------------- the stratigraphic unit
{
  const form = byNode.get('n20')
  if (!form) fail('no form for n20 (SE)')
  else {
    console.log(`\nform "${form.label}"  table ${form.tableId}  ${form.fields.length} fields`)
    console.log('  ' + form.fields.map((f) => `${f.label}[${f.kind}]`).join(', '))
    const description = form.fields.find((f) => f.label === 'Befundbeschreibung')
    if (description?.kind === 'longtext') pass('the unit description is offered as a long text field')
    else fail(`the unit description came out as ${description?.kind ?? 'nothing'}`)
  }
}

// ------------------------------------------ no two fields on one column
/**
 * Every field must own its column.
 *
 * The unit form once had six fields all reading `SE` — the identifier column —
 * because every relation joined on the unit number. They all showed the
 * identifier, which reads as a fault and is only noise; worse, two editable
 * fields on one column would overwrite each other. Relations that follow from
 * the identifier now live in `form.implied` and are stated in one line.
 */
{
  const projects = [
    ['reference project', model],
    ['HME project', readProjectFile(JSON.parse(fs.readFileSync(path.join(session, 'HarrisMatrixEditor_OntoCartographer-Projektdatei.json'), 'utf8')))],
    ['emptied project', readProjectFile(JSON.parse(fs.readFileSync(path.join(session, 'ontocartographer-project_empty.json'), 'utf8')))],
  ]
  const { scaffoldTables, needsScaffolding } = await load('scaffold.js')

  const clashes = []
  let checked = 0
  for (const [name, m] of projects) {
    if (needsScaffolding(m)) scaffoldTables(m)
    for (const form of buildForms(m).forms) {
      const seen = new Map()
      const walk = (fields) => {
        for (const field of fields) {
          if (field.fields) {
            walk(field.fields)
            continue
          }
          // Two fields may *name* one column; only one may write it. A locked
          // duplicate is how an ambiguous mapping is surfaced rather than acted
          // on, and it says so in the field note.
          if (!field.column || field.readOnly) continue
          const at = seen.get(field.column)
          if (at) clashes.push(`${name} / ${form.label}: "${at}" and "${field.label}" both write ${field.column}`)
          else seen.set(field.column, field.label)
        }
      }
      walk(form.fields)
      checked++
    }
  }
  if (clashes.length) fail(`${clashes.length} column(s) written by two fields`, clashes)
  else pass(`no column is written by two fields, across ${checked} forms in ${projects.length} projects`)

  // The ambiguity that could not be resolved must still be visible.
  const locked = []
  for (const [name, m] of projects) {
    for (const form of buildForms(m).forms) {
      for (const field of form.fields) if (field.conflictWith) locked.push(`${name} / ${form.label}: "${field.label}" locked behind "${field.conflictWith}"`)
    }
  }
  if (locked.length) {
    console.log(`
  ${locked.length} field(s) locked because the mapping puts two properties on one column:`)
    for (const line of locked) console.log(`    ${line}`)
    pass('an ambiguous mapping is surfaced as a locked field, not acted on')
  }

  // And what was moved out must still be named somewhere.
  const unitForm = byNode.get('n20')
  if (unitForm?.implied?.length) {
    console.log(`\n  "${unitForm.label}" implied relations: ${unitForm.implied.map((f) => f.label).join(', ')}`)
    pass(`${unitForm.implied.length} relation(s) that follow from the identifier are listed, not shown as fields`)
  } else {
    fail('the unit form lists no implied relations, though several join on its identifier')
  }
}

// --------------------------------------------------- folding, in general
{
  // Nothing may be both folded away and given its own form.
  const clash = folded.filter((id) => byNode.has(id))
  if (clash.length) fail(`${clash.length} node(s) are folded and yet have their own form`, clash)
  else pass('no node is both folded away and given its own form')

  // Every mapped node must be reachable: as a form, folded, or a value node.
  const accounted = new Set([...byNode.keys(), ...folded, ...valueNodes])
  const orphans = [...model.entities.keys()].filter((id) => !accounted.has(id))
  if (orphans.length) {
    fail(`${orphans.length} mapped node(s) are neither a form, folded, nor a value node`, orphans.map((id) => `${id} (${model.entities.get(id).explorerLabel || model.entities.get(id).classLabel})`))
  } else {
    pass(`every one of ${model.entities.size} mapped nodes is accounted for`)
  }
}

// ------------------------------------------------------- the HME project
{
  const hme = readProjectFile(JSON.parse(fs.readFileSync(path.join(session, 'HarrisMatrixEditor_OntoCartographer-Projektdatei.json'), 'utf8')))
  const built = buildForms(hme)
  console.log(
    `\nHME project: ${built.forms.length} forms from ${hme.entities.size} nodes ` +
      `(${built.folded.length} folded, ${built.valueNodes.length} value nodes)`
  )
  console.log('  ' + built.forms.map((f) => f.label).slice(0, 8).join(', ') + (built.forms.length > 8 ? ' …' : ''))
  if (built.forms.length > 0 && built.forms.length < hme.entities.size) {
    pass(`HME project: ${built.forms.length} forms, ${hme.entities.size - built.forms.length} nodes folded or picked`)
  } else {
    fail(`HME project: ${built.forms.length} forms from ${hme.entities.size} nodes — folding did nothing`)
  }
}

console.log(failures === 0 ? '\nPASS — forms hold\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
