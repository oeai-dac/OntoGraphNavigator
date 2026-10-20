/**
 * Building tables for a mapping that brought none.
 *
 * The claim to verify: table boundaries can be *read* from the join keys rather
 * than guessed. So the reference project is stripped of everything the emptied
 * file lacks — tableId, mappedColumn, labelColumn, tableRows — and the grouping
 * derived from the mapping alone is compared to the seven tables it really has.
 *
 * Then the actual emptied file is taken through to the end: scaffold, build
 * forms, create a record, see it in the graph, write the project file back.
 *
 *   node tests/run-scaffold-check.mjs
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

const { readProjectFile, writeProjectFile } = await load('projectFile.js')
const { needsScaffolding, scaffoldTables } = await load('scaffold.js')
const { buildForms } = await load('forms.js')
const { createJournal } = await load('journal.js')
const { createWorkspace, rematerialize, createRecord, rowsForForm, graphIdFor } = await load('edits.js')
const { loadFile } = await load('loadFile.js')

let failures = 0
const fail = (headline, details = []) => {
  failures++
  console.log(`FAIL  ${headline}`)
  for (const line of details.slice(0, 10)) console.log(`        ${line}`)
}
const pass = (headline) => console.log(`ok    ${headline}`)

// ------------------------------- can the grouping be read off the join keys?
{
  const full = JSON.parse(fs.readFileSync(path.join(session, 'OntoCartographer_Projektdatei.json'), 'utf8'))

  // The truth, before stripping.
  const realTable = new Map()
  for (const node of full.nodes) {
    if (node.data?.tableId) realTable.set(node.id, node.data.tableId)
  }

  // Exactly what the emptied file looks like.
  const stripped = {
    ...full,
    nodes: full.nodes.map((node) =>
      node.data
        ? { ...node, data: { ...node.data, tableId: null, tableRows: null, mappedColumn: null, labelColumn: null } }
        : node
    ),
  }

  const model = readProjectFile(stripped)
  if (!needsScaffolding(model)) fail('a project with no columns at all was not recognised as needing tables')
  else pass('a project with no tables and no columns is recognised')

  const result = scaffoldTables(model)
  console.log(`\nderived ${result.tables} tables, ${result.columns} columns`)

  // Compare partitions, not names: our tbl_1 need not be their tbl_3.
  const derivedGroups = new Map()
  for (const [nodeId, tableId] of [...model.entities, ...model.literals].map(([id, n]) => [id, n.tableId])) {
    if (!derivedGroups.has(tableId)) derivedGroups.set(tableId, new Set())
    derivedGroups.get(tableId).add(nodeId)
  }
  const realGroups = new Map()
  for (const [nodeId, tableId] of realTable) {
    if (!realGroups.has(tableId)) realGroups.set(tableId, new Set())
    realGroups.get(tableId).add(nodeId)
  }

  const asKey = (set) => [...set].sort().join(',')
  const derivedKeys = new Set([...derivedGroups.values()].map(asKey))
  const realKeys = new Set([...realGroups.values()].map(asKey))

  for (const [tableId, members] of [...derivedGroups].sort()) {
    const match = [...realGroups].find(([, real]) => asKey(real) === asKey(members))
    console.log(
      `  ${tableId} "${model.tables.get(tableId).name}"  ${members.size} nodes  ` +
        `${model.tables.get(tableId).columns.length} columns  ${match ? `= ${match[0]}` : '= no real table'}`
    )
  }

  const missing = [...realKeys].filter((k) => !derivedKeys.has(k))
  const extra = [...derivedKeys].filter((k) => !realKeys.has(k))
  if (!missing.length && !extra.length) {
    pass(`the grouping reproduces all ${realGroups.size} real tables exactly, from the join keys alone`)
  } else {
    fail(`grouping differs: ${missing.length} real table(s) not reproduced, ${extra.length} invented`, [
      ...missing.map((k) => `not reproduced: ${k}`),
      ...extra.map((k) => `invented: ${k}`),
    ])
  }

  // Join keys must exist as columns, or the joins point at nothing.
  const problems = []
  for (const rel of [...model.relations, ...model.dot1Relations]) {
    if (!rel.joinSource || !rel.joinTarget) continue
    const source = model.entities.get(rel.source)
    const target = model.entities.get(rel.target)
    if (source && !model.tables.get(source.tableId).columns.includes(rel.joinSource)) {
      problems.push(`${source.tableId} is missing join column "${rel.joinSource}"`)
    }
    if (target && !model.tables.get(target.tableId).columns.includes(rel.joinTarget)) {
      problems.push(`${target.tableId} is missing join column "${rel.joinTarget}"`)
    }
  }
  if (!problems.length) pass('every join key exists as a column in its table')
  else fail(`${problems.length} join key(s) have no column`, problems)

  // Column names must be unique per table, or two fields would fight over one.
  const clashes = []
  for (const table of model.tables.values()) {
    const seen = new Set()
    for (const column of table.columns) {
      if (seen.has(column)) clashes.push(`${table.id}: "${column}" twice`)
      seen.add(column)
    }
  }
  if (!clashes.length) pass('column names are unique within every table')
  else fail(`${clashes.length} duplicate column name(s)`, clashes)
}

// ------------------------------------- the real emptied file, end to end
{
  const file = 'ontocartographer-project_empty.json'
  const raw = fs.readFileSync(path.join(session, file), 'utf8')
  const result = loadFile(file, raw)

  console.log(`\n${file}: ${result.report.tables} tables, ${result.report.entities} mapped nodes`)
  for (const warning of result.warnings) console.log(`  ! ${warning}`)
  if (!result.report.scaffolded) fail('the emptied project was loaded without building tables')
  else pass(`loading the emptied project built ${result.report.scaffolded.tables} tables`)

  const model = result.model
  const journal = createJournal({ author: 'scaffold test' })
  const workspace = createWorkspace({ model, journal })
  const { forms } = buildForms(model)
  console.log(`  ${forms.length} forms: ${forms.map((f) => f.label).join(', ')}`)
  if (!forms.length) fail('no forms could be built for the emptied project')
  else pass(`${forms.length} forms built on the new tables`)

  // Two records, because the rule that decides whether they show up is worth
  // pinning down: the materialisation is edge-driven, so a record with no
  // relation to anything is stored but produces no graph node.
  const findForm = forms.find((f) => /Fund \(human-made\)/.test(f.label)) || forms[0]
  const labelField = findForm.fields.find((f) => f.kind === 'label')

  const lonely = { identifier: 'TEST-0001' }
  if (labelField) lonely[labelField.key] = 'Unlinked find'
  const first = createRecord(workspace, findForm, lonely, { source: 'form' })
  const afterFirst = rematerialize(workspace)
  const lonelyId = graphIdFor(workspace, findForm, first.identifier)

  console.log(`  created "${first.identifier}" in ${findForm.tableId} (${findForm.idColumn})`)
  if (!first.rowId) fail('a record could not be created in the empty project', first.warnings)
  else if (rowsForForm(workspace, findForm).length === 1) pass('the first record went into an empty table')
  else fail(`the table holds ${rowsForForm(workspace, findForm).length} record(s) after creating one`)

  if (!afterFirst.nodes[lonelyId]) {
    pass('a record with no relation is stored but produces no graph node — the Studio rule, kept')
  } else {
    fail('an unrelated record produced a graph node, which the Studio would not have written')
  }

  // Now one that is linked: a find type is enough to make it a node.
  const conceptField = findForm.fields.find((f) => f.kind === 'concept')
  const linked = { identifier: 'TEST-0002' }
  if (labelField) linked[labelField.key] = 'Linked find'
  if (conceptField) linked[conceptField.key] = { uri: '', label: 'Fragment' }
  const second = createRecord(workspace, findForm, linked, { source: 'form' })
  const graph = rematerialize(workspace)
  const linkedId = graphIdFor(workspace, findForm, second.identifier)

  console.log(`  created "${second.identifier}" with "${conceptField?.label}" set`)
  console.log(`  graph after the linked record: ${Object.keys(graph.nodes).length} node(s)`)
  if (conceptField && graph.nodes[linkedId]) {
    pass(`a record with one relation appears in the graph (${linkedId})`)
  } else if (!conceptField) {
    fail('the find form offers no concept field to link with')
  } else {
    fail('a linked record still did not appear in the graph')
  }

  // A relation across two tables is an equi-join. Naming a unit that has no row
  // yet would leave the join with nothing to match: no unit, no relation, and a
  // find that looks connected to something absent. The referenced record is
  // therefore brought into being.
  {
    const inbound = findForm.fields.find((f) => f.kind === 'reference' && f.direction === 'in' && !f.readOnly)
    if (!inbound) {
      fail('the find form has no writable cross-table reference to test with')
    } else {
      const unitTable = workspace.model.tables.get(inbound.matchTableId)
      const before = unitTable.rows.length
      const third = { identifier: 'TEST-0003', [inbound.key]: 'SE-9999' }
      const made = createRecord(workspace, findForm, third, { source: 'form' })
      const graph = rematerialize(workspace)

      console.log(
        `  "${inbound.label}" = SE-9999 (not present): ${inbound.matchTableId} went ${before} -> ${unitTable.rows.length} rows`
      )
      for (const item of made.created || []) console.log(`    also created: ${item.value} for "${item.label}"`)

      const unitExists = unitTable.rows.some((r) => String(r[inbound.matchColumn] ?? '').trim() === 'SE-9999')
      const findId = graphIdFor(workspace, findForm, 'TEST-0003')
      const findNode = graph.nodes[findId]
      const linked =
        findNode && Object.values(findNode.i).flat().some((source) => source.endsWith('SE-9999'))

      if (!unitExists) {
        fail('naming a unit that does not exist created no record for it')
      } else if (!linked) {
        fail('the referenced unit was created but the find is not linked to it', [
          `incoming: ${JSON.stringify(findNode?.i)}`,
        ])
      } else {
        pass('naming a record that does not exist creates it, and the relation holds')
      }

      // Naming one that *does* exist must not create a second.
      const rowsNow = unitTable.rows.length
      createRecord(workspace, findForm, { identifier: 'TEST-0004', [inbound.key]: 'SE-9999' }, { source: 'form' })
      rematerialize(workspace)
      if (unitTable.rows.length === rowsNow) {
        pass('naming a record that already exists reuses it rather than duplicating it')
      } else {
        fail(`referencing an existing record added ${unitTable.rows.length - rowsNow} row(s)`)
      }
    }
  }

  // Two things on one table, linked the only way that model allows: entered
  // together into one row. This is the case that reads as "I cannot select the
  // POI from the site" — because there is nothing to select, there is a row to
  // fill.
  {
    const siteForm = forms.find((f) => f.label === 'Ort')
    if (!siteForm) {
      fail('no form for "Ort"')
    } else {
      const partner = siteForm.fields.find((f) => f.kind === 'group' && f.partner)
      if (!partner) {
        fail('the site form offers no way to enter its POI', siteForm.fields.map((f) => `${f.label}[${f.kind}]`))
      } else {
        const idField = partner.fields.find((f) => f.kind === 'reference')
        const labelField = partner.fields.find((f) => f.kind === 'text')
        const values = { identifier: 'EPHESOS' }
        const siteLabel = siteForm.fields.find((f) => f.kind === 'label')
        if (siteLabel) values[siteLabel.key] = 'Ephesos'
        values[partner.key] = {
          [idField.key]: 'DOMITIANSPLATZ',
          ...(labelField ? { [labelField.key]: 'Domitiansplatz' } : {}),
        }
        const made = createRecord(workspace, siteForm, values, { source: 'form' })
        const linked = rematerialize(workspace)
        const siteId = graphIdFor(workspace, siteForm, made.identifier)
        const site = linked.nodes[siteId]

        console.log(`  entered "Ephesos" with its POI "Domitiansplatz" in one record`)
        for (const warning of made.warnings) console.log(`    ! ${warning}`)

        const pointsAtPoi = site && Object.values(site.o).flat().some((target) => target.endsWith('DOMITIANSPLATZ'))
        if (!site) {
          fail('the site did not become a node even though its POI was filled in')
        } else if (pointsAtPoi) {
          pass(`site and POI are linked by sharing a row (${Object.keys(site.o).length} outgoing relation)`)
        } else {
          fail('the site is a node but has no relation to its POI', [
            `outgoing: ${JSON.stringify(site.o)}`,
          ])
        }

        // A second point of interest for the same site. In this model that is a
        // second *row* of the same site — which reads as a duplicate in a list of
        // rows, and is not one: both rows carry the same identifier and merge
        // back into a single node with two relations.
        const second = { identifier: 'EPHESOS' }
        if (siteLabel) second[siteLabel.key] = 'Ephesos'
        second[partner.key] = {
          [idField.key]: 'STAATSMARKT',
          ...(labelField ? { [labelField.key]: 'Staatsmarkt' } : {}),
        }
        createRecord(workspace, siteForm, second, { source: 'form' })
        const twice = rematerialize(workspace)

        const siteNodes = Object.entries(twice.nodes).filter(([, n]) => n.t === siteForm.typeKey)
        const pois = Object.values(twice.nodes[siteId]?.o || {}).flat()
        const rowCount = rowsForForm(workspace, siteForm).filter(
          (r) => String(r.row[siteForm.idColumn] ?? '').trim() === 'EPHESOS'
        ).length

        console.log(`  added a second POI: ${rowCount} rows, ${siteNodes.length} site node, ${pois.length} POIs`)
        if (siteNodes.length === 1 && pois.length === 2 && rowCount === 2) {
          pass('a second POI is a second row, and the two rows merge into one site with two POIs')
        } else {
          fail(
            `a second POI came out wrong: ${rowCount} rows, ${siteNodes.length} site node(s), ${pois.length} POI(s)`,
            siteNodes.map(([id]) => id)
          )
        }
      }
    }
  }

  // The scaffolding has to survive into the project file, or the Studio would
  // see an empty mapping again.
  const written = writeProjectFile(model)
  const withTables = written.nodes.filter((n) => n.data?.tableId).length
  const withColumns = written.nodes.filter((n) => n.data?.mappedColumn).length
  const withRows = written.nodes.filter((n) => Array.isArray(n.data?.tableRows) && n.data.tableRows.length).length
  console.log(`  written project: ${withTables} nodes with a table, ${withColumns} with a column, ${withRows} carrying rows`)
  if (withTables >= 30 && withColumns >= 30 && withRows >= 1) {
    pass('the exported project file carries the new tables, columns and the row just entered')
  } else {
    fail(`the exported project file is incomplete: ${withTables} tables, ${withColumns} columns, ${withRows} with rows`)
  }

  // And reading it back must need no scaffolding a second time.
  const reread = readProjectFile(written)
  if (!needsScaffolding(reread)) pass('reading the exported project back needs no scaffolding')
  else fail('the exported project still looks like it has no tables')
}

console.log(failures === 0 ? '\nPASS — scaffolding holds\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
