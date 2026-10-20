/**
 * A unit's recording protocol as the filled-in PDF form of its package
 * — the Harris Matrix Editor's export
 * (io/pdfExport.js), fed from the tables instead of the HME's own state.
 *
 *   - text fields get the value, the font shrinking in half points from 10 to
 *     6 until it fits; what still does not fit goes to an appended "Beiblatt";
 *   - checkboxes and radio buttons are marked with a drawn X, as the BDA wants
 *     it (and as survives flattening);
 *   - the 7 × 3 stratigraphy grid comes from the matrix: the unit in the middle,
 *     the units above it in the top row, those below in the bottom row —
 *     cells found by their position on the page, not by their names;
 *   - characters the standard fonts cannot encode are replaced or dropped.
 *
 * Which PDF field a schema field fills is the package's pdf-fields.json (the
 * HME's verified field map for the BDA forms).
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { zipSync } from 'fflate'

const CHAR_REPLACE = {
  '–': '-', '—': '-', '‘': "'", '’': "'", '‚': ',', '“': '"', '”': '"', '„': '"',
  '…': '...', ' ': ' ', '\t': '  ', '×': 'x', '≈': '~', '→': '->', '←': '<-',
}
const winAnsiSafe = (str) => String(str)
  .replace(/[–—‘’‚“”„… \t×≈→←]/g, (c) => CHAR_REPLACE[c] || c)
  .replace(/[^\n\x20-\xFF]/g, '')

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
const uniq = (arr, tol) => {
  const out = []
  for (const v of arr) if (!out.some((o) => Math.abs(o - v) < tol)) out.push(v)
  return out
}

/** The unit's number as the form wants it: its name without a leading "SU". */
export const seNumber = (label) => String(label || '').replace(/^SU\s*/i, '').trim()

function drawX(page, rect, font) {
  const s = Math.min(rect.width, rect.height)
  page.drawText('X', { x: rect.x + rect.width / 2 - s * 0.32, y: rect.y + rect.height / 2 - s * 0.36, size: s * 1.05, font, color: rgb(0, 0, 0) })
}

const widgetPage = (pages, widget) => pages.find((pg) => pg.ref === widget.P()) || pages[0]

function estimateLines(text, font, size, width) {
  let lines = 0
  for (const para of String(text).split('\n')) {
    if (para === '') { lines += 1; continue }
    let cur = ''
    for (const w of para.split(/\s+/)) {
      const trial = cur ? `${cur} ${w}` : w
      if (font.widthOfTextAtSize(trial, size) <= width || cur === '') cur = trial
      else { lines += 1; cur = w }
    }
    lines += 1
  }
  return lines
}

const BASE_SIZE = 10
const MIN_SIZE = 6

function fillText(field, value, font, overflow, label) {
  const val = winAnsiSafe(value)
  if (val.trim() === '') return
  const r = field.acroField.getWidgets()[0].getRectangle()
  let multiline = false
  try { multiline = field.isMultiline() } catch { /* single line */ }
  const width = Math.max(10, r.width - 4)
  const height = Math.max(8, r.height - 2)
  let chosen = MIN_SIZE
  let overflows = true
  for (let size = BASE_SIZE; size >= MIN_SIZE; size -= 0.5) {
    const fits = multiline
      ? estimateLines(val, font, size, width) * size * 1.18 <= height
      : font.widthOfTextAtSize(val.replace(/\n/g, ' '), size) <= width
    if (fits) { chosen = size; overflows = false; break }
  }
  // Too long even at the smallest size: the field gets the beginning that
  // fits, the Beiblatt the whole text. (Handing pdf-lib the whole text let it
  // lay out pages of words into one box — 25 s for 300 words.)
  let shown = val
  if (overflows) {
    const words = val.split(/\s+/)
    const MORE = winAnsiSafe(' … → Beiblatt')
    const fits = (k) => {
      const t = words.slice(0, k).join(' ') + MORE
      return multiline ? estimateLines(t, font, MIN_SIZE, width) * MIN_SIZE * 1.18 <= height : font.widthOfTextAtSize(t, MIN_SIZE) <= width
    }
    let lo = 0
    let hi = words.length
    while (lo < hi) {
      const m = Math.ceil((lo + hi) / 2)
      if (fits(m)) lo = m
      else hi = m - 1
    }
    shown = words.slice(0, lo).join(' ') + MORE
  }
  try {
    field.setText(shown)
    field.setFontSize(chosen)
  } catch {
    try { field.setText(shown) } catch { /* left empty */ }
  }
  if (overflows) overflow.push({ label, text: value })
}

