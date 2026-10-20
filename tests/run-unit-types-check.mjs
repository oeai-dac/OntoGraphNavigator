/**
 * The matrix template's own fields beyond the matrix (2026-10-19): unit type,
 * designation and description of a unit (src/lib/hmeImport.js,
 * src/lib/unitTypeEditor.js, src/lib/forms.js):
 *
 *   - the template has them: SU designation (E41 via P1, short text), SU
 *     description (a note via P3, long text), Unit type (E55 via P2) with the
 *     HME's five types offered before any is in the data;
 *   - the unit type set from the matrix: on all rows of a unit, one node per
 *     value shared by every unit of that type, its identifier by the rule; one
 *     undo; cleared again;
 *   - an HME project brings designation, description and type without any
 *     protocol package;
 *   - the BDA standard protocol, bound to the template, finds designation and
 *     description where they are — no second field for either.
 *
 *   node tests/run-unit-types-check.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

register('./resolve-extensionless.mjs', import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const load = (f) => import(pathToFileURL(path.join(root, f)))

const { useStore } = await load('src/store.js')
const { EMPTY_HME_PROJECT, HME_UNIT_TYPES } = await load('src/lib/hmeImport.js')
const { rematerialize, undo, rowsForForm, valuesFromRow, updateRecord } = await load('src/lib/edits.js')
const { addMatrixRelation, matrixRules } = await load('src/lib/matrixEditor.js')
const { materialize } = await load('src/lib/materialize.js')
const B = await load('src/lib/protocolBinding.js')
const { bdaPackages, havePackages, SKIP_PACKAGES } = await import(pathToFileURL(path.join(here, 'protocol-packages.mjs')))

let failures = 0
const check = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${!cond && detail ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}
const S = () => useStore.getState()

// ---- the template ----------------------------------------------------------------------
console.log('matrix template')
await S().load(new File([EMPTY_HME_PROJECT], 'template.json'))
const unitForm = S().forms.forms.find((f) => /SU \(number\)/.test(f.label))
const fieldsOf = (form) => form.fields.flatMap((f) => (f.kind === 'group' ? [f, ...(f.fields || [])] : [f]))
const fields = fieldsOf(unitForm)
const field = (re) => fields.find((f) => re.test(f.label))
check(field(/SU designation/)?.kind === 'text' && field(/SU designation/)?.column === 'SU_designation' && field(/SU designation/)?.idRule === '{SU_uri}_designation', `SU designation: a short text, its identifier by the rule (${field(/SU designation/)?.kind})`, fields.map((f) => `${f.label}:${f.kind}`).join(', '))
check(field(/SU description/)?.kind === 'longtext', `SU description: long text (${field(/SU description/)?.kind})`)
const typeField = field(/unit type/i)
check(typeField?.kind === 'concept' && JSON.stringify(typeField.suggested) === JSON.stringify(HME_UNIT_TYPES), 'Unit type: a picker offering the HME\u2019s five types', JSON.stringify(typeField))
check(JSON.stringify(S().config.valueLists?.nUnitType) === JSON.stringify(HME_UNIT_TYPES), 'the value list is in the settings — it travels in the .ognproj')

// ---- the unit type from the matrix -------------------------------------------------------
const ws = S().workspace
const [{ typeKey, baseProp }] = matrixRules(ws)
const made = addMatrixRelation(ws, { baseProp, typeKey, a: null, b: null, kind: 'higher', word: 'above', newUnits: { a: { label: '1', identifier: 'SU1' }, b: { label: '2', identifier: 'SU2' } } })
addMatrixRelation(ws, { baseProp, typeKey, a: made.b, b: null, kind: 'higher', word: 'above', newUnits: { b: { label: '3', identifier: 'SU3' } } })
rematerialize(ws)
const info = S().describeUnitTypes({ typeKey })
check(info.available && JSON.stringify(info.options.slice(0, 5)) === JSON.stringify(HME_UNIT_TYPES) && !!info.edgeKey, 'the matrix is offered the five types', JSON.stringify(info))
const r1 = S().editUnitTypes({ typeKey, unitId: made.a, value: 'layer' })
const r2 = S().editUnitTypes({ typeKey, unitId: made.b, value: 'layer' })
const r3 = S().editUnitTypes({ typeKey, unitId: made.b, value: 'interface' })
const g = S().workspace.graph
const typeOf = (u) => (g.nodes[u]?.o?.[info.edgeKey] || []).map((t) => [t, g.nodes[t]?.l])
check(r1.ok && r2.ok && r3.ok && typeOf(made.a)[0]?.[1] === 'layer' && typeOf(made.b)[0]?.[1] === 'interface', 'types given and changed', JSON.stringify({ a: typeOf(made.a), b: typeOf(made.b) }))
check(/Unit_type_layer$/.test(typeOf(made.a)[0]?.[0] || ''), 'the identifier by the rule: Unit_type_layer', typeOf(made.a)[0]?.[0])
const unitTable = [...S().workspace.model.tables.values()][0]
const rowsOfB = unitTable.rows.filter((r) => r.SU_uri === 'SU2' || r.SU_relation_uri === 'SU2')
check(unitTable.rows.filter((r) => r.SU_uri === 'SU2').every((r) => r.Unit_type === 'interface'), 'on every row of the unit', JSON.stringify(rowsOfB.map((r) => [r.SU_uri, r.Unit_type])))
S().editUnitTypes({ typeKey, unitIds: [made.a, made.b], value: 'fill' })
const g2 = S().workspace.graph
const fillNodes = Object.keys(g2.nodes).filter((id) => g2.nodes[id].l === 'fill')
check(fillNodes.length === 1, 'two units of one type: one type node, shared', fillNodes.join())
undo(S().workspace)
rematerialize(S().workspace)
check(S().workspace.graph.nodes[made.a] && (S().workspace.graph.nodes[made.a].o?.[info.edgeKey] || []).map((t) => S().workspace.graph.nodes[t]?.l).join() === 'layer', 'one undo puts both back')
S().editUnitTypes({ typeKey, unitId: made.a, value: '' })
check(!(S().workspace.graph.nodes[made.a].o?.[info.edgeKey] || []).length, 'and a type taken away')
const fresh = materialize(S().workspace.model).graph
check(JSON.stringify(Object.keys(fresh.nodes).sort()) === JSON.stringify(Object.keys(S().workspace.graph.nodes).sort()), 'the incremental graph equals a fresh one')

// ---- designation and description through the form --------------------------------------------
{
  const w = S().workspace
  const form = S().forms.forms.find((f) => f.nodeId === unitForm.nodeId)
  const { rowId, row } = rowsForForm(w, form).find((x) => x.row.SU_uri === 'SU1')
  const designation = fieldsOf(form).find((f) => /SU designation/.test(f.label))
  const description = fieldsOf(form).find((f) => /SU description/.test(f.label))
  const values = { ...valuesFromRow(form, row), [designation.key]: 'Humus', [description.key]: 'Dark brown, loose, roots.' }
  updateRecord(w, form, rowId, values)
  rematerialize(w)
  const r = [...w.model.tables.values()][0].rows.find((x) => x.SU_uri === 'SU1')
  const gu = w.graph.nodes[made.a]
  const named = Object.entries(gu?.o || {}).filter(([k]) => /P1_is_identified_by/.test(k)).flatMap(([, t]) => t)
  check(r.SU_designation === 'Humus' && r.SU_designation_uri === 'SU1_designation' && named.some((t) => t.endsWith('SU1_designation') && w.graph.nodes[t]?.l === 'Humus'),
    'a designation typed: its text in SU_designation, its node SU1_designation by the rule', JSON.stringify({ r, named }))
  check(Object.values(gu?.a || {}).flat().includes('Dark brown, loose, roots.'), 'the description on the unit', JSON.stringify(gu?.a))
}

// ---- the object in the form: a choice, its identifier by the rule or the one it has ------------
{
  const w = S().workspace
  const form = S().forms.forms.find((f) => f.nodeId === unitForm.nodeId)
  const objectField = fieldsOf(form).find((f) => /^Objno/.test(f.label))
  check(objectField?.kind === 'concept' && !fieldsOf(form).some((f) => /forms part of/i.test(f.label)), 'the object: a choice of the objects there are, not their columns typed in', JSON.stringify(objectField))
  check(fieldsOf(form).every((f) => !f.label || f.label[0] === f.label[0].toUpperCase()), 'every field name starts with a capital', fieldsOf(form).map((f) => f.label).join(', '))
  const save = (su, label) => {
    const { rowId, row } = rowsForForm(w, form).find((x) => x.row.SU_uri === su)
    updateRecord(w, form, rowId, { ...valuesFromRow(form, row), [objectField.key]: { label } })
  }
  save('SU1', 'Wall 1')
  save('SU2', 'Wall 1')
  rematerialize(w)
  const rows = [...w.model.tables.values()][0].rows.filter((r) => r.SU_uri === 'SU1' || r.SU_uri === 'SU2')
  check(rows.every((r) => r.Objno === 'Wall 1' && r.Objno_uri === 'Obj_Wall_1'), 'a new object by name: its identifier by the rule, Obj_Wall_1; chosen again, the same one', JSON.stringify(rows.map((r) => [r.SU_uri, r.Objno, r.Objno_uri])))
  check(Object.values(w.graph.nodes).filter((n) => n.l === 'Wall 1').length === 1, 'one object node, two units in it')
}

// ---- the standard protocol finds them --------------------------------------------------------
if (!havePackages) console.log(SKIP_PACKAGES)
else {
  const std = (await bdaPackages()).find((p) => p.protocol.key === 'standard')
  const prop = B.proposeBinding(S().workspace.model, std)
  const choice = (p) => prop.fields.find((f) => f.path === p)?.choice
  check(choice('befunddaten.SE_Bez')?.use === 'package' && !choice('befunddaten.SE_Bez')?.create
    && choice('beschreibungen.Beschreibung_SE')?.use === 'package' && !choice('beschreibungen.Beschreibung_SE')?.create,
    'the BDA standard protocol finds SU designation and SU description — no second field for either', JSON.stringify({ bez: choice('befunddaten.SE_Bez'), desc: choice('beschreibungen.Beschreibung_SE') }))
}

// ---- an HME project, without a package --------------------------------------------------------
const hmeFile = 'c:/CRM/HarrisMatrixEditor/data/test-data.json'
if (fs.existsSync(hmeFile)) {
  console.log('\nHME project, no package')
  const text = fs.readFileSync(hmeFile, 'utf8')
  const hme = JSON.parse(text)
  await S().load(new File([text], 'test-data.json'))
  const gh = S().workspace.graph
  const unit = (label) => Object.values(gh.nodes).find((n) => n.l === label && n.t === S().workspace.model.entities.get('n10').typeKey)
  const withType = hme.nodes.filter((n) => n.type)
  const node = hme.nodes.find((n) => n.description)
  const u = unit(node.label)
  const bez = Object.entries(u?.o || {}).filter(([k]) => /P1_is_identified_by/.test(k)).flatMap(([, t]) => t).map((t) => gh.nodes[t]?.l)
  check([...bez, ...Object.values(u?.a || {}).flat()].some((v) => String(v).includes(node.description)), `the HME description of ${node.label} is there without a package — joined to the protocol's where both fields were taken`, JSON.stringify({ bez, a: u?.a }))
  const typed = Object.values(gh.nodes).filter((n) => n.t === S().workspace.model.entities.get('n10').typeKey && Object.entries(n.o || {}).some(([k, ts]) => /P2_has_type/.test(k) && ts.some((t) => HME_UNIT_TYPES.includes(gh.nodes[t]?.l))))
  check(typed.length === withType.length, `${typed.length} units carry their HME type`)
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPASS — unit types, designation and description hold')
process.exit(failures ? 1 : 0)
