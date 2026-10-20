#!/usr/bin/env node
/**
 * What a fillable PDF form contains, and a first draft of how a recording
 * protocol's fields could land in it.
 *
 *   node scripts/pdf-fields.mjs form.pdf                      list the fields
 *   node scripts/pdf-fields.mjs form.pdf --schema schema.json  … and draft pdf-fields.json
 *   node scripts/pdf-fields.mjs form.pdf --schema schema.json --out pdf-fields.json
 *
 * Writing the field assignment for a protocol package is handwork, and the
 * names inside a PDF are rarely what one would guess: in the BDA form the
 * leftmost "Konsistenz" checkbox is called "Kons sehrfein" and means "sehr fest".
 * So the listing gives every field its page and position, sorted the way the
 * form reads — top to bottom, left to right — which is what tells two
 * similarly named boxes apart.
 *
 * With a schema, every schema field gets a proposal where a PDF field's name
 * matches its key, label or option closely enough, and stays `null` where none
 * does. A proposal is a suggestion to check, not a decision: the draft is meant
 * to be opened, corrected and saved as the package's pdf-fields.json. The
 * entry kinds are the ones the Harris Matrix Editor's hand-made map uses:
 *
 *   text       string field          -> { t: 'text', pdf }
 *   check      boolean               -> { t: 'check', pdf }
 *   multi      multi_select          -> { t: 'multi', options: { option: pdf } }
 *   radio      single_select         -> { t: 'radio', pdf, options: { option: value } }
 *   qualified  value + qualifiers    -> { t: 'qualified', pdf, quals: { qualifier: pdf } }
 *   object     nested fields         -> { t: 'object', subfields: { key: entry } }
 *   grid       array (matrix grid)   -> { t: 'grid', prefix }
 */

import fs from 'node:fs'
import path from 'node:path'
import { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFButton, PDFSignature } from 'pdf-lib'

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : null
}
const pdfPath = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
if (!pdfPath) {
  console.error('usage: node scripts/pdf-fields.mjs form.pdf [--schema schema.json] [--out pdf-fields.json]')
  process.exit(2)
}

// ------------------------------------------------------------- reading

function kindOf(field) {
  if (field instanceof PDFTextField) return 'text'
  if (field instanceof PDFCheckBox) return 'check'
  if (field instanceof PDFRadioGroup) return 'radio'
  if (field instanceof PDFDropdown) return 'dropdown'
  if (field instanceof PDFOptionList) return 'list'
  if (field instanceof PDFButton) return 'button'
  if (field instanceof PDFSignature) return 'signature'
  return 'other'
}

async function readFields(file) {
  const doc = await PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: true })
  const pages = doc.getPages()
  const pageOf = new Map(pages.map((p, i) => [p.ref.toString(), i + 1]))
  const out = []
  for (const field of doc.getForm().getFields()) {
    const widgets = field.acroField.getWidgets()
    const w = widgets[0]
    const rect = w?.getRectangle() || { x: 0, y: 0, width: 0, height: 0 }
    const pageRef = w?.P()?.toString()
    const entry = {
      name: field.getName(),
      kind: kindOf(field),
      page: (pageRef && pageOf.get(pageRef)) || pageOfWidget(doc, w) || 0,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    }
    if (widgets.length > 1) entry.widgets = widgets.length
    if (entry.kind === 'radio' || entry.kind === 'dropdown' || entry.kind === 'list') entry.options = field.getOptions()
    if (entry.kind === 'text') {
      if (field.isMultiline()) entry.multiline = true
      const max = field.getMaxLength()
      if (max) entry.maxLength = max
    }
    out.push(entry)
  }
  // Reading order: page, then top to bottom (PDF y grows upwards), then left to right.
  // Rows are taken as 4 pt bands, so boxes on one printed line stay together.
  out.sort((a, b) => a.page - b.page || Math.round(b.y / 4) - Math.round(a.y / 4) || a.x - b.x)
  return out
}

/** Widgets without a /P entry: find the page whose annotations hold them. */
function pageOfWidget(doc, widget) {
  if (!widget) return 0
  const pages = doc.getPages()
  for (let i = 0; i < pages.length; i++) {
    const annots = pages[i].node.Annots()
    if (!annots) continue
    for (let k = 0; k < annots.size(); k++) {
      if (doc.context.lookup(annots.get(k)) === widget.dict) return i + 1
    }
  }
  return 0
}

// ------------------------------------------------------------- matching

/** Lower case, umlauts transliterated, nothing but letters and digits. */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/**
 * The best unused PDF field for a set of names, or null.
 * Exact beats prefix beats containment; a short name must match exactly, since
 * "SE" is contained in half the form.
 */
function best(names, candidates, used) {
  const wanted = names.map(norm).filter(Boolean)
  let pick = null
  let score = 0
  for (const c of candidates) {
    if (used.has(c.name)) continue
    const n = norm(c.name)
    for (const w of wanted) {
      let s = 0
      if (n === w) s = 3
      else if (w.length >= 4 && (n.startsWith(w) || w.startsWith(n))) s = 2
      else if (w.length >= 5 && (n.includes(w) || w.includes(n))) s = 1
      if (s > score) {
        score = s
        pick = c
      }
    }
  }
  return pick
}

