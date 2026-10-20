/**
 * Identifier rules: the language, and whether a rule can be read off real data.
 *
 * The inference cases are the reference project's own identifier columns. If the
 * tool cannot rediscover the rules that are visibly there, it will not help
 * anyone write new ones.
 *
 *   node tests/run-uri-template-check.mjs
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

const { parseTemplate, renderTemplate, validateTemplate, previewTemplate, mintUnique, inferTemplate } =
  await load('uriTemplate.js')
const { readProjectFile } = await load('projectFile.js')

let failures = 0
const fail = (headline, details = []) => {
  failures++
  console.log(`FAIL  ${headline}`)
  for (const line of details.slice(0, 6)) console.log(`        ${line}`)
}
const pass = (headline) => console.log(`ok    ${headline}`)
const is = (label, got, want) => {
  if (got === want) pass(`${label}: ${JSON.stringify(got)}`)
  else fail(`${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
}

// ------------------------------------------------------------- the language
{
  const row = {
    SE: 'SU 001',
    'SE-Nummer': 'EDP22-SE2001',
    HMO_INVENTARNUMMER: '',
    OR_INVENTARNUMMER: 'EDP22-2001-2010',
    Ort: 'Groß Sankt Florian',
  }
  const r = (tpl, ctx) => renderTemplate(tpl, row, ctx).value

  is('plain column', r('{SE-Nummer}_verm_OK'), 'EDP22-SE2001_verm_OK')
  is('fallback chain skips the empty column', r('{HMO_INVENTARNUMMER|OR_INVENTARNUMMER}_ProdDate'), 'EDP22-2001-2010_ProdDate')
  is('~num keeps only digits', r('SE_Probe_{SE~num}'), 'SE_Probe_001')
  is('~slug transliterates and is URI-safe', r('{Ort~slug}'), 'Gross-Sankt-Florian')
  is('~upper', r('{SE~upper}'), 'SU 001')
  is('seq with padding', r('P{seq:4}', { sequence: 7 }), 'P0007')
  is('literal braces', r('{{SE}}'), '{SE}')
  is('fixed date', r('{today}', { now: new Date('2026-08-05T10:00:00Z') }), '2026-08-05')

  const missing = renderTemplate('{Nope}_x', row)
  if (missing.missing.length === 1 && missing.missing[0] === 'Nope') {
    pass('an unresolved placeholder is reported rather than silently dropped')
  } else {
    fail(`unresolved placeholder not reported: ${JSON.stringify(missing)}`)
  }

  for (const [bad, expect] of [
    ['{SE', 'never closed'],
    ['SE}', 'Unexpected'],
    ['{}', 'Empty placeholder'],
    ['{SE~nope}', 'Unknown modifier'],
    ['{seq:x}', 'must be a number'],
  ]) {
    try {
      parseTemplate(bad)
      fail(`"${bad}" was accepted but is not valid`)
    } catch (error) {
      if (error.message.includes(expect)) pass(`rejected "${bad}": ${error.message}`)
      else fail(`"${bad}" rejected with an unhelpful message: ${error.message}`)
    }
  }

  const check = validateTemplate('{Nope}', ['SE'])
  if (!check.ok && check.errors[0].includes('No such column')) pass('validation names a column that does not exist')
  else fail(`validation missed an unknown column: ${JSON.stringify(check)}`)

  const constant = validateTemplate('always-the-same', ['SE'])
  if (constant.ok && constant.warnings.length) pass('validation warns about a rule with nothing variable in it')
  else fail('a constant rule produced no warning')
}

// --------------------------------------------------------- uniqueness
{
  const taken = new Set(['P0001', 'P0002'])
  const first = mintUnique('P{seq:4}', {}, taken)
  is('mintUnique advances past taken values', first.value, 'P0003')

  const stuck = mintUnique('{SE}_x', { SE: 'a' }, new Set(['a_x']))
  if (stuck.collision) pass('mintUnique reports a collision it cannot resolve without {seq}')
  else fail('a collision without {seq} went unreported')
}

// ------------------------------------- inference against the real project
const project = JSON.parse(fs.readFileSync(path.join(session, 'OntoCartographer_Projektdatei.json'), 'utf8'))
const model = readProjectFile(project)

const cases = [
  { table: 'tbl_6', column: 'SE_Measurement_id', expect: '{SE-Nummer}_verm_OK' },
  { table: 'tbl_3', column: 'SEBeschreibung_ID', expect: '{SE}_Beschreibung' },
  // 18 of the 397 geometry ids in tbl_7 are built from Fund-Nr. instead of
  // Punktnr, so no single rule reaches 100 % here — and a fallback chain does
  // not help, because Punktnr is never empty and would always win.
  { table: 'tbl_7', column: 'geometry_id', expect: '{Punktnr}_geom', coverage: 379 / 397 },
]

console.log('')
for (const testCase of cases) {
  const table = model.tables.get(testCase.table)
  const guess = inferTemplate(testCase.column, table.rows, { columns: table.columns })
  const got = guess?.template ?? null
  console.log(
    `  ${testCase.table}.${testCase.column}  ->  ${got ?? 'no rule found'}` +
      (guess ? `   (${(guess.coverage * 100).toFixed(0)}% of ${guess.rows} rows)` : '')
  )
  if (got === testCase.expect && (testCase.coverage === undefined || Math.abs(guess.coverage - testCase.coverage) < 1e-6)) {
    pass(`inferred ${testCase.table}.${testCase.column}${testCase.coverage !== undefined ? ` at ${(guess.coverage * 100).toFixed(1)}%` : ''}`)
  }
  else fail(`inferred ${testCase.table}.${testCase.column}: got ${JSON.stringify(got)}, expected ${JSON.stringify(testCase.expect)}`)
}

// The column that holds two different rules, one per mapping node. Filtered to
// the rows each node actually applies to, both must come out cleanly.
{
  const table = model.tables.get('tbl_11')
  const production = table.rows.filter((r) => String(r.HMO_INVENTARNUMMER ?? '').trim())
  const genesis = table.rows.filter((r) => String(r.OR_INVENTARNUMMER ?? '').trim())

  for (const [label, rows, expect] of [
    ['Herstellungszeitraum (n67)', production, '{HMO_INVENTARNUMMER}_ProdDate'],
    ['Enstehungszeitraum (n71)', genesis, '{OR_INVENTARNUMMER}_GenesisDate'],
  ]) {
    const guess = inferTemplate('Datierung_ID', rows, { columns: table.columns })
    console.log(`  tbl_11.Datierung_ID for ${label}  ->  ${guess?.template ?? 'no rule found'}`)
    if (guess?.template === expect) pass(`inferred Datierung_ID for ${label}`)
    else fail(`inferred Datierung_ID for ${label}: got ${JSON.stringify(guess?.template ?? null)}, expected ${JSON.stringify(expect)}`)
  }

  // Unfiltered, the same column carries both remainders. One rule cannot express
  // that, and the inference must not pretend otherwise by merging them.
  const merged = inferTemplate('Datierung_ID', table.rows, { columns: table.columns })
  if (!merged || merged.coverage < 0.99) {
    pass(`unfiltered Datierung_ID: no single rule claimed to cover it (${merged ? `${(merged.coverage * 100).toFixed(0)}%` : 'none'})`)
  } else {
    fail(`unfiltered Datierung_ID: claimed full coverage with "${merged.template}" — two rules were merged into one`)
  }
}

// ------------------------------------------------------------ preview
{
  const table = model.tables.get('tbl_6')
  const preview = previewTemplate('{SE-Nummer}_verm_OK', table.rows, { columns: table.columns, limit: 2 })
  console.log(
    `\n  preview on tbl_6: ${preview.distinct} distinct of ${preview.total} rows, ` +
      `${preview.collisions.length} collision(s), ${preview.empty} empty`
  )
  for (const sample of preview.samples) console.log(`    row ${sample.index}: ${sample.value}`)
  if (preview.distinct === preview.total && !preview.collisions.length && !preview.empty) {
    pass('preview: the inferred rule reproduces one distinct identifier per row')
  } else {
    fail(`preview: ${preview.collisions.length} collisions, ${preview.empty} empty of ${preview.total}`)
  }

  const bad = previewTemplate('constant', table.rows, { columns: table.columns })
  if (bad.collisions.length === 1 && bad.collisions[0].count === table.rows.length) {
    pass('preview: a constant rule is shown colliding on every row')
  } else {
    fail(`preview did not flag a constant rule: ${JSON.stringify(bad.collisions)}`)
  }
}

console.log(failures === 0 ? '\nPASS — identifier rules hold\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