function markCheck(form, name, pages, font, missing) {
  try {
    const w = form.getCheckBox(name).acroField.getWidgets()[0]
    drawX(widgetPage(pages, w), w.getRectangle(), font)
  } catch { missing.push(`check:${name}`) }
}

function markRadio(form, name, option, optionList, pages, font, missing) {
  try {
    const radio = form.getRadioGroup(name)
    const widgets = radio.acroField.getWidgets()
    const onOf = (w) => (w.getOnValue() ? w.getOnValue().asString().replace(/^\//, '') : null)
    // The on-value is the option's label in some forms, its index in others.
    let target = widgets.find((w) => onOf(w) === option)
    if (!target) {
      const i = (optionList || radio.getOptions()).indexOf(option)
      if (i >= 0) target = widgets.find((w) => onOf(w) === String(i))
    }
    if (target) drawX(widgetPage(pages, target), target.getRectangle(), font)
    else missing.push(`radio:${name}[${option}]`)
  } catch { missing.push(`radio:${name}`) }
}

function fillGrid(form, prefix, unitNumber, above, below, overflow) {
  const cells = form.getFields().filter((f) => f.getName().startsWith(prefix)).map((f) => {
    const r = f.acroField.getWidgets()[0].getRectangle()
    return { field: f, x: r.x, y: r.y }
  })
  if (!cells.length) return
  const rowsY = uniq(cells.map((c) => c.y), 6).sort((a, b) => b - a) // top to bottom
  const colsX = uniq(cells.map((c) => c.x), 6).sort((a, b) => a - b) // left to right
  const nCols = colsX.length
  const mid = Math.floor(nCols / 2)
  const put = (row, col, v) => {
    const c = cells.find((x) => Math.abs(x.y - rowsY[row]) < 6 && Math.abs(x.x - colsX[col]) < 6)
    if (c) { try { c.field.setText(winAnsiSafe(v)) } catch { /* ignore */ } }
  }
  put(1, mid, unitNumber)
  const place = (row, values, what) => {
    if (!values.length) return
    const start = Math.max(0, Math.min(nCols - values.length, mid - Math.floor((values.length - 1) / 2)))
    values.slice(0, nCols).forEach((v, i) => put(row, start + i, v))
    if (values.length > nCols) overflow.push({ label: `Stratigrafie ${what}`, text: values.join(', ') })
  }
  place(0, above, 'darüber (Reihe 1)')
  place(2, below, 'darunter (Reihe 3)')
}

/** The continuation sheet — on as many pages as it takes. */
function appendBeiblatt(doc, unitNumber, overflow, font, bold) {
  if (!overflow.length) return
  const W = 595
  const H = 842
  const margin = 50
  const maxW = W - 2 * margin
  let page = doc.addPage([W, H])
  let y = H - margin
  page.drawText(winAnsiSafe(`Beiblatt zu SE ${unitNumber}`), { x: margin, y, size: 15, font: bold, color: rgb(0, 0, 0) })
  page.drawText('Fortsetzung von Feldern, die im Formular nicht vollständig Platz fanden.', { x: margin, y: y - 18, size: 8, font, color: rgb(0.4, 0.4, 0.4) })
  y -= 42
  const next = () => {
    page = doc.addPage([W, H])
    y = H - margin
  }
  const wrap = (text, size) => {
    const out = []
    for (const para of winAnsiSafe(text).split('\n')) {
      let cur = ''
      for (const w of para.split(/\s+/)) {
        const trial = cur ? `${cur} ${w}` : w
        if (font.widthOfTextAtSize(trial, size) <= maxW || cur === '') cur = trial
        else { out.push(cur); cur = w }
      }
      out.push(cur)
    }
    return out
  }
  for (const item of overflow) {
    if (y < margin + 40) next()
    page.drawText(winAnsiSafe(item.label), { x: margin, y, size: 10, font: bold, color: rgb(0, 0, 0) })
    y -= 15
    for (const line of wrap(item.text, 10)) {
      if (y < margin) next()
      page.drawText(line, { x: margin, y, size: 10, font, color: rgb(0.1, 0.1, 0.1) })
      y -= 13
    }
    y -= 10
  }
}

/**
 * Fill the form of `pkg` for one unit.
 *
 * @param {object} pkg       a protocol package with pdfFields (and its template bytes)
 * @param {Uint8Array|ArrayBuffer} template
 * @param {object} unit      { label, values, above: [labels], below: [labels], derived: { 'section.field': value } }
 *                           derived — what the matrix knows (phase, object), filling a field left empty
 * @returns {Promise<{ bytes: Uint8Array, missing: string[], pages: number }>}
 */
export async function fillProtocolPdf(pkg, template, unit, { flatten = true } = {}) {
  const map = pkg.pdfFields
  if (!map || !template) throw new Error(`${pkg.protocol?.name || pkg.id} has no PDF form.`)
  const doc = await PDFDocument.load(template)
  const form = doc.getForm()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const pages = doc.getPages()
  const overflow = []
  const missing = []
  const values = unit.values || {}
  const valueOf = (path) => {
    const [s, f] = path.split('.')
    return values?.[s]?.[f]
  }
  const number = seNumber(unit.label)

  const apply = (entry, value) => {
    if (value === undefined || value === null) return
    switch (entry.t) {
      case 'text':
        try { fillText(form.getTextField(entry.pdf), Array.isArray(value) ? value.join(', ') : value, font, overflow, entry.pdf) } catch { missing.push(`text:${entry.pdf}`) }
        break
      case 'check':
        if (value === true) markCheck(form, entry.pdf, pages, bold, missing)
        break
      case 'multi':
        for (const opt of Array.isArray(value) ? value : []) {
          if (entry.options[opt]) markCheck(form, entry.options[opt], pages, bold, missing)
          else missing.push(`multi-option:${opt}`)
        }
        break
      case 'radio':
        if (typeof value === 'string' && value) markRadio(form, entry.pdf, value, entry.options, pages, bold, missing)
        break
      case 'qualified': {
        const v = value && typeof value === 'object' ? value : {}
        if (v.wert) { try { fillText(form.getTextField(entry.pdf), v.wert, font, overflow, entry.pdf) } catch { missing.push(`text:${entry.pdf}`) } }
        for (const [q, name] of Object.entries(entry.quals || {})) if (v[q] === true) markCheck(form, name, pages, bold, missing)
        break
      }
      case 'object': {
        const v = value && typeof value === 'object' ? value : {}
        for (const [sub, parts] of Object.entries(entry.subfields || {})) {
          const sv = v[sub] && typeof v[sub] === 'object' ? v[sub] : {}
          for (const [part, e] of Object.entries(parts)) apply(e, sv[part])
        }
        break
      }
      default:
        break
    }
  }

  // 1. Kopfdaten — the project's.
  for (const [key, name] of Object.entries(map.kopf || {})) {
    const v = values?.kopfdaten?.[key]
    if (!blank(v)) { try { fillText(form.getTextField(name), v, font, overflow, name) } catch { missing.push(`kopf:${name}`) } }
  }
  // 2. The unit's number, from its name in the matrix.
  if (map.seField) { try { fillText(form.getTextField(map.seField), number, font, overflow, map.seField) } catch { missing.push(`se:${map.seField}`) } }
  // 3. The fields.
  for (const [path, entry] of Object.entries(map.fields || {})) apply(entry, valueOf(path))
  // 4. What the matrix knows fills a field left empty (the phase as the
  //    provisional dating, the object's name) — what was typed always wins.
  for (const [path, value] of Object.entries(unit.derived || {})) {
    const entry = map.fields?.[path]
    if (blank(value) || !blank(valueOf(path)) || entry?.t !== 'text') continue
    try { fillText(form.getTextField(entry.pdf), value, font, overflow, entry.pdf) } catch { /* not on this form */ }
  }
  // 5. The stratigraphy grid.
  if (map.gridPrefix) fillGrid(form, map.gridPrefix, number, (unit.above || []).map(seNumber), (unit.below || []).map(seNumber), overflow)
  // 6. The continuation sheet.
  appendBeiblatt(doc, number, overflow, font, bold)
  if (flatten) { try { form.flatten() } catch { /* stays fillable */ } }
  const bytes = await doc.save()
  return { bytes, missing, pages: doc.getPageCount() }
}

/** File name of one unit's protocol: SE_<number>_<package>.pdf */
export const protocolFilename = (label, pkg) => `SE_${seNumber(label).replace(/[^\w.-]+/g, '_') || 'x'}_${pkg.protocol?.key || pkg.id}.pdf`

/** Several units' protocols as one PDF. `items` = [{ pkg, template, unit }] */
export async function combinedProtocols(items, onProgress) {
  const out = await PDFDocument.create()
  const missing = []
  for (const [i, { pkg, template, unit }] of items.entries()) {
    const filled = await fillProtocolPdf(pkg, template, unit)
    missing.push(...filled.missing.map((m) => `${unit.label}: ${m}`))
    const src = await PDFDocument.load(filled.bytes)
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p)
    onProgress?.(i + 1, items.length)
  }
  return { bytes: await out.save(), missing }
}

/** Several units' protocols as a zip of one PDF each. */
export async function zippedProtocols(items, onProgress) {
  const files = {}
  const missing = []
  for (const [i, { pkg, template, unit }] of items.entries()) {
    const filled = await fillProtocolPdf(pkg, template, unit)
    missing.push(...filled.missing.map((m) => `${unit.label}: ${m}`))
    files[protocolFilename(unit.label, pkg)] = filled.bytes
    onProgress?.(i + 1, items.length)
  }
  return { bytes: zipSync(files, { level: 6 }), missing }
}

/**
 * Does every PDF field the package names exist in its form? Problems in the
 * shape of readPackage's; run on import and in the checks.
 */
export async function checkPdfFields(pkg, template) {
  if (!pkg.pdfFields || !template) return []
  const problems = []
  let form
  try {
    form = (await PDFDocument.load(template)).getForm()
  } catch (error) {
    return [{ severity: 'error', message: `template.pdf cannot be read: ${error.message}` }]
  }
  const names = new Set(form.getFields().map((f) => f.getName()))
  const want = []
  const walk = (entry) => {
    if (!entry) return
    if (entry.t === 'text' || entry.t === 'check' || entry.t === 'radio') want.push(entry.pdf)
    if (entry.t === 'multi') want.push(...Object.values(entry.options || {}))
    if (entry.t === 'qualified') want.push(entry.pdf, ...Object.values(entry.quals || {}))
    if (entry.t === 'object') for (const parts of Object.values(entry.subfields || {})) for (const e of Object.values(parts)) walk(e)
  }
  for (const e of Object.values(pkg.pdfFields.fields || {})) walk(e)
  want.push(...Object.values(pkg.pdfFields.kopf || {}))
  if (pkg.pdfFields.seField) want.push(pkg.pdfFields.seField)
  const absent = [...new Set(want)].filter((n) => !names.has(n))
  if (absent.length) problems.push({ severity: 'warning', message: `pdf-fields.json names ${absent.length} field(s) the form does not have: ${absent.slice(0, 6).join(', ')}${absent.length > 6 ? ' …' : ''}` })
  if (pkg.pdfFields.gridPrefix && ![...names].some((n) => n.startsWith(pkg.pdfFields.gridPrefix))) {
    problems.push({ severity: 'warning', message: `The form has no stratigraphy grid fields starting with "${pkg.pdfFields.gridPrefix}".` })
  }
  return problems
}