function draft(schema, fields) {
  const used = new Set()
  const text = fields.filter((f) => f.kind === 'text')
  const checks = fields.filter((f) => f.kind === 'check')
  const radios = fields.filter((f) => f.kind === 'radio')
  const take = (f) => {
    if (f) used.add(f.name)
    return f ? f.name : null
  }

  function entryFor(key, def) {
    const names = [key, def.label, def.beschreibung].filter(Boolean)
    switch (def.typ) {
      case 'boolean':
        return { t: 'check', pdf: take(best(names, checks, used)) }
      case 'multi_select': {
        const options = {}
        for (const o of def.optionen || []) options[o] = take(best([`${key} ${o}`, `${o} ${key}`, o], checks, used))
        return { t: 'multi', options }
      }
      case 'single_select': {
        const group = best(names, radios, used)
        if (group) {
          const options = {}
          for (const o of def.optionen || []) {
            const hit = (group.options || []).find((v) => norm(v) === norm(o)) || null
            options[o] = hit
          }
          return { t: 'radio', pdf: take(group), options }
        }
        // Forms often draw a choice as separate boxes rather than a radio group.
        const options = {}
        for (const o of def.optionen || []) options[o] = take(best([`${key} ${o}`, `${o} ${key}`, o], checks, used))
        return { t: 'multi', options, note: 'single choice drawn as separate checkboxes' }
      }
      case 'object': {
        const subfields = {}
        for (const [k, d] of Object.entries(def.felder || {})) subfields[k] = entryFor(`${key} ${k}`, { label: k, ...d })
        return { t: 'object', subfields }
      }
      case 'array': {
        const hit = best(names, fields, used)
        const prefix = hit ? hit.name.replace(/[\s._-]*\d+$/, '') : null
        if (prefix) for (const f of fields) if (f.name.startsWith(prefix)) used.add(f.name)
        return { t: 'grid', prefix }
      }
      default: {
        const pdf = take(best(names, text, used))
        if (!def.qualifikatoren) return { t: 'text', pdf }
        const quals = {}
        for (const q of Object.keys(def.qualifikatoren)) quals[q] = take(best([`${key} ${q}`, `${def.label || key} ${q}`], checks, used))
        return { t: 'qualified', pdf, quals }
      }
    }
  }

  const out = {}
  let total = 0
  let proposed = 0
  const tally = (e) => {
    if (e.t === 'object') return Object.values(e.subfields).forEach(tally)
    if (e.t === 'multi' || (e.t === 'radio' && !e.pdf)) {
      for (const v of Object.values(e.options)) {
        total++
        if (v) proposed++
      }
      return
    }
    if (e.t === 'qualified') {
      for (const v of Object.values(e.quals)) {
        total++
        if (v) proposed++
      }
    }
    total++
    if (e.pdf || e.prefix) proposed++
  }
  for (const [section, sectionFields] of Object.entries(schema.felder || {})) {
    for (const [key, def] of Object.entries(sectionFields)) {
      if (!def || typeof def !== 'object' || Array.isArray(def)) continue
      const e = entryFor(key, def)
      out[`${section}.${key}`] = e
      tally(e)
    }
  }
  return { fields: out, unassigned: fields.filter((f) => !used.has(f.name)).map((f) => f.name), total, proposed }
}

// ------------------------------------------------------------- output

const fields = await readFields(pdfPath)
const count = (k) => fields.filter((f) => f.kind === k).length
console.log(`${path.basename(pdfPath)}: ${fields.length} fields — ${count('text')} text, ${count('check')} checkbox, ${count('radio')} radio, ${count('dropdown') + count('list')} choice, ${count('button') + count('signature') + count('other')} other\n`)

let page = 0
for (const f of fields) {
  if (f.page !== page) {
    page = f.page
    console.log(`page ${page}`)
  }
  const extra = [
    f.options ? `options: ${f.options.join(' | ')}` : '',
    f.multiline ? 'multiline' : '',
    f.maxLength ? `max ${f.maxLength}` : '',
    f.widgets ? `${f.widgets} widgets` : '',
  ].filter(Boolean).join(', ')
  console.log(`  ${f.kind.padEnd(9)} ${JSON.stringify(f.name).padEnd(44)} at ${String(f.x).padStart(4)},${String(f.y).padStart(4)}  ${f.w}x${f.h}${extra ? '  ' + extra : ''}`)
}

const schemaPath = option('schema')
if (schemaPath) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
  const result = draft(schema, fields)
  const doc = {
    template: path.basename(pdfPath),
    generated: 'draft by scripts/pdf-fields.mjs — check every entry before use',
    fields: result.fields,
    unassigned: result.unassigned,
    pdf: fields,
  }
  console.log(`\nschema ${path.basename(schemaPath)}: proposals for ${result.proposed} of ${result.total} slots, ${result.unassigned.length} PDF fields unassigned`)
  const out = option('out')
  if (out) {
    fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n')
    console.log(`draft written to ${out}`)
  } else {
    console.log('(add --out pdf-fields.json to write the draft)')
  }
}
