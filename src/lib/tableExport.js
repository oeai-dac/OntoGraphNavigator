/**
 * Tables out: the raw rows, and a flattened view of the graph.
 *
 * TSV is the default rather than CSV, for the same reason HME chose it: the
 * Studio's table parser splits on the separator without honouring quotes, so a
 * comma in a find description tears the row apart. Tabs and line breaks inside
 * values become spaces on the way out.
 */

export const TABLE_FORMATS = {
  tsv: { label: 'TSV', extension: 'tsv', separator: '\t', mime: 'text/tab-separated-values' },
  csv: { label: 'CSV', extension: 'csv', separator: ',', mime: 'text/csv' },
}

function clean(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[\r\n\t]+/g, ' ')
}

/** CSV quotes what it must; TSV never needs to, having stripped tabs already. */
function field(value, separator) {
  const text = clean(value)
  if (separator !== ',') return text
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function serializeTable(columns, rows, format = 'tsv') {
  const spec = TABLE_FORMATS[format]
  if (!spec) throw new Error(`unknown table format: ${format}`)
  const sep = spec.separator
  const lines = [columns.map((c) => field(c, sep)).join(sep)]
  for (const row of rows) lines.push(columns.map((c) => field(row[c], sep)).join(sep))
  return lines.join('\n') + '\n'
}

/** One file per source table, named after its id. */
export function tablesToFiles(model, format = 'tsv') {
  const spec = TABLE_FORMATS[format]
  const files = []
  for (const table of model.tables.values()) {
    const columns = table.columns.length
      ? table.columns
      : [...new Set(table.rows.flatMap((r) => Object.keys(r)))]
    files.push({
      name: `${table.name || table.id}.${spec.extension}`,
      mime: spec.mime,
      content: serializeTable(columns, table.rows, format),
      rows: table.rows.length,
    })
  }
  return files
}

/**
 * One file per node type, for a graph that has no tables behind it.
 *
 * Columns are id, label, every attribute key the type uses, and one column per
 * relation holding the targets' labels. Relations are flattened with " | "
 * because a spreadsheet has no room for a second dimension — this is a view for
 * reading and counting, not a format to read back in.
 */
export function graphToFiles(graph, derivedModel, format = 'tsv') {
  const spec = TABLE_FORMATS[format]
  const files = []

  for (const type of derivedModel.types) {
    const attrKeys = type.attributes.map((a) => a.key)
    const outKeys = type.outgoing.map((r) => r.key)
    const inKeys = type.incoming.map((r) => r.key)
    const columns = [
      'id',
      'label',
      ...attrKeys,
      ...outKeys.map((k) => `-> ${graph.schema.edgeLabels?.[k] || k}`),
      ...inKeys.map((k) => `<- ${graph.schema.edgeLabels?.[k] || k}`),
    ]

    const rows = []
    for (const [id, node] of Object.entries(graph.nodes)) {
      if (node.t !== type.typeKey) continue
      const row = { id, label: node.l }
      for (const key of attrKeys) row[key] = node.a[key] ?? ''
      for (const key of outKeys) {
        row[`-> ${graph.schema.edgeLabels?.[key] || key}`] = (node.o[key] || [])
          .map((t) => graph.nodes[t]?.l || t)
          .join(' | ')
      }
      for (const key of inKeys) {
        row[`<- ${graph.schema.edgeLabels?.[key] || key}`] = (node.i[key] || [])
          .map((t) => graph.nodes[t]?.l || t)
          .join(' | ')
      }
      rows.push(row)
    }

    const safe = (type.label || type.typeKey).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'type'
    files.push({
      name: `${safe}.${spec.extension}`,
      mime: spec.mime,
      content: serializeTable(columns, rows, format),
      rows: rows.length,
    })
  }

  return files
}
